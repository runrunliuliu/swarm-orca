"""Same-live-Coordinator continuation outbox. No driver, dispatch or shell input.

enqueue records at most one wakeup per action; claim is an at-most-once local
execution fence, NOT an execution receipt. Crash after claim requires manual
reconciliation by the original live Coordinator, never automatic replay.
"""

import argparse
from datetime import timedelta
import json
import math
import os
from pathlib import Path
import subprocess
import uuid
import observation_budget as budget
import tui_adapter

from coordinator_io import (try_bound_lock, correction_fence, canonical, digest, now, parse, path, pinned,
                            publish_new, read_json, replace_json, timestamp, validate_ref)
from coordinator_tui_errors import TuiError, failure, require
from coordinator_tui_checkpoint import validate_checkpoint, validate_domain
from coordinator_authority_bundle import validate_binding
from coordinator_loop import transition
from coordinator_startup import KIND, identity, validate
from coordinator_strict import caller_result
from operator_sender import preflight as sender_preflight
from trae_coordinator import ContextFreshnessError, TUI_ADAPTER, native, NATIVE_RPC_TIMEOUT_SECONDS


STRICT_CALLER_CAPABILITY = "orchestration.strict-caller-check.v1"
WORKFLOW_PROTOCOL = "workflow-v2"
# check: five native fence calls + two four-call TUI snapshots, and up to
# two extra calls on the verified runtime-rebind path. Also allow two 30s
# owner observations and 30s aggregate filesystem work. No config read precedes
# this budget. action_seconds is advice, NOT time spent executing/waiting here.
CHECK_IO_SECONDS = 15 * NATIVE_RPC_TIMEOUT_SECONDS + 2 * 30 + 30


def freshness(contract, evidence, deadline):
    """Advice for bounded turns, never a refreshed timestamp or authority lease."""
    observed = timestamp(evidence["observed_at"])
    current = timestamp(now())
    max_age = contract["freshness"]["context_max_age_seconds"]
    age = (current - observed).total_seconds()
    if not 0 <= age <= max_age:
        raise ContextFreshnessError(age, max_age)
    expires = observed + timedelta(seconds=max_age)
    if deadline is not None:
        require(current < timestamp(deadline), "tui_continuation_deadline")
        expires = min(expires, timestamp(deadline))
    # Reserve time for checkpoint/domain review + enqueue. This is scheduling
    # advice, not permission to finish an action after evidence expires.
    checkpoint_by = expires - timedelta(seconds=min(180, max_age / 2))
    return {"context_observed_at": evidence["observed_at"], "context_age_seconds": age,
            "context_expires_at": (observed + timedelta(seconds=max_age)).isoformat(),
            "valid_until": expires.isoformat(), "checkpoint_by": checkpoint_by.isoformat(),
            "checkpoint_due": current >= checkpoint_by,
            "remaining_seconds": max(0, (expires - current).total_seconds())}


def action_window(timing, seconds):
    require(type(seconds) in (int, float) and math.isfinite(seconds) and seconds > 0,
            "tui_action_seconds_required")
    available = max(0, (timestamp(timing["checkpoint_by"]) - timestamp(now())).total_seconds())
    allowed = not timing["checkpoint_due"] and seconds < available
    return {"action_allowed": allowed, "action_seconds": seconds,
            "action_window_seconds": available,
            "next_step": "bounded_action" if allowed else "checkpoint_enqueue_end_turn"}


def read_outbox(root):
    state_path = root / "outbox.json"
    state = read_json(state_path) if os.path.lexists(state_path) else {"actions": {}, "order": []}
    require(set(state) == {"actions", "order"} and isinstance(state["actions"], dict)
            and isinstance(state["order"], list)
            and all(isinstance(k, str) for k in state["order"])
            and len(state["order"]) == len(set(state["order"]))
            and set(state["order"]) == set(state["actions"]), "tui_outbox_invalid")
    require(all(isinstance(entry, dict) and set(entry) == {
        "checkpoint", "request_id", "attempted", "delivery", "claimed_at", "result"}
        and type(entry["attempted"]) is bool
        for entry in state["actions"].values()), "tui_outbox_invalid")
    return state


def read_scheduler_journal(root, config_ref):
    """Read the bound scheduler state without creating a journal or lock.

    Only this continuation state is addressable by the pinned config. A separate
    Operator monitor-stop is NOT covered by this read-only observation.
    """
    journal_path = root / "scheduler.json"
    if not os.path.lexists(journal_path):
        return None
    journal = read_json(journal_path)
    require(isinstance(journal, dict) and journal.get("config") == config_ref,
            "tui_scheduler_config_changed")
    required = {"config", "stop", "waits", "turns"}
    optional = {"review_clear", "operator_review"}
    require(required <= set(journal) <= required | optional
            and isinstance(journal["waits"], dict) and isinstance(journal["turns"], dict),
            "tui_scheduler_journal_invalid")
    stop = journal["stop"]
    if stop is not None:
        require(isinstance(stop, dict) and stop.get("state") == "review_required"
                and stop.get("business_acceptance") == "not_evaluated",
                "tui_scheduler_journal_invalid")
        if "reason" in stop:
            require(set(stop) == {"state", "reason", "checkpoint", "progress", "business_acceptance"}
                    and stop["reason"] == "tui_scheduler_no_acceptance_progress",
                    "tui_scheduler_journal_invalid")
            progress = stop["progress"]
            require(isinstance(progress, dict) and set(progress) == {
                "consecutive_without_acceptance_advance", "limit", "scope"}
                and type(progress["consecutive_without_acceptance_advance"]) is int
                and type(progress["limit"]) is int and progress["limit"] == 3
                and progress["consecutive_without_acceptance_advance"] >= progress["limit"]
                and progress["scope"] == "declared_acceptance_only_not_semantic_verification",
                "tui_scheduler_journal_invalid")
        else:
            require(set(stop) == {"state", "route", "checkpoint", "business_acceptance"}
                    and stop.get("route") in ("acceptance_review", "alternatives_review",
                                               "operator_handoff", "unsupported_executor"),
                    "tui_scheduler_journal_invalid")
        validate_ref(stop["checkpoint"])
    if "review_clear" in journal:
        validate_ref(journal["review_clear"])
    if "operator_review" in journal:
        require(isinstance(journal["operator_review"], dict), "tui_scheduler_journal_invalid")
        for key, item in journal["operator_review"].items():
            require(isinstance(key, str) and len(key) == 64 and isinstance(item, dict)
                    and set(item) == {"schema_version", "kind", "config", "checkpoint", "action_id",
                                      "action_key", "result", "outbox_delivery", "run",
                                      "coordinator", "request_id", "attempted", "delivery"}
                    and item["schema_version"] == 1
                    and item["kind"] == "coordinator-operator-result-review-request"
                    and item["config"] == config_ref and item["action_key"] == key
                    and isinstance(item["action_id"], str) and item["action_id"]
                    and isinstance(item["request_id"], str) and item["request_id"]
                    and type(item["attempted"]) is bool,
                    "tui_scheduler_journal_invalid")
            validate_ref(item["checkpoint"])
            validate_ref(item["result"])
            require(isinstance(item["outbox_delivery"], dict)
                    and item["outbox_delivery"].get("kind") == "operator_handoff",
                    "tui_scheduler_journal_invalid")
            run = item["run"]
            coordinator = item["coordinator"]
            require(isinstance(run, dict) and set(run) == {"id", "generation"}
                    and isinstance(run["id"], str) and type(run["generation"]) is int
                    and isinstance(coordinator, dict)
                    and set(coordinator) == {"terminal", "incarnation", "session"}
                    and all(isinstance(v, str) and v for v in coordinator.values()),
                    "tui_scheduler_journal_invalid")
            delivery = item["delivery"]
            require(delivery is None or (isinstance(delivery, dict)
                    and set(delivery) == {"message_id", "enqueued_at"}
                    and isinstance(delivery["message_id"], str) and delivery["message_id"]
                    and isinstance(delivery["enqueued_at"], str)
                    and timestamp(delivery["enqueued_at"]) <= timestamp(now())),
                    "tui_scheduler_journal_invalid")
    return journal


def validate_scheduler_review_clear(clear_ref, journal, config, contract, root, config_ref):
    """Validate an immutable independent review that permits one stopped checkpoint to continue.

    This is a bridge from an already checked domain receipt to the runtime scheduler
    circuit breaker. It does not grant authority, rewrite the stop, clear outbox, or
    prove business success. The old stop remains in the journal and inside the
    immutable receipt for audit.
    """
    require(isinstance(journal, dict) and journal.get("stop") is not None,
            "tui_scheduler_review_clear_requires_stop")
    stop = journal["stop"]
    require(stop.get("reason") == "tui_scheduler_no_acceptance_progress",
            "tui_scheduler_review_clear_unsupported_stop")
    validate_ref(clear_ref)
    target = path(clear_ref["path"])
    require(any(target.is_relative_to(Path(r)) for r in contract["observation"]["roots"])
            and not target.is_relative_to(root), "tui_scheduler_review_clear_outside_scope")
    clear = parse(pinned(clear_ref))
    require(isinstance(clear, dict) and set(clear) == {
            "schema_version", "kind", "config", "stop", "checkpoint", "domain_check",
            "decision", "reason", "reviewed_at"}
            and clear["schema_version"] == 1
            and clear["kind"] == "scheduler-review-clear"
            and clear["config"] == config_ref
            and clear["stop"] == stop
            and clear["checkpoint"] == stop["checkpoint"]
            and clear["reason"] == "independent_authorized_progress_review",
            "tui_scheduler_review_clear_invalid")
    require(timestamp(clear["reviewed_at"]) <= timestamp(now()),
            "tui_scheduler_review_clear_invalid")
    record, route = validate_checkpoint(clear["checkpoint"], config, contract)
    require(clear["domain_check"] == record["domain_check"]
            and clear["decision"] == route.decision == "continue",
            "tui_scheduler_review_clear_binding_mismatch")
    return clear


def scheduler_review_clear(journal, config, contract, root, config_ref):
    if not journal or journal.get("stop") is None or "review_clear" not in journal:
        return None
    clear = validate_scheduler_review_clear(journal["review_clear"], journal, config, contract, root, config_ref)
    return {"receipt": journal["review_clear"], "review": clear}


def active_scheduler_stop(journal, head):
    """Return the persisted stop that still applies to the current checkpoint head.

    The no-acceptance circuit breaker is intentionally global until a matching
    independent review is applied. Terminal review stops are tied to the exact
    checkpoint that produced them, so an older terminal stop is audit history for
    a later head rather than a live blocker.
    """
    stop = journal.get("stop") if isinstance(journal, dict) else None
    if stop is None:
        return None
    if stop.get("reason") == "tui_scheduler_no_acceptance_progress":
        return stop
    return stop if stop["checkpoint"] == head else None


def applicable_scheduler_review_clear(journal, config, contract, root, config_ref):
    """Return a clear receipt only for the stop class it is allowed to clear.

    A stale clear pin may remain beside a later terminal review stop in older
    journals. Observation paths must not treat that pin as authority, but also
    should not crash before reporting the real stop. Explicit apply-review-clear
    and no-acceptance clears still use the strict validator above.
    """
    if not journal or journal.get("stop") is None:
        return None
    if journal["stop"].get("reason") != "tui_scheduler_no_acceptance_progress":
        return None
    return scheduler_review_clear(journal, config, contract, root, config_ref)


def scheduler_review_is_cleared(journal, review, config, contract, root, config_ref):
    if review is None or not journal or journal.get("stop") != review:
        return None
    return scheduler_review_clear(journal, config, contract, root, config_ref)


def persist_scheduler_review_stop(journal, root, review):
    """Persist the current scheduler circuit-breaker stop exactly once.

    This is shared by the monitor scheduler and the Coordinator delivery finish
    path.  A stale clear receipt must not remain attached to a new stop: the
    immutable receipt still exists at its pinned path, but the journal now waits
    for a clear that binds this exact review object.
    """
    journal["stop"] = review
    journal.pop("review_clear", None)
    replace_json(root / "scheduler.json", journal)
    return journal["stop"]


def apply_review_clear(config_ref, clear_ref):
    """Attach one pinned independent review to the current scheduler stop.

    The clear receipt is written outside the continuation state first, then this
    function only records its immutable pin under the continuation lock. It is
    intentionally narrower than a reset: the persisted stop remains unchanged,
    outbox entries are not touched, and old deliveries are never replayed.
    """
    config, contract, root = load(config_ref)
    if "execution" in config:
        from startup_execution import can_send
        can_send(config)
    require("scheduler" in config, "tui_scheduler_review_clear_requires_scheduler")
    with try_bound_lock(root, config_ref, "tui-continuation") as acquired:
        if not acquired:
            return {"state": "retryable", "reason": "tui_continuation_lock_busy", "retryable": True,
                    "committed": False, "execute_action": False, "retry_mode": "apply-review-clear",
                    "retry_after_seconds": 1,
                    "next_step": "retry_same_review_clear_without_modifying_receipt"}
        load(config_ref)
        journal = read_scheduler_journal(root, config_ref)
        require(journal is not None, "tui_scheduler_journal_required")
        existing = journal.get("review_clear")
        if existing is not None:
            require(existing == clear_ref, "tui_scheduler_review_clear_conflict")
            clear = validate_scheduler_review_clear(clear_ref, journal, config, contract, root, config_ref)
            return {"ok": True, "state": "scheduler_review_clear_already_applied",
                    "execute_action": False, "scheduler_stop_persisted": True,
                    "checkpoint": clear["checkpoint"],
                    "scheduler_review_clear": {"receipt": clear_ref, "review": clear}}
        clear = validate_scheduler_review_clear(clear_ref, journal, config, contract, root, config_ref)
        if "execution" in config:
            can_send(config)
        journal["review_clear"] = clear_ref
        replace_json(root / "scheduler.json", journal)
        return {"ok": True, "state": "scheduler_review_clear_applied", "execute_action": False,
                "scheduler_stop_persisted": True, "checkpoint": clear["checkpoint"],
                "scheduler_review_clear": {"receipt": clear_ref, "review": clear}}


def scheduler_review(head, route, progress):
    """Same review decision at pre-yield and completed-turn boundaries."""
    if route.kind not in ("coordinator_turn", "dependency_wait"):
        return {"state": "review_required", "route": route.kind, "checkpoint": head,
                "business_acceptance": "not_evaluated"}
    if progress["consecutive_without_acceptance_advance"] >= progress["limit"]:
        return {"state": "review_required", "reason": "tui_scheduler_no_acceptance_progress",
                "checkpoint": head, "progress": progress, "business_acceptance": "not_evaluated"}
    return None


def load(ref):
    config = parse(pinned(ref))
    contract = validate_config(config)
    try:
        root = path(config["state_root"], directory=True)
    except FileNotFoundError:
        require(False, "tui_continuation_state_not_initialized")
    require(any(root.is_relative_to(Path(r)) for r in contract["observation"]["roots"]),
            "tui_continuation_state_outside_roots")
    try:
        head = path(config["checkpoint_head"])
    except FileNotFoundError:
        require(False, "tui_checkpoint_head_not_initialized")
    require(any(head.is_relative_to(Path(r)) for r in contract["observation"]["roots"]),
            "tui_checkpoint_head_outside_roots")
    correction_fence(root, ref)
    return config, contract, root


def validate_config(config, *, require_executing=True):
    """Shared pinned config validation, including before initialization writes.

    ``require_executing=False`` is only for the deterministic pre-fence pass: it keeps
    every schema/pin/binding check but skips the markers the fence writes.
    """
    keys = {"schema_version", "contract", "dispatch_gate", "state_root", "deadline", "acceptance", "checkpoint_head"}
    require(type(config.get("schema_version")) is int and config["schema_version"] in (1, 2)
            and set(config) == keys | ({"scheduler"} if config["schema_version"] == 2 else set())
                | ({"startup_lifecycle"} if config["schema_version"] == 2 and "startup_lifecycle" in config else set())
                | ({"turn_protocol"} if config["schema_version"] == 2 and "turn_protocol" in config else set())
                | ({"authority_binding"} if config["schema_version"] == 2 and "authority_binding" in config else set())
                | ({"domain_binding"} if config["schema_version"] == 2 and "domain_binding" in config else set())
                | (set(config) & {"execution", "startup_evidence"} if config["schema_version"] == 2 else set()),
            "tui_continuation_config_invalid")
    require("turn_protocol" not in config or config["turn_protocol"] == WORKFLOW_PROTOCOL,
            "tui_turn_protocol_invalid")
    # Explicit opt-in for new scheduler configs only. Never reinterpret a missing,
    # malformed or historical deadline as unlimited, or rewrite a bound config.
    deadline = config["deadline"]
    require((deadline is None and config["schema_version"] == 2)
            or isinstance(deadline, str), "tui_continuation_deadline_invalid")
    if deadline is not None:
        try:
            deadline = timestamp(deadline)
        except ValueError:
            require(False, "tui_continuation_deadline_invalid")
    if config["schema_version"] == 2:
        sender = config["scheduler"]
        require(isinstance(sender, dict) and set(sender) == {"terminal", "incarnation", "workspace"}
                and all(isinstance(v, str) and v.strip() for v in sender.values()),
                "tui_scheduler_binding_invalid")
    contract = parse(pinned(config["contract"]))
    # A new role-produced contract cannot use the historical no-lifecycle branch
    # by omitting execution fields from a fresh continuation configuration.
    binding_path = Path(config["contract"]["path"]).parent / "binding.json"
    if Path(config["contract"]["path"]).name == "first-contract.json" and os.path.lexists(binding_path):
        binding = read_json(binding_path)
        require(config.get("startup_lifecycle") == binding.get("lifecycle") and "execution" in config,
                "startup_lifecycle_required")
    validate(contract)
    from coordinator_domain import validate_config_binding
    validate_config_binding(config, contract)
    acceptance = parse(pinned(config["acceptance"]))
    require(isinstance(acceptance, dict) and set(acceptance) == {"requirements"}, "tui_acceptance_invalid")
    if "authority_binding" in config:
        validate_binding(config["authority_binding"], contract, acceptance)
    # Every TUI adapter this build knows may continue its own Run; an adapter outside
    # that set is refused by name instead of being reported as a missing gated Run.
    require(tui_adapter.is_tui(contract.get("adapter")), "tui_continuation_adapter_unsupported")
    require(contract["run"] is not None, "tui_continuation_requires_gated_run")
    require(config.get("scheduler", {}).get("terminal") != contract["coordinator"]["terminal"],
            "tui_scheduler_requires_operator")
    if "startup_lifecycle" in config:
        from operator_startup import validate_continuation_binding
        validate_continuation_binding(config["startup_lifecycle"], config, contract,
                                      require_executing=require_executing)
    from startup_execution import policy, startup_gate
    policy(config)
    require("startup_evidence" not in config or "execution" in config, "startup_execution_mode_required")
    gate = startup_gate(config)
    require(gate.get("kind") == KIND and gate.get("ok") is True
            and gate.get("schema_version") == 2 and gate.get("actor") == "coordinator"
            and gate.get("phase") == ("first-dispatch" if config["dispatch_gate"] is not None else "run-readiness")
            and gate.get("contract_sha256") == config["contract"]["sha256"]
            and gate.get("identity_sha256") == digest(canonical(identity(contract)))
            and gate.get("run", {}).get("id") == contract["run"]["id"]
            and gate["run"].get("coordinator_handle") == contract["coordinator"]["terminal"]
            and type(gate["run"].get("consumer_generation")) is int
            and gate["run"]["consumer_generation"] == contract["run"]["generation"],
            "tui_continuation_dispatch_gate_mismatch")
    require(timestamp(gate["started_at"]) <= timestamp(gate["completed_at"])
            <= timestamp(gate["valid_until"]) and
            timestamp(gate["completed_at"]) <= timestamp(now()),
            "tui_continuation_deadline")
    require(deadline is None or timestamp(now()) < deadline, "tui_continuation_deadline")
    return contract


def prepare_entry(state, checkpoint_ref, record, root):
    """Single action journal shared by model-driven and scheduled continuations."""
    key = digest(canonical(record["checkpoint"]["next_action"]["id"]))
    entries = state["actions"]
    if key not in entries:
        require(all(item.get("result") for item in entries.values()), "tui_pending_continuation_exists")
        validate_transition(state, record)
        entries[key] = {"checkpoint": checkpoint_ref, "request_id": str(uuid.uuid4()),
                        "attempted": False, "delivery": None, "claimed_at": None, "result": None}
        state["order"].append(key)
        replace_json(root / "outbox.json", state)
    entry = entries[key]
    require(entry["checkpoint"] == checkpoint_ref, "tui_action_id_reused_or_checkpoint_changed")
    return entry


def cancel_unsent(state, root, reason):
    """Under the continuation lock, archive before removing never-sent intents."""
    for key in list(state["order"]):
        entry = state["actions"][key]
        if entry["attempted"] is not False:
            continue
        require(all(entry[k] is None for k in ("delivery", "claimed_at", "result")),
                "tui_unsent_intent_invalid")
        archive = root / ("cancelled-" + digest(canonical(entry["request_id"])) + ".json")
        if os.path.lexists(archive):
            saved = read_json(archive)
            require(saved.get("action_key") == key and saved.get("entry") == entry,
                    "tui_cancelled_intent_changed")
        else:
            publish_new(archive, {"action_key": key, "entry": entry, "reason": reason, "at": now()})
        del state["actions"][key]
        state["order"].remove(key)
        replace_json(root / "outbox.json", state)


def validate_transition(state, record):
    if state["order"]:
        previous = state["actions"][state["order"][-1]]
        require(previous["result"] is not None, "tui_pending_continuation_exists")
        before = parse(pinned(previous["checkpoint"]))["checkpoint"]
        result = parse(pinned(previous["result"]))
        for ref in result["evidence"]:
            pinned(ref)
        transition(before, record["checkpoint"], result, result["evidence"])


def validate_next_scheduled_action(state, record):
    """Shared read-only fence for a settled journal before the next turn.

    A fresh domain receipt does not make a previously executed action new. The
    caller must first rule out pending entries; this is not a recovery/reset API.
    """
    action = record["checkpoint"]["next_action"]
    key = digest(canonical(action["id"])) if action else None
    require(key not in state["actions"], "tui_scheduler_checkpoint_not_advanced")
    validate_transition(state, record)


def validate_scheduler_progress(state, record=None):
    """Bound automatic actions without new acceptance declarations.

    Reconstruct from the immutable outbox, including after monitor restart. New
    hashes/action names/prose do not reset the bound. A first newly met requirement
    may reset it, but is NOT semantic acceptance; independent review still applies.
    This conservative circuit breaker may pause legitimate multi-step work.
    """
    seen = set()
    completed = []
    for key in state["order"]:
        entry = state["actions"][key]
        if entry["result"] is None:
            continue
        result = parse(pinned(entry["result"]))
        pinned(entry["checkpoint"])
        for ref in result["evidence"]:
            pinned(ref)
        hashes = {ref["sha256"] for ref in result["evidence"]}
        require(hashes - seen, "tui_scheduler_no_novel_execution_evidence")
        seen.update(hashes)
        completed.append(parse(pinned(entry["checkpoint"]))["checkpoint"])
    count, seen_met = 0, set()
    if completed and record is not None:
        seen_met = {r["id"] for r in completed[0]["requirements"] if r["status"] == "met"}
        for after in completed[1:] + [record["checkpoint"]]:
            met = {r["id"] for r in after["requirements"] if r["status"] == "met"}
            count = 0 if met - seen_met else count + 1
            seen_met.update(met)
    return {"consecutive_without_acceptance_advance": count, "limit": 3,
            "scope": "declared_acceptance_only_not_semantic_verification"}


def deliver_entry(config_ref, config, contract, root, state, entry, record, call, pre_send):
    """Intent-before-send and receipt-only recovery, using the actor's OWN context."""
    if entry["delivery"] is not None:
        return
    cli, runtime, run = contract["cli"]["path"], contract["runtime"], contract["run"]["id"]
    if entry["attempted"]:
        reply, _ = request_show_with_runtime_epoch(cli, runtime, call, entry["request_id"])
        require(reply.get("requestId") == entry["request_id"] and reply.get("state") == "completed"
                and reply.get("method") == "orchestration.send", "tui_send_requires_reconciliation")
        reply = reply.get("receipt", {})
    else:
        delivery_runtime = pre_send()
        from startup_execution import require_send
        require_send(config)
        entry["attempted"] = True
        replace_json(root / "outbox.json", state)
        action = record["checkpoint"]["next_action"]
        suffix = ("Publish a new domain-checked checkpoint from this real turn and update checkpoint_head; "
                  "next_action must describe the next authorized action with an ID never used in this journal, "
                  "not the action just settled. Changing only timestamps or renaming completed work is not progress. "
                  "run coordinator_tui_continue.py turn-end with the original config pins before ending "
                  "the turn. check alone does not validate checkpoint freshness. Keep the original config "
                  "and journal even after a duplicate wakeup; do not reinitialize or rewrite timestamps. "
                  "The Operator scheduler will enqueue after this real turn ends. Do not enqueue yourself. "
                  if "scheduler" in config else
                  "Enqueue the next authorized action if needed, then run turn-end. ")
        from operator_continuity_route import continuation_plan
        recovery_plan = continuation_plan()
        body = ("Resume the original task in this same TUI, within original authority/budget. "
            "Use coordinator_tui_continue.py check --action-seconds <bounded estimate>, then claim "
            "--action-seconds <same estimate> against these pins. Only execute_action=true permits "
            "the action; persist evidence and settle before acknowledging the whole Delivery batch by "
            "deliveryId. Check/claim alone is not completion. Reconcile duplicates or uncertain results "
            "without replay. Lock-busy (exit 75) means this invocation did not commit: retry the same "
            "command/pins within the original budget and any explicit deadline, waiting at least 1 second. A settle retry "
            "must not repeat the action or ACK before settlement. For a wait action, recheck only "
            "the named dependencies before deciding. " + suffix +
            "Never consume a newly enqueued continuation in the same turn.")
        if config.get("turn_protocol") == WORKFLOW_PROTOCOL:
            body = ("Resume the original task in this same TUI within original authority/budget. "
                "Use coordinator_tui_workflow.py begin --config/--config-sha256 from the payload "
                "with --execute --action-seconds <bounded estimate>. Execute only when "
                "execute_action=true; a duplicate begin never permits reexecution. Process the WHOLE "
                "returned Delivery batch, save evidence and a new domain-checked checkpoint, then use "
                "coordinator_tui_workflow.py submit with the same config pins, --result/--next/--processed "
                "path and sha256 pairs, --receipt <new approved path> and --execute. The program validates, "
                "settles, ACKs, publishes the head and audits turn-end. Do not perform these steps manually. "
                "Check/claim or ending a model answer is not submission. Inspect submission_accepted and "
                "turn_end separately: acceptance of the submission is not business acceptance or permission "
                "to continue. For exit 75 retry identical submit pins after at least 1 second within the "
                "original budget/deadline, never the business action. For a wait action recheck only named "
                "dependencies. The next_action needs an unused ID and real authorized work; new timestamps, "
                "hashes or renamed completed work are not progress. Reconcile unknown outcomes; never "
                "replay a claimed action, reset state, enqueue yourself or consume new mail in this turn.")
        if recovery_plan is not None:
            body = ("Continue the original task within original authority/budget. Use "
                "operator_monitor_cross_runtime.py continue-begin with the payload recovery_plan path/hash "
                "and --execute --action-seconds <bounded estimate>. Execute only when execute_action=true. "
                "Publish evidence and a new domain-checked checkpoint, then use continue-finish with the same "
                "plan pins, --result/--next/--processed pins and a new --receipt path; it settles and ACKs "
                "the WHOLE Delivery batch before turn-end. Do not replay a claimed or uncertain action, "
                "use same-runtime commands, modify historical pins, enqueue yourself or consume new mail "
                "in this turn. A duplicate begin does not permit reexecution.")
        require_send(config)
        reply = call(cli, delivery_runtime or runtime, ["orchestration", "send", "--to", "run:" + run,
            "--run", run, "--type", "status", "--subject", "Coordinator continuation " + digest(canonical(action["id"])),
            "--body", body,
            "--payload", canonical({"kind": "coordinator_tui_continue_v1", "config": config_ref,
                                     "checkpoint": entry["checkpoint"], "action_id": action["id"],
                                     **({"turn_protocol": WORKFLOW_PROTOCOL}
                                        if config.get("turn_protocol") == WORKFLOW_PROTOCOL else {}),
                                     **({"recovery_plan": recovery_plan} if recovery_plan else {})}).decode(),
            "--retry-request", entry["request_id"]])
    message = reply.get("message", {})
    sender = config.get("scheduler", {}).get("terminal", contract["coordinator"]["terminal"])
    require(reply.get("mutation", {}).get("requestId") == entry["request_id"]
            and message.get("run_id") == run and message.get("to_handle") == "run:" + run
            and message.get("from_handle") == sender
            and isinstance(message.get("id"), str) and message["id"], "tui_send_receipt_mismatch")
    entry["delivery"] = {"message_id": message["id"], "enqueued_at": now()}
    replace_json(root / "outbox.json", state)


def request_show_with_runtime_epoch(cli, runtime, call, request_id):
    """Reconcile an already attempted native send across a Server epoch change.

    This path is deliberately narrower than the pre-send fence: it does not
    claim work, observe TUI state, consume inbox, or send. It only asks Orca for
    the durable receipt of the exact request id that was persisted before the
    ambiguous send. Native caller/request ownership remains Orca's job.
    """
    from operator_continuity_route import runtime as transport_runtime
    args = ["orchestration", "request-show", "--request", request_id]
    try:
        return call(cli, runtime, args), transport_runtime(runtime)
    except ValueError as exc:
        if str(exc) != "native query failed or runtime changed":
            raise
    current, _ = discover_runtime(cli)
    require(current != transport_runtime(runtime), "tui_runtime_rebind_unavailable")
    return call(cli, current, args), current


@budget.observed("runtime_discovery")
def discover_runtime(cli):
    """Read the current Server epoch without weakening native query fences.

    Historical continuation contracts pin the runtime that was current when the
    Coordinator started. After a Server restart, regular native calls correctly
    reject that stale epoch. This discovery is only used to propose a candidate
    epoch; fence() must still prove the same strict caller, terminal and Run
    before any continuation action can proceed.
    """
    reply = subprocess.run([cli, "status", "--json"], check=True, text=True,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           timeout=budget.timeout(NATIVE_RPC_TIMEOUT_SECONDS))
    value = json.loads(reply.stdout)
    result = value.get("result", {})
    runtime = result.get("runtime", {})
    current = runtime.get("runtimeId")
    require(value.get("ok") is True and isinstance(value.get("_meta"), dict)
            and isinstance(result, dict) and isinstance(runtime, dict)
            and isinstance(current, str) and current
            and value["_meta"].get("runtimeId") == current
            and runtime.get("state") == "ready"
            and runtime.get("appVersion") == "1.4.219"
            and STRICT_CALLER_CAPABILITY in runtime.get("capabilities", []),
            "tui_runtime_rebind_unavailable")
    return current, result


def live_runtime_epoch(cli, runtime, call, initial, contract):
    """Return the native runtime usable for this live Coordinator fence.

    The fast path preserves the historical contract runtime. The restart path is
    deliberately narrow: only a stale-runtime native failure may trigger current
    epoch discovery, and the caller must then match the original strict caller
    before the caller can observe TUI state or claim work.
    """
    from operator_continuity_route import runtime as transport_runtime
    try:
        live = caller_result(call(cli, runtime, ["orchestration", "strict-caller-check"]),
                             transport_runtime(runtime))
        return transport_runtime(runtime), live, None
    except ValueError as exc:
        if str(exc) != "native query failed or runtime changed":
            raise
    current, status = discover_runtime(cli)
    require(current != transport_runtime(runtime), "tui_runtime_rebind_unavailable")
    live = caller_result(call(cli, current, ["orchestration", "strict-caller-check"]), current)
    require(live["caller"] == initial["caller"], "tui_live_caller_changed")
    return current, live, {
        "schema_version": 1,
        "kind": "verified_same_coordinator_runtime_epoch_rebind",
        "source_runtime": runtime,
        "target_runtime": current,
        "terminal": contract["coordinator"]["terminal"],
        "incarnation": contract["coordinator"]["incarnation"],
        "workspace": contract["workspace"]["id"],
        "run": {"id": contract["run"]["id"], "generation": contract["run"]["generation"]},
        "status": {"runtimeId": current, "appVersion": status["runtime"]["appVersion"],
                   "state": status["runtime"]["state"]},
    }


def fence_with_runtime(contract, call):
    """Fence the live Coordinator turn through the reviewed reader of its own adapter."""
    adapter = contract["adapter"]
    observer, policy_key = tui_adapter.reader(adapter)
    provider = tui_adapter.provider(adapter)
    cli, runtime = contract["cli"]["path"], contract["runtime"]
    c, r = contract["coordinator"], contract["run"]
    require(os.environ.get("ORCA_TERMINAL_HANDLE") == c["terminal"], "tui_original_context_required")
    initial = caller_result(parse(pinned(contract["observation"]["caller_receipt"])), runtime)
    live_runtime, live, runtime_rebind = live_runtime_epoch(cli, runtime, call, initial, contract)
    require(live["caller"] == initial["caller"], "tui_live_caller_changed")
    terminal = call(cli, live_runtime, ["terminal", "show", "--terminal", c["terminal"]])["terminal"]
    require(terminal.get("incarnationId") == c["incarnation"]
            and terminal.get("worktreeId") == contract["workspace"]["id"]
            and terminal.get("agentIdentity") == provider and terminal.get("connected") is True
            and terminal.get("orphaned") is False, "tui_agent_unverifiable")
    def check_owner():
        shown = call(cli, live_runtime, ["orchestration", "run-show", "--id", r["id"]])
        run = shown.get("run", {})
        require(shown.get("coordinatorPolicy") == "strict-v1" and not shown.get("strictRetirement")
                and run.get("id") == r["id"] and run.get("coordinator_handle") == c["terminal"]
                and type(run.get("consumer_generation")) is int
                and run["consumer_generation"] == r["generation"], "tui_run_owner_changed")

    check_owner()
    o = contract["observation"]
    options = dict(cli=cli, runtime=live_runtime, terminal=c["terminal"], incarnation=c["incarnation"],
        workspace=contract["workspace"]["id"], cwd=contract["workspace"]["path"],
        profile=o["profile"], caller_receipt=o["caller_receipt"], log_root=o["log_root"], roots=o["roots"],
        expected_thread=c["session"],
        context_max_age_seconds=contract["freshness"]["context_max_age_seconds"], startup_anchor=o["startup_anchor"],
        caller_receipt_runtime=runtime)
    options[policy_key] = tui_adapter.input_value(adapter, contract["runtime_config"])
    if policy_key == "trae_runtime_config":
        options["accepted_runtime_rebind"] = runtime_rebind
    else:
        # A Pi anchor requires one runtime id; a rebind is not a supported shape.
        require(runtime_rebind is None, "tui_runtime_rebind_unsupported")
    evidence = observer(**options)
    require(evidence["thread_id"] == c["session"], "tui_provider_session_changed")
    # Settings/log inspection does not lease authority during its I/O window.
    check_owner()
    after = caller_result(call(cli, live_runtime, ["orchestration", "strict-caller-check"]), live_runtime)
    require(after["caller"] == live["caller"], "tui_live_caller_changed")
    return evidence, live_runtime


def fence(contract, call):
    evidence, _ = fence_with_runtime(contract, call)
    return evidence


def check_with_runtime(config_ref, *, action_seconds=None, call=native):
    """Read-only same-session revalidation; no outbox, wakeup or business action.

    A new real model turn can supply a newer turn_context in the SAME anchored
    log. Re-reading an old turn does not refresh it. Never replace startup pins.
    """
    config, contract, root = load(config_ref)
    binding = root / "tui-continuation-binding.json"
    if os.path.lexists(binding):
        require(read_json(binding) == config_ref, "tui_continuation_config_changed")
    evidence, live_runtime = fence_with_runtime(contract, call)
    load(config_ref)
    if "execution" in config:
        from startup_execution import can_send
        can_send(config)  # Even read-only action-window advice needs current admission.
    timing = freshness(contract, evidence, config["deadline"])
    window = action_window(timing, action_seconds) if action_seconds is not None else {}
    return ({"ok": True, "state": "checked", "execute_action": False, **window,
             "freshness": timing,
             "execution_authorized": False}, live_runtime)


def check(config_ref, *, action_seconds=None, call=native):
    result, _ = check_with_runtime(config_ref, action_seconds=action_seconds, call=call)
    return result


def result_pin(ref, config, contract, root, *, document=False):
    """Scope before contents; control state cannot be durable execution evidence.

    Exclude the whole owned journal directory, not just today's filenames, and
    the independently located head. Use publish_new snapshots outside these
    locations for observations. This does not prove other files are immutable.
    """
    validate_ref(ref)
    target = path(ref["path"])
    require(any(target.is_relative_to(Path(r)) for r in contract["observation"]["roots"]),
            "tui_result_outside_roots" if document else "tui_result_evidence_outside_roots")
    require(not target.is_relative_to(root) and target != Path(config["checkpoint_head"]),
            "tui_result_control_file_reference")
    return pinned(ref)


def scheduler_sender_fence(config, contract, call, *, environment=None):
    """Validate the bound native Operator sender, not the Coordinator TUI."""
    require(config.get("schema_version") == 2 and "scheduler" in config,
            "monitor_native_sender_configuration_required")
    sender = config["scheduler"]
    environment = os.environ if environment is None else environment
    require(environment.get("ORCA_TERMINAL_HANDLE") == sender["terminal"]
            and not any(environment.get(k) for k in ("ORCA_AGENT_SESSION_ID", "ORCA_STRUCTURED_SESSION",
                "ORCA_DISPATCH_ID", "ORCA_TASK_ID")), "monitor_requires_own_operator_terminal")
    cli, runtime, run_id = contract["cli"]["path"], contract["runtime"], contract["run"]["id"]
    shown = call(cli, runtime, ["orchestration", "run-show", "--id", run_id])
    run = shown.get("run", {})
    require(shown.get("coordinatorPolicy") == "strict-v1" and not shown.get("strictRetirement")
            and run.get("id") == run_id
            and run.get("coordinator_handle") == contract["coordinator"]["terminal"]
            and type(run.get("consumer_generation")) is int
            and run["consumer_generation"] == contract["run"]["generation"],
            "monitor_coordinator_changed")
    coordinator = call(cli, runtime, ["terminal", "show", "--terminal", contract["coordinator"]["terminal"]]).get("terminal", {})
    require(coordinator.get("handle") == contract["coordinator"]["terminal"]
            and coordinator.get("incarnationId") == contract["coordinator"]["incarnation"]
            and coordinator.get("worktreeId") == contract["workspace"]["id"]
            and coordinator.get("connected") is True and coordinator.get("orphaned") is False,
            "monitor_coordinator_unverifiable")
    observed = sender_preflight(sender, runtime, lambda args, rt: call(cli, rt, args))
    require(environment.get("ORCA_PANE_KEY") == observed["tabId"] + ":" + observed["leafId"],
            "monitor_operator_terminal_unverifiable")
    return observed


def validate_action_result(result_ref, checkpoint_ref, action, config, contract, root):
    result = parse(result_pin(result_ref, config, contract, root, document=True))
    require(set(result) == {"action_id", "checkpoint", "status", "evidence"}
            and result["action_id"] == action["id"] and result["checkpoint"] == checkpoint_ref
            and result["status"] == "executed" and isinstance(result["evidence"], list)
            and result["evidence"], "tui_executed_action_evidence_required")
    for ref in result["evidence"]:
        result_pin(ref, config, contract, root)
    return result


def step(config_ref, checkpoint_ref, *, mode, result_ref=None, action_seconds=60, call=native):
    require(mode in ("enqueue", "claim", "settle", "operator-settle"), "tui_continuation_mode_invalid")
    require((mode in ("settle", "operator-settle")) == (result_ref is not None), "tui_result_pin_required")
    config, contract, root = load(config_ref)
    if "execution" in config:
        from startup_execution import can_send
        can_send(config)  # Action admission, independent of whether mode permits automatic sends.
    require(mode != "enqueue" or "scheduler" not in config, "tui_enqueue_owned_by_scheduler")
    # Domain checker/provenance must be audited before invoking this structural adapter.
    # An immutable projection keeps the repository's operational schema unchanged.
    record, route = validate_checkpoint(checkpoint_ref, config, contract)
    domain = record["domain_check"]
    action = record["checkpoint"]["next_action"]
    if mode == "operator-settle":
        require("scheduler" in config and route.kind == "operator_handoff"
                and action["owner"] == "outer-operator", "tui_no_operator_handoff")
    else:
        require(route.kind == "coordinator_turn" or ("scheduler" in config and route.kind == "dependency_wait"),
                "tui_no_continuation_action")
    key = digest(canonical(action["id"]))
    with try_bound_lock(root, config_ref, "tui-continuation") as acquired:
        if not acquired:
            return {"state": "retryable", "reason": "tui_continuation_lock_busy", "retryable": True,
                    "committed": False, "execute_action": False, "retry_mode": mode,
                    "retry_after_seconds": 1,
                    "next_step": ("retry_same_settle_without_reexecuting_or_ack" if mode in ("settle", "operator-settle")
                                  else "retry_same_command_before_action")}
        load(config_ref)
        if "execution" in config:
            can_send(config)
        if mode != "settle":
            require(read_json(config["checkpoint_head"]) == checkpoint_ref, "tui_checkpoint_superseded")
        if mode == "operator-settle":
            sender = scheduler_sender_fence(config, contract, call)
        else:
            freshness(contract, fence(contract, call), config["deadline"])
        state_path = root / "outbox.json"
        state = read_outbox(root)
        entries = state["actions"]
        entry = entries.get(key)
        if mode == "operator-settle":
            validate_action_result(result_ref, checkpoint_ref, action, config, contract, root)
        if entry is None:
            require(mode in ("enqueue", "operator-settle"), "tui_continuation_not_enqueued")
            entry = prepare_entry(state, checkpoint_ref, record, root)
        require(entry["checkpoint"] == checkpoint_ref, "tui_action_id_reused_or_checkpoint_changed")
        if mode == "operator-settle":
            require(entry["result"] in (None, result_ref), "tui_action_result_changed")
            if entry["result"] is not None:
                require(entry["attempted"] is True and entry["claimed_at"] is not None
                        and isinstance(entry["delivery"], dict)
                        and entry["delivery"].get("kind") == "operator_handoff"
                        and entry["delivery"].get("sender") == config["scheduler"],
                        "tui_operator_handoff_settlement_invalid")
                return {"state": "operator_settled", "execute_action": False,
                        "result": result_ref, "business_processed": "operator_handoff_declared_executed_requires_domain_audit"}
            require(entry["attempted"] is False and entry["delivery"] is None
                    and entry["claimed_at"] is None, "tui_operator_handoff_conflicting_outbox")
            pinned(checkpoint_ref)
            load(config_ref)
            require(read_json(config["checkpoint_head"]) == checkpoint_ref, "tui_checkpoint_superseded")
            scheduler_sender_fence(config, contract, call)
            pinned(checkpoint_ref)
            validate_domain(record, contract, config)
            validate_action_result(result_ref, checkpoint_ref, action, config, contract, root)
            entry["attempted"] = True
            entry["delivery"] = {"kind": "operator_handoff", "sender": config["scheduler"],
                                 "settled_at": now()}
            entry["claimed_at"] = now()
            entry["result"] = result_ref
            replace_json(state_path, state)
            return {"state": "operator_settled", "execute_action": False,
                    "result": result_ref, "sender": sender,
                    "business_processed": "operator_handoff_declared_executed_requires_domain_audit"}
        if mode == "settle":
            require(entry["claimed_at"] is not None, "tui_action_not_claimed")
            result = validate_action_result(result_ref, checkpoint_ref, action, config, contract, root)
            require(entry["result"] in (None, result_ref), "tui_action_result_changed")
            # Pin revalidation and caller check immediately before the local commit.
            pinned(checkpoint_ref)
            load(config_ref)
            evidence = fence(contract, call)
            pinned(checkpoint_ref)
            validate_domain(record, contract, config)
            result_pin(result_ref, config, contract, root, document=True)
            for ref in result["evidence"]:
                result_pin(ref, config, contract, root)
            freshness(contract, evidence, config["deadline"])
            entry["result"] = result_ref
            replace_json(state_path, state)
            return {"state": "settled", "execute_action": False, "result": result_ref,
                    "business_processed": "declared_executed_requires_domain_audit"}
        if entry["claimed_at"]:
            return {"state": "already_claimed", "execute_action": False,
                    "business_processed": "unknown", "request_id": entry["request_id"]}
        if entry["delivery"] is None:
            require("scheduler" not in config, "tui_scheduler_delivery_unconfirmed")
            def pre_send():
                require(mode == "enqueue", "tui_continuation_not_enqueued")
                pinned(checkpoint_ref)
                evidence, delivery_runtime = fence_with_runtime(contract, call)
                pinned(checkpoint_ref)
                load(config_ref)
                validate_domain(record, contract, config)
                require(read_json(config["checkpoint_head"]) == checkpoint_ref, "tui_checkpoint_superseded")
                freshness(contract, evidence, config["deadline"])
                return delivery_runtime
            deliver_entry(config_ref, config, contract, root, state, entry, record, call, pre_send)
        execute = mode == "claim"
        if execute:
            load(config_ref)
            pinned(checkpoint_ref)
            pinned(domain["source"])
            pinned(domain["receipt"])
            evidence = fence(contract, call)
            pinned(checkpoint_ref)
            load(config_ref)
            validate_domain(record, contract, config, current=True)
            require(read_json(config["checkpoint_head"]) == checkpoint_ref, "tui_checkpoint_superseded")
            timing = freshness(contract, evidence, config["deadline"])
            require(timestamp(evidence["observed_at"]) > timestamp(entry["delivery"]["enqueued_at"]),
                    "tui_continuation_new_real_turn_required")
            require(action_window(timing, action_seconds)["action_allowed"],
                    "tui_action_window_insufficient")
            entry["claimed_at"] = now()
            replace_json(state_path, state)  # At-most-once claim; not proof of action completion.
        return {"state": "claimed" if execute else "enqueued", "execute_action": execute,
                "request_id": entry["request_id"], "delivery": entry["delivery"],
                "business_processed": "unknown", "action": action if execute else None}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("check", "turn-end", "enqueue", "claim", "settle",
                                         "operator-settle", "apply-review-clear"))
    parser.add_argument("--action-seconds", type=float)
    for name in ("config", "config-sha256"):
        parser.add_argument("--" + name, required=True)
    for name in ("checkpoint", "checkpoint-sha256"):
        parser.add_argument("--" + name)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--result")
    parser.add_argument("--result-sha256")
    parser.add_argument("--review-clear")
    parser.add_argument("--review-clear-sha256")
    args = parser.parse_args(argv)
    try:
        config_ref = {"path": args.config, "sha256": args.config_sha256}
        if args.mode in ("check", "turn-end"):
            require(not any((args.execute, args.checkpoint, args.checkpoint_sha256,
                             args.result, args.result_sha256, args.review_clear,
                             args.review_clear_sha256)), "tui_check_read_only_arguments_required")
            if args.mode == "turn-end":
                require(args.action_seconds is None, "tui_turn_end_read_only_arguments_required")
                from coordinator_tui_turn_end import turn_end
                result = turn_end(config_ref)
            else:
                from blocking_io import run as bounded_io
                result = bounded_io(lambda: check(config_ref, action_seconds=args.action_seconds),
                                    seconds=CHECK_IO_SECONDS, name="tui_check")
            print(json.dumps(result, ensure_ascii=False))
            if result.get("ok") is False or result.get("action_allowed") is False:
                return 2
            return 0
        if args.mode == "apply-review-clear":
            require(args.action_seconds is None and not any((args.checkpoint, args.checkpoint_sha256,
                    args.result, args.result_sha256)), "tui_review_clear_arguments")
            require(args.execute, "tui_explicit_execute_required")
            require(bool(args.review_clear) and bool(args.review_clear_sha256),
                    "tui_scheduler_review_clear_pin_required")
            result = apply_review_clear(config_ref,
                {"path": args.review_clear, "sha256": args.review_clear_sha256})
            print(json.dumps(result, ensure_ascii=False))
            return 75 if result.get("retryable") is True else 0
        require(args.action_seconds is None or args.mode == "claim", "tui_action_seconds_claim_only")
        require(args.execute, "tui_explicit_execute_required")
        require(bool(args.checkpoint) and bool(args.checkpoint_sha256), "tui_checkpoint_pin_required")
        require(bool(args.result) == bool(args.result_sha256)
                and (bool(args.result) == (args.mode in ("settle", "operator-settle"))),
                "tui_result_pin_required")
        require(not any((args.review_clear, args.review_clear_sha256)), "tui_review_clear_arguments")
        result = step(config_ref,
                      {"path": args.checkpoint, "sha256": args.checkpoint_sha256}, mode=args.mode,
                      result_ref={"path": args.result, "sha256": args.result_sha256} if args.result else None,
                      action_seconds=60 if args.action_seconds is None else args.action_seconds)
        print(json.dumps(result, ensure_ascii=False))
        return 75 if result.get("retryable") is True else 0
    except (OSError, ValueError, KeyError, TypeError, AttributeError, subprocess.SubprocessError) as exc:
        result = failure(exc, "tui_continuation_stopped_preserve_receipts")
        from blocking_io import BlockingIOTimeout
        if isinstance(exc, BlockingIOTimeout):
            result["diagnostics"] = exc.details
        print(json.dumps(result))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

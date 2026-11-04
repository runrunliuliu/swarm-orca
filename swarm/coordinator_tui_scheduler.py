"""One monitor tick of the strict TUI goal loop; no process launch or executor.

The existing Operator monitor owns the loop. The existing continuation journal
owns action deduplication. This adapter only joins completed provider turns to
domain checkpoints and the Operator's native Run-mailbox sender.
"""

import os
import uuid

from coordinator_io import (try_bound_lock, canonical, digest, file_ref, now, parse, pinned, publish_new, read_json,
                            replace_json, timestamp)
from coordinator_tui_checkpoint import validate_checkpoint
from coordinator_tui_continue import (WORKFLOW_PROTOCOL, cancel_unsent, deliver_entry, load, prepare_entry, read_outbox,
                                      read_scheduler_journal, persist_scheduler_review_stop,
                                      active_scheduler_stop, applicable_scheduler_review_clear,
                                      scheduler_review,
                                      scheduler_review_is_cleared, validate_next_scheduled_action,
                                      validate_scheduler_progress, validate_transition)
from coordinator_tui_errors import require
from coordinator_tui_dependencies import wait_spec
from trae_tui import observe
from terminal_idle_wait import IdleWaitResult, idle_wait_args


class WaitNotReady(Exception):
    """A validated wait outcome, not an identity, query, or send failure."""

    def __init__(self, result):
        super().__init__(result.reason)
        self.result = result

    def status(self, phase):
        state = ("interaction_required" if self.result.state == "interaction_required" else
                 "awaiting_real_turn_end" if phase == "initial" else "reobserving")
        return {"state": state, "reason": self.result.reason, "phase": phase}


def completed(contract, call):
    c, o = contract["coordinator"], contract["observation"]

    def observe_completed_turn():
        return observe(cli=contract["cli"]["path"], runtime=contract["runtime"], terminal=c["terminal"],
            incarnation=c["incarnation"], workspace=contract["workspace"]["id"], cwd=contract["workspace"]["path"],
            profile=o["profile"], caller_receipt=o["caller_receipt"], log_root=o["log_root"], roots=o["roots"],
            trae_runtime_config=contract["runtime_config"]["path"], expected_thread=c["session"],
            context_max_age_seconds=contract["freshness"]["context_max_age_seconds"],
            startup_anchor=o["startup_anchor"], completed_turn=True)

    idle = call(idle_wait_args(c["terminal"]), contract["runtime"])
    require(isinstance(idle, IdleWaitResult) and idle.state in
            ("ready", "pending", "interaction_required"), "tui_idle_state_unavailable")
    if idle.state == "ready":
        return observe_completed_turn()
    if idle.state == "pending" and idle.reason == "tui_idle_timeout":
        observed = observe_completed_turn()
        if observed is not None:
            return observed
    if idle.state != "ready":
        raise WaitNotReady(idle)


def dependencies(record, snapshot):
    """Exact domain-pinned dependencies, not unrelated task/artifact changes."""
    spec = wait_spec(record["checkpoint"]["next_action"])
    workers = {w["dispatch"]: w for w in snapshot["workers"]}
    jobs = snapshot.get("jobs", {})
    require(all(k in workers for k in spec["dispatches"]) and all(k in jobs for k in spec["jobs"]),
            "tui_wait_dependency_unknown")
    facts = {"workers": [workers[k] for k in sorted(spec["dispatches"])],
             "jobs": {k: jobs[k] for k in sorted(spec["jobs"])}}
    attention = (any(w.get("dispatch_status") in ("completed", "failed", "cancelled")
                     or w.get("state") in ("completed", "failed", "cancelled") for w in facts["workers"])
                 or any(j["status"] not in ("running", "queued", "submitted") for j in facts["jobs"].values()))
    return facts, attention


def pending_mailbox(config, contract, call):
    """Filter before limiting; delivered-but-unacked batches still count as pending."""
    run = contract["run"]["id"]
    limit = config.data["inbox_limit"]
    reply = call(["orchestration", "inbox", "--terminal", "run:" + run,
                  "--pending", "--limit", str(limit)], contract["runtime"])
    require(reply.get("filter") == {"mode": "pending", "terminal": "run:" + run,
                                     "deliveryContract": "current_delivery"},
            "tui_pending_inbox_unsupported_or_scope_mismatch")
    rows = reply.get("messages")
    require(isinstance(rows, list) and type(reply.get("count")) is int
            and reply["count"] == len(rows) and len(rows) <= limit, "tui_pending_inbox_invalid")
    for row in rows:
        require(isinstance(row, dict) and row.get("run_id") == run
                and row.get("to_handle") == "run:" + run
                and row.get("delivery_contract") == "current_delivery"
                and type(row.get("read")) is int and row["read"] == 0, "tui_pending_inbox_invalid")
    return rows


def quiet_mailbox(config, contract, call):
    return not pending_mailbox(config, contract, call)


def checkpoint_from_completed_turn(source, turn):
    require(isinstance(source.get("observed_at"), str), "tui_checkpoint_turn_timestamp_required")
    require(isinstance(turn, dict) and all(isinstance(turn.get(k), str)
            for k in ("context_at", "completed_at")), "tui_completed_turn_invalid")
    return (timestamp(turn["context_at"]) <= timestamp(source["observed_at"])
            <= timestamp(turn["completed_at"]) <= timestamp(now()))


def validate_settlement_entry(entry, config, contract, *, require_checkpoint=None):
    """Validate a completed outbox entry by exact pins, not by result presence."""
    require(entry["attempted"] is True and entry["delivery"] is not None
            and entry["claimed_at"] is not None and entry["result"] is not None,
            "tui_scheduler_invalid_settlement")
    if require_checkpoint is not None:
        require(entry["checkpoint"] == require_checkpoint, "tui_action_id_reused_or_checkpoint_changed")
    record, route = validate_checkpoint(entry["checkpoint"], config, contract)
    delivery = entry["delivery"]
    if route.kind == "operator_handoff":
        require(isinstance(delivery, dict) and set(delivery) == {"kind", "sender", "settled_at"}
                and delivery["kind"] == "operator_handoff"
                and delivery["sender"] == config.get("scheduler")
                and isinstance(delivery["settled_at"], str)
                and timestamp(delivery["settled_at"]) <= timestamp(now()),
                "tui_scheduler_invalid_settlement")
    else:
        require(not (isinstance(delivery, dict) and delivery.get("kind") == "operator_handoff"),
                "tui_scheduler_invalid_settlement")
    result = parse(pinned(entry["result"]))
    require(set(result) == {"action_id", "checkpoint", "status", "evidence"}
            and result["action_id"] == record["checkpoint"]["next_action"]["id"]
            and result["checkpoint"] == entry["checkpoint"]
            and result["status"] == "executed"
            and isinstance(result["evidence"], list) and result["evidence"],
            "tui_scheduler_invalid_settlement")
    for ref in result["evidence"]:
        pinned(ref)
    return record, result


def validate_settled_history(state, config, contract):
    for key in state["order"]:
        entry = state["actions"][key]
        if entry["result"] is not None:
            validate_settlement_entry(entry, config, contract)


def settled_entry_for_head(state, config, contract, head):
    """Return the exact settled current-head entry, if one exists."""
    record, _ = validate_checkpoint(head, config, contract)
    action = record["checkpoint"].get("next_action")
    key = digest(canonical(action["id"])) if action else None
    entry = state["actions"].get(key) if key else None
    if entry is None or entry["result"] is None or entry["checkpoint"] != head:
        return None
    record, result = validate_settlement_entry(entry, config, contract, require_checkpoint=head)
    _, route = validate_checkpoint(head, config, contract)
    return {"key": key, "entry": entry, "record": record, "route": route, "result": result}


def settled_observation_for_head(state, config, contract, head):
    """Return the exact settled current-head observation, if one exists."""
    settled = settled_entry_for_head(state, config, contract, head)
    if settled is None:
        return None
    entry = settled["entry"]
    return {"state": "settled_checkpoint_observed", "checkpoint": head,
            "result": entry["result"]}


def operator_review_request(journal, ref, config, contract, head, settled):
    """Create or validate the durable review request for a settled Operator handoff."""
    require(settled["route"].kind == "operator_handoff", "tui_operator_review_wrong_route")
    action = settled["record"]["checkpoint"]["next_action"]
    entry = settled["entry"]
    request = {"schema_version": 1,
               "kind": "coordinator-operator-result-review-request",
               "config": ref,
               "checkpoint": head,
               "action_id": action["id"],
               "action_key": settled["key"],
               "result": entry["result"],
               "outbox_delivery": entry["delivery"],
               "run": {"id": contract["run"]["id"],
                       "generation": contract["run"]["generation"]},
               "coordinator": {"terminal": contract["coordinator"]["terminal"],
                               "incarnation": contract["coordinator"]["incarnation"],
                               "session": contract["coordinator"]["session"]},
               "request_id": str(uuid.uuid4()),
               "attempted": False,
               "delivery": None}
    reviews = journal.setdefault("operator_review", {})
    existing = reviews.get(settled["key"])
    if existing is None:
        reviews[settled["key"]] = request
        return request, True
    comparable = dict(existing)
    comparable["request_id"] = request["request_id"]
    comparable["attempted"] = False
    comparable["delivery"] = None
    require(comparable == request, "tui_operator_review_binding_changed")
    return existing, False


def deliver_operator_review(monitor, ref, config, contract, root, journal, journal_path,
                            head, settled, call):
    """Enqueue exactly one Coordinator review request for a settled Operator result."""
    request, created = operator_review_request(journal, ref, config, contract, head, settled)
    if request["delivery"] is not None:
        return {"state": "awaiting_operator_result_review", "checkpoint": head,
                "result": request["result"], "delivery": request["delivery"]}
    monitor.revalidate()
    load(ref)
    state = read_outbox(root)
    latest = settled_entry_for_head(state, config, contract, head)
    require(latest is not None and latest["key"] == settled["key"],
            "tui_operator_review_binding_changed")
    stop = active_scheduler_stop(journal, head)
    require(stop is None or stop.get("route") == "operator_handoff", "tui_scheduler_stopped")
    require(read_json(config["checkpoint_head"]) == head, "tui_checkpoint_superseded")
    from operator_monitor import fence
    fence(monitor, call)
    if not quiet_mailbox(monitor, contract, call):
        if created:
            replace_json(journal_path, journal)
        return {"state": "awaiting_native_mail_processing"}
    if request["attempted"]:
        reply = call(["orchestration", "request-show", "--request", request["request_id"]],
                     contract["runtime"])
        require(reply.get("requestId") == request["request_id"] and reply.get("state") == "completed"
                and reply.get("method") == "orchestration.send", "tui_send_requires_reconciliation")
        reply = reply.get("receipt", {})
    else:
        from startup_execution import require_send
        require_send(config)
        request["attempted"] = True
        replace_json(journal_path, journal)
        payload = {"kind": "coordinator_tui_operator_result_review_v1", "request": request}
        body = ("Review the already-settled Operator handoff result in this same Coordinator. "
                "Do not replay the Operator action. Run coordinator_tui_workflow.py "
                "operator-review-begin with the config pins, review the pinned result/evidence, "
                "publish a domain-checked next checkpoint, then run operator-review-finish with "
                "the result, next checkpoint, processed batch and receipt pins. ACK only the whole "
                "review delivery batch; do not consume later mail in the same turn.")
        require_send(config)
        reply = call(["orchestration", "send", "--to", "run:" + contract["run"]["id"],
                      "--run", contract["run"]["id"], "--type", "status",
                      "--subject", "Coordinator operator result review " + settled["key"],
                      "--body", body, "--payload", canonical(payload).decode(),
                      "--retry-request", request["request_id"]], contract["runtime"])
    message = reply.get("message", {})
    require(reply.get("mutation", {}).get("requestId") == request["request_id"]
            and message.get("run_id") == contract["run"]["id"]
            and message.get("to_handle") == "run:" + contract["run"]["id"]
            and message.get("from_handle") == config["scheduler"]["terminal"]
            and isinstance(message.get("id"), str) and message["id"],
            "tui_send_receipt_mismatch")
    request["delivery"] = {"message_id": message["id"], "enqueued_at": now()}
    replace_json(journal_path, journal)
    return {"state": "operator_result_review_enqueued", "checkpoint": head,
            "result": request["result"], "delivery": request["delivery"]}


def accepted_submission(journal, entry, config, contract, root, config_ref):
    """Validate the immutable closeout, independently of its mutable turn-end audit."""
    ref = journal.get("accepted_receipt")
    if ref is None:
        return None
    from coordinator_tui_workflow import ack_confirmed, processed_batch
    receipt = parse(pinned(ref))
    delivery, ack = receipt.get("delivery"), receipt.get("ack")
    require(receipt.get("schema_version") == 2 and receipt.get("kind") == "coordinator-delivery-submission"
            and journal.get("config") == receipt.get("config") == config_ref
            and journal.get("checkpoint") == receipt.get("checkpoint") == entry["checkpoint"]
            and journal.get("request_id") == receipt.get("request_id") == entry["request_id"]
            and journal.get("recovery") == receipt.get("recovery")
            and receipt.get("result") == entry["result"]
            and receipt.get("receipt_path") == ref["path"]
            and journal.get("finish") == {k: receipt.get(k) for k in
                ("result", "next_checkpoint", "processed", "receipt_path")}
            and isinstance(delivery, dict) and isinstance(ack, dict)
            and journal.get("consume", {}).get("reply") == delivery
            and journal.get("ack", {}).get("reply") == ack,
            "tui_workflow_projection_invalid")
    processed_batch(receipt["processed"], entry["result"], delivery, entry, config, contract, root)
    ack_confirmed(ack, delivery["deliveryId"], contract["run"]["id"])
    return ref


def unsubmitted_settlement(state, config, contract, root, config_ref):
    if config.get("turn_protocol") != WORKFLOW_PROTOCOL:
        return None
    for key in state["order"]:
        entry = state["actions"][key]
        # Operator handoffs have a separate result-review workflow, unchanged.
        if entry["result"] is None or entry["delivery"].get("kind") == "operator_handoff":
            continue
        target = root / ("workflow-" + key + ".json")
        journal = read_json(target) if os.path.lexists(target) else {}
        if accepted_submission(journal, entry, config, contract, root, config_ref) is None:
            return entry
    return None


def workflow_projection_for_head(state, config, contract, root, config_ref, head):
    """Accept only a completed Coordinator delivery workflow as head provenance.

    A workflow-finish retry can publish the already prevalidated next checkpoint
    after ACK without that checkpoint's source timestamp falling inside the latest
    provider completed-turn envelope. This is narrower than historical recovery:
    it requires the settled outbox entry, exact workflow journal, immutable receipt,
    ACK confirmation, and turn-end receipt to all bind the same next checkpoint.
    """
    for key in state["order"]:
        entry = state["actions"][key]
        if entry["result"] is None:
            continue
        _, result = validate_settlement_entry(entry, config, contract)
        candidates = [
            (root / ("workflow-" + digest(canonical(result["action_id"])) + ".json"),
             "coordinator-delivery-submission" if config.get("turn_protocol") == WORKFLOW_PROTOCOL
             else "coordinator-delivery-workflow"),
            (root / ("operator-review-workflow-" + key + ".json"),
             "coordinator-operator-result-review-workflow"),
        ]
        for target, kind in candidates:
            if not os.path.lexists(target):
                continue
            journal = read_json(target)
            receipt_ref = journal.get("completed_receipt") if isinstance(journal, dict) else None
            if receipt_ref is None:
                continue
            receipt = parse(pinned(receipt_ref))
            if receipt.get("next_checkpoint") != head:
                continue
            delivery = receipt.get("delivery")
            ack = receipt.get("ack")
            submission = kind == "coordinator-delivery-submission"
            turn_end = journal.get("submission_audit") if submission else receipt.get("turn_end")
            if submission:
                require(accepted_submission(journal, entry, config, contract, root, config_ref) == receipt_ref,
                        "tui_workflow_projection_invalid")
            require(journal.get("config") == config_ref
                    and journal.get("checkpoint") == entry["checkpoint"]
                    and journal.get("completed_receipt") == receipt_ref,
                    "tui_workflow_projection_invalid")
            require(receipt.get("kind") == kind
                    and receipt.get("config") == config_ref
                    and receipt.get("checkpoint") == entry["checkpoint"]
                    and receipt.get("result") == entry["result"],
                    "tui_workflow_projection_invalid")
            if kind in ("coordinator-delivery-workflow", "coordinator-delivery-submission"):
                require(journal.get("request_id") == entry["request_id"]
                        and receipt.get("request_id") == entry["request_id"],
                        "tui_workflow_projection_invalid")
            else:
                require(journal.get("action_key") == key
                        and journal.get("result") == entry["result"]
                        and isinstance(journal.get("request_id"), str)
                        and receipt.get("action_key") == key
                        and receipt.get("request_id") == journal.get("request_id"),
                        "tui_workflow_projection_invalid")
            require(isinstance(delivery, dict) and isinstance(delivery.get("deliveryId"), str)
                    and delivery["deliveryId"]
                    and isinstance(delivery.get("messages"), list),
                    "tui_workflow_projection_invalid")
            require(isinstance(ack, dict) and ack.get("runId") == contract["run"]["id"]
                    and ack.get("acknowledged") == delivery["deliveryId"]
                    and not ack.get("waitInterrupted") and not ack.get("cancelled")
                    and not ack.get("connectionLost") and not ack.get("timedOut")
                    and type(ack.get("hasOutstandingDelivery")) is bool
                    and isinstance(ack.get("messages"), list) and type(ack.get("count")) is int
                    and ack["count"] == len(ack["messages"]),
                    "tui_workflow_projection_ack_unconfirmed")
            require(isinstance(turn_end, dict) and turn_end.get("ok") is True
                    and turn_end.get("state") == "turn_end_checked"
                    and turn_end.get("checkpoint") == head
                    and turn_end.get("outcome") == "scheduler_will_check_real_turn_end",
                    "tui_workflow_projection_turn_end_invalid")
            marker = turn_end.get("scheduler_head_current_turn_validation")
            require(marker in (None, "prevalidated_delivery_workflow"),
                    "tui_workflow_projection_turn_end_invalid")
            return {"kind": kind, "receipt": receipt_ref,
                    "checkpoint": entry["checkpoint"], "result": entry["result"]}
    return None


def historical_turn_binding(journal, head, source):
    require(isinstance(journal, dict) and isinstance(journal.get("turns"), dict),
            "tui_checkpoint_historical_turn_binding_missing")
    for turn_id, item in journal["turns"].items():
        if not isinstance(item, dict) or item.get("checkpoint") != head:
            continue
        observation = item.get("observation")
        turn = observation.get("completed_turn") if isinstance(observation, dict) else None
        if isinstance(turn, dict) and checkpoint_from_completed_turn(source, turn):
            return {"turn_id": turn_id, "observation": observation}
    require(False, "tui_checkpoint_historical_turn_binding_missing")


def historical_observation_snapshot(config, contract, root, config_ref, *, state=None,
                                    journal=None, head=None, cleared_stop=None,
                                    require_review_clear=True):
    """Classify a non-current checkpoint that is valid history but not sendable now.

    This is an observe-only recovery predicate. It never sends, claims, ACKs,
    consumes inbox, rewrites the head, or treats a review clear as freshness.
    """
    state = read_outbox(root) if state is None else state
    journal = read_scheduler_journal(root, config_ref) if journal is None else journal
    head = read_json(config["checkpoint_head"]) if head is None else head
    record, _ = validate_checkpoint(head, config, contract)
    source = parse(pinned(record["domain_check"]["source"]))
    require(isinstance(source.get("observed_at"), str), "tui_checkpoint_turn_timestamp_required")
    from startup_execution import startup_gate
    gate = startup_gate(config)
    require(timestamp(source["observed_at"]) >= timestamp(gate["completed_at"]),
            "tui_checkpoint_predates_dispatch_gate")
    validate_settled_history(state, config, contract)
    action = record["checkpoint"]["next_action"]
    key = digest(canonical(action["id"])) if action else None
    existing = state["actions"].get(key)
    pending = [e for e in state["actions"].values() if e["result"] is None]
    require(len(pending) <= 1, "tui_outbox_invalid")
    require(not pending, "tui_pending_continuation_exists")
    observed = settled_observation_for_head(state, config, contract, head)
    if observed is not None:
        return observed
    if require_review_clear:
        require(cleared_stop is not None and cleared_stop["review"]["checkpoint"] == head,
                "tui_checkpoint_historical_review_required")
    binding = historical_turn_binding(journal, head, source)
    validate_transition(state, record)
    return {"state": "awaiting_fresh_checkpoint", "checkpoint": head,
            "reason": "historical_checkpoint_not_sendable",
            "historical_turn": binding["turn_id"]}


class ReobserveBeforeSend(Exception):
    """A proven pre-send race, never a native send or identity failure."""


def turn_changed(contract, call, observe_turn, ended):
    after = observe_turn(contract, call)
    if after is None:
        return True
    require(after["thread_id"] == contract["coordinator"]["session"], "tui_provider_session_changed")
    return after["completed_turn"] != ended["completed_turn"]


def incomplete_continuation(ref, config, contract, root, entry, ended):
    """Record an ended post-delivery turn without submission; never resend/claim.

    Diagnostic evidence is immutable and does not block the original Coordinator
    from later reconciling/submitting. A pre-delivery, busy, or ambiguous turn is
    not evidence that this particular continuation was left unfinished.
    """
    waiting = {"state": "awaiting_continuation", "delivery": entry["delivery"]}
    if config.get("turn_protocol") != WORKFLOW_PROTOCOL:
        return waiting
    turn = ended["completed_turn"]
    require(all(isinstance(turn.get(k), str) and turn[k]
                for k in ("turn_id", "context_at", "completed_at")), "tui_completed_turn_invalid")
    require(timestamp(turn["context_at"]) <= timestamp(turn["completed_at"]) <= timestamp(now()),
            "tui_completed_turn_invalid")
    if timestamp(turn["context_at"]) <= timestamp(entry["delivery"]["enqueued_at"]):
        return waiting
    item = dict(schema_version=1, kind="coordinator-incomplete-turn", config=ref,
                checkpoint=entry["checkpoint"], request_id=entry["request_id"], delivery=entry["delivery"],
                run=contract["run"], coordinator=contract["coordinator"], observation=ended)
    key = digest(canonical([entry["request_id"], turn["turn_id"]]))
    target = root / ("incomplete-turn-" + key + ".json")
    if os.path.lexists(target):
        saved = read_json(target)
        # Hook counters/observation metadata can advance for the same completed
        # turn. Preserve the first snapshot; bind retries to stable turn evidence.
        require({k: v for k, v in saved.items() if k != "observation"}
                == {k: v for k, v in item.items() if k != "observation"}
                and saved["observation"]["completed_turn"] == turn
                and saved["observation"]["thread_id"] == ended["thread_id"],
                "tui_incomplete_turn_evidence_changed")
    else:
        publish_new(target, item)
    return dict(state="continuation_incomplete", reason="tui_workflow_submission_missing",
                receipt=file_ref(target), checkpoint=entry["checkpoint"], execute_action=False,
                execution_status=("settled_submission_missing" if entry["result"] is not None else
                                  "unknown" if entry["claimed_at"] is not None else "not_claimed"),
                automatic_replay=False, recovery="original_coordinator_reconcile_without_replay")


def schedule(monitor, snapshot, call, *, observe_turn=completed):
    from operator_monitor import fence

    def observe_fenced(contract, call):
        try:
            result = observe_turn(contract, call)
        except WaitNotReady:
            # timeout has no handle/incarnation in its envelope. Even a normal
            # wait must not hide retirement or replacement during that wait.
            fence(monitor, call)
            raise
        fence(monitor, call)
        return result

    ref = monitor.data["continuation"]
    config, contract, root = load(ref)
    require(config.get("scheduler") == monitor.data["sender"], "tui_scheduler_binding_invalid")
    from startup_execution import can_send, unknown_sends
    if not can_send(config):
        require(not unknown_sends(config, monitor.root), "startup_isolation_send_unknown")
        return {"state": "observation_only", "execution_mode": config["execution"]["mode"],
                "automatic_sends_allowed": False, "autonomous_wait_ready": False}

    # Keep the continuation lock to state transitions only. Provider observation
    # can wait on the TUI and inspect logs; holding this lock there would starve
    # the live Coordinator's claim/settle/finish path after a delivered action.
    with try_bound_lock(root, ref, "tui-continuation") as acquired:
        if not acquired:
            return {"state": "reobserving", "reason": "tui_continuation_lock_busy"}
        state = read_outbox(root)
        journal_path = root / "scheduler.json"
        journal = read_scheduler_journal(root, ref) or {
            "config": ref, "stop": None, "waits": {}, "turns": {}}
        current_head = read_json(config["checkpoint_head"])
        stop = active_scheduler_stop(journal, current_head)
        cleared_stop = (applicable_scheduler_review_clear(journal, config, contract, root, ref)
                        if stop is not None else None)
        if stop is not None and cleared_stop is None:
            if stop.get("route") == "operator_handoff":
                settled = settled_entry_for_head(state, config, contract, current_head)
                if settled is not None:
                    return deliver_operator_review(monitor, ref, config, contract, root, journal,
                                                   journal_path, current_head, settled, call)
            return stop
        pending = [e for e in state["actions"].values() if e["result"] is None]
        require(len(pending) <= 1, "tui_outbox_invalid")
        if (pending and pending[0]["delivery"] is not None
                and current_head == pending[0]["checkpoint"]
                and config.get("turn_protocol") != WORKFLOW_PROTOCOL):
            return {"state": "awaiting_continuation", "delivery": pending[0]["delivery"]}

    fence(monitor, call)
    try:
        ended = observe_fenced(contract, call)
    except WaitNotReady as exc:
        return exc.status("initial")
    if ended is None:
        return {"state": "awaiting_real_turn_end"}
    require(ended["thread_id"] == contract["coordinator"]["session"], "tui_provider_session_changed")
    turn = ended["completed_turn"]
    head = read_json(config["checkpoint_head"])
    try:
        changed = turn_changed(contract, call, observe_fenced, ended)
    except WaitNotReady as exc:
        return exc.status("recheck")
    if changed or read_json(config["checkpoint_head"]) != head:
        return {"state": "reobserving", "reason": "tui_observation_changed"}

    with try_bound_lock(root, ref, "tui-continuation") as acquired:
        if not acquired:
            return {"state": "reobserving", "reason": "tui_continuation_lock_busy"}
        state = read_outbox(root)
        journal_path = root / "scheduler.json"
        journal = read_scheduler_journal(root, ref) or {
            "config": ref, "stop": None, "waits": {}, "turns": {}}
        pending = [e for e in state["actions"].values() if e["result"] is None]
        require(len(pending) <= 1, "tui_outbox_invalid")
        current_head = read_json(config["checkpoint_head"])
        stop = active_scheduler_stop(journal, current_head)
        cleared_stop = (applicable_scheduler_review_clear(journal, config, contract, root, ref)
                        if stop is not None else None)
        if stop is not None and cleared_stop is None:
            if stop.get("route") == "operator_handoff":
                settled = settled_entry_for_head(state, config, contract, current_head)
                if settled is not None:
                    return deliver_operator_review(monitor, ref, config, contract, root, journal,
                                                   journal_path, current_head, settled, call)
            return stop
        if (pending and pending[0]["delivery"] is not None
                and current_head == pending[0]["checkpoint"]):
            return incomplete_continuation(ref, config, contract, root, pending[0], ended)
        if current_head != head:
            return {"state": "reobserving", "reason": "tui_observation_changed"}
        record, route = validate_checkpoint(head, config, contract)
        source = parse(pinned(record["domain_check"]["source"]))
        from startup_execution import startup_gate
        gate = startup_gate(config)
        require(timestamp(source["observed_at"]) >= timestamp(gate["completed_at"]),
                "tui_checkpoint_predates_dispatch_gate")
        validate_settled_history(state, config, contract)
        unfinished = unsubmitted_settlement(state, config, contract, root, ref)
        if unfinished is not None:
            return incomplete_continuation(ref, config, contract, root, unfinished, ended)
        pending = [e for e in state["actions"].values() if e["result"] is None]
        require(len(pending) <= 1, "tui_outbox_invalid")
        require(not any(e["claimed_at"] for e in pending), "tui_scheduler_unsettled_action")
        action = record["checkpoint"]["next_action"]
        key = digest(canonical(action["id"])) if action else None
        existing = state["actions"].get(key)
        settled = settled_entry_for_head(state, config, contract, head)
        if settled is not None:
            if settled["route"].kind == "operator_handoff":
                return deliver_operator_review(monitor, ref, config, contract, root, journal,
                                               journal_path, head, settled, call)
            return settled_observation_for_head(state, config, contract, head)
        current_turn_checkpoint = checkpoint_from_completed_turn(source, turn)
        workflow_projection = None if current_turn_checkpoint else workflow_projection_for_head(
            state, config, contract, root, ref, head)
        if not current_turn_checkpoint and workflow_projection is None:
            require(cleared_stop is not None and cleared_stop["review"]["checkpoint"] == head,
                    "tui_checkpoint_not_from_completed_turn")
            return historical_observation_snapshot(config, contract, root, ref, state=state,
                journal=journal, head=head, cleared_stop=cleared_stop)
        # Pin a real turn to one checkpoint, across crashes and monitor restarts.
        previous = journal["turns"].get(turn["turn_id"])
        require(previous is None or previous["checkpoint"] == head, "tui_completed_turn_checkpoint_changed")
        if previous is None:
            item = {"checkpoint": head, "observation": ended}
            if workflow_projection is not None:
                item["provenance"] = workflow_projection
            journal["turns"][turn["turn_id"]] = item
        replace_json(journal_path, journal)
        # Restart may find an intent persisted before the pre-send check ran. Do
        # this only after proving the head is from the current completed turn, so
        # historical observations cannot accidentally consume or rewrite old work.
        cancel_unsent(state, root, "reobserve_unsent_intent")
        progress = validate_scheduler_progress(state, record)
        pending = [e for e in state["actions"].values() if e["result"] is None]
        require(len(pending) <= 1, "tui_outbox_invalid")
        require(not any(e["claimed_at"] for e in pending), "tui_scheduler_unsettled_action")
        existing = state["actions"].get(key)
        if pending:
            require(existing == pending[0] and existing["checkpoint"] == head, "tui_pending_continuation_exists")
            if existing["delivery"] is not None:
                require(timestamp(turn["completed_at"]) <= timestamp(existing["delivery"]["enqueued_at"]),
                        "tui_scheduler_continuation_not_processed")
                return {"state": "awaiting_continuation", "delivery": existing["delivery"]}
        else:
            validate_next_scheduled_action(state, record)
        if not (existing and existing["attempted"]) and not quiet_mailbox(monitor, contract, call):
            return {"state": "awaiting_native_mail_processing"}
        review = scheduler_review(head, route, progress)
        if review is not None:
            cleared_review = scheduler_review_is_cleared(journal, review, config, contract, root, ref)
            if cleared_review is None:
                return persist_scheduler_review_stop(journal, root, review)
        if route.kind == "dependency_wait" and existing is None:
            facts, attention = dependencies(record, snapshot)
            wait_key = digest(canonical(head))
            before = journal["waits"].get(wait_key)
            if before is None:
                journal["waits"][wait_key] = facts
                replace_json(journal_path, journal)
            if not attention and (before is None or before == facts):
                return {"state": "waiting_dependencies", "checkpoint": head}

        def pre_send():
            monitor.revalidate()
            load(ref)
            validate_checkpoint(head, config, contract)
            fence(monitor, call)
            if turn_changed(contract, call, observe_fenced, ended):
                raise ReobserveBeforeSend("tui_turn_changed_before_send")
            if read_json(config["checkpoint_head"]) != head:
                raise ReobserveBeforeSend("tui_checkpoint_superseded")
            if not quiet_mailbox(monitor, contract, call):
                raise ReobserveBeforeSend("tui_mail_arrived_before_send")

        entry = prepare_entry(state, head, record, root)
        # Receipt lookup must use the same Operator identity as the original send.
        native = lambda cli, runtime, args: call(args, runtime)
        try:
            deliver_entry(ref, config, contract, root, state, entry, record, native, pre_send)
        except WaitNotReady as exc:
            cancel_unsent(state, root, str(exc))
            return exc.status("pre_send")
        except ReobserveBeforeSend as exc:
            cancel_unsent(state, root, str(exc))
            return {"state": "reobserving", "reason": str(exc)}
        return {"state": "continuation_enqueued", "checkpoint": head, "delivery": entry["delivery"]}

"""Original-Coordinator Delivery workflow. No business executor or automatic PASS.

begin derives the action from the outbox and consumes/claims it. submit (opt-in
workflow-v2) validates the whole batch, settles, ACKs without consuming new mail,
publishes the checked head and records acceptance before auditing turn-end.
finish retains legacy semantics unless opted in. Native mutation intents survive
crashes; unknown outcomes are reconciled by request ID, never blindly replayed.
"""

import argparse
import os
from pathlib import Path
import subprocess
import uuid

from coordinator_io import (canonical, digest, directory_lock, file_ref, now, parse,
                            pinned, publish_new, read_json, replace_json, timestamp)
from coordinator_tui_checkpoint import validate_checkpoint
from coordinator_tui_continue import (WORKFLOW_PROTOCOL, check, load, read_outbox, result_pin, step,
                                      read_scheduler_journal, persist_scheduler_review_stop,
                                      active_scheduler_stop, applicable_scheduler_review_clear,
                                      scheduler_review, scheduler_review_is_cleared,
                                      validate_action_result,
                                      validate_next_scheduled_action, validate_scheduler_progress)
from coordinator_tui_errors import failure, require
from coordinator_tui_turn_end import turn_end
from trae_coordinator import native


def action_entry(state, checkpoint):
    entries = [e for e in state["actions"].values() if e["checkpoint"] == checkpoint]
    require(len(entries) == 1, "tui_workflow_action_missing")
    return entries[0]


def require_scheduler_available(schedule, config, contract, root, config_ref):
    require(schedule is not None, "tui_scheduler_stopped")
    stop = active_scheduler_stop(schedule, read_json(config["checkpoint_head"]))
    if stop is not None:
        require(applicable_scheduler_review_clear(schedule, config, contract, root, config_ref) is not None,
                "tui_scheduler_stopped")


def mutation(journal, target, name, args, contract, call):
    """Intent before native call; only a matching durable receipt can recover it."""
    intent = journal.setdefault(name, {"request_id": str(uuid.uuid4()), "attempted": False,
                                       "reply": None, "args": args})
    require(intent["args"] == args, "tui_workflow_mutation_changed")
    if intent["reply"] is not None:
        return intent["reply"]
    cli, runtime = contract["cli"]["path"], contract["runtime"]
    if intent["attempted"]:
        shown = call(cli, runtime, ["orchestration", "request-show", "--request", intent["request_id"]])
        require(shown.get("requestId") == intent["request_id"] and shown.get("state") == "completed"
                and shown.get("method") == "orchestration.check", "tui_workflow_native_outcome_unknown")
        reply = shown.get("receipt", {})
    else:
        intent["attempted"] = True
        replace_json(target, journal)
        reply = call(cli, runtime, [*args, "--retry-request", intent["request_id"]])
    require(reply.get("runId") == contract["run"]["id"], "tui_workflow_wrong_run")
    intent["reply"] = reply
    replace_json(target, journal)
    return reply


def delivery_ids(delivery, run):
    rows = delivery.get("messages")
    require(delivery.get("runId") == run and isinstance(delivery.get("deliveryId"), str)
            and delivery["deliveryId"] and isinstance(rows, list) and rows
            and type(delivery.get("count")) is int and delivery["count"] == len(rows)
            and all(isinstance(row, dict) and isinstance(row.get("id"), str) and row["id"]
                    for row in rows), "tui_workflow_delivery_invalid")
    ids = [row["id"] for row in rows]
    require(len(set(ids)) == len(ids), "tui_workflow_delivery_invalid")
    return ids


def ack_confirmed(ack, delivery, run):
    # Native persists an interrupted ACK before later routing/consumer checks.
    # That is evidence of ACK only, not a successful whole check operation.
    require(ack.get("runId") == run and ack.get("acknowledged") == delivery
            and not ack.get("waitInterrupted") and not ack.get("cancelled")
            and not ack.get("connectionLost") and not ack.get("timedOut")
            and type(ack.get("hasOutstandingDelivery")) is bool
            and isinstance(ack.get("messages"), list) and type(ack.get("count")) is int
            and ack["count"] == len(ack["messages"]), "tui_workflow_ack_unconfirmed")


def processed_batch_for_message(processed_ref, result_ref, delivery, message_id, config, contract, root):
    ids = delivery_ids(delivery, contract["run"]["id"])
    processed = parse(result_pin(processed_ref, config, contract, root, document=True))
    rows = processed.get("messages")
    require(set(processed) == {"delivery_id", "messages"}
            and processed["delivery_id"] == delivery["deliveryId"] and isinstance(rows, list)
            and all(isinstance(row, dict) and set(row) == {"id", "evidence"}
                    and isinstance(row["id"], str) and isinstance(row["evidence"], list)
                    and row["evidence"] for row in rows)
            and len(rows) == len(ids) and {row["id"] for row in rows} == set(ids),
            "tui_workflow_whole_delivery_evidence_required")
    for row in rows:
        for ref in row["evidence"]:
            result_pin(ref, config, contract, root)
    own = next(row for row in rows if row["id"] == message_id)
    require(result_ref in own["evidence"], "tui_workflow_action_result_required")


def processed_batch(processed_ref, result_ref, delivery, entry, config, contract, root):
    processed_batch_for_message(processed_ref, result_ref, delivery,
                                entry["delivery"]["message_id"], config, contract, root)


def operator_review_requests(schedule, config, contract, root, config_ref, *, checkpoint=None):
    require(schedule is not None and isinstance(schedule.get("operator_review"), dict),
            "tui_operator_review_missing")
    state = read_outbox(root)
    requests = schedule["operator_review"]
    head = read_json(config["checkpoint_head"]) if checkpoint is None else checkpoint
    matches = []
    for key, request in requests.items():
        if request["checkpoint"] != head:
            continue
        entry = state["actions"].get(key)
        if entry is None:
            continue
        record, _ = validate_checkpoint(head, config, contract)
        action = record["checkpoint"]["next_action"]
        validate_action_result(request["result"], head, action, config, contract, root)
        require(entry["checkpoint"] == head and entry["result"] == request["result"]
                and entry["delivery"] == request["outbox_delivery"]
                and request["action_id"] == action["id"]
                and request["run"] == {"id": contract["run"]["id"],
                                      "generation": contract["run"]["generation"]}
                and request["coordinator"] == {"terminal": contract["coordinator"]["terminal"],
                                               "incarnation": contract["coordinator"]["incarnation"],
                                               "session": contract["coordinator"]["session"]},
                "tui_operator_review_binding_changed")
        require(entry["attempted"] is True and entry["claimed_at"] is not None,
                "tui_operator_review_unsettled")
        matches.append((key, request, entry, record))
    require(len(matches) == 1, "tui_operator_review_missing")
    return matches[0]


def operator_review_processed_batch(processed_ref, result_ref, delivery, request, config, contract, root):
    processed_batch_for_message(processed_ref, result_ref, delivery,
                                request["delivery"]["message_id"], config, contract, root)


def operator_review_begin(config_ref, *, action_seconds=60, call=native):
    config, contract, root = load(config_ref)
    require("scheduler" in config, "tui_workflow_requires_scheduler")
    checked = check(config_ref, action_seconds=action_seconds, call=call)
    require(checked["action_allowed"], "tui_action_window_insufficient")
    with directory_lock(root, "tui-workflow"):
        require(not any(os.path.lexists(root / name) for name in ("STOP", "monitor-stop.json")),
                "tui_workflow_persistent_stop")
        schedule = read_scheduler_journal(root, config_ref)
        key, request, entry, record = operator_review_requests(schedule, config, contract, root, config_ref)
        stop = active_scheduler_stop(schedule, request["checkpoint"])
        require(stop is None or stop.get("route") == "operator_handoff", "tui_scheduler_stopped")
        require(request["delivery"] is not None, "tui_operator_review_delivery_unconfirmed")
        target = root / ("operator-review-workflow-" + key + ".json")
        journal = read_json(target) if os.path.lexists(target) else dict(
            schema_version=1, config=config_ref, checkpoint=request["checkpoint"],
            action_key=key, request_id=request["request_id"], result=request["result"])
        require(journal.get("config") == config_ref and journal.get("checkpoint") == request["checkpoint"]
                and journal.get("action_key") == key and journal.get("request_id") == request["request_id"]
                and journal.get("result") == request["result"], "tui_workflow_binding_changed")
        require(read_json(config["checkpoint_head"]) == request["checkpoint"], "tui_checkpoint_superseded")
        delivery = mutation(journal, target, "consume", ["orchestration", "check", "--run",
                            contract["run"]["id"]], contract, call)
        ids = delivery_ids(delivery, contract["run"]["id"])
        require(request["delivery"]["message_id"] in ids, "tui_workflow_other_delivery_first")
        return {"state": "operator_result_review_ready", "execute_action": False,
                "checkpoint": request["checkpoint"], "result": request["result"],
                "workflow": file_ref(target), "delivery_id": delivery["deliveryId"],
                "message_ids": ids, "batch": delivery,
                "next_step": "review_pinned_operator_result_then_finish_with_new_checkpoint"}


def operator_review_finish(config_ref, result_ref, next_ref, processed_ref, receipt_path, *, call=native):
    config, contract, root = load(config_ref)
    require("scheduler" in config, "tui_workflow_requires_scheduler")
    checked = check(config_ref, call=call)
    receipt = Path(receipt_path)
    result = parse(result_pin(result_ref, config, contract, root, document=True))
    require(set(result) == {"action_id", "checkpoint", "status", "evidence"}
            and result["status"] == "executed" and isinstance(result["evidence"], list)
            and result["evidence"], "tui_executed_action_evidence_required")
    for ref in result["evidence"]:
        result_pin(ref, config, contract, root)
    require(receipt.is_absolute() and receipt.parent.resolve(strict=True) == receipt.parent
            and any(receipt.is_relative_to(Path(r)) for r in contract["observation"]["roots"])
            and not receipt.is_relative_to(root) and str(receipt) != config["checkpoint_head"],
            "tui_workflow_receipt_outside_scope")
    with directory_lock(root, "tui-workflow"):
        require(not any(os.path.lexists(root / name) for name in ("STOP", "monitor-stop.json")),
                "tui_workflow_persistent_stop")
        schedule = read_scheduler_journal(root, config_ref)
        key, request, entry, old_record = operator_review_requests(
            schedule, config, contract, root, config_ref, checkpoint=result["checkpoint"])
        require(result_ref == request["result"], "tui_workflow_action_result_required")
        action = old_record["checkpoint"]["next_action"]
        validate_action_result(result_ref, request["checkpoint"], action, config, contract, root)
        target = root / ("operator-review-workflow-" + key + ".json")
        journal = read_json(target)
        require(journal.get("config") == config_ref and journal.get("checkpoint") == request["checkpoint"]
                and journal.get("action_key") == key and journal.get("request_id") == request["request_id"]
                and journal.get("result") == result_ref, "tui_workflow_binding_changed")
        delivery = journal["consume"]["reply"]
        operator_review_processed_batch(processed_ref, result_ref, delivery, request, config, contract, root)
        scope = dict(result=result_ref, next_checkpoint=next_ref, processed=processed_ref,
                     receipt_path=str(receipt))
        saved_finish = journal.get("finish")
        require(saved_finish is None or saved_finish == scope, "tui_workflow_finish_changed")
        ack_before = False
        if saved_finish == scope:
            ack_entry = journal.get("ack")
            ack = ack_entry.get("reply") if isinstance(ack_entry, dict) else None
            if ack is not None:
                ack_confirmed(ack, delivery["deliveryId"], contract["run"]["id"])
                ack_before = True
        if os.path.lexists(receipt):
            saved = read_json(receipt)
            require(saved.get("kind") == "coordinator-operator-result-review-workflow"
                    and saved.get("config") == config_ref and saved.get("checkpoint") == request["checkpoint"]
                    and saved.get("request_id") == request["request_id"]
                    and saved.get("delivery") == delivery
                    and all(saved.get(k) == v for k, v in scope.items()), "tui_workflow_receipt_changed")
        journal["finish"] = scope
        record, route = validate_checkpoint(next_ref, config, contract, current=True)
        source = parse(pinned(record["domain_check"]["source"]))
        if not ack_before:
            require(timestamp(checked["freshness"]["context_observed_at"])
                    <= timestamp(source["observed_at"]) <= timestamp(now()),
                    "tui_checkpoint_not_from_current_turn")
        else:
            require(timestamp(source["observed_at"]) <= timestamp(now()),
                    "tui_checkpoint_not_from_current_turn")
        from startup_execution import startup_gate
        require(timestamp(startup_gate(config)["completed_at"])
                <= timestamp(source["observed_at"]), "tui_checkpoint_predates_dispatch_gate")
        projected = parse(canonical(read_outbox(root)))
        validate_next_scheduled_action(projected, record)
        review = scheduler_review(next_ref, route, validate_scheduler_progress(projected, record))
        cleared_review = scheduler_review_is_cleared(schedule, review, config, contract, root, config_ref)
        if review is not None and "reason" in review and cleared_review is None:
            require(schedule is not None, "tui_scheduler_stopped")
            persist_scheduler_review_stop(schedule, root, review)
            require(False, "tui_scheduler_no_acceptance_progress")
        require(read_json(config["checkpoint_head"]) in (request["checkpoint"], next_ref),
                "tui_checkpoint_superseded")
        replace_json(target, journal)
        check(config_ref, call=call)
        operator_review_processed_batch(processed_ref, result_ref, delivery, request, config, contract, root)
        validate_checkpoint(next_ref, config, contract, current=True)
        ack = mutation(journal, target, "ack", ["orchestration", "check", "--run", contract["run"]["id"],
                       "--ack", delivery["deliveryId"], "--peek"], contract, call)
        ack_confirmed(ack, delivery["deliveryId"], contract["run"]["id"])
        from coordinator_io import try_bound_lock
        with try_bound_lock(root, config_ref, "tui-continuation") as acquired:
            if not acquired:
                return dict(state="retryable", retryable=True, execute_action=False,
                            next_step="retry_same_operator_review_finish_without_replay", retry_after_seconds=1)
            check(config_ref, call=call)
            validate_checkpoint(next_ref, config, contract, current=True)
            require(read_json(config["checkpoint_head"]) in (request["checkpoint"], next_ref),
                    "tui_checkpoint_superseded")
            replace_json(Path(config["checkpoint_head"]), next_ref)
        audit = turn_end(config_ref, prevalidated_scheduler_head=next_ref if ack_before else None, call=call)
        if not audit["ok"]:
            return audit
        completed = dict(schema_version=1, kind="coordinator-operator-result-review-workflow",
                         config=config_ref, checkpoint=request["checkpoint"], action_key=key,
                         request_id=request["request_id"], delivery=delivery, **scope,
                         ack=ack, turn_end=audit, completed_at=now())
        if os.path.lexists(receipt):
            saved = read_json(receipt)
            require(all(saved.get(k) == completed[k] for k in completed if k not in ("completed_at", "turn_end")),
                    "tui_workflow_receipt_changed")
        else:
            publish_new(receipt, completed)
        journal["completed_receipt"] = file_ref(receipt)
        replace_json(target, journal)
        return dict(ok=True, state="turn_end_checked", receipt=file_ref(receipt), execute_action=False,
                    business_acceptance="requires_independent_review", runtime_end_hook=False)


def recovery_boundary(ref, config_ref, entry, call):
    if ref is not None:
        from operator_monitor_recovery import coordinator_boundary
        coordinator_boundary(ref, config_ref, entry, call)


def begin(config_ref, *, action_seconds=60, recovery_ref=None, call=native):
    from operator_continuity_route import require_permit
    require_permit(recovery_ref)
    config, contract, root = load(config_ref)
    require("scheduler" in config, "tui_workflow_requires_scheduler")
    require(recovery_ref is None or config.get("turn_protocol") != WORKFLOW_PROTOCOL,
            "recovery_workflow_v2_not_supported")
    checked = check(config_ref, action_seconds=action_seconds, call=call)
    require(checked["action_allowed"], "tui_action_window_insufficient")
    with directory_lock(root, "tui-workflow"):
        schedule = read_scheduler_journal(root, config_ref)
        require_scheduler_available(schedule, config, contract, root, config_ref)
        require(not any(os.path.lexists(root / name) for name in ("STOP", "monitor-stop.json")),
                "tui_workflow_persistent_stop")
        state = read_outbox(root)
        pending = [e for e in state["actions"].values() if e["result"] is None]
        require(len(pending) == 1, "tui_workflow_requires_one_pending_action")
        entry = pending[0]
        recovery_boundary(recovery_ref, config_ref, entry, call)
        require(entry["attempted"] and entry["delivery"], "tui_scheduler_delivery_unconfirmed")
        checkpoint = entry["checkpoint"]
        record, _ = validate_checkpoint(checkpoint, config, contract)
        key = digest(canonical(record["checkpoint"]["next_action"]["id"]))
        target = root / ("workflow-" + key + ".json")
        journal = read_json(target) if os.path.lexists(target) else dict(
            schema_version=1, config=config_ref, checkpoint=checkpoint, request_id=entry["request_id"],
            recovery=recovery_ref)
        require(journal.get("config") == config_ref and journal.get("checkpoint") == checkpoint
                and journal.get("request_id") == entry["request_id"]
                and journal.get("recovery") == recovery_ref, "tui_workflow_binding_changed")
        require(read_json(config["checkpoint_head"]) == checkpoint, "tui_checkpoint_superseded")
        delivery = mutation(journal, target, "consume", ["orchestration", "check", "--run",
                            contract["run"]["id"]], contract, call)
        ids = delivery_ids(delivery, contract["run"]["id"])
        require(entry["delivery"]["message_id"] in ids, "tui_workflow_other_delivery_first")
        claimed = step(config_ref, checkpoint, mode="claim", action_seconds=action_seconds, call=call)
        return {**claimed, "checkpoint": checkpoint, "workflow": file_ref(target),
                "delivery_id": delivery["deliveryId"], "message_ids": ids, "batch": delivery,
                "next_step": ("execute_only_if_claimed_then_submit_with_whole_batch_evidence"
                              if config.get("turn_protocol") == WORKFLOW_PROTOCOL else
                              "execute_only_if_claimed_then_finish_with_whole_batch_evidence")}


def submission_status(config_ref, config, journal, target, receipt, next_ref, call):
    """Submission acceptance is durable; readiness to yield is a separate observation.

    Called only after validating the exact scope, settlement and native ACK. A
    retry must never move a newer head backwards, nor reinterpret an old result
    as the completion of a newer turn. No failed audit revokes accepted evidence.
    """
    ref = file_ref(receipt)
    require(journal.get("accepted_receipt") in (None, ref), "tui_workflow_receipt_changed")
    journal["accepted_receipt"] = ref
    replace_json(target, journal)
    result = dict(submission_accepted=True, receipt=ref, execute_action=False,
                  business_acceptance="requires_independent_review", runtime_end_hook=False)
    if read_json(config["checkpoint_head"]) != next_ref:
        return dict(result, ok=True, state="submission_already_accepted", turn_end=None,
                    next_step="inspect_current_head_without_replaying_or_republishing_old_result")
    try:
        audit = turn_end(config_ref, prevalidated_scheduler_head=next_ref, call=call)
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as exc:
        audit = failure(exc, "tui_submission_accepted_audit_requires_reconciliation")
    journal["submission_audit"] = audit
    if audit.get("ok"):
        journal["completed_receipt"] = ref
    else:
        journal.pop("completed_receipt", None)
    replace_json(target, journal)
    return dict(result, ok=audit.get("ok") is True,
                state="submitted" if audit.get("ok") else "submitted_followup_required", turn_end=audit)


def submit(config_ref, result_ref, next_ref, processed_ref, receipt_path, *, recovery_ref=None, call=native):
    """Explicit v2 entry: model supplies decisions/evidence, program closes delivery."""
    config, _, _ = load(config_ref)
    require(config.get("turn_protocol") == WORKFLOW_PROTOCOL, "tui_submit_requires_workflow_v2")
    return finish(config_ref, result_ref, next_ref, processed_ref, receipt_path,
                  recovery_ref=recovery_ref, call=call)


def finish(config_ref, result_ref, next_ref, processed_ref, receipt_path, *, recovery_ref=None, call=native):
    from operator_continuity_route import require_permit
    require_permit(recovery_ref)
    config, contract, root = load(config_ref)
    require("scheduler" in config, "tui_workflow_requires_scheduler")
    submission = config.get("turn_protocol") == WORKFLOW_PROTOCOL
    require(recovery_ref is None or not submission, "recovery_workflow_v2_not_supported")
    checked = check(config_ref, call=call)
    result = parse(result_pin(result_ref, config, contract, root, document=True))
    require(set(result) == {"action_id", "checkpoint", "status", "evidence"}
            and result["status"] == "executed" and isinstance(result["evidence"], list)
            and result["evidence"], "tui_executed_action_evidence_required")
    for ref in result["evidence"]:
        result_pin(ref, config, contract, root)
    checkpoint = result["checkpoint"]
    key = digest(canonical(result["action_id"]))
    target = root / ("workflow-" + key + ".json")
    receipt = Path(receipt_path)
    # A new immutable receipt outside control state, inside the approved roots.
    require(receipt.is_absolute() and receipt.parent.resolve(strict=True) == receipt.parent
            and any(receipt.is_relative_to(Path(r)) for r in contract["observation"]["roots"])
            and not receipt.is_relative_to(root) and str(receipt) != config["checkpoint_head"],
            "tui_workflow_receipt_outside_scope")
    with directory_lock(root, "tui-workflow"):
        require(not any(os.path.lexists(root / name) for name in ("STOP", "monitor-stop.json")),
                "tui_workflow_persistent_stop")
        schedule = read_scheduler_journal(root, config_ref)
        if not submission:
            require_scheduler_available(schedule, config, contract, root, config_ref)
        journal = read_json(target)
        require(journal.get("config") == config_ref and journal.get("checkpoint") == checkpoint,
                "tui_workflow_binding_changed")
        entry = action_entry(read_outbox(root), checkpoint)
        require(journal.get("recovery") == recovery_ref, "tui_workflow_binding_changed")
        recovery_boundary(recovery_ref, config_ref, entry, call)
        require(journal["request_id"] == entry["request_id"], "tui_workflow_binding_changed")
        delivery = journal["consume"]["reply"]
        processed_batch(processed_ref, result_ref, delivery, entry, config, contract, root)
        scope = dict(result=result_ref, next_checkpoint=next_ref, processed=processed_ref,
                     receipt_path=str(receipt))
        saved_finish = journal.get("finish")
        require(saved_finish is None or saved_finish == scope, "tui_workflow_finish_changed")
        finish_prevalidated = saved_finish == scope
        if os.path.lexists(receipt):
            saved = read_json(receipt)
            require(saved.get("kind") == ("coordinator-delivery-submission" if submission else
                                         "coordinator-delivery-workflow")
                    and saved.get("config") == config_ref and saved.get("checkpoint") == checkpoint
                    and saved.get("recovery") == recovery_ref and saved.get("delivery") == delivery
                    and all(saved.get(k) == v for k, v in scope.items()), "tui_workflow_receipt_changed")
        journal["finish"] = scope
        # Validate before first settlement/ACK, including transition and current-turn provenance.
        # If a prior invocation already persisted this finish scope and durably settled the
        # action, later retries only complete the same delivery closeout; they must not use a
        # newer TUI context as a reason to replay, ACK manually, or abandon the checked head.
        ack_before = False
        if finish_prevalidated and entry.get("result") == result_ref:
            ack_entry = journal.get("ack")
            ack = ack_entry.get("reply") if isinstance(ack_entry, dict) else None
            # A lost ACK reply may already have committed before a newer context
            # appeared. Reconcile only that attempted request, never issue a new ACK.
            if submission and ack is None and isinstance(ack_entry, dict) and ack_entry.get("attempted"):
                ack = mutation(journal, target, "ack", ["orchestration", "check", "--run",
                    contract["run"]["id"], "--ack", delivery["deliveryId"], "--peek"], contract, call)
            if ack is not None:
                ack_confirmed(ack, delivery["deliveryId"], contract["run"]["id"])
                ack_before = True
        record, route = validate_checkpoint(next_ref, config, contract, current=True)
        if submission and os.path.lexists(receipt):
            require(ack_before and saved.get("schema_version") == 2
                    and saved.get("ack") == ack and saved.get("request_id") == entry["request_id"],
                    "tui_workflow_receipt_changed")
            return submission_status(config_ref, config, journal, target, receipt, next_ref, call)
        source = parse(pinned(record["domain_check"]["source"]))
        if not ack_before:
            require(timestamp(checked["freshness"]["context_observed_at"])
                    <= timestamp(source["observed_at"]) <= timestamp(now()),
                    "tui_checkpoint_not_from_current_turn")
        else:
            require(timestamp(source["observed_at"]) <= timestamp(now()),
                    "tui_checkpoint_not_from_current_turn")
        from startup_execution import startup_gate
        require(timestamp(startup_gate(config)["completed_at"])
                <= timestamp(source["observed_at"]), "tui_checkpoint_predates_dispatch_gate")
        projected = parse(canonical(read_outbox(root)))
        action_entry(projected, checkpoint)["result"] = result_ref
        validate_next_scheduled_action(projected, record)
        review = scheduler_review(next_ref, route, validate_scheduler_progress(projected, record))
        cleared_review = scheduler_review_is_cleared(schedule, review, config, contract, root, config_ref)
        if submission:
            # A concurrent scheduler can have recorded this exact review after
            # head publication. Only close out the already ACKed, identical scope.
            if not (ack_before and review is not None
                    and active_scheduler_stop(schedule, next_ref) == review):
                require_scheduler_available(schedule, config, contract, root, config_ref)
        if not submission and review is not None and "reason" in review and cleared_review is None:
            require(schedule is not None, "tui_scheduler_stopped")
            persist_scheduler_review_stop(schedule, root, review)
            require(False, "tui_scheduler_no_acceptance_progress")
        require(read_json(config["checkpoint_head"]) in (checkpoint, next_ref), "tui_checkpoint_superseded")
        if not ack_before:
            replace_json(target, journal)
            settled = step(config_ref, checkpoint, mode="settle", result_ref=result_ref, call=call)
            if settled.get("retryable"):
                return settled
        check(config_ref, call=call)
        recovery_boundary(recovery_ref, config_ref, action_entry(read_outbox(root), checkpoint), call)
        processed_batch(processed_ref, result_ref, delivery, entry, config, contract, root)
        validate_checkpoint(next_ref, config, contract, current=True)
        ack = mutation(journal, target, "ack", ["orchestration", "check", "--run", contract["run"]["id"],
                       "--ack", delivery["deliveryId"], "--peek"], contract, call)
        ack_confirmed(ack, delivery["deliveryId"], contract["run"]["id"])
        # Never consume newly arrived mail as a side effect of ACK.
        from coordinator_io import try_bound_lock
        with try_bound_lock(root, config_ref, "tui-continuation") as acquired:
            if not acquired:
                return dict(state="retryable", retryable=True, execute_action=False,
                            next_step="retry_same_finish_without_action_replay", retry_after_seconds=1)
            check(config_ref, call=call)
            validate_checkpoint(next_ref, config, contract, current=True)
            require(read_json(config["checkpoint_head"]) in (checkpoint, next_ref), "tui_checkpoint_superseded")
            if submission:
                # A stop can arrive during native I/O. It must not be erased or
                # bypassed by publishing a different head after that observation.
                latest = read_scheduler_journal(root, config_ref)
                require(latest is not None, "tui_scheduler_stopped")
                if not (ack_before and review is not None
                        and active_scheduler_stop(latest, next_ref) == review):
                    require_scheduler_available(latest, config, contract, root, config_ref)
            replace_json(Path(config["checkpoint_head"]), next_ref)
            if submission:
                accepted = dict(schema_version=2, kind="coordinator-delivery-submission", config=config_ref,
                    checkpoint=checkpoint, request_id=entry["request_id"], delivery=delivery,
                    **scope, recovery=recovery_ref, ack=ack, submitted_at=now())
                publish_new(receipt, accepted)
                # Re-read under the writer lock; never overwrite a newer scheduler
                # journal with the snapshot captured before native I/O.
                if review is not None and scheduler_review_is_cleared(
                        latest, review, config, contract, root, config_ref) is None:
                    active = active_scheduler_stop(latest, next_ref)
                    require(active is None or active == review, "tui_scheduler_stopped")
                    persist_scheduler_review_stop(latest, root, review)
        if submission:
            return submission_status(config_ref, config, journal, target, receipt, next_ref, call)
        audit = turn_end(config_ref, prevalidated_scheduler_head=next_ref if ack_before else None, call=call)
        if not audit["ok"]:
            return audit
        completed = dict(schema_version=1, kind="coordinator-delivery-workflow", config=config_ref,
                         checkpoint=checkpoint, request_id=entry["request_id"], delivery=delivery,
                         **scope, recovery=recovery_ref, ack=ack, turn_end=audit, completed_at=now())
        if os.path.lexists(receipt):
            saved = read_json(receipt)
            require(all(saved.get(k) == completed[k] for k in completed if k not in ("completed_at", "turn_end")),
                    "tui_workflow_receipt_changed")
        else:
            publish_new(receipt, completed)
        journal["completed_receipt"] = file_ref(receipt)
        replace_json(target, journal)
        return dict(ok=True, state="turn_end_checked", receipt=file_ref(receipt), execute_action=False,
                    business_acceptance="requires_independent_review", runtime_end_hook=False)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("mode", choices=("begin", "submit", "finish", "operator-review-begin",
                                    "operator-review-finish"))
    for key in ("config", "config-sha256"):
        p.add_argument("--" + key, required=True)
    for key in ("result", "next", "processed"):
        p.add_argument("--" + key)
        p.add_argument("--" + key + "-sha256")
    p.add_argument("--receipt")
    p.add_argument("--recovery")
    p.add_argument("--recovery-sha256")
    p.add_argument("--action-seconds", type=float, default=60)
    p.add_argument("--execute", action="store_true")
    a = p.parse_args(argv)
    try:
        require(a.execute, "tui_explicit_execute_required")
        ref = dict(path=a.config, sha256=a.config_sha256)
        require(bool(a.recovery) == bool(a.recovery_sha256), "tui_workflow_recovery_pin_required")
        recovery = dict(path=a.recovery, sha256=a.recovery_sha256) if a.recovery else None
        if a.mode == "begin":
            require(not any((a.result, a.result_sha256, a.next, a.next_sha256, a.processed,
                             a.processed_sha256, a.receipt)), "tui_workflow_begin_arguments")
            result = begin(ref, action_seconds=a.action_seconds, recovery_ref=recovery)
        elif a.mode == "operator-review-begin":
            require(recovery is None and not any((a.result, a.result_sha256, a.next, a.next_sha256,
                    a.processed, a.processed_sha256, a.receipt)), "tui_workflow_begin_arguments")
            result = operator_review_begin(ref, action_seconds=a.action_seconds)
        elif a.mode in ("finish", "submit"):
            require(all((a.result, a.result_sha256, a.next, a.next_sha256, a.processed,
                         a.processed_sha256, a.receipt)), "tui_workflow_finish_arguments")
            handler = submit if a.mode == "submit" else finish
            result = handler(ref, dict(path=a.result, sha256=a.result_sha256),
                            dict(path=a.next, sha256=a.next_sha256),
                            dict(path=a.processed, sha256=a.processed_sha256), a.receipt, recovery_ref=recovery)
        else:
            require(recovery is None and all((a.result, a.result_sha256, a.next, a.next_sha256,
                    a.processed, a.processed_sha256, a.receipt)), "tui_workflow_finish_arguments")
            result = operator_review_finish(ref, dict(path=a.result, sha256=a.result_sha256),
                            dict(path=a.next, sha256=a.next_sha256),
                            dict(path=a.processed, sha256=a.processed_sha256), a.receipt)
        print(canonical(result).decode())
        return 75 if result.get("retryable") else 2 if result.get("ok") is False else 0
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as exc:
        print(canonical(failure(exc, "tui_workflow_stopped_preserve_receipts")).decode())
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

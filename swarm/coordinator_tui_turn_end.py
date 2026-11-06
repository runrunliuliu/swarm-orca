"""Non-consuming turn-end audit; no reminders, acknowledgements or business executor."""

from coordinator_io import canonical, digest, now, parse, pinned, read_json, timestamp
from coordinator_loop import transition
from coordinator_tui_checkpoint import validate_checkpoint
from coordinator_tui_continue import (active_scheduler_stop, applicable_scheduler_review_clear,
                                      check_with_runtime, load, read_outbox, read_scheduler_journal,
                                      scheduler_review, scheduler_review_is_cleared,
                                      validate_next_scheduled_action, validate_scheduler_progress)
from coordinator_tui_errors import require
from trae_coordinator import native
import observation_budget as budget


def turn_end(config_ref, *, prevalidated_scheduler_head=None, call=native):
    # Scope the function, not only the CLI: workflow.finish audits after ACK too.
    def query(cli, runtime, args):
        with budget.stage(budget.query_name(args)):
            return call(cli, runtime, args)
    with budget.scope():
        return _turn_end(config_ref, prevalidated_scheduler_head=prevalidated_scheduler_head,
                         call=query)


def _turn_end(config_ref, *, prevalidated_scheduler_head=None, call=native):
    with budget.stage("initial_fence"):
        checked, live_runtime = check_with_runtime(config_ref, call=call)
    with budget.stage("checkpoint"):
        config, contract, root = load(config_ref)
        scheduled = "scheduler" in config
        journal = read_scheduler_journal(root, config_ref) if scheduled else None
        head = read_json(config["checkpoint_head"])
        record, route = validate_checkpoint(head, config, contract, current=True)
        state = read_outbox(root)
    pending = [entry for entry in state["actions"].values() if entry["result"] is None]
    require(len(pending) <= 1, "tui_outbox_invalid")
    require(not any(entry["claimed_at"] is not None for entry in pending),
            "tui_turn_end_unsettled_action")
    # Reuse native pending-mail truth; old servers cannot prove this check.
    mailbox = call(contract["cli"]["path"], live_runtime,
                   ["orchestration", "check", "--run", contract["run"]["id"], "--peek"])
    require(mailbox.get("runId") == contract["run"]["id"]
            and type(mailbox.get("hasOutstandingDelivery")) is bool
            and isinstance(mailbox.get("messages"), list)
            and type(mailbox.get("count")) is int
            and mailbox["count"] == len(mailbox["messages"])
            and all(isinstance(message, dict) for message in mailbox["messages"]),
            "tui_turn_end_mailbox_state_unavailable")
    require(not mailbox["hasOutstandingDelivery"], "tui_turn_end_unprocessed_delivery")
    require(prevalidated_scheduler_head is None or scheduled,
            "tui_turn_end_prevalidated_scheduler_only")
    if scheduled:
        # Identity/freshness alone is not readiness to yield: an external or
        # duplicate message can start a new real turn with the old head intact.
        # Reject here while the Coordinator can still publish checked evidence;
        # the scheduler keeps its independent completed-turn safety fence.
        source = parse(pinned(record["domain_check"]["source"]))
        require(isinstance(source.get("observed_at"), str), "tui_checkpoint_turn_timestamp_required")
        if prevalidated_scheduler_head is None:
            require(timestamp(checked["freshness"]["context_observed_at"])
                    <= timestamp(source["observed_at"]) <= timestamp(now()),
                    "tui_checkpoint_not_from_current_turn")
        else:
            require(head == prevalidated_scheduler_head, "tui_checkpoint_superseded")
            require(timestamp(source["observed_at"]) <= timestamp(now()),
                    "tui_checkpoint_not_from_current_turn")
        from startup_execution import startup_gate
        gate = startup_gate(config)
        require(timestamp(gate["completed_at"]) <= timestamp(source["observed_at"]),
                "tui_checkpoint_predates_dispatch_gate")
        require(not pending, "tui_turn_end_pending_continuation")
        require(mailbox["count"] == 0, "tui_turn_end_pending_mail")
        validate_next_scheduled_action(state, record)
        progress = validate_scheduler_progress(state, record)
        stop = active_scheduler_stop(journal, head)
        persisted = stop is not None
        clear = (applicable_scheduler_review_clear(journal, config, contract, root, config_ref)
                 if persisted else None)
        current_review = scheduler_review(head, route, progress)
        persisted_blocks = persisted and clear is None
        if persisted_blocks:
            review = stop
        elif scheduler_review_is_cleared(journal, current_review, config, contract, root, config_ref) is not None:
            review = None
        else:
            review = current_review
        outcome = "scheduler_will_check_real_turn_end"
    elif route.kind == "coordinator_turn":
        action = record["checkpoint"]["next_action"]
        entry = state["actions"].get(digest(canonical(action["id"])))
        require(len(pending) == 1 and entry == pending[0] and entry["checkpoint"] == head,
                "tui_turn_end_continuation_required")
        delivery = entry["delivery"]
        require(entry["attempted"] is True and isinstance(delivery, dict)
                and isinstance(delivery.get("message_id"), str), "tui_send_requires_reconciliation")
        require(timestamp(delivery["enqueued_at"]) >=
                timestamp(checked["freshness"]["context_observed_at"]),
                "tui_turn_end_continuation_not_processed")
        require(any(message.get("id") == delivery["message_id"] for message in mailbox["messages"]),
                "tui_turn_end_continuation_wakeup_missing")
        outcome = "continuation_enqueued"
    else:
        require(not pending, "tui_turn_end_pending_continuation")
        require(mailbox["count"] == 0, "tui_turn_end_pending_mail")
        if state["order"]:
            previous = state["actions"][state["order"][-1]]
            before = parse(pinned(previous["checkpoint"]))["checkpoint"]
            result = parse(pinned(previous["result"]))
            for ref in result["evidence"]:
                pinned(ref)
            transition(before, record["checkpoint"], result, result["evidence"])
        # A declared barrier alone cannot attest an actual native dependency wakeup.
        require(route.decision != "wait", "tui_dependency_wakeup_requires_native_verification")
        require(route.decision in ("blocked", "complete"), "tui_turn_end_executor_handoff_required")
        outcome = "domain_review_required"
    readiness = None
    if scheduled and "startup_lifecycle" in config:
        from operator_readiness import for_continuation
        with budget.stage("readiness"):
            readiness = for_continuation(config_ref, call=lambda args, runtime, timeout:
                budget.call_with_timeout(call, contract["cli"]["path"], runtime, args, timeout))
    # Readiness performs native I/O too; retain the final context/head/journal
    # fence after that observation, not before it.
    with budget.stage("final_fence"):
        final, final_runtime = check_with_runtime(config_ref, call=call)
    require(final_runtime == live_runtime, "tui_turn_end_runtime_changed")
    validate_checkpoint(head, config, contract)
    require(read_json(config["checkpoint_head"]) == head and read_outbox(root) == state,
            "tui_turn_end_state_changed")
    if scheduled:
        require(read_scheduler_journal(root, config_ref) == journal, "tui_turn_end_state_changed")
    require(final["freshness"]["context_observed_at"] == checked["freshness"]["context_observed_at"],
            "tui_turn_end_context_changed")
    result = {"ok": True, "state": "turn_end_checked", "outcome": outcome,
            "decision": route.decision, "execute_action": False, "execution_authorized": False,
            "business_processed": "requires_domain_audit", "freshness": final["freshness"]}
    if scheduled:
        result.update(progress=progress, checkpoint=head, scheduler_stop_persisted=persisted,
                      scheduler_state_scope="continuation_journal_only_not_operator_monitor_stop")
        if prevalidated_scheduler_head is not None:
            result["scheduler_head_current_turn_validation"] = "prevalidated_delivery_workflow"
        if clear is not None:
            result["scheduler_review_clear"] = clear
        if review is not None:
            result["scheduler_review"] = review
            if persisted_blocks or "reason" in review:
                result.update(ok=False, state="review_required", outcome="scheduler_review_required",
                              error=review.get("reason", "tui_scheduler_stopped"),
                              recovery=("independent_review_required_preserve_config_journal_and_stop_no_reset"
                                        if persisted_blocks else
                                        "revalidate_domain_evidence_in_current_turn_no_automatic_met_or_stop_reset"))
        if readiness is not None:
            result.update(readiness=readiness, scheduler_state_scope="continuation_and_operator_monitor")
            if (route.kind in ("coordinator_turn", "dependency_wait")
                    and not readiness.get("legal_yield_ready", readiness["autonomous_wait_ready"]) and result["ok"]):
                result.update(ok=False, state="autonomy_not_ready", outcome="operator_readiness_required",
                              error=readiness.get("reason", "monitor_not_ready"),
                              recovery="operator_resume_same_startup_lifecycle_no_business_prompt_or_state_reset")
            if "execution" in config:
                result["execution_mode"] = config["execution"]["mode"]
                if result["ok"] and config["execution"]["mode"] != "autonomous":
                    result["outcome"] = ("designated_native_event_only" if config["execution"]["mode"] == "native-event"
                                         else "manual_non_autonomous_handoff")
    return result

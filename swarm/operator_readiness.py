"""Read-only startup/turn-end readiness. Liveness is not autonomous acceptance.

No lock creation, sends, ACKs, resets, or domain adapter fallback. A snapshot is
not a lease: the monitor and Coordinator retain their independent action fences.
"""

import subprocess

from coordinator_io import (canonical, digest, now, parse, pinned, read_json,
                            require, timestamp)
from coordinator_tui_checkpoint import validate_checkpoint
from coordinator_tui_continue import (active_scheduler_stop, applicable_scheduler_review_clear,
                                      load, read_outbox, read_scheduler_journal, scheduler_review,
                                      scheduler_review_is_cleared, validate_scheduler_progress)


def scheduler_health(scheduler):
    state = scheduler.get("state") if isinstance(scheduler, dict) else None
    ready = state in {
        "awaiting_real_turn_end", "awaiting_continuation", "awaiting_native_mail_processing",
        "waiting_dependencies", "continuation_enqueued",
        "operator_result_review_enqueued", "awaiting_operator_result_review"}
    return dict(ready=ready, state=state, bootstrap=state == "awaiting_real_turn_end",
                reason=None if ready else (state or "scheduler_status_missing"))


def unavailable(exc):
    # Export protocol codes only, never raw CLI bodies, paths or credentials.
    code = str(exc)
    safe = isinstance(exc, ValueError) and 0 < len(code) <= 100 and all(
        c in "abcdefghijklmnopqrstuvwxyz_" for c in code)
    return code if safe else ("readiness_evidence_missing" if isinstance(exc, FileNotFoundError)
                              else "readiness_observation_failed")


def continuation(ref):
    config, contract, root = load(ref)
    require(config["schema_version"] == 2, "readiness_scheduler_required")
    require(read_json(root / "tui-continuation-binding.json") == ref,
            "readiness_continuation_binding_changed")
    head = read_json(config["checkpoint_head"])
    record, route = validate_checkpoint(head, config, contract)
    source = parse(pinned(record["domain_check"]["source"]))
    from startup_execution import startup_gate
    gate = startup_gate(config)
    require(isinstance(source.get("observed_at"), str)
            and timestamp(gate["completed_at"]) <= timestamp(source["observed_at"]) <= timestamp(now()),
            "readiness_checkpoint_timestamp_invalid")
    state, journal = read_outbox(root), read_scheduler_journal(root, ref)
    from coordinator_tui_scheduler import validate_settled_history
    validate_settled_history(state, config, contract)
    progress = validate_scheduler_progress(state, record)
    review = scheduler_review(head, route, progress)
    if scheduler_review_is_cleared(journal, review, config, contract, root, ref) is not None:
        review = None
    stop = active_scheduler_stop(journal, head)
    if stop is not None and applicable_scheduler_review_clear(journal, config, contract, root, ref) is None:
        review = stop
    unknown = any(e["attempted"] and e["delivery"] is None for e in state["actions"].values())
    executable = route.kind in ("coordinator_turn", "dependency_wait")
    ready = executable and review is None and not unknown
    return dict(continuation_ready=True, checkpoint=head, decision=route.decision,
                eligible=ready, review=review,
                reason=("tui_send_requires_reconciliation" if unknown else
                        "scheduler_review_required" if review or not executable else None),
                snapshot=digest(canonical(dict(head=head, outbox=state, scheduler=journal))))


def check(continuation_ref, plan_ref, *, call=None):
    """Use live deployment proof AND current checkpoint/journal, not cached milestones."""
    result = dict(ok=False, state="not_ready", continuation_ready=False, monitor_ready=False,
                  runtime_ready=False, legal_yield_ready=False, acceptance_complete=False,
                  autonomous_wait_ready=False, autonomy_verified=False,
                  autonomy_verification="requires_independent_live_acceptance", next_owner="operator",
                  observed_at=now())
    try:
        before = continuation(continuation_ref)
        result.update(continuation_ready=True, continuation=before)
        from operator_monitor_deploy import validate, verify
        _, config = validate(plan_ref)
        require(config.data["continuation"] == continuation_ref, "readiness_deployment_continuation_changed")
        proof = verify(plan_ref, call=call)
        after = continuation(continuation_ref)
        require(after == before, "readiness_continuation_changed_during_observation")
        health = proof["scheduler_readiness"]
        continuation_config, contract, _ = load(continuation_ref)
        from startup_execution import policy, event_ready, unknown_sends, can_send
        execution = policy(continuation_config)
        if execution is not None:
            can_send(continuation_config)  # Current owner health even in observation-only modes.
        if execution is not None and execution["mode"] != "autonomous":
            require(proof["scheduler_readiness"]["state"] == "observation_only", "startup_observation_not_ready")
            result.update(monitor=proof, monitor_ready=True, execution_mode=execution["mode"],
                          automatic_sends_allowed=False)
            require(not unknown_sends(continuation_config, config.root), "startup_isolation_send_unknown")
            if execution["mode"] == "native-event":
                result["trigger_readiness"] = event_ready(continuation_config, contract)
            require(continuation(continuation_ref) == before, "readiness_continuation_changed_during_observation")
            ready = before["eligible"]
            result.update(ok=ready, state="runtime_ready" if ready else "not_ready", monitor=proof,
                          monitor_ready=True, runtime_ready=ready, legal_yield_ready=ready,
                          execution_mode=execution["mode"], autonomous_wait_ready=False,
                          automatic_sends_allowed=False, bootstrap=False, reason=before["reason"],
                          next_owner="coordinator" if ready else "operator", missing=[] if ready else [before["reason"]])
            return result
        ready = before["eligible"] and health["ready"]
        result.update(ok=ready, state="monitor_ready" if ready else "not_ready", monitor=proof,
                      monitor_ready=ready, autonomous_wait_ready=ready,
                      bootstrap=health["bootstrap"], reason=before["reason"] or health["reason"],
                      next_owner="coordinator" if ready else "operator")
        result.update(runtime_ready=ready, legal_yield_ready=ready,
                      execution_mode="autonomous" if execution else "historical")
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as exc:
        result["reason"] = unavailable(exc)
    result["missing"] = ([] if result["runtime_ready"] else [result.get("reason") or "monitor_not_ready"])
    return result


def for_continuation(config_ref, *, call=None):
    """Opted-in continuations cannot silently fall back when publication is absent."""
    config, _, _ = load(config_ref)
    require("startup_lifecycle" in config, "readiness_lifecycle_required")
    from operator_startup import load as load_startup, read_state
    from coordinator_io import file_ref
    plan, _, _, _ = load_startup(config["startup_lifecycle"])
    state = None
    try:
        state = read_state(plan, config["startup_lifecycle"])
        deployment_ref = file_ref(plan["deployment_dir"] + "/deployment.json")
        require(state["deployment"] == deployment_ref and state["continuation"] == config_ref,
                "readiness_lifecycle_deployment_changed")
        from operator_monitor_deploy import validate
        _, monitor = validate(deployment_ref)
        require(monitor.data["state_root"] == plan["monitor_state_root"]
                and monitor.data["sender"] == plan["sender"], "readiness_lifecycle_deployment_changed")
        return check(config_ref, deployment_ref, call=call)
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as exc:
        missing = isinstance(exc, FileNotFoundError) and state is not None and state["deployment"] is None
        reason = "monitor_deployment_not_published" if missing else unavailable(exc)
        return dict(ok=False, state="bootstrap" if missing else "not_ready", monitor_ready=False,
                    autonomous_wait_ready=False, autonomy_verified=False, reason=reason,
                    missing=[reason], next_owner="operator")

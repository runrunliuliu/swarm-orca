"""Observe or seal a planned restart under the existing recovery locks.

observe_source is read-only. seal_source publishes native receipts, never approval
or a resume permit; service restart and independent review remain explicit.
"""

from contextlib import ExitStack, contextmanager

import operator_monitor as monitor
import operator_monitor_deploy as deploy
from operator_monitor_recovery import locks, snapshot
from operator_sender_correct import live
from operator_continuity_deployment import original
import operator_continuity_route as route
from operator_continuity_scope import deployment_scope
from coordinator_io import canonical, digest, file_ref, now, parse, pinned, publish_new, require, timestamp
from coordinator_strict import caller_result
from coordinator_tui_scheduler import completed, pending_mailbox
from trae_coordinator import native


def source_caller(contract, sender, call, caller_call):
    runtime, operator = route.runtime(contract["runtime"]), contract["operator"]
    require(operator["terminal"] not in (sender["terminal"], contract["coordinator"]["terminal"]),
            "continuity_source_independent_operator_required")
    started = timestamp(now())
    result = caller_result(caller_call(contract["cli"]["path"], runtime,
                                      ["orchestration", "strict-caller-check"]), runtime)
    require(started <= timestamp(result["checkedAt"]) <= timestamp(now()),
            "continuity_source_caller_not_fresh")
    caller = result["caller"]
    require(caller["terminalHandle"] == operator["terminal"], "continuity_source_wrong_caller")
    terminal = call(["terminal", "show", "--terminal", operator["terminal"]], runtime, 20).get("terminal", {})
    require(terminal.get("handle") == operator["terminal"]
            and terminal.get("incarnationId") == operator["incarnation"]
            and terminal.get("connected") is True and terminal.get("orphaned") is False
            and terminal.get("agentIdentity") == operator["provider"]
            and all(isinstance(terminal.get(k), str) and terminal[k] for k in ("tabId", "leafId"))
            and caller["paneKey"] == terminal["tabId"] + ":" + terminal["leafId"],
            "continuity_source_operator_changed")
    return caller


def pending_request(parts, saved, call):
    plan, config, cref, _, contract, _ = parts
    entry = saved["outbox"]["actions"][saved["action_key"]]
    request_id, runtime, run = entry["request_id"], contract["runtime"], contract["run"]["id"]
    require(isinstance(request_id, str) and request_id, "continuity_source_request_id_required")
    shown = call(["orchestration", "request-show", "--request", request_id], runtime, 20)
    require(shown.get("requestId") == request_id and shown.get("state") == "completed"
            and shown.get("method") == "orchestration.send", "continuity_source_request_unconfirmed")
    receipt = shown.get("receipt", {})
    message = receipt.get("message", {})
    require(receipt.get("mutation", {}).get("requestId") == request_id
            and message.get("id") == entry["delivery"]["message_id"]
            and message.get("run_id") == run and message.get("to_handle") == "run:" + run
            and message.get("from_handle") == plan["sender"]["terminal"]
            and message.get("delivery_contract") == "current_delivery",
            "continuity_source_request_mismatch")
    record = parse(pinned(entry["checkpoint"]))
    expected_payload = dict(kind="coordinator_tui_continue_v1", config=cref,
                            checkpoint=entry["checkpoint"], action_id=record["checkpoint"]["next_action"]["id"])
    if plan.get("schema_version") == 3:
        from operator_continuity_route import continuation_plan
        expected_payload["recovery_plan"] = continuation_plan()
    require(isinstance(message.get("payload"), str) and parse(message["payload"]) == expected_payload,
            "continuity_source_request_payload_mismatch")
    # A limit of one cannot distinguish the only pending message from a truncated prefix.
    require(config["inbox_limit"] >= 2, "continuity_source_pending_window_too_small")
    validated = monitor.Config(plan["config"]["path"], plan["config"]["sha256"])
    rows = pending_mailbox(validated, contract, lambda args, runtime: call(args, runtime, 20))
    require(len(rows) == 1 and rows[0].get("id") == message["id"]
            and rows[0].get("from_handle") == message["from_handle"]
            and rows[0].get("payload") == message["payload"],
            "continuity_source_requires_exact_pending_message")
    return dict(request=shown, pending_message=rows[0])


@contextmanager
def locked_source(plan_ref, *, call=monitor.native, caller_call=native, observe_turn=completed):
    """Reuse the recovery locks through the caller's native prepare/seal operation."""
    parts = original(plan_ref)
    plan, config, _, _, contract, roots = parts
    call = monitor.bind_contract(call, contract)
    deploy.validate(plan_ref)
    with ExitStack() as stack:
        transition = plan.get("recovery", {}).get("transition")
        if transition:
            stack.enter_context(route.scope(transition, "source-prepare", dict(plan=plan_ref)))
            call, caller_call = route.routed(call), route.coordinator_call(caller_call)
        locks(stack, roots, create=False)

        def state():
            require(original(plan_ref) == parts, "continuity_source_deployment_changed")
            deploy.validate(plan_ref)
            saved = snapshot(plan_ref, *parts)
            lock_refs = [file_ref(root / (name + ".lock")) for root, name in (
                (roots[0], "monitor"), (roots[1], "tui-continuation"), (roots[1], "tui-workflow"))]
            return dict(snapshot=saved, locks=lock_refs, scope=deployment_scope(plan_ref, parts, saved))

        before = state()

        def observed():
            actor = source_caller(contract, plan["sender"], call, caller_call)
            sender = live(config, plan["sender"], call)
            ended = observe_turn(contract, lambda args, runtime: call(args, runtime, 20))
            require(isinstance(ended, dict) and ended.get("thread_id") == contract["coordinator"]["session"]
                    and isinstance(ended.get("completed_turn"), dict), "continuity_source_completed_turn_required")
            # Reuse the provider's completed-turn identity, not its observation timestamp.
            turn = ended["completed_turn"]
            require(isinstance(turn.get("turn_id"), str) and turn["turn_id"]
                    and timestamp(turn["context_at"]) <= timestamp(turn["completed_at"]) <= timestamp(now()),
                    "continuity_source_completed_turn_required")
            request = pending_request(parts, before["snapshot"], call)
            require(sender == live(config, plan["sender"], call), "continuity_source_sender_changed")
            require(actor == source_caller(contract, plan["sender"], call, caller_call),
                    "continuity_source_caller_changed")
            return dict(caller=actor, sender=sender, completed_turn=turn, **request)

        first = observed()
        require(before == state(), "continuity_source_files_changed")
        require(first == observed(), "continuity_source_native_state_changed")
        require(before == state(), "continuity_source_files_changed")
        observation = dict(schema_version=1, kind="cross-runtime-source-observation", plan=plan_ref,
                           binding=config["binding"], **before, **first)
        result = dict(observation=observation, observation_canonical_sha256=digest(canonical(observation)),
                      observed_at=now(), execution_authorized=False, server_continuity_verified=False,
                      reusable_as_seal=False, locks_held_after_return=False,
                      remaining_checks=["native_prepare_and_seal", "independent_review",
                                        "successor_admission", "reviewed_monitor_recovery"])
        yield result


def observe_source(plan_ref, **kwargs):
    with locked_source(plan_ref, **kwargs) as result:
        return result


def seal_source(plan_ref, output_dir, *, expires_at_ms, call=monitor.native,
                caller_call=native, observe_turn=completed):
    """Produce a fresh request and seal under the original locks; never approve or restart."""
    parts = original(plan_ref)
    output = deploy.private_directory(output_dir)
    require(not any(output.iterdir()) and all(not output.is_relative_to(root)
            and not root.is_relative_to(output) for root in parts[-1]), "continuity_requires_fresh_output")
    contract = parts[4]
    from operator_continuity_route import maintenance_call
    with locked_source(plan_ref, call=call, caller_call=caller_call, observe_turn=observe_turn) as result:
        observation = result["observation"]
        publish_new(output / "source.json", observation)
        request = dict(phase="prepare", runId=contract["run"]["id"], sender=parts[0]["sender"]["terminal"],
                       proposal=observation, proposalCanonicalSha256=result["observation_canonical_sha256"])
        runtime = route.runtime(contract["runtime"])
        prepared = maintenance_call(contract["cli"], runtime, request, call=caller_call)
        require(prepared.get("preparationCanonicalSha256") == digest(canonical(prepared.get("preparation")))
                and prepared["preparation"].get("proposal") == observation, "continuity_preparation_mismatch")
        publish_new(output / "preparation.json", prepared)
        # No monitor/workflow can enter between source observation and native freeze.
        sealed = maintenance_call(contract["cli"], runtime, dict(phase="seal",
            preparationCanonicalSha256=prepared["preparationCanonicalSha256"], expiresAtMs=expires_at_ms),
            call=caller_call)
        require(sealed.get("sealCanonicalSha256") == digest(canonical(sealed.get("seal")))
                and sealed["seal"].get("runId") == contract["run"]["id"]
                and sealed["seal"].get("sourceRuntimeId") == runtime, "continuity_seal_mismatch")
        publish_new(output / "seal.json", sealed)
    return dict(source=file_ref(output / "source.json"), preparation=file_ref(output / "preparation.json"),
                seal=file_ref(output / "seal.json"), state="sealed_awaiting_independent_review")

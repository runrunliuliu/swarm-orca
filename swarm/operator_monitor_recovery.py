"""Narrow reviewed same-Run recovery for a delivered, unclaimed continuation.

prepare/apply do not revive the monitor or send to an Agent. The original live
Coordinator reconciles via coordinator_tui_workflow. complete verifies its receipt
and publishes a source-pinned deployment LAST. STOP is never removed or rewritten.
Only this one known omission is supported; unknown/claimed actions fail closed.
"""

import argparse
from contextlib import ExitStack
from datetime import timedelta
import os
from pathlib import Path
import subprocess

import operator_monitor as monitor
import operator_monitor_deploy as deploy
from operator_sender_correct import live, locks as state_locks
from operator_continuity_deployment import original, stop_path
from operator_monitor_upgrade import inventory, reviewed, review_assertion
from coordinator_io import (canonical, digest, directory_lock, file_ref, now, parse, pinned, publish_new,
                            read_json, timestamp)
from coordinator_tui_errors import failure, require
from coordinator_tui_checkpoint import validate_checkpoint
from coordinator_tui_continue import (WORKFLOW_PROTOCOL, read_outbox, read_scheduler_journal, scheduler_review,
                                      validate_next_scheduled_action, validate_scheduler_progress)
from coordinator_tui_scheduler import WaitNotReady, completed, quiet_mailbox
from coordinator_tui_workflow import ack_confirmed, delivery_ids, processed_batch


KIND = "same-run-unclaimed-continuation-recovery"
CROSS_KIND = "planned-restart-unclaimed-continuation-recovery"
REASONS = {"tui_checkpoint_not_from_completed_turn", "tui_scheduler_continuation_not_processed"}


def locks(stack, roots, *, create=True):
    # Same order as workflow (workflow -> continuation); locks are nonblocking.
    stack.enter_context(directory_lock(roots[1], "tui-workflow", create=create))
    state_locks(stack, roots, create=create)


def snapshot(plan_ref, plan, config, cref, continuation, contract, roots):
    monitor.Config(plan["config"]["path"], plan["config"]["sha256"])
    require(read_json(roots[0] / "monitor-binding.json") == plan["config"]
            and read_json(roots[1] / "tui-continuation-binding.json") == cref, "recovery_binding_changed")
    require(not any(os.path.lexists(r / "STOP") for r in roots), "recovery_manual_stop")
    stop = file_ref(stop_path(plan, roots[0]))
    require(parse(pinned(stop)).get("reason") in REASONS, "recovery_stop_not_supported")
    require(not os.path.lexists(roots[1] / "monitor-stop.json"), "recovery_other_stop")
    journal = read_scheduler_journal(roots[1], cref)
    require(journal is not None and journal["stop"] is None, "recovery_scheduler_review_required")
    status = read_json(roots[0] / "deployment-status.json")
    require(status.get("schema_version") == plan["schema_version"] and status.get("plan") == plan_ref
            and status.get("verification_mode") == "native-runtime" and status.get("phase") == "exited"
            and status.get("first_tick_at") is not None
            and timestamp(status["started_at"]) <= timestamp(status["first_tick_at"])
            <= timestamp(status["observed_at"])
            and status.get("status") == file_ref(roots[0] / "status.json")
            and read_json(roots[0] / "status.json").get("state") == "stopped",
            "recovery_requires_exited_stopped_monitor")
    state = read_json(roots[0] / "state.json")
    require(state.get("config") == plan["config"] and not state.get("outbox"),
            "recovery_scheduler_only_required")
    outbox = read_outbox(roots[1])
    pending = [(key, e) for key, e in outbox["actions"].items() if e["result"] is None]
    require(len(pending) == 1, "recovery_requires_one_pending_action")
    key, entry = pending[0]
    require(outbox["order"][-1] == key and entry["attempted"] is True
            and isinstance(entry["delivery"], dict) and entry["claimed_at"] is None,
            "recovery_requires_delivered_unclaimed_action")
    require(not os.path.lexists(roots[1] / ("workflow-" + key + ".json")),
            "recovery_existing_workflow_requires_reconciliation")
    require(set(entry["delivery"]) == {"message_id", "enqueued_at"}
            and isinstance(entry["delivery"]["message_id"], str) and entry["delivery"]["message_id"],
            "recovery_invalid_delivery")
    head = file_ref(continuation["checkpoint_head"])
    require(parse(pinned(head)) == entry["checkpoint"], "recovery_head_changed")
    record, route = validate_checkpoint(entry["checkpoint"], continuation, contract)
    require(key == digest(canonical(record["checkpoint"]["next_action"]["id"]))
            and route.kind in ("coordinator_turn", "dependency_wait"), "recovery_action_changed")
    require(scheduler_review(entry["checkpoint"], route,
            validate_scheduler_progress(outbox, record)) is None, "recovery_scheduler_review_required")
    # Full prior settlements must remain valid; unknown work is never replayed.
    for old in outbox["actions"].values():
        if old is entry:
            continue
        result = parse(pinned(old["result"]))
        previous = parse(pinned(old["checkpoint"]))
        require(set(result) == {"action_id", "checkpoint", "status", "evidence"}
                and result["action_id"] == previous["checkpoint"]["next_action"]["id"]
                and old["claimed_at"] and result.get("checkpoint") == old["checkpoint"]
                and result.get("status") == "executed" and result.get("evidence"),
                "recovery_prior_settlement_invalid")
        for ref in result["evidence"]:
            pinned(ref)
    return dict(head=head, stop=stop, action_key=key, outbox=outbox, files=inventory(roots))


def prepare(plan_ref, output_dir, *, call=monitor.native, transition_ref=None):
    transition = None
    if transition_ref is not None:
        from operator_continuity_route import require_active, validate
        transition = validate(transition_ref)
        require_active(transition)
        require(transition["old_plan"] == plan_ref, "cross_runtime_source_state_changed")
    parts = original(plan_ref)
    plan, config, cref, continuation, contract, roots = parts
    # The recovery/deployment chain pins legacy completion receipts including
    # turn-end. Do not begin a recovery which cannot consume a v2 submission.
    require(continuation.get("turn_protocol") != WORKFLOW_PROTOCOL,
            "recovery_workflow_v2_not_supported")
    require(plan.get("schema_version") != 3 or transition_ref is not None,
            "cross_runtime_explicit_entry_required")
    require(plan["python"] == str(Path(deploy.sys.executable).resolve()), "monitor_deployment_python_changed")
    output = deploy.private_directory(output_dir)
    require(not any(output.iterdir()) and all(not output.is_relative_to(r) and not r.is_relative_to(output)
            for r in roots), "recovery_requires_fresh_output")
    preparer = os.environ.get("ORCA_TERMINAL_HANDLE")
    require(isinstance(preparer, str) and preparer, "recovery_preparer_identity_required")
    identity = call(["terminal", "show", "--terminal", preparer], config["binding"]["runtime"], 20).get("terminal", {})
    require(identity.get("handle") == preparer and identity.get("connected") is True
            and identity.get("orphaned") is False and identity.get("agentIdentity"),
            "recovery_preparer_unverifiable")
    with ExitStack() as stack:
        locks(stack, roots)
        before = snapshot(plan_ref, *parts)
        live(config, plan["sender"], call)
        sources = deploy.sources()
        require(before == snapshot(plan_ref, *parts), "recovery_state_changed")
        if transition is not None:
            require(transition["snapshot"] == before, "cross_runtime_source_state_changed")
        publish_new(output / "proposal.json", dict(schema_version=1,
            kind=CROSS_KIND if transition_ref else KIND, old_plan=plan_ref,
            continuation=cref, preparer=preparer, prepared_at=now(),
            valid_until=(timestamp(now()) + timedelta(minutes=30)).isoformat(),
            sources=sources, snapshot=before, **({"transition": transition_ref} if transition_ref else {})))
    return file_ref(output / "proposal.json")


def proposal_data(ref):
    p = parse(pinned(ref))
    cross = p.get("kind") == CROSS_KIND
    require(set(p) == {"schema_version", "kind", "old_plan", "continuation", "preparer", "prepared_at",
            "valid_until", "sources", "snapshot"} | ({"transition"} if cross else set())
            and p["schema_version"] == 1 and p["kind"] in (KIND, CROSS_KIND),
            "recovery_invalid_proposal")
    if cross:
        from operator_continuity_route import require_active, validate
        transition = validate(p["transition"])
        require_active(transition)
        require(transition["old_plan"] == p["old_plan"] and transition["snapshot"] == p["snapshot"],
                "cross_runtime_source_state_changed")
    require(timestamp(p["prepared_at"]) <= timestamp(now()) < timestamp(p["valid_until"])
            <= timestamp(p["prepared_at"]) + timedelta(minutes=31), "recovery_proposal_expired")
    require(p["sources"] == deploy.sources(), "monitor_deployment_source_changed")
    parts = original(p["old_plan"])
    require(p["continuation"] == parts[2], "recovery_binding_changed")
    output = deploy.private_directory(str(Path(ref["path"]).parent))
    require(all(not output.is_relative_to(r) and not r.is_relative_to(output) for r in parts[-1]),
            "recovery_output_overlaps_state")
    return p, parts, output


def apply(proposal_ref, review_ref, *, call=monitor.native):
    p, parts, output = proposal_data(proposal_ref)
    plan, config, cref, continuation, contract, roots = parts
    receipt = dict(schema_version=1, kind=p["kind"], state="reviewed_not_resumed", proposal=proposal_ref,
                   review=review_ref, continuation=cref)
    with ExitStack() as stack:
        locks(stack, roots)
        reviewed(proposal_ref, review_ref, config,
                 (p["preparer"], plan["sender"]["terminal"], config["binding"]["terminal"]), call)
        target = output / "reviewed.json"
        if os.path.lexists(target):
            require(read_json(target) == receipt, "recovery_review_changed")
            return file_ref(target)  # No send, reset or replay even after progress.
        require(p["snapshot"] == snapshot(p["old_plan"], *parts), "recovery_state_changed")
        live(config, plan["sender"], call)
        require(p["snapshot"] == snapshot(p["old_plan"], *parts), "recovery_state_changed")
        pinned(proposal_ref)
        pinned(review_ref)
        require(p["sources"] == deploy.sources(), "monitor_deployment_source_changed")
        publish_new(target, receipt)
    return file_ref(target)


def permit(ref, config_ref):
    """Coordinator-side receipt check. It never supplies the caller's identity."""
    receipt = parse(pinned(ref))
    require(set(receipt) == {"schema_version", "kind", "state", "proposal", "review", "continuation"}
            and receipt["schema_version"] == 1 and receipt["kind"] in (KIND, CROSS_KIND)
            and receipt["state"] == "reviewed_not_resumed" and receipt["continuation"] == config_ref,
            "recovery_review_required")
    p, parts, output = proposal_data(receipt["proposal"])
    require(receipt["kind"] == p["kind"], "recovery_review_changed")
    require(Path(ref["path"]) == output / "reviewed.json", "recovery_review_changed")
    review_assertion(receipt["proposal"], receipt["review"],
                     (p["preparer"], parts[0]["sender"]["terminal"], parts[1]["binding"]["terminal"]))
    return receipt, p, parts, output


def coordinator_boundary(ref, config_ref, entry, call):
    """Under workflow lock, pin all stopped state except this exact reconciliation."""
    receipt, p, parts, output = permit(ref, config_ref)
    plan, config, cref, continuation, contract, roots = parts
    key = p["snapshot"]["action_key"]
    old = p["snapshot"]["outbox"]["actions"][key]
    expected = {**old, "claimed_at": entry["claimed_at"], "result": entry["result"]}
    require(entry == expected, "recovery_action_changed")
    current = read_outbox(roots[1])
    expected_outbox = parse(canonical(p["snapshot"]["outbox"]))
    expected_outbox["actions"][key] = entry
    require(current == expected_outbox, "recovery_outbox_changed")
    allowed = {str(roots[1] / name) for name in ("outbox.json", "workflow-" + key + ".json")}
    require([r for r in inventory(roots) if r["path"] not in allowed]
            == [r for r in p["snapshot"]["files"] if r["path"] not in allowed], "recovery_state_changed")
    live(config, plan["sender"], lambda args, runtime, timeout: call(contract["cli"]["path"], runtime, args))
    pinned(p["snapshot"]["stop"])
    require([r for r in inventory(roots) if r["path"] not in allowed]
            == [r for r in p["snapshot"]["files"] if r["path"] not in allowed], "recovery_state_changed")


def complete(permit_ref, workflow_ref, *, call=monitor.native, observe_turn=completed):
    receipt = parse(pinned(permit_ref))
    receipt, p, parts, output = permit(permit_ref, receipt["continuation"])
    plan, config, cref, continuation, contract, roots = parts
    proof = parse(pinned(workflow_ref))
    old = p["snapshot"]["outbox"]
    key = p["snapshot"]["action_key"]
    entry = old["actions"][key]
    require(proof.get("kind") == "coordinator-delivery-workflow" and proof.get("schema_version") == 1
            and proof.get("config") == cref and proof.get("checkpoint") == entry["checkpoint"]
            and proof.get("request_id") == entry["request_id"]
            and proof.get("recovery") == permit_ref
            and entry["delivery"]["message_id"] in delivery_ids(proof["delivery"], contract["run"]["id"])
            and proof.get("ack", {}).get("acknowledged") == proof["delivery"]["deliveryId"]
            and proof.get("turn_end", {}).get("ok") is True
            and proof["turn_end"].get("checkpoint") == proof.get("next_checkpoint"), "recovery_workflow_incomplete")
    ack_confirmed(proof["ack"], proof["delivery"]["deliveryId"], contract["run"]["id"])
    processed_batch(proof["processed"], proof["result"], proof["delivery"], entry,
                    continuation, contract, roots[1])
    result = parse(pinned(proof["result"]))
    require(set(result) == {"action_id", "checkpoint", "status", "evidence"}
            and digest(canonical(result["action_id"])) == key
            and result.get("checkpoint") == entry["checkpoint"] and result.get("status") == "executed"
            and isinstance(result.get("evidence"), list) and result["evidence"], "recovery_workflow_incomplete")
    for ref in result["evidence"]:
        pinned(ref)
    with ExitStack() as stack:
        locks(stack, roots)
        committed = output / "committed.json"
        target = output / "deployment.json"
        new_plan = {**plan, "schema_version": 3, "sources": p["sources"],
                    "recovery": dict(commit_path=str(committed), permit=permit_ref, stop=p["snapshot"]["stop"],
                        **({"transition": p["transition"]} if p["kind"] == CROSS_KIND else {}))}
        if os.path.lexists(target):
            require(read_json(target) == new_plan and read_json(committed).get("workflow") == workflow_ref,
                    "recovery_publication_changed")
            deploy.validate(file_ref(target))
            return file_ref(target)

        def recheck():
            workflow = read_json(roots[1] / ("workflow-" + key + ".json"))
            require(workflow.get("completed_receipt") == workflow_ref and workflow.get("recovery") == permit_ref
                    and workflow.get("checkpoint") == entry["checkpoint"] and workflow.get("config") == cref
                    and workflow.get("request_id") == entry["request_id"]
                    and workflow.get("finish") == {k: proof[k] for k in
                        ("result", "next_checkpoint", "processed", "receipt_path")}, "recovery_workflow_incomplete")
            for name, reply, args in (("consume", proof["delivery"], ["orchestration", "check", "--run", contract["run"]["id"]]),
                    ("ack", proof["ack"], ["orchestration", "check", "--run", contract["run"]["id"],
                                         "--ack", proof["delivery"]["deliveryId"], "--peek"])):
                intent = workflow[name]
                require(intent["attempted"] is True and intent["reply"] == reply and intent["args"] == args,
                        "recovery_workflow_incomplete")
                native = call(["orchestration", "request-show", "--request", intent["request_id"]], contract["runtime"], 20)
                require(native.get("requestId") == intent["request_id"] and native.get("state") == "completed"
                        and native.get("method") == "orchestration.check" and native.get("receipt") == reply,
                        "recovery_native_receipt_unconfirmed")
            current = read_outbox(roots[1])
            expected = parse(canonical(old))
            expected["actions"][key].update(claimed_at=current["actions"][key]["claimed_at"], result=proof["result"])
            require(current == expected and current["actions"][key]["claimed_at"], "recovery_outbox_changed")
            require(read_json(continuation["checkpoint_head"]) == proof["next_checkpoint"], "recovery_head_changed")
            record, route = validate_checkpoint(proof["next_checkpoint"], continuation, contract)
            validate_next_scheduled_action(current, record)
            require(scheduler_review(proof["next_checkpoint"], route,
                    validate_scheduler_progress(current, record)) is None, "recovery_scheduler_review_required")
            # Only target claim/result, workflow journal/lock and external head may change.
            allowed = {str(roots[1] / name) for name in ("outbox.json", "workflow-" + key + ".json", "tui-workflow.lock")}
            before = [r for r in p["snapshot"]["files"] if r["path"] not in allowed]
            after = [r for r in inventory(roots) if r["path"] not in allowed]
            require(before == after, "recovery_state_changed")
            live(config, plan["sender"], call)
            ended = observe_turn(contract, lambda args, runtime: call(args, runtime, 20))
            require(ended and ended["thread_id"] == contract["coordinator"]["session"], "recovery_session_changed")
            turn = ended["completed_turn"]
            source = parse(pinned(record["domain_check"]["source"]))
            require(timestamp(proof["turn_end"]["freshness"]["context_observed_at"])
                    == timestamp(turn["context_at"]), "recovery_workflow_turn_changed")
            require(timestamp(p["prepared_at"]) <= timestamp(current["actions"][key]["claimed_at"])
                    <= timestamp(proof["completed_at"]), "recovery_claim_time_invalid")
            require(timestamp(turn["context_at"]) <= timestamp(source["observed_at"])
                    <= timestamp(proof["completed_at"]) <= timestamp(turn["completed_at"]) <= timestamp(now()),
                    "recovery_checkpoint_not_from_completed_turn")
            require(quiet_mailbox(monitor.Config(plan["config"]["path"], plan["config"]["sha256"]),
                    contract, lambda args, runtime: call(args, runtime, 20)), "recovery_pending_mail")
            pinned(permit_ref)
            pinned(workflow_ref)
            pinned(p["snapshot"]["stop"])
            require(p["sources"] == deploy.sources(), "monitor_deployment_source_changed")
            return ended

        ended = recheck()
        require(recheck() == ended, "recovery_state_changed")
        data = dict(schema_version=1, kind=p["kind"], state="reconciled_not_started", permit=permit_ref,
                    workflow=workflow_ref, old_plan=p["old_plan"], new_plan=new_plan,
                    completed_turn=ended, stop=p["snapshot"]["stop"])
        if os.path.lexists(committed):
            require(read_json(committed) == data, "recovery_publication_changed")
        else:
            publish_new(committed, data)
        publish_new(target, new_plan)
    return file_ref(target)


def deployment_recovery(plan):
    """Validate a committed plan, not an arbitrary ignore-STOP flag. No TTL lease."""
    recovery = plan["recovery"]
    cross = "transition" in recovery
    require(set(recovery) == {"commit_path", "permit", "stop"} | ({"transition"} if cross else set()),
            "recovery_invalid_deployment")
    receipt = parse(pinned(recovery["permit"]))
    proposal = parse(pinned(receipt["proposal"]))
    require(recovery["commit_path"] == str(Path(recovery["permit"]["path"]).parent / "committed.json"),
            "recovery_invalid_deployment")
    commit = read_json(recovery["commit_path"])
    old = parse(pinned(proposal["old_plan"]))
    old_config = parse(pinned(old["config"]))
    kind = CROSS_KIND if cross else KIND
    if cross:
        from operator_continuity_route import validate
        transition = validate(recovery["transition"])
        require(proposal.get("transition") == recovery["transition"]
                and transition["old_plan"] == proposal["old_plan"]
                and transition["snapshot"] == proposal["snapshot"], "cross_runtime_source_state_changed")
    if old.get("schema_version") == 3:
        require(cross and "transition" in deployment_recovery(old), "recovery_invalid_deployment")
    require(old.get("schema_version") in (2, 3) and receipt.get("kind") == proposal.get("kind") == kind
            and receipt.get("state") == "reviewed_not_resumed" and receipt.get("continuation") == old_config["continuation"]
            and proposal.get("continuation") == old_config["continuation"], "recovery_invalid_deployment")
    review_assertion(receipt["proposal"], receipt["review"],
                     (proposal["preparer"], old["sender"]["terminal"], old_config["binding"]["terminal"]))
    require(commit.get("kind") == kind and commit.get("state") == "reconciled_not_started"
            and commit.get("permit") == recovery["permit"] and commit.get("new_plan") == plan
            and commit.get("stop") == recovery["stop"] == proposal["snapshot"]["stop"]
            and plan == {**old, "schema_version": 3, "sources": proposal["sources"], "recovery": recovery},
            "recovery_invalid_deployment")
    proof = parse(pinned(commit["workflow"]))
    require(proof.get("recovery") == recovery["permit"] and proof.get("config") == receipt["continuation"]
            and proof.get("turn_end", {}).get("ok") is True, "recovery_workflow_incomplete")
    require(recovery["stop"]["path"] == str(stop_path(old, Path(old_config["state_root"])))
            and parse(pinned(recovery["stop"])).get("reason") in REASONS, "recovery_stop_not_supported")
    pinned(recovery["stop"])
    return recovery


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="mode", required=True)
    for mode, refs in (("prepare", ("plan",)), ("apply", ("proposal", "review")),
                       ("complete", ("permit", "workflow"))):
        parser = sub.add_parser(mode)
        for key in refs:
            parser.add_argument("--" + key, required=True)
            parser.add_argument("--" + key + "-sha256", required=True)
        if mode == "prepare":
            parser.add_argument("--output-dir", required=True)
        else:
            parser.add_argument("--execute", action="store_true")
    a = p.parse_args(argv)
    ref = lambda key: dict(path=getattr(a, key), sha256=getattr(a, key + "_sha256"))
    if a.mode == "prepare":
        result = dict(state="awaiting_independent_review", proposal=prepare(ref("plan"), a.output_dir))
    else:
        require(a.execute, "recovery_execute_required")
        if a.mode == "apply":
            result = dict(state="reviewed_not_resumed", permit=apply(ref("proposal"), ref("review")))
        else:
            result = dict(state="reconciled_not_started", plan=complete(ref("permit"), ref("workflow")))
    print(canonical({**result, "execution_authorized": False}).decode())
    return 0


def cli(argv=None):
    try:
        return main(argv)
    except WaitNotReady as exc:
        print(canonical(dict(ok=False, state="retryable", reason=exc.result.reason,
                             execution_authorized=False, next_step="await_original_coordinator_turn_end")).decode())
        return 75
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as exc:
        print(canonical(failure(exc, "recovery_stopped_preserve_all_evidence")).decode())
        return 2


if __name__ == "__main__":
    raise SystemExit(cli())

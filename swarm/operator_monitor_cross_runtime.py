"""Planned-restart client workflow, gated by the Server recovery boundary.

Reuses the same-Run recovery and TUI workflow; never rewrites historical runtime
pins. Every phase checks the consumed native transition before entering recovery.
"""

import argparse
import subprocess

from coordinator_io import canonical, parse, pinned, require
from coordinator_tui_errors import failure
from coordinator_tui_scheduler import completed, WaitNotReady
from coordinator_tui_turn_end import turn_end
import coordinator_tui_workflow as workflow
import operator_continuity_route as route
import operator_monitor as monitor
import operator_monitor_deploy as deploy
import operator_monitor_recovery as recovery
from trae_coordinator import native


def transition(ref, *, permit=False):
    value = parse(pinned(ref))
    if permit:
        require(value.get("kind") == recovery.CROSS_KIND, "cross_runtime_permit_required")
        value = parse(pinned(value["proposal"]))
    require(value.get("kind") == recovery.CROSS_KIND, "cross_runtime_proposal_required")
    return value["transition"]


def prepare(transition_ref, output_dir, *, call=monitor.native):
    with route.scope(transition_ref, "prepare"):
        value = route.validate(transition_ref)
        return recovery.prepare(value["old_plan"], output_dir, transition_ref=transition_ref,
                                call=route.routed(call))


def apply(proposal_ref, review_ref, *, call=monitor.native):
    with route.scope(transition(proposal_ref), "apply", dict(proposal=proposal_ref, review=review_ref)):
        return recovery.apply(proposal_ref, review_ref, call=route.routed(call))


def begin(permit_ref, *, action_seconds=60, call=native):
    with route.scope(transition(permit_ref, permit=True), "begin", dict(permit=permit_ref)):
        return workflow.begin(parse(pinned(permit_ref))["continuation"], action_seconds=action_seconds,
                              recovery_ref=permit_ref, call=route.coordinator_call(call))


def finish(permit_ref, result_ref, next_ref, processed_ref, receipt_path, *, call=native):
    evidence = dict(permit=permit_ref, result=result_ref, next_checkpoint=next_ref, processed=processed_ref)
    with route.scope(transition(permit_ref, permit=True), "finish", evidence):
        return workflow.finish(parse(pinned(permit_ref))["continuation"], result_ref, next_ref,
            processed_ref, receipt_path, recovery_ref=permit_ref, call=route.coordinator_call(call))


def complete(permit_ref, workflow_ref, *, call=monitor.native, observe_turn=completed):
    evidence = dict(permit=permit_ref, workflow=workflow_ref)
    with route.scope(transition(permit_ref, permit=True), "complete", evidence):
        return recovery.complete(permit_ref, workflow_ref, call=route.routed(call), observe_turn=observe_turn)


def deployment_scope(plan_ref, phase):
    plan, config = deploy.validate(plan_ref)
    ref = plan.get("recovery", {}).get("transition")
    require(ref is not None, "cross_runtime_deployment_required")
    require(not monitor.persistently_stopped(config), "monitor_deployment_persistent_stop")
    return route.scope(ref, phase, dict(plan=plan_ref))


def run(plan_ref, *, once=False):
    with deployment_scope(plan_ref, "run"):
        return deploy.run(plan_ref, once=once)


def verify(plan_ref, *, call=monitor.native, max_age_seconds=120):
    with deployment_scope(plan_ref, "verify"):
        return deploy.verify(plan_ref, call=route.routed(call), max_age_seconds=max_age_seconds)


def continue_begin(plan_ref, *, action_seconds=60, call=native):
    with deployment_scope(plan_ref, "continue-begin"):
        _, config = deploy.validate(plan_ref)
        return workflow.begin(config.data["continuation"], action_seconds=action_seconds,
                              call=route.coordinator_call(call))


def continue_finish(plan_ref, result_ref, next_ref, processed_ref, receipt_path, *, call=native):
    with deployment_scope(plan_ref, "continue-finish"):
        _, config = deploy.validate(plan_ref)
        return workflow.finish(config.data["continuation"], result_ref, next_ref, processed_ref,
                               receipt_path, call=route.coordinator_call(call))


def audit(plan_ref, *, call=native):
    with deployment_scope(plan_ref, "turn-end"):
        _, config = deploy.validate(plan_ref)
        return turn_end(config.data["continuation"], call=route.coordinator_call(call))


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="mode", required=True)
    for mode, refs in (("prepare", ("transition",)), ("apply", ("proposal", "review")),
                       ("begin", ("permit",)), ("finish", ("permit", "result", "next", "processed")),
                       ("complete", ("permit", "workflow")), ("run", ("plan",)), ("verify", ("plan",)),
                       ("continue-begin", ("plan",)), ("turn-end", ("plan",)),
                       ("continue-finish", ("plan", "result", "next", "processed"))):
        parser = sub.add_parser(mode)
        for key in refs:
            parser.add_argument("--" + key, required=True)
            parser.add_argument("--" + key + "-sha256", required=True)
        if mode == "prepare":
            parser.add_argument("--output-dir", required=True)
        if mode not in ("prepare", "verify"):
            parser.add_argument("--execute", action="store_true")
        if mode in ("begin", "continue-begin"):
            parser.add_argument("--action-seconds", type=float, default=60)
        if mode in ("finish", "continue-finish"):
            parser.add_argument("--receipt", required=True)
        if mode == "run":
            parser.add_argument("--confirm-skill-read", action="store_true")
            parser.add_argument("--once", action="store_true")
    a = p.parse_args(argv)
    ref = lambda key: dict(path=getattr(a, key), sha256=getattr(a, key + "_sha256"))
    if a.mode not in ("prepare", "verify"):
        require(a.execute, "cross_runtime_execute_required")
    if a.mode == "prepare":
        result = dict(state="awaiting_independent_review", proposal=prepare(ref("transition"), a.output_dir))
    elif a.mode == "apply":
        result = dict(state="reviewed_not_resumed", permit=apply(ref("proposal"), ref("review")))
    elif a.mode == "begin":
        result = begin(ref("permit"), action_seconds=a.action_seconds)
    elif a.mode == "finish":
        result = finish(ref("permit"), ref("result"), ref("next"), ref("processed"), a.receipt)
    elif a.mode == "complete":
        result = dict(state="reconciled_not_started", plan=complete(ref("permit"), ref("workflow")))
    elif a.mode == "verify":
        result = verify(ref("plan"))
    elif a.mode == "continue-begin":
        result = continue_begin(ref("plan"), action_seconds=a.action_seconds)
    elif a.mode == "continue-finish":
        result = continue_finish(ref("plan"), ref("result"), ref("next"), ref("processed"), a.receipt)
    elif a.mode == "turn-end":
        result = audit(ref("plan"))
    else:
        require(a.confirm_skill_read, "cross_runtime_skill_read_required")
        return run(ref("plan"), once=a.once)
    print(canonical({**result, "execution_authorized": False}).decode())
    return 75 if result.get("retryable") else 2 if result.get("ok") is False else 0


def cli(argv=None):
    try:
        return main(argv)
    except WaitNotReady as exc:
        print(canonical(dict(ok=False, state="retryable", reason=exc.result.reason,
                             execution_authorized=False)).decode())
        return 75
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as exc:
        print(canonical(failure(exc, "cross_runtime_stopped_preserve_all_evidence")).decode())
        return 2


if __name__ == "__main__":
    raise SystemExit(cli())

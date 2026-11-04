"""Reviewed source-only plan revision for an exited, settled monitor.

No configuration/state migration, stop reset, Agent input or automatic start.
The new executable plan is published last, after an independent external review.
"""

import argparse
from contextlib import ExitStack
import os
from pathlib import Path

import operator_monitor as monitor
import operator_monitor_deploy as deploy
from operator_sender_correct import original as native_original, live, locks
from coordinator_io import (canonical, digest, file_ref, now, parse, pinned, publish_new,
                            read_json, require, timestamp)
from coordinator_tui_checkpoint import validate_checkpoint
from coordinator_tui_continue import read_outbox, scheduler_review_clear, validate_config
from coordinator_tui_scheduler import historical_observation_snapshot


SOURCE_UPGRADE_LATCH_REASONS = {"file_pin_changed", "tui_checkpoint_not_from_completed_turn"}


def native_deployment(plan):
    return (isinstance(plan, dict)
            and set(plan) == {"schema_version", "verification_mode", "config", "sources", "python", "sender"}
            and plan.get("schema_version") == 2
            and plan.get("verification_mode") == "native-runtime")


def source_upgrade_deployment(plan):
    return (isinstance(plan, dict)
            and set(plan) == {"schema_version", "verification_mode", "config", "sources", "python", "sender", "recovery"}
            and plan.get("schema_version") == 3
            and plan.get("verification_mode") == "native-runtime"
            and isinstance(plan.get("recovery"), dict)
            and plan["recovery"].get("kind") == "monitor-source-only-upgrade")


def current(plan_ref):
    """Load the current deployment being upgraded.

    Schema v2 is the original native deployment.  Schema v3 is accepted only for
    the reviewed monitor-source-only-upgrade chain and still resolves to the same
    immutable monitor config, continuation contract and state roots.  No state is
    migrated or reset here.
    """
    plan = parse(pinned(plan_ref))
    if native_deployment(plan):
        return native_original(plan_ref)
    require(source_upgrade_deployment(plan), "correction_requires_native_deployment")
    deployment_recovery(plan)
    config = parse(pinned(plan["config"]))
    continuation_ref = config["continuation"]
    continuation = parse(pinned(continuation_ref))
    contract = validate_config(continuation)
    require(continuation["schema_version"] == 2 and config["schema_version"] == 2
            and plan["sender"] == config["sender"] == continuation["scheduler"],
            "correction_original_binding_mismatch")
    roots = [deploy.private_directory(config["state_root"]),
             deploy.private_directory(continuation["state_root"])]
    require(not roots[0].is_relative_to(roots[1]) and not roots[1].is_relative_to(roots[0]),
            "correction_state_overlap")
    return plan, config, continuation_ref, continuation, contract, roots


def review_evidence_pin(ref):
    """Extract the strict file pin from a reviewed evidence object.

    fin_verl RSI reviews may attach reviewer metadata such as kind/checked next
    to the pinned file.  The upgrade gate still verifies only the immutable file
    pin and ignores the metadata for authorization purposes.
    """
    require(isinstance(ref, dict), "invalid_file_pin")
    return {"path": ref.get("path"), "sha256": ref.get("sha256")}


def review_assertion(proposal_ref, review_ref, excluded, *, verify_evidence=True):
    """Shared pinned independent-review assertion; not an authority signature."""
    review = parse(pinned(review_ref))
    require(set(review) == {"schema_version", "proposal", "approved", "reviewer", "evidence", "reason"}
            and review["schema_version"] == 1 and review["proposal"] == proposal_ref
            and review["approved"] is True and isinstance(review["reason"], str) and review["reason"].strip()
            and isinstance(review["evidence"], list) and review["evidence"], "upgrade_external_review_required")
    if verify_evidence:
        for ref in review["evidence"]:
            pinned(review_evidence_pin(ref))
    reviewer = review["reviewer"]
    require(isinstance(reviewer, dict) and set(reviewer) == {"terminal", "incarnation", "workspace"}
            and all(isinstance(v, str) and v.strip() for v in reviewer.values())
            and reviewer["terminal"] not in excluded, "upgrade_independent_reviewer_required")
    return review


def reviewed(proposal_ref, review_ref, config, excluded, call):
    review = review_assertion(proposal_ref, review_ref, excluded)
    reviewer = review["reviewer"]
    t = call(["terminal", "show", "--terminal", reviewer["terminal"]], config["binding"]["runtime"], 20).get("terminal", {})
    require(all(t.get(k) == reviewer[v] for k, v in (("handle", "terminal"),
            ("incarnationId", "incarnation"), ("worktreeId", "workspace")))
            and t.get("connected") is True and t.get("orphaned") is False
            and isinstance(t.get("agentIdentity"), str) and t["agentIdentity"].strip(),
            "upgrade_reviewer_unverifiable")
    return review


def inventory(roots):
    refs = []
    for root in roots:
        for item in sorted(root.rglob("*")):
            require(not item.is_symlink(), "upgrade_state_symlink")
            if item.is_dir():
                continue
            require(item.is_file(), "upgrade_state_not_regular")
            if item not in (root / "monitor.lock", root / "tui-continuation.lock", root / "tui-workflow.lock"):
                refs.append(file_ref(item))
    return refs


def scheduler_review_allows_upgrade(journal_path, continuation, contract, root, config_ref):
    if not journal_path.exists():
        return True
    journal = read_json(journal_path)
    if journal.get("stop") is None:
        return True
    return scheduler_review_clear(journal, continuation, contract, root, config_ref) is not None


def scheduler_review_clear_ref(journal_path, continuation, contract, root, config_ref):
    require(journal_path.exists(), "upgrade_scheduler_review_required")
    journal = read_json(journal_path)
    require(journal.get("stop") is not None, "upgrade_scheduler_review_required")
    ref = scheduler_review_clear(journal, continuation, contract, root, config_ref)
    require(ref is not None, "upgrade_scheduler_review_required")
    return ref


def compatible_old_source_stop(root):
    target = root / "monitor-stop.json"
    if not os.path.lexists(target):
        return None
    ref = file_ref(target)
    stop = parse(pinned(ref))
    require(set(stop) == {"at", "reason"} and stop["reason"] == "tui_scheduler_journal_invalid"
            and timestamp(stop["at"]), "upgrade_persistent_stop")
    return ref


def compatible_source_upgrade_latch(root, plan):
    if not source_upgrade_deployment(plan):
        return None
    target = root / ("recovery-stop-" + plan["recovery"]["permit"]["sha256"] + ".json")
    if not os.path.lexists(target):
        return None
    ref = file_ref(target)
    stop = parse(pinned(ref))
    require(set(stop) == {"at", "reason"} and stop["reason"] in SOURCE_UPGRADE_LATCH_REASONS
            and timestamp(stop["at"]), "upgrade_source_revision_stop")
    return ref


def source_revision_stop_reason(ref):
    if ref is None:
        return None
    stop = parse(pinned(ref))
    require(set(stop) == {"at", "reason"} and stop["reason"] in SOURCE_UPGRADE_LATCH_REASONS
            and timestamp(stop["at"]), "upgrade_source_revision_stop")
    return stop["reason"]


def historical_observation_recovery_snapshot(continuation, contract, root, cref):
    journal_path = root / "scheduler.json"
    require(journal_path.exists(), "upgrade_scheduler_journal_required")
    journal = read_json(journal_path)
    clear = scheduler_review_clear(journal, continuation, contract, root, cref)
    require(clear is not None, "upgrade_scheduler_review_required")
    snapshot = historical_observation_snapshot(continuation, contract, root, cref,
                                               journal=journal, cleared_stop=clear)
    require(snapshot["state"] == "awaiting_fresh_checkpoint", "upgrade_historical_observation_required")
    return {**snapshot, "scheduler_review_clear": clear}


def reviewed_receipt_ref(output, proposal_ref, review_ref):
    receipt = dict(schema_version=1, kind="monitor-source-only-upgrade",
                   state="reviewed_not_started", proposal=proposal_ref, review=review_ref)
    ref = dict(path=str(output / "reviewed.json"), sha256=digest(canonical(receipt) + b"\n"))
    return receipt, ref


def checked_transition(plan_ref, transition_ref, snapshot=None):
    if transition_ref is None:
        return None
    from operator_continuity_route import require_active, validate
    transition = validate(transition_ref)
    require_active(transition)
    require(transition["old_plan"] == plan_ref, "cross_runtime_source_state_changed")
    if snapshot is not None:
        require(transition["snapshot"] == snapshot, "cross_runtime_source_state_changed")
    return transition


def final_plan(proposal, permit_ref):
    plan = proposal["new_plan"]
    stop = proposal["snapshot"].get("monitor_stop")
    if stop is None:
        require("transition" not in proposal, "cross_runtime_source_stop_required")
        return plan
    recovery = dict(kind="monitor-source-only-upgrade", permit=permit_ref, stop=stop)
    if "transition" in proposal:
        recovery["transition"] = proposal["transition"]
    return {**plan, "schema_version": 3, "recovery": recovery}


def checkpoint(plan_ref, plan, config, cref, continuation, contract, roots):
    """Only while both original locks are held. Never mutate either state root."""
    monitor.Config(plan["config"]["path"], plan["config"]["sha256"])
    require(read_json(roots[0] / "monitor-binding.json") == plan["config"]
            and read_json(roots[1] / "tui-continuation-binding.json") == cref,
            "upgrade_binding_changed")
    require(not any(os.path.lexists(root / "STOP") for root in roots), "upgrade_persistent_stop")
    require(not os.path.lexists(roots[1] / "monitor-stop.json"), "upgrade_persistent_stop")
    monitor_stop = compatible_old_source_stop(roots[0])
    scheduler_clear = (scheduler_review_clear_ref(roots[1] / "scheduler.json", continuation, contract, roots[1], cref)
                       if monitor_stop is not None else None)
    if monitor_stop is None:
        require(scheduler_review_allows_upgrade(roots[1] / "scheduler.json", continuation, contract, roots[1], cref),
                "upgrade_scheduler_review_required")
    source_revision_stop = compatible_source_upgrade_latch(roots[0], plan)
    source_revision_reason = source_revision_stop_reason(source_revision_stop)
    historical_observation = (historical_observation_recovery_snapshot(continuation, contract, roots[1], cref)
                              if source_revision_reason == "tui_checkpoint_not_from_completed_turn" else None)
    status = read_json(roots[0] / "deployment-status.json")
    require(status.get("schema_version") == plan["schema_version"] and status.get("plan") == plan_ref
            and status.get("verification_mode") == "native-runtime"
            and status.get("phase") == "exited", "upgrade_requires_exited_monitor")
    if historical_observation is None:
        require(status.get("first_tick_at") is not None
                and timestamp(status["started_at"]) <= timestamp(status["first_tick_at"])
                <= timestamp(status["observed_at"]), "upgrade_requires_exited_monitor")
    else:
        require(status.get("first_tick_at") is None
                and timestamp(status["started_at"]) <= timestamp(status["observed_at"]),
                "upgrade_requires_exited_monitor")
    require(status.get("status") == file_ref(roots[0] / "status.json"), "upgrade_status_changed")
    current_stop = source_revision_stop or (monitor_stop if native_deployment(plan) else None)
    require(read_json(roots[0] / "status.json").get("state") == ("stopped" if current_stop else "monitoring"),
            "upgrade_requires_clean_exit")
    outbox = read_outbox(roots[1])
    for entry in outbox["actions"].values():
        require(entry["attempted"] and entry["delivery"] and entry["claimed_at"] and entry["result"],
                "upgrade_unsettled_action")
        record = parse(pinned(entry["checkpoint"]))
        result = parse(pinned(entry["result"]))
        require(set(result) == {"action_id", "checkpoint", "status", "evidence"}
                and result["action_id"] == record["checkpoint"]["next_action"]["id"]
                and result["checkpoint"] == entry["checkpoint"] and result["status"] == "executed"
                and isinstance(result["evidence"], list) and result["evidence"],
                "upgrade_invalid_settlement")
        for ref in result["evidence"]:
            pinned(ref)
    state = read_json(roots[0] / "state.json")
    require(state.get("config") == plan["config"] and not state.get("outbox"),
            "upgrade_requires_scheduler_only_state")
    head = file_ref(continuation["checkpoint_head"])
    validate_checkpoint(parse(pinned(head)), continuation, contract)
    return dict(head=head, files=inventory(roots), monitor_stop=monitor_stop,
                source_revision_stop=source_revision_stop, scheduler_review_clear=scheduler_clear,
                historical_observation=historical_observation)


def prepare(plan_ref, output_dir, *, call=monitor.native, transition_ref=None):
    if transition_ref is not None:
        checked_transition(plan_ref, transition_ref)
        from operator_continuity_route import routed
        call = routed(call)
    plan, config, cref, continuation, contract, roots = current(plan_ref)
    call = monitor.bind_contract(call, contract)
    require(plan["python"] == str(Path(deploy.sys.executable).resolve()), "monitor_deployment_python_changed")
    output = deploy.private_directory(output_dir)
    require(not any(output.iterdir()) and all(not output.is_relative_to(r) and not r.is_relative_to(output)
            for r in roots), "upgrade_requires_fresh_output")
    new_plan = {**plan, "sources": deploy.sources()}
    require(new_plan != plan, "upgrade_sources_unchanged")
    with ExitStack() as stack:
        locks(stack, roots)
        snapshot = checkpoint(plan_ref, plan, config, cref, continuation, contract, roots)
        checked_transition(plan_ref, transition_ref, snapshot)
        observation = live(config, plan["sender"], call)
        require(snapshot == checkpoint(plan_ref, plan, config, cref, continuation, contract, roots),
                "upgrade_state_changed")
        require(new_plan["sources"] == deploy.sources(), "monitor_deployment_source_changed")
        pinned(plan_ref)
        publish_new(output / "proposal.json", dict(schema_version=1, kind="monitor-source-only-upgrade",
            prepared_at=now(), old_plan=plan_ref, new_plan=new_plan, snapshot=snapshot,
            sender_observation=observation, **({"transition": transition_ref} if transition_ref else {})))
    return file_ref(output / "proposal.json")


def apply(proposal_ref, review_ref, *, call=monitor.native):
    proposal = parse(pinned(proposal_ref))
    cross = "transition" in proposal
    expected = {"schema_version", "kind", "prepared_at", "old_plan", "new_plan",
                "snapshot", "sender_observation"} | ({"transition"} if cross else set())
    require(set(proposal) == expected
            and proposal["schema_version"] == 1
            and proposal["kind"] == "monitor-source-only-upgrade", "invalid_upgrade_proposal")
    if cross:
        checked_transition(proposal["old_plan"], proposal["transition"], proposal["snapshot"])
        from operator_continuity_route import routed
        call = routed(call)
    plan, config, cref, continuation, contract, roots = current(proposal["old_plan"])
    call = monitor.bind_contract(call, contract)
    require(proposal["new_plan"] == {**plan, "sources": deploy.sources()}
            and proposal["new_plan"] != plan
            and plan["python"] == str(Path(deploy.sys.executable).resolve()), "upgrade_revision_changed_scope")
    excluded = (plan["sender"]["terminal"], config["binding"]["terminal"])
    review = review_assertion(proposal_ref, review_ref, excluded)
    output = deploy.private_directory(str(Path(proposal_ref["path"]).parent))
    require(all(not output.is_relative_to(r) and not r.is_relative_to(output) for r in roots),
            "upgrade_output_overlaps_state")
    receipt, permit_ref = reviewed_receipt_ref(output, proposal_ref, review_ref)
    revised_plan = final_plan(proposal, permit_ref)
    target = output / "deployment.json"
    with ExitStack() as stack:
        locks(stack, roots)
        if target.exists():
            require(read_json(target) == revised_plan
                    and read_json(output / "reviewed.json") == receipt, "upgrade_publication_changed")
            deploy.validate(file_ref(target))
            return file_ref(target)  # No launch/replay, even after normal progress.
        require(proposal["snapshot"] == checkpoint(proposal["old_plan"], plan, config, cref,
                continuation, contract, roots), "upgrade_state_changed")
        live(config, plan["sender"], call)
        reviewed(proposal_ref, review_ref, config, excluded, call)
        pinned(proposal_ref)
        pinned(review_ref)
        pinned(proposal["old_plan"])
        for ref in review["evidence"]:
            pinned(review_evidence_pin(ref))
        require(proposal["snapshot"] == checkpoint(proposal["old_plan"], plan, config, cref,
                continuation, contract, roots), "upgrade_state_changed")
        require(proposal["new_plan"]["sources"] == deploy.sources(), "monitor_deployment_source_changed")
        if (output / "reviewed.json").exists():
            require(read_json(output / "reviewed.json") == receipt, "upgrade_publication_changed")
        else:
            publish_new(output / "reviewed.json", receipt)
        publish_new(target, revised_plan)
        deploy.validate(file_ref(target))
    return file_ref(target)


def deployment_recovery(plan):
    """Validate a source-upgrade plan that preserves one old-source stop."""
    require(source_upgrade_deployment(plan), "upgrade_invalid_deployment")
    recovery = plan["recovery"]
    cross = "transition" in recovery
    expected_recovery = {"kind", "permit", "stop"} | ({"transition"} if cross else set())
    require(set(recovery) == expected_recovery
            and recovery["kind"] == "monitor-source-only-upgrade", "upgrade_invalid_deployment")
    permit = parse(pinned(recovery["permit"]))
    require(set(permit) == {"schema_version", "kind", "state", "proposal", "review"}
            and permit["schema_version"] == 1 and permit["kind"] == "monitor-source-only-upgrade"
            and permit["state"] == "reviewed_not_started", "upgrade_invalid_deployment")
    proposal = parse(pinned(permit["proposal"]))
    expected_proposal = {"schema_version", "kind", "prepared_at", "old_plan", "new_plan",
                         "snapshot", "sender_observation"} | ({"transition"} if cross else set())
    require(set(proposal) == expected_proposal
            and proposal["schema_version"] == 1
            and proposal["kind"] == "monitor-source-only-upgrade", "upgrade_invalid_deployment")
    if cross:
        from operator_continuity_route import validate
        transition = validate(recovery["transition"])
        require(proposal["transition"] == recovery["transition"]
                and transition["old_plan"] == proposal["old_plan"]
                and transition["snapshot"] == proposal["snapshot"], "cross_runtime_source_state_changed")
    old = parse(pinned(proposal["old_plan"]))
    old_config = parse(pinned(old["config"]))
    if source_upgrade_deployment(old):
        deployment_recovery(old)
    require((native_deployment(old) or source_upgrade_deployment(old))
            and proposal["new_plan"] == {**old, "sources": proposal["new_plan"].get("sources")}
            and proposal["new_plan"] != old, "upgrade_invalid_deployment")
    review_assertion(permit["proposal"], permit["review"],
                     (old["sender"]["terminal"], old_config["binding"]["terminal"]),
                     verify_evidence=False)
    require(Path(recovery["permit"]["path"]) == Path(permit["proposal"]["path"]).parent / "reviewed.json"
            and file_ref(recovery["permit"]["path"]) == recovery["permit"], "upgrade_invalid_deployment")
    require(recovery["stop"] == proposal["snapshot"].get("monitor_stop")
            and recovery["stop"]["path"] == str(Path(old_config["state_root"]) / "monitor-stop.json"),
            "upgrade_invalid_deployment")
    stop = parse(pinned(recovery["stop"]))
    require(set(stop) == {"at", "reason"} and stop["reason"] == "tui_scheduler_journal_invalid"
            and timestamp(stop["at"]), "upgrade_persistent_stop")
    clear = proposal["snapshot"].get("scheduler_review_clear")
    require(isinstance(clear, dict) and set(clear) == {"receipt", "review"},
            "upgrade_scheduler_review_required")
    require(parse(pinned(clear["receipt"])) == clear["review"],
            "upgrade_scheduler_review_required")
    source_stop = proposal["snapshot"].get("source_revision_stop")
    if source_stop is not None:
        require(source_upgrade_deployment(old)
                and source_stop["path"] == str(Path(old_config["state_root"]) /
                    ("recovery-stop-" + old["recovery"]["permit"]["sha256"] + ".json"))
                and file_ref(source_stop["path"]) == source_stop,
                "upgrade_source_revision_stop")
        reason = source_revision_stop_reason(source_stop)
        historical = proposal["snapshot"].get("historical_observation")
        if reason == "tui_checkpoint_not_from_completed_turn":
            require(isinstance(historical, dict)
                    and historical.get("state") == "awaiting_fresh_checkpoint"
                    and historical.get("reason") == "historical_checkpoint_not_sendable"
                    and isinstance(historical.get("checkpoint"), dict)
                    and isinstance(historical.get("historical_turn"), str)
                    and historical.get("scheduler_review_clear") == clear,
                    "upgrade_historical_observation_required")
        else:
            require(historical is None, "upgrade_historical_observation_required")
    require(plan == final_plan(proposal, recovery["permit"]), "upgrade_invalid_deployment")
    return recovery


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("prepare")
    for key in ("plan", "plan-sha256", "output-dir"):
        p.add_argument("--" + key, required=True)
    p.add_argument("--transition")
    p.add_argument("--transition-sha256")
    p = sub.add_parser("apply")
    for key in ("proposal", "proposal-sha256", "review", "review-sha256"):
        p.add_argument("--" + key, required=True)
    p.add_argument("--execute", action="store_true")
    args = parser.parse_args(argv)
    def optional_transition():
        has_path = bool(getattr(args, "transition", None))
        has_hash = bool(getattr(args, "transition_sha256", None))
        require(has_path == has_hash, "cross_runtime_transition_pin_required")
        if not has_path:
            return None
        return dict(path=args.transition, sha256=args.transition_sha256)
    if args.command == "prepare":
        plan_ref = dict(path=args.plan, sha256=args.plan_sha256)
        transition_ref = optional_transition()
        if transition_ref is None:
            ref = prepare(plan_ref, args.output_dir, call=monitor.native)
        else:
            from operator_continuity_route import scope
            with scope(transition_ref, "prepare", dict(plan=plan_ref)):
                ref = prepare(plan_ref, args.output_dir, call=monitor.native, transition_ref=transition_ref)
        result = dict(state="awaiting_external_review", proposal=ref, execution_authorized=False)
    else:
        require(args.execute, "upgrade_execute_required")
        proposal_ref = dict(path=args.proposal, sha256=args.proposal_sha256)
        review_ref = dict(path=args.review, sha256=args.review_sha256)
        proposal = parse(pinned(proposal_ref))
        if isinstance(proposal, dict) and "transition" in proposal:
            from operator_continuity_route import scope
            with scope(proposal["transition"], "apply", dict(proposal=proposal_ref, review=review_ref)):
                ref = apply(proposal_ref, review_ref, call=monitor.native)
        else:
            ref = apply(proposal_ref, review_ref, call=monitor.native)
        result = dict(state="reviewed_not_started", plan=ref, execution_authorized=False)
    print(canonical(result).decode())


if __name__ == "__main__":
    main()

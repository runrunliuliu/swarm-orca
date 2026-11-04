"""Explicit, audited correction of a deployment that failed before its first tick.

Never clear stop/outbox/claim history. Prepare is inert; apply holds both original
locks, journals invalidation before rebinding, and publishes the commit last.
The review is an external assertion, not a grant of authority or process proof.
"""

import argparse
from contextlib import ExitStack
import os
from pathlib import Path

import operator_monitor as monitor
import operator_monitor_deploy as deploy
from coordinator_io import (canonical, correction_fence, directory_lock, file_ref, now, parse, pinned,
                            publish_new, read_bytes, read_json, replace_json, require, timestamp)
from coordinator_tui_checkpoint import validate_checkpoint
from coordinator_tui_continue import validate_config


def original(plan_ref):
    plan = parse(pinned(plan_ref))
    require(set(plan) == {"schema_version", "verification_mode", "config", "sources", "python", "sender"}
            and plan["schema_version"] == 2 and plan["verification_mode"] == "native-runtime",
            "correction_requires_native_deployment")
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


def live(config, sender, call):
    """Native target observations; the later monitor still proves its own caller."""
    b = config["binding"]
    result = call(["orchestration", "run-show", "--id", b["run"]], b["runtime"], 20)
    r = result.get("run", {})
    require(result.get("coordinatorPolicy") == "strict-v1" and not result.get("strictRetirement")
            and r.get("id") == b["run"] and r.get("coordinator_handle") == b["terminal"]
            and type(r.get("consumer_generation")) is int and r["consumer_generation"] == b["generation"],
            "correction_run_changed")
    t = call(["terminal", "show", "--terminal", b["terminal"]], b["runtime"], 20).get("terminal", {})
    require(all(t.get(k) == b[v] for k, v in (("handle", "terminal"), ("incarnationId", "incarnation"),
                ("worktreeId", "workspace"))) and t.get("connected") is True and t.get("orphaned") is False
            and isinstance(t.get("agentIdentity"), str) and t["agentIdentity"].strip(),
            "correction_coordinator_changed")
    require(sender["terminal"] != b["terminal"], "invalid_monitor_sender")
    return monitor.sender_preflight(sender, b["runtime"], lambda args, runtime: call(args, runtime, 20))


def inventory(roots):
    allowed = ({"monitor.lock", "monitor-binding.json", "deployment-status.json", "binding-correction.json"},
               {"tui-continuation.lock", "tui-continuation-binding.json", "binding-correction.json"})
    for root, names in zip(roots, allowed):
        require(all(p.name in names and p.is_file() and not p.is_symlink() for p in root.iterdir()),
                "correction_requires_unstarted_state")


def locks(stack, roots, *, create=True):
    for root, name in sorted(zip(roots, ("monitor", "tui-continuation"))):
        stack.enter_context(directory_lock(root, name, create=create))


def failed_before_tick(status, plan_ref):
    require(isinstance(status, dict) and set(status) == {
        "schema_version", "plan", "started_at", "first_tick_at", "phase", "status", "observed_at"}
        and status["schema_version"] == 2 and status["plan"] == plan_ref
        and status["phase"] == "exited" and status["first_tick_at"] is None and status["status"] is None,
        "correction_requires_prelaunch_failure")
    require(timestamp(status["started_at"]) <= timestamp(status["observed_at"]),
            "correction_invalid_failure_time")


def prepare(plan_ref, sender, output_dir, *, call=monitor.native):
    plan, config, cref, continuation, contract, roots = original(plan_ref)
    output = deploy.private_directory(output_dir)
    require(not any(output.iterdir()) and all(not output.is_relative_to(r) and not r.is_relative_to(output)
            for r in roots), "correction_requires_fresh_output")
    require(sender != plan["sender"], "correction_sender_unchanged")
    with ExitStack() as stack:
        locks(stack, roots)
        inventory(roots)
        require(not any(os.path.lexists(r / "binding-correction.json") for r in roots),
                "correction_already_prepared")
        require(read_json(roots[0] / "monitor-binding.json") == plan["config"]
                and read_json(roots[1] / "tui-continuation-binding.json") == cref,
                "correction_original_binding_mismatch")
        status = read_json(roots[0] / "deployment-status.json")
        failed_before_tick(status, plan_ref)
        # Validate the complete old execution configuration before making a revision.
        monitor.Config(plan["config"]["path"], plan["config"]["sha256"])
        head = file_ref(continuation["checkpoint_head"])
        validate_checkpoint(parse(pinned(head)), continuation, contract)
        observation = live(config, sender, call)
        saved = []
        for i, root in enumerate(roots):
            for p in sorted(root.iterdir()):
                if p.name.endswith(".lock"):
                    continue
                target = output / (str(i) + "-before-" + p.name)
                publish_new(target, read_bytes(p))
                saved.append(dict(target=str(p), before=file_ref(target)))
        new_continuation = {**continuation, "scheduler": sender}
        publish_new(output / "continuation.json", new_continuation)
        new_cref = file_ref(output / "continuation.json")
        new_config = {**config, "sender": sender, "continuation": new_cref}
        monitor.Config.__new__(monitor.Config).validate(new_config)
        publish_new(output / "monitor.json", new_config)
        new_plan = {**plan, "config": file_ref(output / "monitor.json"), "sender": sender,
                    "sources": deploy.sources(), "python": str(Path(deploy.sys.executable).resolve())}
        publish_new(output / "deployment.json", new_plan)
        live(config, sender, call)
        pinned(head)
        require(new_plan["sources"] == deploy.sources(), "monitor_deployment_source_changed")
        proposal = dict(schema_version=1, kind="unstarted-sender-correction", prepared_at=now(),
                        old_plan=plan_ref, new_plan=file_ref(output / "deployment.json"),
                        old_continuation=cref, new_continuation=new_cref,
                        checkpoint_head=head, snapshots=saved, sender_observation=observation)
        publish_new(output / "proposal.json", proposal)
        return file_ref(output / "proposal.json")


def apply(proposal_ref, review_ref, *, call=monitor.native):
    proposal = parse(pinned(proposal_ref))
    require(set(proposal) == {"schema_version", "kind", "prepared_at", "old_plan", "new_plan",
            "old_continuation", "new_continuation", "checkpoint_head", "snapshots", "sender_observation"}
            and proposal["schema_version"] == 1 and proposal["kind"] == "unstarted-sender-correction",
            "invalid_correction_proposal")
    review = parse(pinned(review_ref))
    require(set(review) == {"schema_version", "proposal", "approved", "reviewer", "evidence", "reason"}
            and review["schema_version"] == 1 and review["proposal"] == proposal_ref
            and review["approved"] is True and isinstance(review["reason"], str) and review["reason"].strip()
            and isinstance(review["evidence"], list) and review["evidence"], "correction_external_review_required")
    for ref in review["evidence"]:
        pinned(ref)
    plan, config, cref, continuation, contract, roots = original(proposal["old_plan"])
    new_plan = parse(pinned(proposal["new_plan"]))
    new_config = parse(pinned(new_plan["config"]))
    new_continuation = parse(pinned(proposal["new_continuation"]))
    sender = new_plan["sender"]
    require(proposal["old_continuation"] == cref and sender != plan["sender"]
            and new_continuation == {**continuation, "scheduler": sender}
            and new_config == {**config, "sender": sender, "continuation": proposal["new_continuation"]}
            and new_plan == {**plan, "sender": sender, "config": new_plan["config"],
                             "sources": deploy.sources(), "python": str(Path(deploy.sys.executable).resolve())},
            "correction_revision_changed_scope")
    validate_config(new_continuation)
    # Equality above limits the revision to sender/pins. Config.validate loads
    # live state and must not run here: an interrupted transaction is fenced
    # until this very operation publishes its final commit.
    require(proposal["checkpoint_head"]["path"] == continuation["checkpoint_head"],
            "correction_checkpoint_changed")
    reviewer = review["reviewer"]
    require(isinstance(reviewer, dict) and set(reviewer) == {"terminal", "incarnation", "workspace"}
            and reviewer["terminal"] not in (sender["terminal"], config["binding"]["terminal"]),
            "correction_independent_reviewer_required")
    output = deploy.private_directory(str(Path(proposal_ref["path"]).parent))
    commit_path = output / "committed.json"
    bindings = (new_plan["config"], proposal["new_continuation"])
    targets = (roots[0] / "monitor-binding.json", roots[1] / "tui-continuation-binding.json")
    expected = {str(targets[0]), str(targets[1]), str(roots[0] / "deployment-status.json")}
    require(isinstance(proposal["snapshots"], list) and len(proposal["snapshots"]) == 3
            and all(isinstance(s, dict) and set(s) == {"target", "before"} for s in proposal["snapshots"])
            and {s["target"] for s in proposal["snapshots"]} == expected,
            "correction_snapshot_scope_changed")
    saved = {s["target"]: parse(pinned(s["before"])) for s in proposal["snapshots"]}
    require(saved[str(targets[0])] == plan["config"] and saved[str(targets[1])] == cref,
            "correction_original_binding_mismatch")
    failed_before_tick(saved[str(roots[0] / "deployment-status.json")], proposal["old_plan"])
    with ExitStack() as stack:
        locks(stack, roots)
        if os.path.lexists(commit_path):
            commit = read_json(commit_path)
            require(commit.get("proposal") == proposal_ref and commit.get("review") == review_ref
                    and commit.get("state") == "committed", "correction_commit_changed")
            deploy.validate(proposal["new_plan"])
            for root, binding in zip(roots, bindings):
                require(read_json(root / "binding-correction.json") == dict(
                    proposal=proposal_ref, new_binding=binding, commit_path=str(commit_path)),
                    "correction_conflicting_transaction")
                correction_fence(root, binding)
            return file_ref(commit_path)  # Idempotent even after normal monitor progress.
        inventory(roots)
        validate_checkpoint(parse(pinned(proposal["checkpoint_head"])), continuation, contract)
        for snapshot in proposal["snapshots"]:
            before = pinned(snapshot["before"])
            target = Path(snapshot["target"])
            current = read_bytes(target)
            require(current == before or (target in targets and parse(current) == bindings[targets.index(target)]
                    and os.path.lexists(target.parent / "binding-correction.json")),
                    "correction_state_changed")
        live(config, sender, call)
        t = call(["terminal", "show", "--terminal", reviewer["terminal"]], config["binding"]["runtime"], 20).get("terminal", {})
        require(all(t.get(k) == reviewer[v] for k, v in (("handle", "terminal"), ("incarnationId", "incarnation"),
                ("worktreeId", "workspace"))) and t.get("connected") is True and t.get("orphaned") is False
                and isinstance(t.get("agentIdentity"), str) and t["agentIdentity"].strip(),
                "correction_reviewer_unverifiable")
        pinned(proposal_ref)
        pinned(review_ref)
        for ref in review["evidence"]:
            pinned(ref)
        require(new_plan["sources"] == deploy.sources(), "monitor_deployment_source_changed")
        for root, binding in zip(roots, bindings):
            marker = dict(proposal=proposal_ref, new_binding=binding, commit_path=str(commit_path))
            target = root / "binding-correction.json"
            if os.path.lexists(target):
                require(read_json(target) == marker, "correction_conflicting_transaction")
            else:
                publish_new(target, marker)
        for target, binding in zip(targets, bindings):
            replace_json(target, binding)
        publish_new(commit_path, dict(schema_version=1, state="committed", proposal=proposal_ref,
                    review=review_ref, old_plan=proposal["old_plan"], new_plan=proposal["new_plan"], committed_at=now()))
        return file_ref(commit_path)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("prepare")
    for key in ("plan", "plan-sha256", "sender", "sender-sha256", "output-dir"):
        p.add_argument("--" + key, required=True)
    p = sub.add_parser("apply")
    for key in ("proposal", "proposal-sha256", "review", "review-sha256"):
        p.add_argument("--" + key, required=True)
    p.add_argument("--execute", action="store_true")
    args = parser.parse_args(argv)
    if args.command == "prepare":
        ref = prepare(dict(path=args.plan, sha256=args.plan_sha256),
                      parse(pinned(dict(path=args.sender, sha256=args.sender_sha256))), args.output_dir)
        result = dict(state="awaiting_external_review", proposal=ref, execution_authorized=False)
    else:
        require(args.execute, "correction_execute_required")
        ref = apply(dict(path=args.proposal, sha256=args.proposal_sha256), dict(path=args.review, sha256=args.review_sha256))
        result = dict(state="committed_not_started", receipt=ref, execution_authorized=False)
    print(canonical(result).decode())


if __name__ == "__main__":
    main()

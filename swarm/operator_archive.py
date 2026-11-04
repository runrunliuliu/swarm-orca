"""Add an independently approved task-private archive parent before TUI launch.

Rebuild the existing strict planner; never launch, create a Run, repair permissions
or claim an Agent file-tool probe. The actual Run child is bound after Run creation.
"""

import argparse
import errno
import json
import os
from pathlib import Path
import sys

from coordinator_io import file_ref, now, parse, path, pinned, publish_new, require, scoped_refs
from coordinator_strict import strict_plan
from trae_coordinator import build_trae_plan
from evidence_policy import directory_identity
import coordinator_snapshots as snapshots_io


def prepare(ref):
    spec = parse(pinned(ref))
    require(isinstance(spec, dict) and set(spec) == {
        "schema_version", "directory", "read_roots", "write_roots", "launch_plan", "archive_parent"}
        and type(spec["schema_version"]) is int and spec["schema_version"] == 1,
        "invalid_operator_archive_input")
    from operator_prepare import directories
    read_roots, write_roots = directories(spec["read_roots"]), directories(spec["write_roots"])
    directory = path(spec["directory"], directory=True)
    archive = path(spec["archive_parent"], directory=True)
    for target in (directory, archive):
        info = target.stat()
        require(info.st_uid == os.getuid() and info.st_mode & 0o777 == 0o700,
                "private_archive_directory_required")
        require(any(target.is_relative_to(root) for root in write_roots), "archive_outside_write_scope")
    require(not any(directory.iterdir()), "archive_attempt_not_empty")
    require(directory != archive and not directory.is_relative_to(archive)
            and not archive.is_relative_to(directory), "archive_attempt_overlap")
    identities = [directory_identity(target) for target in (directory, archive)]

    def recheck_directories():
        for expected in identities:
            target = path(expected["path"], directory=True)
            require(directory_identity(target) == expected, "archive_directory_changed")

    scoped_refs([ref, spec["launch_plan"]], read_roots, [directory])
    plan = parse(pinned(spec["launch_plan"]))
    require(plan.get("strict_coordinator") is True and plan.get("phase") == "strict-tui-bootstrap",
            "archive_requires_fresh_strict_tui_plan")
    # Reject a shared ancestor (worktree, bootstrap, or any existing task root)
    # even when a broad write scope was mistakenly supplied. Scope review still
    # belongs to the outer Operator; mode 0700 alone is not authorization.
    for value in [plan["cwd"], *plan["task_write_roots"]]:
        existing = path(value, directory=True)
        require(existing != archive and not existing.is_relative_to(archive), "archive_parent_too_broad")
    sources = [ref, spec["launch_plan"]]
    for key in ("runtime_config", "prompt_file"):
        target = path(plan[key])
        require(any(target.is_relative_to(root) for root in read_roots)
                and not target.is_relative_to(directory), "progress_artifact_outside_scope")
        sources.append(file_ref(target))
    scoped_refs(sources, read_roots, [directory])
    snapshots = snapshots_io.collect(sources)

    def rebuild(roots):
        return strict_plan(build_trae_plan(
            trae=plan["native_launch"]["verified_executable"], cwd=plan["cwd"], archive_dir=None,
            bootstrap_dir=plan["artifact_dirs"]["archive"], write_dirs=roots,
            selection=plan["selection"], runtime_config=plan["runtime_config"],
            prompt_file=plan["prompt_file"], resume_session=None))

    require(rebuild(plan["task_write_roots"]) == plan, "strict_native_plan_changed")
    prepared = rebuild([*plan["task_write_roots"], str(archive)])
    recheck_directories()
    publish_new(directory / "archive-intent.json", {
        "schema_version": 1, "input": ref, "started_at": now(), "execution_authorized": False})
    mappings, _ = snapshots_io.publish(directory, snapshots, prefix="source", publisher=publish_new)
    snapshots_io.recheck(snapshots)
    require(rebuild(prepared["task_write_roots"]) == prepared, "archive_plan_drift")
    for item in mappings:
        pinned(item["snapshot"])
    recheck_directories()
    target = directory / "launch-plan.json"
    publish_new(target, prepared)
    result = {"schema_version": 1, "ok": True, "status": "awaiting_external_audit",
              "input": ref, "launch_plan": file_ref(target), "archive_parent": str(archive),
              "run_id": None, "run_archive_rule": "archive_parent/<actual-native-run-id>",
              "required_session_write_roots": prepared["task_write_roots"],
              "file_tool_probe_verified": False, "git_writes_verified": False,
              "execution_authorized": False, "completed_at": now(), "snapshots": mappings}
    recheck_directories()
    publish_new(directory / "prepared.json", result)
    return {key: value for key, value in result.items() if key != "snapshots"}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True)
    parser.add_argument("--input-sha256", required=True, help="independently reviewed RAW input digest")
    parser.add_argument("--execute", action="store_true", help="publish local plan only; no launch")
    args = parser.parse_args(argv)
    try:
        require(args.execute, "archive_prepare_explicit_execute_required")
        result = prepare({"path": args.input, "sha256": args.input_sha256})
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
        result = {"ok": False, "decision": "stop", "execution_authorized": False,
                  "error": "operator_archive_failed_preserve_attempt_and_check_scope",
                  "error_type": type(exc).__name__}
        if isinstance(exc, OSError):
            result["os_error"] = errno.errorcode.get(exc.errno, "UNKNOWN")
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())

"""Pre-session static preparation and thin Operator adapters. Never launch or issue gates.

prepare publishes local evidence only, ending at awaiting_external_audit.
native-plan delegates the existing strict Coordinator planner, not a second launcher.
observe-session delegates the existing Trae TUI Coordinator reader after a session exists;
observe-operator delegates the reviewed Operator runtime-state reader.
"""

import argparse
import errno
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

import coordinator_snapshots as snapshots_io
from coordinator_io import file_ref, now, parse, path, pinned, publish_new, scoped_refs
from coordinator_task_source import task_source_refs, task_source_summary
# Only the provider/Run-independent, read-only Git primitive is reused here.
from native_preflight import PreflightError, _baseline_check, _default_runner


class PrepareError(ValueError):
    pass


SAFE_STRICT_TASK_ERRORS = {
    "strict_config_task_source_invalid",
    "strict_config_task_source_scope_mismatch",
    "strict_config_task_invalid",
    "strict_config_recovery_note_invalid",
}


def safe_error(exc, fallback):
    message = str(exc)
    return message if message in SAFE_STRICT_TASK_ERRORS else fallback


def require(value, code):
    if not value:
        raise PrepareError(code)


def named(value):
    return isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", value)


def directories(values):
    require(isinstance(values, list) and values, "operator_prepare_roots_required")
    result = [path(value, directory=True) for value in values]
    require(len(set(result)) == len(result) and all(
        p != Path(p.anchor) and not any(p == root or p.is_relative_to(root)
                                      for root in map(Path, ("/proc", "/sys", "/dev")))
        for p in result), "operator_prepare_task_roots_required")
    return result


def reviewed(ref):
    source = parse(pinned(ref))
    required = {
        "schema_version", "preparation_id", "directory", "read_roots", "write_roots",
        "baselines", "sources", "authority_refs"}
    task_fields = {"task_source", "task_workspace", "recovery_note"}
    require(isinstance(source, dict) and required <= set(source) <= required | task_fields
        and type(source["schema_version"]) is int and source["schema_version"] == 1,
        "operator_prepare_input_invalid")
    present_task_fields = set(source) & task_fields
    require(not present_task_fields or {"task_source", "task_workspace"} <= set(source),
            "operator_prepare_task_source_required")
    require(named(source["preparation_id"]), "operator_prepare_id_invalid")
    read_roots, write_roots = directories(source["read_roots"]), directories(source["write_roots"])
    directory = path(source["directory"], directory=True)
    require(any(directory.is_relative_to(root) for root in write_roots),
            "operator_prepare_output_outside_scope")
    info = directory.stat()
    require(info.st_uid == os.getuid() and info.st_mode & 0o777 == 0o700,
            "operator_prepare_private_directory_required")
    require(not any(directory.iterdir()), "operator_prepare_directory_not_empty")
    require(isinstance(source["sources"], list) and source["sources"], "operator_prepare_sources_required")
    names, refs = set(), [ref]
    for item in source["sources"]:
        require(isinstance(item, dict) and set(item) == {"name", "ref", "format"}
                and named(item["name"]) and item["name"] not in names
                and item["format"] in ("bytes", "json"), "operator_prepare_source_invalid")
        names.add(item["name"])
        refs.append(item["ref"])
    require(isinstance(source["authority_refs"], list) and source["authority_refs"],
            "operator_prepare_authority_references_required")
    refs.extend(source["authority_refs"])
    business_task = None
    if present_task_fields:
        business_task = {"task_source": source["task_source"], "workspace": source["task_workspace"],
                         "recovery_note": source.get("recovery_note")}
        refs.append(source["task_source"])
    # Check scope before reading source contents. Explicit list only: never scan
    # a tree that could include the manifest, credentials or unrelated sessions.
    scoped_refs(refs, read_roots, [directory])
    task_authority_refs = []
    task_summary = None
    if business_task is not None:
        task_refs = task_source_refs(business_task)
        require(task_refs[0] == source["task_source"], "operator_prepare_task_source_required")
        task_authority_refs = task_refs[1:]
        scoped_refs(task_authority_refs, read_roots, [directory])
        refs.extend(task_authority_refs)
        task_summary = task_source_summary(business_task)
    snapshots = snapshots_io.collect(refs)
    for item in source["sources"]:
        if item["format"] == "json":
            parse(snapshots[(item["ref"]["path"], item["ref"]["sha256"])][1])
    require(isinstance(source["baselines"], list) and source["baselines"],
            "operator_prepare_baselines_required")
    names, locations = set(), set()
    for baseline in source["baselines"]:
        require(isinstance(baseline, dict) and set(baseline) == {"name", "path", "head", "clean"}
                and named(baseline["name"]) and baseline["name"] not in names
                and isinstance(baseline["head"], str)
                and re.fullmatch(r"(?:[a-f0-9]{40}|[a-f0-9]{64})", baseline["head"])
                and type(baseline["clean"]) is bool, "operator_prepare_baseline_invalid")
        target = path(baseline["path"], directory=True)
        require(target not in locations and any(target.is_relative_to(root) for root in read_roots),
                "operator_prepare_baseline_outside_scope_or_duplicate")
        # Preparation output must not dirty or recursively consume a baseline.
        require(not directory.is_relative_to(target) and not target.is_relative_to(directory),
                "operator_prepare_output_overlaps_baseline")
        names.add(baseline["name"])
        locations.add(target)
    return source, directory, snapshots, task_summary, task_authority_refs


def prepare(ref):
    started_at, started = now(), time.monotonic()
    source, directory, snapshots, task_summary, task_authority_refs = reviewed(ref)
    # A Git environment override could bind an explicit cwd to a different repo.
    require(not any(key in os.environ for key in (
        "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR")),
        "operator_prepare_git_context_override")
    query_seconds, query_count = 0.0, 0

    def runner(argv, timeout):
        nonlocal query_seconds, query_count
        before = time.monotonic()
        try:
            result = _default_runner(argv, timeout)
            require(result.returncode == 0, "operator_prepare_git_query_failed")
            return result
        finally:
            query_seconds += time.monotonic() - before
            query_count += 1

    def baselines():
        results = []
        for item in source["baselines"]:
            top = runner(["git", "--no-optional-locks", "-C", item["path"],
                          "rev-parse", "--show-toplevel"], 10)
            require(top.stdout.decode().strip() == item["path"], "operator_prepare_git_root_mismatch")
            results.append(_baseline_check(item, 10, runner))
        return results

    baseline_before = baselines()
    publish_new(directory / "prepare-intent.json", {
        "schema_version": 1, "kind": "operator_static_preparation_intent",
        "preparation_id": source["preparation_id"], "input": ref, "started_at": started_at})
    mappings, frozen = snapshots_io.publish(directory, snapshots, prefix="source", publisher=publish_new)
    baseline_after = baselines()
    require(baseline_after == baseline_before, "operator_prepare_baseline_drift")
    snapshots_io.recheck(snapshots)
    for item in mappings:
        pinned(item["snapshot"])

    def frozen_ref(item):
        return frozen[(item["path"], item["sha256"])]

    completed_at = now()
    timing = {
        "prepare_started_at": started_at, "checks_completed_at": completed_at,
        "awaiting_external_audit_at": completed_at,
        "checks_wall_seconds": time.monotonic() - started,
        "git_query_seconds": query_seconds, "git_query_count": query_count,
        "operator_started_at": None, "model_responses": None, "audit_wait_seconds": None,
        "coordinator_started_at": None, "run_created_at": None, "first_worker_tool_at": None}
    manifest = {
        "schema_version": 1, "kind": "operator_static_prepared",
        "status": "awaiting_external_audit", "preparation_id": source["preparation_id"],
        "input": ref, "input_snapshot": frozen_ref(ref), "snapshots": mappings,
        "sources": [{**item, "snapshot": frozen_ref(item["ref"])} for item in source["sources"]],
        "authority_snapshots": [frozen_ref(item) for item in source["authority_refs"]],
        "declared_scope": {key: source[key] for key in ("read_roots", "write_roots")},
        "baselines": [{"expected": expected, "observed": observed}
                      for expected, observed in zip(source["baselines"], baseline_after)],
        "timing": timing, "run_id": None,
        "authority_interpreted": False, "operator_identity_verified": False,
        "file_tool_probe_verified": False, "git_writes_verified": False,
        "execution_authorized": False}
    if task_summary is not None:
        manifest["business_task"] = {**task_summary,
            "task_source_snapshot": frozen_ref(task_summary["task_source"]),
            "authorization_snapshots": [frozen_ref(item) for item in task_authority_refs]}
    # Sole handoff/commit point. Partial attempts have no consumable manifest;
    # exclusive publication wins concurrent claims without overwriting evidence.
    target = directory / "prepared.json"
    publish_new(target, manifest)
    return {"ok": True, "kind": manifest["kind"], "status": manifest["status"],
            "preparation_id": source["preparation_id"], "preparation": file_ref(target),
            "source_count": len(source["sources"]), "snapshot_count": len(mappings),
            "timing": timing, "execution_authorized": False,
            "next_step": "independent_external_audit_of_sources_scope_and_baselines"}


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv and argv[0] == "trust-workspace":
        from operator_trust import main as trust_main
        return trust_main(argv[1:])
    if argv and argv[0] == "check-authority":
        from operator_authority import main as authority_main
        return authority_main(argv[1:])
    if argv and argv[0] == "archive-plan":
        from operator_archive import main as archive_main
        return archive_main(argv[1:])
    if argv and argv[0] == "assemble-materials":
        from operator_materials import main as materials_main
        return materials_main(argv[1:])
    if argv and argv[0] == "native-plan":
        from coordinator_strict import cli_main
        return cli_main(["strict-native-plan", *argv[1:]])
    if argv and argv[0] in ("observe-session", "observe-coordinator"):
        from operator_session import main as observe_main
        return observe_main(["observe-coordinator", *argv[1:]])
    if argv and argv[0] == "observe-operator":
        from operator_session import main as observe_main
        return observe_main(argv)
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="mode", required=True)
    local = commands.add_parser("prepare", help="freeze static inputs; stop at external audit")
    local.add_argument("--input", required=True)
    local.add_argument("--input-sha256", required=True)
    local.add_argument("--execute", action="store_true", help="publish local files only")
    # Detailed flags/help are delegated above, avoiding a second CLI schema.
    commands.add_parser("native-plan", add_help=False, help="use existing strict-native-plan (--help)")
    commands.add_parser("observe-operator", add_help=False, help="save Operator identity/runtime-state observation (--help)")
    commands.add_parser("observe-coordinator", add_help=False, help="save Coordinator TUI observation (--help)")
    commands.add_parser("observe-session", add_help=False,
                        help="legacy alias for observe-coordinator (--help)")
    commands.add_parser("check-authority", add_help=False, help="check pinned RSI inputs and publish a receipt (--help)")
    commands.add_parser("archive-plan", add_help=False, help="include a reviewed task archive parent before launch (--help)")
    commands.add_parser("assemble-materials", add_help=False, help="generate reviewed handoff, launch plan and checklist (--help)")
    commands.add_parser("trust-workspace", add_help=False, help="register an authorized exact Trae workspace (--help)")
    args = parser.parse_args(argv)
    try:
        require(args.execute, "operator_prepare_explicit_execute_required")
        result = prepare({"path": args.input, "sha256": args.input_sha256})
    except (OSError, ValueError, KeyError, TypeError, AttributeError, subprocess.SubprocessError) as exc:
        result = {"ok": False, "decision": "stop", "execution_authorized": False,
                  "error": str(exc) if isinstance(exc, (PrepareError, PreflightError)) else
                  safe_error(exc, "operator_prepare_failed_preserve_attempt_and_check_pins")}
        if isinstance(exc, OSError) and exc.errno is not None:
            result["os_error"] = errno.errorcode.get(exc.errno, "UNKNOWN")
        print(json.dumps(result))
        return 2
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

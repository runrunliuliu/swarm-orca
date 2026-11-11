"""Deterministic pre-launch material assembly; never starts Agents, Runs or gates."""

import argparse
import errno
import json
import os
from pathlib import Path
import re
import subprocess

from coordinator_input import bind_prompt, digest, input_bytes
from coordinator_io import (file_ref, now, parse, path, pinned, publish_new,
                            scoped_refs, validate_ref)
from coordinator_launch import build_plan
import coordinator_snapshots as snapshots_io
from coordinator_task_source import task_source_refs, task_source_summary
from native_preflight import PreflightError, _baseline_check, _default_runner


class MaterialsError(ValueError):
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
        raise MaterialsError(code)


def named(value):
    return isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", value)


def directories(values):
    require(isinstance(values, list) and values, "operator_materials_roots_required")
    result = [path(value, directory=True) for value in values]
    require(len(set(result)) == len(result) and all(
        p != Path(p.anchor) and not any(p == root or p.is_relative_to(root)
                                      for root in map(Path, ("/proc", "/sys", "/dev")))
        for p in result), "operator_materials_roots_required")
    return result


def ref_list(value, *, required=False):
    require(isinstance(value, list) and (value or not required), "operator_materials_refs_invalid")
    for ref in value:
        validate_ref(ref)
    return value


def unique_refs(refs):
    result = []
    for ref in refs:
        validate_ref(ref)
        if ref not in result:
            result.append(ref)
    return result


def launch_config_refs(launch):
    refs = []
    for key in ("model_config", "runtime_config", "trae_runtime_config"):
        if key in launch:
            refs.append(file_ref(path(launch[key])))
    # Why: a Pi launch's reviewed input is the pi policy, and it is a required
    # input of that branch — it must be pinned like the other launch configs, not
    # only re-read later by the reader.
    if "pi_policy" in launch:
        refs.append(file_ref(path(launch["pi_policy"])))
    return refs


def launch_kwargs(launch, handoff):
    require(isinstance(launch, dict) and isinstance(launch.get("agent"), str),
            "operator_materials_launch_invalid")
    agent = launch["agent"]
    common = {"cwd": launch.get("cwd"), "write_dirs": launch.get("write_dirs", [])}
    require(isinstance(common["write_dirs"], list), "operator_materials_launch_invalid")
    if agent == "codex":
        fields = {"agent", "codex", "cwd", "archive_dir", "write_dirs", "model_config", "runtime_config"}
        require(set(launch) == fields, "operator_materials_launch_invalid")
        return dict(codex=launch["codex"], archive_dir=launch["archive_dir"],
                    model_config=launch["model_config"], runtime_config=launch["runtime_config"],
                    **common)
    if agent == "trae":
        allowed = {"agent", "trae", "cwd", "archive_dir", "bootstrap_dir", "write_dirs",
                   "model_config", "trae_runtime_config", "resume_session", "replacement_run",
                   "strict_coordinator", "registered_bootstrap", "reviewed_inputs", "helper_root"}
        require(set(launch) <= allowed and {"trae", "cwd", "model_config", "trae_runtime_config"} <= set(launch),
                "operator_materials_launch_invalid")
        return dict(trae=launch["trae"], archive_dir=launch.get("archive_dir"),
                    bootstrap_dir=launch.get("bootstrap_dir"), model_config=launch["model_config"],
                    trae_runtime_config=launch["trae_runtime_config"], prompt_file=handoff,
                    resume_session=launch.get("resume_session"), replacement_run=launch.get("replacement_run"),
                    strict_coordinator=launch.get("strict_coordinator", False),
                    registered_bootstrap=launch.get("registered_bootstrap", False),
                    reviewed_inputs=launch.get("reviewed_inputs"),
                    helper_root=launch.get("helper_root"), **common)
    if agent == "pi":
        allowed = {"agent", "pi", "cwd", "bootstrap_dir", "write_dirs", "pi_policy",
                   "strict_coordinator", "registered_bootstrap", "reviewed_inputs", "helper_root"}
        require(set(launch) <= allowed
                and {"pi", "cwd", "bootstrap_dir", "pi_policy"} <= set(launch),
                "operator_materials_launch_invalid")
        return dict(pi=launch["pi"], bootstrap_dir=launch["bootstrap_dir"],
                    pi_policy=launch["pi_policy"], prompt_file=handoff,
                    strict_coordinator=launch.get("strict_coordinator", False),
                    registered_bootstrap=launch.get("registered_bootstrap", False),
                    reviewed_inputs=launch.get("reviewed_inputs"),
                    helper_root=launch.get("helper_root"), **common)
    raise MaterialsError("operator_materials_launch_invalid")


def baseline_documents(refs, read_roots, directory):
    documents = []
    names, locations = set(), set()
    for ref in refs:
        source = parse(pinned(ref))
        require(isinstance(source, dict)
                and set(source) == {"schema_version", "kind", "baselines"}
                and type(source["schema_version"]) is int and source["schema_version"] == 1
                and source["kind"] == "reviewed_baseline"
                and isinstance(source["baselines"], list) and source["baselines"],
                "operator_materials_baseline_refs_invalid")
        checked = []
        for baseline in source["baselines"]:
            require(isinstance(baseline, dict)
                    and {"name", "path", "head", "clean"} <= set(baseline) <=
                    {"name", "path", "head", "clean", "note"}
                    and named(baseline["name"]) and baseline["name"] not in names
                    and isinstance(baseline["head"], str)
                    and re.fullmatch(r"(?:[a-f0-9]{40}|[a-f0-9]{64})", baseline["head"])
                    and type(baseline["clean"]) is bool,
                    "operator_materials_baseline_invalid")
            target = path(baseline["path"], directory=True)
            require(target not in locations and any(target.is_relative_to(root) for root in read_roots),
                    "operator_materials_baseline_outside_scope_or_duplicate")
            require(not directory.is_relative_to(target) and not target.is_relative_to(directory),
                    "operator_materials_output_overlaps_baseline")
            if "note" in baseline:
                require(isinstance(baseline["note"], str), "operator_materials_baseline_invalid")
            names.add(baseline["name"])
            locations.add(target)
            checked.append({key: baseline[key] for key in ("name", "path", "head", "clean")})
        documents.append({"ref": ref, "baselines": checked})
    return documents


def check_baselines(documents):
    require(not any(key in os.environ for key in (
        "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR")),
        "operator_materials_git_context_override")

    def runner(argv, timeout):
        result = _default_runner(argv, timeout)
        require(result.returncode == 0, "operator_materials_git_query_failed")
        return result

    results = []
    for document in documents:
        for item in document["baselines"]:
            top = runner(["git", "--no-optional-locks", "-C", item["path"],
                          "rev-parse", "--show-toplevel"], 10)
            require(top.stdout.decode().strip() == item["path"],
                    "operator_materials_git_root_mismatch")
            results.append({"expected": item, "observed": _baseline_check(item, 10, runner)})
    return results


def reviewed(ref):
    source = parse(pinned(ref))
    fields = {"schema_version", "assembly_id", "directory", "read_roots", "write_roots",
              "task_source", "task_workspace", "recovery_note", "authority_refs",
              "acceptance_refs", "scope_refs", "baseline_refs", "reference_refs", "launch"}
    require(isinstance(source, dict) and set(source) == fields
            and type(source["schema_version"]) is int and source["schema_version"] == 1,
            "operator_materials_input_invalid")
    require(named(source["assembly_id"]), "operator_materials_id_invalid")
    read_roots, write_roots = directories(source["read_roots"]), directories(source["write_roots"])
    directory = path(source["directory"], directory=True)
    require(any(directory.is_relative_to(root) for root in write_roots),
            "operator_materials_output_outside_scope")
    info = directory.stat()
    require(info.st_uid == os.getuid() and info.st_mode & 0o777 == 0o700,
            "operator_materials_private_directory_required")
    require(not any(directory.iterdir()), "operator_materials_directory_not_empty")
    typed = {name: ref_list(source[name], required=name in ("authority_refs", "acceptance_refs"))
             for name in ("authority_refs", "acceptance_refs", "scope_refs", "baseline_refs", "reference_refs")}
    business = {"task_source": source["task_source"], "workspace": source["task_workspace"],
                "recovery_note": source["recovery_note"]}
    scoped_refs([ref, source["task_source"]], read_roots, [directory])
    task_refs = task_source_refs(business)
    task_authority = task_refs[1:]
    require(all(item in typed["authority_refs"] for item in task_authority),
            "operator_materials_task_authority_missing")
    launch_refs = launch_config_refs(source["launch"])
    static_refs = unique_refs([ref, *task_refs, *typed["authority_refs"], *typed["acceptance_refs"],
                               *typed["scope_refs"], *typed["baseline_refs"], *typed["reference_refs"],
                               *launch_refs])
    scoped_refs(static_refs, read_roots, [directory])
    baselines = baseline_documents(typed["baseline_refs"], read_roots, directory)
    return source, directory, static_refs, typed, task_authority, launch_refs, task_source_summary(business), baselines


def handoff_text(source, typed, task_summary, task_authority, contract):
    payload = {
        "assembly_id": source["assembly_id"],
        "business_task": task_summary,
        "authorization_refs": typed["authority_refs"],
        "task_authorization_refs": task_authority,
        "acceptance_refs": typed["acceptance_refs"],
        "scope_refs": typed["scope_refs"],
        "baseline_refs": typed["baseline_refs"],
        "reference_refs": typed["reference_refs"],
        "declared_scope": {key: source[key] for key in ("read_roots", "write_roots")},
        # Why: S0 records the input_contract hashes; naming the contract file by its fixed
        # path keeps every hash resolvable to a file instead of a filesystem-wide search.
        "input_contract": {"path": contract["path"],
                           "note": "read this file for each hash and the file that carries it; "
                                   "never search the filesystem for a hash"},
    }
    return (
        "# Reviewed Coordinator handoff\n\n"
        "This file is generated from pinned reviewed inputs. It does not authorize launch, "
        "create a Run, issue gates or reinterpret authority. Recovery notes are separate "
        "context and do not replace the business objective.\n\n"
        "```json\n" + json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=2) + "\n```\n"
    )


def assemble(ref):
    source, directory, static_refs, typed, task_authority, launch_refs, task_summary, baselines = reviewed(ref)
    baseline_before = check_baselines(baselines) if baselines else []
    snapshots = snapshots_io.collect(static_refs)
    handoff = directory / "handoff.md"
    contract_path = directory / "input-contract.json"
    fragment_path = directory / "prompt-fragment.txt"
    stdin_path = directory / "stdin.txt"
    # Why: S0 must record the input_contract hashes, and a hash with no path invites the
    # reader to search the filesystem for its preimage. The handoff names the contract file
    # by its fixed path (no bytes needed), and the contract file names a file for every hash.
    handoff_bytes = handoff_text(source, typed, task_summary, task_authority,
                                 {"path": str(contract_path)}).encode("utf-8")
    publish_new(handoff, handoff_bytes)
    raw_plan = build_plan(**launch_kwargs(source["launch"], handoff))
    fragment = raw_plan.get("prompt_fragment")
    require(isinstance(fragment, str) and fragment, "operator_materials_launch_invalid")
    require(digest(handoff_bytes) == digest(handoff.read_bytes()),
            "operator_materials_handoff_changed")
    launch_plan = directory / "launch-plan.json"
    publish_new(launch_plan, raw_plan)
    bound = bind_prompt(raw_plan, handoff)
    stdin = input_bytes(bound)
    bound_plan = directory / "bound-launch-plan.json"
    publish_new(bound_plan, bound)
    fragment_bytes = fragment.encode("utf-8")
    spec = bound["input_contract"]
    require(digest(fragment_bytes) == spec["fragment_sha256"] and digest(stdin) == spec["stdin_sha256"]
            and digest(handoff_bytes) == spec["brief_sha256"],
            "operator_materials_input_contract_mismatch")
    publish_new(fragment_path, fragment_bytes)
    publish_new(stdin_path, stdin)
    contract = {
        "schema_version": 1,
        "kind": "coordinator_input_contract_sources",
        "assembly_id": source["assembly_id"],
        "input_contract": spec,
        "sources": {"brief": str(handoff), "fragment": str(fragment_path),
                    "stdin": str(stdin_path), "plan": str(bound_plan)},
        "note": "Record each hash from the file at its path above; brief is a hash of handoff.md "
                "itself and stdin is the rendered phase contract plus handoff. Never search the "
                "filesystem for a hash and never substitute another material.",
        "created_at": now(),
        "execution_authorized": False,
    }
    publish_new(contract_path, contract)
    mappings, frozen = snapshots_io.publish(directory, snapshots, prefix="source", publisher=publish_new)
    baseline_after = check_baselines(baselines) if baselines else []
    require(baseline_after == baseline_before, "operator_materials_baseline_drift")
    snapshots_io.recheck(snapshots)
    for item in mappings:
        pinned(item["snapshot"])
    for generated in (handoff, launch_plan, bound_plan):
        pinned(file_ref(generated))
    completed_at = now()
    checklist = {
        "schema_version": 1, "kind": "operator_prelaunch_materials",
        "status": "ready_for_external_review", "assembly_id": source["assembly_id"],
        "input": ref, "input_snapshot": frozen[(ref["path"], ref["sha256"])],
        "business_task": {**task_summary,
            "task_source_snapshot": frozen[(task_summary["task_source"]["path"], task_summary["task_source"]["sha256"])]},
        "dependencies": {
            "authority_refs": typed["authority_refs"], "task_authority_refs": task_authority,
            "acceptance_refs": typed["acceptance_refs"], "scope_refs": typed["scope_refs"],
            "baseline_refs": typed["baseline_refs"], "reference_refs": typed["reference_refs"],
            "launch_config_refs": launch_refs,
        },
        "artifacts": {"handoff": file_ref(handoff), "launch_plan": file_ref(launch_plan),
                      "bound_launch_plan": file_ref(bound_plan),
                      "input_contract": file_ref(contract_path),
                      "prompt_fragment": file_ref(fragment_path), "stdin": file_ref(stdin_path)},
        "source_snapshots": mappings, "created_at": completed_at,
        "final_checklist_includes_self": False,
        "agent_started": False, "run_created": False, "gate_issued": False,
        "execution_authorized": False,
    }
    target = directory / "final-checklist.json"
    publish_new(target, checklist)
    result = {"ok": True, "kind": checklist["kind"], "status": checklist["status"],
              "assembly_id": source["assembly_id"], "materials": file_ref(target),
              "handoff": checklist["artifacts"]["handoff"],
              "bound_launch_plan": checklist["artifacts"]["bound_launch_plan"],
              "snapshot_count": len(mappings), "execution_authorized": False}
    verify_materials(result["materials"])
    return result


def verify_materials(ref):
    value = parse(pinned(ref))
    require(isinstance(value, dict) and set(value) == {
        "schema_version", "kind", "status", "assembly_id", "input", "input_snapshot",
        "business_task", "dependencies", "artifacts", "source_snapshots", "created_at",
        "final_checklist_includes_self", "agent_started", "run_created", "gate_issued",
        "execution_authorized"}
        and type(value["schema_version"]) is int and value["schema_version"] == 1
        and value["kind"] == "operator_prelaunch_materials"
        and value["final_checklist_includes_self"] is False
        and value["agent_started"] is False and value["run_created"] is False
        and value["gate_issued"] is False and value["execution_authorized"] is False,
        "operator_materials_checklist_invalid")
    refs = [value["input"], value["input_snapshot"], *value["artifacts"].values()]
    for refs_field in value["dependencies"].values():
        require(isinstance(refs_field, list), "operator_materials_checklist_invalid")
        refs.extend(refs_field)
    for item in value["source_snapshots"]:
        require(isinstance(item, dict) and set(item) == {"source", "snapshot"},
                "operator_materials_snapshot_invalid")
        require(item["source"]["sha256"] == item["snapshot"]["sha256"],
                "operator_materials_snapshot_invalid")
        refs.extend([item["source"], item["snapshot"]])
    require(ref not in refs, "operator_materials_self_reference_forbidden")
    for item in unique_refs(refs):
        pinned(item)
    return value


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True)
    parser.add_argument("--input-sha256", required=True)
    parser.add_argument("--execute", action="store_true", help="publish local materials only")
    args = parser.parse_args(argv)
    try:
        require(args.execute, "operator_materials_explicit_execute_required")
        result = assemble({"path": args.input, "sha256": args.input_sha256})
    except (OSError, ValueError, KeyError, TypeError, AttributeError, subprocess.SubprocessError) as exc:
        result = {"ok": False, "decision": "stop", "execution_authorized": False,
                  "error": str(exc) if isinstance(exc, (MaterialsError, PreflightError)) else
                  safe_error(exc, "operator_materials_failed")}
        if isinstance(exc, OSError) and exc.errno is not None:
            result["os_error"] = errno.errorcode.get(exc.errno, "UNKNOWN")
        print(json.dumps(result))
        return 2
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

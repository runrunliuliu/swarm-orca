"""Software progress consistency checks, not execution/authentication or authority.

Only reads pinned, scoped records and current file bytes. The CLI publishes one
immutable receipt; it never executes commands, queries native objects or dispatches.
See docs/design/software-development-schema.md for the versioned wire contract.
"""

import argparse
import os
from pathlib import Path
import re

from coordinator_domain import FIELDS, SOFTWARE
from coordinator_io import (canonical, digest, file_ref, now, parse, path, pinned,
                            publish_new, scoped_refs, timestamp, validate_ref)
from coordinator_loop import checkpoint_route
from coordinator_tui_errors import failure, require


LIMITS = "scoped_file_and_record_consistency_only; execution_and_identity_require_external_audit"
MATERIALS = ("skill", "coordinator", "implementation", "review")


def shape(value, keys, code="software_schema_invalid"):
    require(isinstance(value, dict) and set(value) == set(keys), code)


def text(value):
    return isinstance(value, str) and bool(value.strip()) and "\0" not in value


def sha(value):
    return isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value) is not None


def location(value):
    """Also supports deleted/new files; reject noncanonical ancestors and traversal."""
    require(text(value), "software_path_invalid")
    target = Path(value)
    require(target.is_absolute() and str(target) == value and ".." not in target.parts
            and target.resolve() == target and not target.is_symlink(), "software_path_invalid")
    return target


def inside(target, roots):
    return any(target.is_relative_to(Path(root)) for root in roots)


def scoped_json(ref, roots, excluded=()):
    scoped_refs([ref], [Path(r) for r in roots], [Path(p) for p in excluded])
    return parse(pinned(ref))


def references(refs, roots, excluded=(), *, nonempty=True):
    require(isinstance(refs, list) and (refs or not nonempty), "software_source_records_required")
    scoped_refs(refs, [Path(r) for r in roots], [Path(p) for p in excluded])
    require(len({r["path"] for r in refs}) == len(refs), "software_duplicate_reference")


def archived_content(ref, task):
    validate_ref(ref)
    require(not location(ref["path"]).is_relative_to(Path(task["repository"]["worktree"])),
            "software_content_archive_required")
    references([ref], task["scope"]["read_roots"], task["scope"]["exclude_paths"])


def validate_binding(binding, startup):
    shape(binding, {"schema_version", "adapter", "contract", "checker", "materials", "reads"})
    require(type(binding["schema_version"]) is int and binding["schema_version"] == 1
            and binding["adapter"] == SOFTWARE, "tui_domain_adapter_unsupported")
    require(binding["checker"] == file_ref(Path(__file__).resolve()), "software_checker_changed")
    roots = startup["observation"]["roots"]
    task = scoped_json(binding["contract"], roots)
    validate_task(task, startup)
    materials = binding["materials"]
    shape(materials, MATERIALS)
    workspace = path(startup["workspace"]["path"], directory=True)
    base = workspace / "swarm/skills/software-development"
    for key in MATERIALS:
        expected = base / ("SKILL.md" if key == "skill" else f"references/{key}.md")
        validate_ref(materials[key])
        require(materials[key]["path"] == str(expected), "software_role_material_changed")
        scoped_refs([materials[key]], [workspace], [Path(p) for p in task["scope"]["exclude_paths"]])
    shape(binding["reads"], {"operator", "coordinator"})
    for role, ref in binding["reads"].items():
        validate_ref(ref)
        require(inside(path(ref["path"]), roots), "tui_domain_evidence_outside_roots")
        read = scoped_json(ref, task["scope"]["read_roots"], task["scope"]["exclude_paths"])
        shape(read, {"actor", "materials", "source_records"})
        require(read["actor"] == startup[role]
                and read["materials"] == [materials["skill"], materials["coordinator"]],
                "software_role_read_mismatch")
        references(read["source_records"], task["scope"]["read_roots"], task["scope"]["exclude_paths"])
    return task


def validate_task(task, startup):
    shape(task, {"schema_version", "task_id", "objective", "acceptance", "repository",
                 "baseline", "scope", "policy", "authority_review"})
    require(type(task["schema_version"]) is int and task["schema_version"] == 1
            and text(task["task_id"]) and text(task["objective"]), "software_task_invalid")
    repo = task["repository"]
    shape(repo, {"root", "worktree", "branch", "base_commit"})
    path(repo["root"], directory=True)
    path(repo["worktree"], directory=True)
    require(repo["worktree"] == startup["workspace"]["path"] and text(repo["branch"])
            and isinstance(repo["base_commit"], str)
            and re.fullmatch(r"[a-f0-9]{40}|[a-f0-9]{64}", repo["base_commit"]),
            "software_repository_mismatch")
    scope = task["scope"]
    shape(scope, {"read_roots", "write_roots", "exclude_paths", "operations"})
    for key in ("read_roots", "write_roots", "exclude_paths"):
        values = scope[key]
        require(isinstance(values, list) and (values or key == "exclude_paths")
                and all(text(v) for v in values) and len(set(values)) == len(values), "software_scope_invalid")
        for value in values:
            location(value)
    require(inside(Path(repo["worktree"]), scope["read_roots"]), "software_worktree_read_scope_required")
    for value in scope["write_roots"]:
        target = location(value)
        require(target.is_relative_to(Path(repo["worktree"])) and inside(target, scope["read_roots"])
                and not inside(target, scope["exclude_paths"]), "software_write_scope_invalid")
    operations = scope["operations"]
    require(isinstance(operations, list) and operations and len(set(operations)) == len(operations)
            and set(operations) <= {"modify", "create", "delete", "test", "review"},
            "software_operations_invalid")
    # The baseline and all authority inputs must be readable *before* they are opened.
    acceptance = scoped_json(task["acceptance"], scope["read_roots"], scope["exclude_paths"])
    shape(acceptance, {"requirements"})
    require(isinstance(acceptance["requirements"], list) and acceptance["requirements"],
            "software_requirements_required")
    ids = []
    for row in acceptance["requirements"]:
        require(isinstance(row, dict) and text(row.get("id"))
                and row.get("verification") in ("test", "manual"), "software_verification_method_required")
        if row["verification"] == "manual":
            require(text(row.get("manual_method")), "software_manual_method_required")
        ids.append(row["id"])
    require(len(set(ids)) == len(ids), "software_duplicate_requirement")
    policy = task["policy"]
    shape(policy, {"max_workers", "token_budget", "cost_budget", "deadline", "retry_limit", "stop_conditions"})
    require(type(policy["max_workers"]) is int and policy["max_workers"] > 0, "software_worker_limit_required")
    for key in ("token_budget", "retry_limit"):
        require(policy[key] is None or type(policy[key]) is int and policy[key] >= 0,
                "software_policy_invalid")
    require(policy["cost_budget"] is None or type(policy["cost_budget"]) in (int, float)
            and policy["cost_budget"] >= 0, "software_policy_invalid")
    if policy["deadline"] is not None:
        timestamp(policy["deadline"])
    require(isinstance(policy["stop_conditions"], list) and policy["stop_conditions"]
            and all(text(v) for v in policy["stop_conditions"]), "software_stop_policy_required")
    baseline = scoped_json(task["baseline"], scope["read_roots"], scope["exclude_paths"])
    baseline_files(baseline, task)
    review = scoped_json(task["authority_review"], scope["read_roots"], scope["exclude_paths"])
    shape(review, {"actor", "approved", "inputs", "source_records"})
    expected = {k: task[k] for k in ("task_id", "objective", "acceptance", "repository", "baseline", "scope", "policy")}
    require(review["actor"] == startup["operator"] and review["approved"] is True
            and canonical(review["inputs"]) == canonical(expected), "software_authority_review_mismatch")
    references(review["source_records"], scope["read_roots"], scope["exclude_paths"])
    return acceptance


def baseline_files(baseline, task):
    shape(baseline, {"repository", "files", "inventory_records"})
    require(baseline["repository"] == task["repository"], "software_baseline_mismatch")
    scope = task["scope"]
    references(baseline["inventory_records"], scope["read_roots"], scope["exclude_paths"])
    require(isinstance(baseline["files"], list), "software_baseline_invalid")
    result = {}
    for row in baseline["files"]:
        shape(row, {"path", "content", "tracked", "dirty", "owner", "diff"})
        target = location(row["path"])
        require(target.is_relative_to(Path(task["repository"]["worktree"]))
                and inside(target, scope["read_roots"]) and not inside(target, scope["exclude_paths"])
                and type(row["tracked"]) is bool and type(row["dirty"]) is bool
                and (row["tracked"] or row["dirty"]) and text(row["owner"]), "software_baseline_invalid")
        if row["content"] is None:
            require(row["tracked"] and row["dirty"], "software_baseline_invalid")
        else:
            archived_content(row["content"], task)
        if row["tracked"] and row["dirty"]:
            references([row["diff"]], scope["read_roots"], scope["exclude_paths"])
        else:
            require(row["diff"] is None, "software_baseline_invalid")
        require(row["path"] not in result, "software_duplicate_file")
        result[row["path"]] = row
    inventory = scoped_json(baseline["inventory_records"][0], scope["read_roots"], scope["exclude_paths"])
    require(isinstance(inventory, dict) and inventory.get("repository") == task["repository"]
            and inventory.get("files") == [dict(path=row["path"], sha256=row["content"]["sha256"] if row["content"] else None,
                tracked=row["tracked"], dirty=row["dirty"]) for row in baseline["files"]],
            "software_baseline_inventory_mismatch")
    return result


def snapshot(task):
    """Inventory every visible worktree file, including untracked files. No Git shell.

    Exclusions are explicit audit gaps, not permission to modify excluded files.
    Symlinks in the visible tree fail closed (including directory symlinks).
    """
    scope = task["scope"]
    result = []
    def scan_failed(error):
        raise error
    for root, dirs, files in os.walk(task["repository"]["worktree"], followlinks=False, onerror=scan_failed):
        for name in list(dirs) + files:
            target = Path(root) / name
            if inside(target, scope["exclude_paths"]):
                if name in dirs:
                    dirs.remove(name)
                continue
            require(not target.is_symlink(), "software_symlink_in_snapshot")
            require(inside(target, scope["read_roots"]), "software_snapshot_outside_scope")
            if name in files:
                result.append(file_ref(target))
    return sorted(result, key=lambda row: row["path"])


def check(binding, startup, source_ref, *, current=False):
    task = validate_binding(binding, startup)
    scope = task["scope"]
    roots, excluded = scope["read_roots"], scope["exclude_paths"]
    validate_ref(source_ref)
    require(inside(path(source_ref["path"]), startup["observation"]["roots"]), "tui_domain_evidence_outside_roots")
    source = scoped_json(source_ref, roots, excluded)
    shape(source, {"schema_version", "adapter", "task_id", "run_id", "generation", "runtime",
                   "contract_sha256", "observed_at", *FIELDS, "snapshot", "changes",
                   "actions", "validations", "reviews", "audit", "pending_operations"})
    require(type(source["schema_version"]) is int and source["schema_version"] == 1
            and source["adapter"] == SOFTWARE and source["task_id"] == task["task_id"]
            and startup["run"] is not None and source["run_id"] == startup["run"]["id"]
            and type(source["generation"]) is int and source["generation"] == startup["run"]["generation"]
            and canonical(source["runtime"]) == canonical(startup["runtime"])
            and source["contract_sha256"] == binding["contract"]["sha256"], "software_progress_binding_mismatch")
    observed = timestamp(source["observed_at"])
    require(observed <= timestamp(now()), "software_future_observation")
    acceptance = scoped_json(task["acceptance"], roots, excluded)
    require(isinstance(source["barriers"], list), "software_barrier_invalid")
    for barrier in source["barriers"]:
        require(isinstance(barrier, dict)
                and isinstance(barrier.get("evidence_refs"), list)
                and all(text(ref) for ref in barrier["evidence_refs"]),
                "software_barrier_invalid")
    route = checkpoint_route({k: source[k] for k in FIELDS}, acceptance)
    require(isinstance(source["snapshot"], list), "software_snapshot_invalid")
    frozen = []
    for row in source["snapshot"]:
        shape(row, {"path", "sha256", "content"})
        target = location(row["path"])
        require(target.is_relative_to(Path(task["repository"]["worktree"]))
                and inside(target, roots) and not inside(target, excluded), "software_snapshot_outside_scope")
        archived_content(row["content"], task)
        require(row["sha256"] == row["content"]["sha256"], "software_snapshot_content_mismatch")
        frozen.append({k: row[k] for k in ("path", "sha256")})
    require(frozen == sorted(frozen, key=lambda row: row["path"])
            and len({row["path"] for row in frozen}) == len(frozen), "software_snapshot_invalid")
    # Old claimed checkpoints are revalidated during settlement after code changes.
    # Their archived bytes remain valid history; only a new frontier must match disk.
    verify_current = current or source["decision"] == "complete"
    if verify_current:
        require(snapshot(task) == frozen, "software_snapshot_changed")
    snapshot_hash = digest(canonical(frozen))
    baseline = baseline_files(scoped_json(task["baseline"], roots, excluded), task)
    before = {p: row["content"]["sha256"] if row["content"] else None for p, row in baseline.items()}
    after = {r["path"]: r["sha256"] for r in frozen}
    changes = []
    for name in sorted(before.keys() | after.keys()):
        if before.get(name) == after.get(name):
            continue
        op = "create" if before.get(name) is None else "delete" if name not in after else "modify"
        require(inside(Path(name), scope["write_roots"]) and op in scope["operations"],
                "software_change_outside_scope")
        require(name not in baseline or not baseline[name]["dirty"]
                or baseline[name]["owner"] == task["task_id"], "software_initial_dirty_protected")
        changes.append(dict(path=name, operation=op, before=before.get(name), after=after.get(name)))
    require(source["changes"] == changes, "software_change_manifest_mismatch")
    require(isinstance(source["pending_operations"], list)
            and all(text(v) for v in source["pending_operations"]), "software_pending_operations_invalid")
    ids = {r["id"] for r in acceptance["requirements"]}
    actions, evidence = {}, {}
    all_refs = []
    for kind in ("actions", "validations", "reviews"):
        refs = source[kind]
        references(refs, roots, excluded, nonempty=False)
        all_refs.extend(refs)
        for ref in refs:
            row = scoped_json(ref, roots, excluded)
            common = {"id", "task_id", "run", "runtime", "requirements", "snapshot_sha256", "actor", "source_records"}
            extra = ({"action_id", "native_task", "dispatch", "inputs", "outputs", "materials", "read_evidence"}
                     if kind == "actions" else
                     {"action", "method", "command", "cwd", "started_at", "ended_at", "exit_code", "passed", "reports", "tool"}
                     if kind == "validations" else
                     {"action", "decision", "findings", "resolves", "reviewed_at"})
            shape(row, common | extra)
            require(text(row["id"]) and row["id"] not in evidence and text(row["actor"])
                    and row["task_id"] == task["task_id"] and canonical(row["run"]) == canonical(startup["run"])
                    and canonical(row["runtime"]) == canonical(startup["runtime"]) and sha(row["snapshot_sha256"])
                    and isinstance(row["requirements"], list) and row["requirements"]
                    and all(text(v) and v in ids for v in row["requirements"]), "software_evidence_binding_mismatch")
            references(row["source_records"], roots, excluded)
            evidence[row["id"]] = (kind, row, ref)
            if kind == "actions":
                require(all(text(row[k]) for k in ("action_id", "native_task", "dispatch")), "software_native_link_required")
                references(row["inputs"], roots, excluded)
                references(row["outputs"], roots, excluded)
                require(row["materials"] in ([binding["materials"]["skill"], binding["materials"]["implementation"]],
                                             [binding["materials"]["skill"], binding["materials"]["review"]]),
                        "software_worker_material_mismatch")
                read = scoped_json(row["read_evidence"], roots, excluded)
                shape(read, {"actor", "materials", "source_records"})
                require(read["actor"] == row["actor"] and read["materials"] == row["materials"], "software_worker_read_mismatch")
                references(read["source_records"], roots, excluded)
                # Normalized exports must include the native object linkage. An outer
                # audit still has to authenticate these exports against the runtime.
                native = scoped_json(row["source_records"][0], roots, excluded)
                require(isinstance(native, dict) and canonical(native.get("runtime")) == canonical(startup["runtime"])
                        and canonical(native.get("run")) == canonical(startup["run"])
                        and native.get("action_id") == row["action_id"]
                        and native.get("task") == {"id": row["native_task"], "run_id": source["run_id"]}
                        and native.get("dispatch") == {"id": row["dispatch"], "task_id": row["native_task"], "worker_handle": row["actor"]},
                        "software_native_link_mismatch")
                actions[row["id"]] = row
            else:
                require(row["action"] in actions and actions[row["action"]]["actor"] == row["actor"]
                        and actions[row["action"]]["snapshot_sha256"] == row["snapshot_sha256"]
                        and set(row["requirements"]) <= set(actions[row["action"]]["requirements"]),
                        "software_action_link_mismatch")
            if kind == "validations":
                require("test" in scope["operations"], "software_operation_not_allowed")
                require(row["method"] in ("test", "manual") and text(row["command"]) and text(row["tool"])
                        and type(row["exit_code"]) is int and type(row["passed"]) is bool,
                        "software_validation_invalid")
                require(inside(path(row["cwd"], directory=True), roots)
                        and not inside(Path(row["cwd"]), excluded), "software_validation_cwd_outside_scope")
                require(timestamp(row["started_at"]) <= timestamp(row["ended_at"]) <= observed,
                        "software_validation_time_invalid")
                references(row["reports"], roots, excluded)
            if kind == "reviews":
                require("review" in scope["operations"], "software_operation_not_allowed")
                require(row["decision"] in ("approved", "changes_requested")
                        and isinstance(row["findings"], list) and all(text(v) for v in row["findings"])
                        and isinstance(row["resolves"], list) and all(text(v) for v in row["resolves"])
                        and timestamp(row["reviewed_at"]) <= observed, "software_review_invalid")
                require(actions[row["action"]]["materials"][1] == binding["materials"]["review"],
                        "software_reviewer_role_required")
            if kind != "actions":
                exported = scoped_json(row["source_records"][0], roots, excluded)
                require(isinstance(exported, dict) and exported.get("kind") == kind
                        and canonical(exported.get("record")) == canonical({k: v for k, v in row.items() if k != "source_records"}),
                        "software_execution_record_mismatch")
    review_ids = {row["id"] for kind, row, _ in evidence.values() if kind == "reviews"}
    for kind, row, _ in evidence.values():
        if kind == "reviews":
            require(set(row["resolves"]) <= review_ids, "software_review_resolves_unknown")
    # Barrier evidence is readable and scoped, never a string claiming an object exists.
    for barrier in source["barriers"]:
        for ref in barrier["evidence_refs"]:
            require(ref in evidence, "software_barrier_evidence_required")
    for row in source["requirements"]:
        if row["status"] == "blocked" and not any(p["requirement_id"] == row["id"] for p in source["paths"]):
            require(row.get("path_review_ref") in evidence
                    and evidence[row["path_review_ref"]][0] == "reviews"
                    and row["id"] in evidence[row["path_review_ref"]][1]["requirements"]
                    and evidence[row["path_review_ref"]][1]["snapshot_sha256"] == snapshot_hash,
                    "software_path_review_required")
    if route.kind == "dependency_wait":
        from coordinator_tui_dependencies import wait_spec
        wait = wait_spec(source["next_action"])
        require(not wait["jobs"] and set(wait["dispatches"]) <= {a["dispatch"] for a in actions.values()},
                "software_wait_native_evidence_required")
    met = [row for row in source["requirements"] if row["status"] == "met"]
    for requirement in met:
        required_id = requirement["id"]
        claimed = requirement["evidence"]
        require(isinstance(claimed, list) and claimed, "software_completion_evidence_required")
        selected = []
        for item in claimed:
            shape(item, {"kind", "ref"})
            require(item["kind"] == SOFTWARE and item["ref"] in evidence, "software_completion_evidence_required")
            kind, row, _ = evidence[item["ref"]]
            require(required_id in row["requirements"] and row["snapshot_sha256"] == snapshot_hash,
                    "software_stale_or_unrelated_evidence")
            selected.append((kind, row))
        validations = [row for kind, row in selected if kind == "validations" and row["passed"]
                       and row["exit_code"] == 0 and row["method"] == requirement["verification"]
                       and (row["method"] != "manual" or row["command"] == requirement["manual_method"])]
        reviews = [row for kind, row in selected if kind == "reviews" and row["decision"] == "approved"
                   and not row["findings"]]
        authors = {row["actor"] for row in actions.values()
                   if required_id in row["requirements"] and row["materials"][1] == binding["materials"]["implementation"]}
        rejected = [row for kind, row, _ in evidence.values()
                    if kind == "reviews" and required_id in row["requirements"] and row["decision"] == "changes_requested"]
        require(validations and authors and any(
            review["actor"] not in authors
            and review["actor"] not in {v["actor"] for v in validations}
            and all(rejection["id"] in review["resolves"]
                    and timestamp(rejection["reviewed_at"]) <= timestamp(review["reviewed_at"]) for rejection in rejected)
            for review in reviews), "software_independent_review_or_validation_required")
    if met:
        audit = scoped_json(source["audit"], roots, excluded)
        shape(audit, {"actor", "snapshot_sha256", "evidence", "verified", "source_records"})
        require(audit["actor"] == startup["operator"] and audit["snapshot_sha256"] == snapshot_hash
                and audit["evidence"] == all_refs and audit["verified"] is True,
                "software_external_audit_required")
        references(audit["source_records"], roots, excluded)
    else:
        require(source["audit"] is None, "software_unused_audit")
    require(route.decision != "complete" or not source["pending_operations"], "software_unresolved_operations")
    # Re-read the inventory after evidence IO: a changed working tree invalidates this check.
    if verify_current:
        require(snapshot(task) == frozen, "software_snapshot_changed")
    return dict(schema_version=1, adapter=SOFTWARE, ok=True, consistent=True,
                grants_authority=False, coverage=LIMITS, source=source_ref,
                binding_sha256=digest(canonical(binding)), checker=binding["checker"],
                runtime=source["runtime"], run=startup["run"], task_id=task["task_id"],
                snapshot_sha256=snapshot_hash, decision=source["decision"],
                next_gate="acceptance_review" if route.decision == "complete" else route.kind)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    for key in ("startup", "startup-sha256", "source", "source-sha256", "output"):
        parser.add_argument("--" + key, required=True)
    args = parser.parse_args(argv)
    try:
        startup_ref = {"path": args.startup, "sha256": args.startup_sha256}
        startup = parse(pinned(startup_ref))
        from coordinator_startup import validate
        validate(startup)
        result = check(startup["domain_binding"], startup,
                       {"path": args.source, "sha256": args.source_sha256}, current=True)
        output = location(args.output)
        path(str(output.parent), directory=True)
        task = scoped_json(startup["domain_binding"]["contract"], startup["observation"]["roots"])
        require(inside(output, startup["observation"]["roots"])
                and inside(output, task["scope"]["read_roots"])
                and not inside(output, task["scope"]["exclude_paths"])
                and not output.is_relative_to(Path(task["repository"]["worktree"])),
                "software_receipt_output_outside_scope")
        pinned(startup_ref)
        publish_new(output, result)
    except (ValueError, OSError, KeyError, TypeError, AttributeError) as exc:
        print(canonical(failure(exc, "software_check_failed")).decode())
        return 2
    print(canonical(dict(ok=True, receipt=file_ref(output), grants_authority=False)).decode())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

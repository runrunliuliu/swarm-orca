"""Pure argv planning for native Coordinator worker-start; never executes Orca."""

import argparse
import json
from pathlib import Path
import shlex
import sys

from coordinator_io import parse, pinned, require, validate_ref
from coordinator_worker_profiles import resolve


CREATION_FIELDS = ("name", "repo", "base_branch", "display_name", "comment", "setup")
REQUEST_FIELDS = {"schema_version", "cli", "run", "task", "spec", "task_title", "deps",
                  "parent", "placement", "on", "terminal", "model", "profiles_sha256",
                  "writable_roots", "write_isolation", "retry_of", "timeout_ms",
                  "first_dispatch"}


def text(value, field):
    require(isinstance(value, str) and bool(value.strip()) and "\0" not in value,
            "invalid " + field)
    return value


def exact(value, field):
    text(value, field)
    require(value.startswith("id:") and bool(value[3:].strip()),
            field + " requires an exact id: selector from native discovery")
    return value


def canonical_directory(value, field):
    candidate = Path(text(value, field))
    require(candidate.is_absolute(), "absolute " + field + " required")
    try:
        resolved = candidate.resolve(strict=True)
    except OSError:
        require(False, field + " must be an existing canonical directory")
    require(resolved == candidate and candidate.is_dir(),
            field + " must be an existing canonical directory")
    return candidate


def contains(parent, child):
    return child == parent or child.is_relative_to(parent)


def placement_flags(placement, remote):
    require(isinstance(placement, dict), "placement object required")
    kind = placement.get("kind")
    require(isinstance(kind, str) and kind in ("existing", "new-child", "new-top-level"),
            "placement kind must be existing, new-child or new-top-level")
    if kind == "existing":
        require(not set(placement).intersection(CREATION_FIELDS),
                "existing placement rejects creation fields; use task_title with spec for a Task title")
        require(set(placement) == {"kind", "worktree"}, "invalid existing placement fields")
        return [("worktree", exact(placement["worktree"], "worktree"))]
    require(not remote or kind == "new-top-level", "remote new-child is unsupported")
    require(set(placement) <= {"kind", *CREATION_FIELDS}, "unknown new-worktree placement fields")
    text(placement.get("name"), "new-worktree name")
    if kind == "new-top-level" or "repo" in placement:
        exact(placement.get("repo"), "repo")
    if "setup" in placement:
        require(placement["setup"] in ("run", "skip", "inherit"), "invalid setup")
    return [("worktree", kind), *((key, text(placement[key], key))
                                  for key in CREATION_FIELDS if key in placement)]


def build_plan(request, *, request_ref=None):
    require(isinstance(request, dict), "worker request object required")
    schema = request.get("schema_version")
    require(type(schema) is int, "worker request schema_version must be 2")
    require(schema != 1,
            "legacy_worker_request_requires_fixed_profile_migration")
    require(schema == 2, "worker request schema_version must be 2")
    require(not {"agent", "effort", "backend_variant"}.intersection(request),
            "worker_launch_settings_are_fixed_choose_model_only")
    require(set(request) <= REQUEST_FIELDS, "unknown request fields")
    request = dict(request)  # Do not mutate the reviewed request when resolving settings.
    resolved_profile = None
    if "terminal" not in request:
        settings, resolved_profile = resolve(text(request.get("model"), "model"),
                                             request.get("profiles_sha256"))
        request.update(settings)
    else:
        require(not {"model", "profiles_sha256"}.intersection(request),
                "terminal reuse cannot override launch settings")
    cli = text(request.get("cli"), "cli")
    require(Path(cli).is_absolute(), "cli must be the verified absolute executable path")
    text(request.get("run"), "run")
    require(("task" in request) != ("spec" in request), "exactly one task or spec is required")
    require(("agent" in request) != ("terminal" in request),
            "exactly one agent or terminal is required")
    require("spec" in request or not {"task_title", "deps", "parent"}.intersection(request),
            "task_title, deps and parent require spec; existing Task metadata is not changed")
    require("retry_of" not in request or "task" in request, "retry_of requires task")
    placement = placement_flags(request.get("placement"), "on" in request)
    creates = request["placement"]["kind"] != "existing"
    if "terminal" in request:
        require(not creates and not {"model", "effort", "backend_variant", "writable_roots"}
                .intersection(request), "terminal reuse cannot create worktrees or override launch settings")
    if "writable_roots" in request:
        roots = request["writable_roots"]
        require(not creates and request.get("agent") == "trae" and "on" not in request,
                "writable_roots requires fresh local Trae in an existing workspace")
        require(isinstance(roots, list) and 1 <= len(roots) <= 32, "invalid writable_roots")
        for root in roots:
            require(Path(text(root, "writable_root")).is_absolute(), "absolute writable_root required")
        # Host canonicality, SSH/WSL placement and capability checks remain native.
    if "write_isolation" in request:
        isolation = request["write_isolation"]
        require(isinstance(isolation, dict)
                and set(isolation) == {"workspace_root", "read_only_roots"},
                "write_isolation requires workspace_root and read_only_roots")
        require(not creates and request.get("agent") == "trae" and "on" not in request
                and "terminal" not in request,
                "write_isolation requires fresh local Trae in an existing workspace")
        workspace_root = canonical_directory(isolation["workspace_root"], "workspace_root")
        read_only = isolation["read_only_roots"]
        require(isinstance(read_only, list) and 1 <= len(read_only) <= 32,
                "invalid read_only_roots")
        read_only_roots = [canonical_directory(root, "read_only_root") for root in read_only]
        require(len(set(read_only_roots)) == len(read_only_roots),
                "duplicate read_only_roots")
        require(request.get("writable_roots") == [str(workspace_root)],
                "write_isolation requires workspace_root as the only writable_root")
        for root in read_only_roots:
            require(not contains(root, workspace_root) and not contains(workspace_root, root),
                    "workspace_root overlaps a read_only_root")
    if "deps" in request:
        require(isinstance(request["deps"], list), "deps must be an array")
        for dependency in request["deps"]:
            text(dependency, "dependency")
    if "timeout_ms" in request:
        require(type(request["timeout_ms"]) is int and request["timeout_ms"] > 0,
                "timeout_ms must be a positive integer")
    # An agent-config-owned model is declared, not passed: the runtime would refuse the flag.
    model_flag = not (resolved_profile and resolved_profile["model_source"] == "agent_config")
    options = [(key, text(request[key], key)) for key in
               ("run", "task", "spec", "task_title", "parent", "on", "agent", "terminal",
                "model", "effort", "backend_variant", "retry_of")
               if key in request and (key != "model" or model_flag)]
    options += placement
    for key in ("deps", "writable_roots"):
        if key in request:
            options.append((key, json.dumps(request[key], ensure_ascii=False)))
    if "timeout_ms" in request:
        options.append(("timeout_ms", str(request["timeout_ms"])))
    argv = [cli, "orchestration", "worker-start"]
    for key, value in options:
        flag = "--" + key.replace("_", "-")
        # Orca's parser treats a separate --leading value as another flag.
        argv += [flag + "=" + value] if value.startswith("--") else [flag, value]
    argv.append("--json")
    if "first_dispatch" in request:
        guard = request["first_dispatch"]
        require(isinstance(guard, dict) and set(guard) == {"contract", "operator_gate", "state_root"},
                "first_dispatch config requires contract, operator_gate and state_root")
        for key in ("contract", "operator_gate"):
            validate_ref(guard[key])
        require(Path(text(guard["state_root"], "state_root")).is_absolute(), "absolute state_root required")
        validate_ref(request_ref)
        argv = [sys.executable, "-B", str(Path(__file__).with_name("coordinator_launch.py").resolve()),
                "first-dispatch", "--request", request_ref["path"],
                "--request-sha256", request_ref["sha256"], "--execute"]
    return {"schema_version": 2, "mode": "native_worker_launch_plan", "argv": argv,
            "resolved_profile": resolved_profile,
            "command": shlex.join(argv), "effectsApplied": False, "runtime_verified": False,
            "requirements": ["Review placement, baseline and write ownership; verify exact native IDs.",
                             "Check original authorization, live Coordinator identity, capacity and gates.",
                             "Execute once from the same Coordinator context; preserve the native receipt.",
                             "Reconcile unknown outcomes before retry; this plan grants no authority."]}


def cli_main(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--request", required=True)
    parser.add_argument("--request-sha256", required=True)
    args = parser.parse_args(argv)
    try:
        ref = {"path": args.request, "sha256": args.request_sha256}
        plan = build_plan(parse(pinned(ref)), request_ref=ref)
    except (OSError, ValueError) as error:
        print(json.dumps({"ok": False, "effectsApplied": False,
                          "error": "worker_request_unreadable" if isinstance(error, OSError) else str(error)}))
        return 2
    print(json.dumps(plan, ensure_ascii=False, indent=2))
    return 0

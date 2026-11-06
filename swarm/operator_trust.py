"""Explicit exact-workspace Operator trust preparation; never launch or approve a Run."""

import argparse
import errno
import json
import os
from pathlib import Path
import re

from coordinator_io import (directory_lock, file_ref, now, parse, path, pinned,
                            publish_new, read_json, require)
from supervisor.config import SafetyError
from supervisor.orca import Orca
from supervisor import trae_trust


SUPPORTED_ROLES = ("operator", "coordinator", "reviewer", "worker")
TRAE_POLICY_KEYS = {"enabled", "hostname", "username", "trae_home", "launch_context_confirmed"}
PI_POLICY_KEYS = {"enabled", "hostname", "username", "launch_context_confirmed"}


def register(ref, *, env=None, native_factory=Orca):
    source = parse(pinned(ref))
    require(isinstance(source, dict) and set(source) == {
        "schema_version", "runtime", "workspace", "head", "agent", "role",
        "policy", "authority_refs", "content_review_refs", "directory"}
        and type(source["schema_version"]) is int and source["schema_version"] == 1,
        "operator_trust_input_invalid")
    require(source["agent"] in ("trae", "pi") and source["role"] in SUPPORTED_ROLES,
            "operator_trust_role_invalid")
    runtime = source["runtime"]
    require(isinstance(runtime, dict) and set(runtime) == {
        "cli", "runtime_id", "version", "repo_id"}
        and all(isinstance(v, str) and v.strip() for v in runtime.values()),
        "operator_trust_runtime_invalid")
    path(runtime["cli"])
    require(runtime["version"] == "1.4.219", "operator_trust_runtime_unsupported")
    workspace = source["workspace"]
    require(isinstance(workspace, str) and workspace.startswith(runtime["repo_id"] + "::/"),
            "operator_trust_workspace_invalid")
    target = trae_trust.canonical_directory(workspace.split("::", 1)[1])
    require(isinstance(source["head"], str) and re.fullmatch(r"[a-f0-9]{40}|[a-f0-9]{64}", source["head"]),
            "operator_trust_head_invalid")
    policy = source["policy"]
    if source["agent"] == "trae":
        require(isinstance(policy, dict) and set(policy) == TRAE_POLICY_KEYS,
            "operator_trust_policy_invalid")
    else:
        require(isinstance(policy, dict) and set(policy) == PI_POLICY_KEYS and
                policy.get("enabled") is True and policy.get("launch_context_confirmed") is True,
                "operator_trust_policy_invalid")
    refs = [ref]
    for key in ("authority_refs", "content_review_refs"):
        require(isinstance(source[key], list) and source[key], "operator_trust_review_refs_required")
        refs.extend(source[key])
    for item in refs:
        pinned(item)
    launch_env = dict(os.environ if env is None else env)
    # Never let explicit -C inspect an environment-selected Git index/config/repo.
    require(not any(key.startswith("GIT_") for key in launch_env), "operator_trust_git_override")
    config_dir = None
    if source["agent"] == "trae":
        config_dir, _ = trae_trust.context(policy, launch_env)
    directory = path(source["directory"], directory=True)
    protected = (target,) if config_dir is None else (target, config_dir)
    require(not any(directory == root or directory.is_relative_to(root)
                    or root.is_relative_to(directory) for root in protected),
            "operator_trust_receipt_overlap")
    require(all(not Path(item["path"]).is_relative_to(directory) for item in refs),
            "operator_trust_input_in_output")
    config = {"runtime": runtime, "base_commit": source["head"]}
    # coordinator=True merely allows the caller's existing Agent context; no identity
    # is manufactured and only status/repo/worktree read operations are used.
    native = native_factory(config, coordinator=True, env=launch_env)

    def verify():
        for item in refs:
            pinned(item)
        native.verify_runtime()
        observed = native.preflight(workspace, for_trust=True, expected_head=source["head"])
        require(observed == target, "operator_trust_workspace_changed")
        if source["agent"] == "trae":
            trae_trust.check_context(policy, launch_env)
        # Native/Git checks can take time; reject evidence drift observed during
        # them before granting trust, not only during the post-write check.
        for item in refs:
            pinned(item)

    verify()
    with directory_lock(directory, "operator-trust"):
        receipt = directory / "trusted.json"
        if receipt.exists():
            previous = read_json(receipt)
            expected = {"schema_version": 1, "kind": "operator_workspace_trusted",
                        "input": ref, "runtime": runtime, "workspace": workspace,
                        "head": source["head"], "agent": source["agent"], "role": source["role"],
                        "status": "trusted_not_started", "execution_authorized": False,
                        "requires_launch_readiness_and_independent_audit": True}
            require(all(previous.get(key) == value for key, value in expected.items())
                    and isinstance(previous.get("registration"), dict)
                    and previous["registration"].get("workspace") == str(target),
                    "operator_trust_receipt_mismatch")
            if source["agent"] == "trae":
                # Read-only revalidation, not a second grant if trust was revoked.
                projects = trae_trust.parse(trae_trust.snapshot(config_dir / "traecli.toml")[0]).get("projects", {})
                require(isinstance(projects, dict) and isinstance(projects.get(str(target)), dict)
                        and projects[str(target)].get("trust_level") == "trusted",
                        "operator_trust_revoked_or_missing")
            else:
                require(previous["registration"].get("native_trust") == "not_required",
                        "operator_trust_receipt_mismatch")
            verify()
            return {"ok": True, "receipt": file_ref(receipt), "reused_receipt": True,
                    "status": "trusted_not_started", "execution_authorized": False}
        require(set(p.name for p in directory.iterdir()) == {"operator-trust.lock"},
                "operator_trust_incomplete_attempt_preserve_and_reconcile")
        publish_new(directory / "trust-intent.json", {"input": ref, "started_at": now()})
        verify()
        result = (trae_trust.register(policy, target, launch_env) if source["agent"] == "trae" else
                  {"workspace": str(target), "changed": False, "native_trust": "not_required",
                   "agent": "pi"})
        verify()
        publish_new(receipt, {
            "schema_version": 1, "kind": "operator_workspace_trusted", "input": ref,
            "runtime": runtime, "workspace": workspace, "head": source["head"], "agent": source["agent"],
            "role": source["role"], "registered_at": now(), "registration": result,
            "status": "trusted_not_started", "execution_authorized": False,
            "requires_launch_readiness_and_independent_audit": True})
        return {"ok": True, "receipt": file_ref(receipt), "reused_receipt": False,
                "registration": result, "status": "trusted_not_started", "execution_authorized": False}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True)
    parser.add_argument("--input-sha256", required=True)
    parser.add_argument("--execute", action="store_true", help="register only the reviewed exact workspace")
    args = parser.parse_args(argv)
    try:
        require(args.execute, "operator_trust_explicit_execute_required")
        result = register({"path": args.input, "sha256": args.input_sha256})
    except (OSError, ValueError, SafetyError, KeyError, TypeError, AttributeError) as exc:
        result = {"ok": False, "decision": "stop", "execution_authorized": False,
                  "error": str(exc) if isinstance(exc, (ValueError, SafetyError)) else
                  "operator_trust_failed_preserve_attempt"}
        if isinstance(exc, OSError) and exc.errno is not None:
            result["os_error"] = errno.errorcode.get(exc.errno, "UNKNOWN")
        print(json.dumps(result))
        return 2
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

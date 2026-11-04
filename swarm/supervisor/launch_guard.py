"""Offline compatibility checks, not permission grants or live attestation.

Orca uses the existing sandbox permissions by default. Explicit escalation, when
separately required, must be compatible with the effective launcher/tool policy.
Evidence is not a UI's 'Full Access' label or a grant of runtime access.
"""

import json
from pathlib import PurePosixPath
import re

from .config import digest, exact_id, execution_sandbox_permissions, require


def target(config):
    return digest({"runtime": config["runtime"], "agents": config["agents"]})


def preflight(config):
    contract = config.get("launch_contract")
    require(isinstance(contract, dict) and type(contract.get("schema_version")) is int
            and contract["schema_version"] == 2,
            "launch_contract_missing: capture schema_version 2 approval and CLI evidence before launching")
    require(contract.get("target_sha256") == target(config), "launch_contract_target_changed")
    require(exact_id(contract.get("evidence_source")), "launch_contract_evidence_missing")
    cli = config["runtime"]["cli"]
    require(isinstance(cli, str) and cli.startswith("/") and str(PurePosixPath(cli)) == cli
            and ".." not in PurePosixPath(cli).parts, "launch_cli_must_be_absolute")
    roles = contract.get("roles")
    require(isinstance(roles, dict) and set(roles) == set(config["agents"]), "launch_contract_roles_missing")
    for role in sorted(roles):
        policy = roles[role]
        require(isinstance(policy, dict), "launch_contract_invalid_role")
        mode = execution_sandbox_permissions(config, role)
        require(policy.get("approval_policy") in ("never", "on-request", "on-failure", "untrusted"),
                "approval_policy_unverified:" + role)
        if mode == "require_escalated":
            require(policy["approval_policy"] != "never", "approval_policy_conflict:" + role)
            require(policy.get("escalation_supported") is True, "escalation_unverified:" + role)
        entries = policy.get("cli_entries")
        require(isinstance(entries, dict) and set(entries) == {"operator", "heartbeat", "recovery"}
                and all(value == cli for value in entries.values()), "launch_cli_mismatch:" + role)
    return {"compatible": True, "scope": "offline_operator_evidence_only", "target_sha256": target(config)}


def startup_diagnosis(receipt, evidence=None):
    """Return whitelisted diagnostics; never promote unknown to ready/dead/settled."""
    envelope = receipt.get("receipt", receipt)
    require(isinstance(envelope, dict) and isinstance(envelope.get("result"), dict), "invalid_start_receipt")
    launch = envelope["result"]
    ids = {key: launch.get(native) for key, native in
           (("run_id", "runId"), ("task_id", "taskId"), ("dispatch_id", "dispatchId"))}
    require(all(exact_id(value) for value in ids.values()), "missing_start_identity")
    ready = envelope.get("ok") is True and launch.get("state") == "ready" and receipt.get("exit_code") in (None, 0)
    code = "ready" if ready else "startup_not_ready"
    if evidence is not None:
        require(isinstance(evidence, dict) and all(evidence.get(k) == v for k, v in ids.items()),
                "startup_evidence_identity_mismatch")
        terminals = {e.get("id") for e in launch.get("effects", [])
                     if isinstance(e, dict) and e.get("kind") == "terminal" and e.get("role") == "agent"}
        require(exact_id(evidence.get("terminal_handle")) and evidence["terminal_handle"] in terminals,
                "startup_evidence_terminal_mismatch")
        requests = {r.get("call_id") for r in evidence.get("tool_requests", [])
                    if isinstance(r, dict) and exact_id(r.get("call_id"))
                    and re.search(r"sandbox_permissions[\"']?\s*:\s*[\"']require_escalated[\"']",
                                  str(r.get("input", "")))}
        denied = any(isinstance(r, dict) and r.get("call_id") in requests
                     and "approval policy is never" in json.dumps(r.get("output", "")).lower()
                     and "reject command" in json.dumps(r.get("output", "")).lower()
                     for r in evidence.get("tool_results", []))
        never = any(isinstance(c, dict) and c.get("approval_policy") == "never"
                    for c in evidence.get("turn_contexts", []))
        if denied and never:
            code = "conflicting_startup_evidence" if launch.get("state") == "ready" else "approval_policy_conflict"
            ready = False
    return {**ids, "ready": ready, "diagnosis": code,
            "automatic_retry_allowed": False, "native_state_recheck_required": not ready}


def require_ready(launch):
    require(launch.get("state") == "ready",
            "startup_not_ready: inspect bound tool evidence for approval_policy_conflict; "
            "inspect native residual resources, never relaunch automatically")

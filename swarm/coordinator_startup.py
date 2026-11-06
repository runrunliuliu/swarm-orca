"""Read-only, Operator-owned startup gates; not a native dispatch interceptor.

Explicit Trae exec/stream and TUI/runtime-state adapters; no automatic fallback.
Historical Runs use recovery, not a backdated first-dispatch receipt. No launch.
"""

import argparse
from datetime import timedelta
import json
import os
import subprocess

from coordinator_io import canonical, digest, now, parse, path, pinned, timestamp
from coordinator_creation_time import creation_bounds
from trae_coordinator import ContextFreshnessError, TUI_ADAPTER, TUI_EXECUTION, native, observe, read_trae_execution


KIND = "independent_coordinator_startup"


def session_contract_value(fields):
    """Materialize fixed new-contract defaults without reading evidence files."""
    require(isinstance(fields, dict) and not {"schema_version", "freshness"} & set(fields),
            "new_contract_fields_required")
    # Copy caller data and materialize defaults before hashing/handing it off.
    contract = parse(canonical(fields))
    contract.update(schema_version=2, freshness={
        "context_max_age_seconds": 1800, "gate_receipt_ttl_seconds": 180})
    contract.setdefault("run", None)
    require(contract["run"] is None, "new_contract_requires_session_phase")
    return contract


def build_session_contract(fields):
    """Build/validate a new v2 session contract, not a gate or identity proof."""
    contract = session_contract_value(fields)
    validate(contract)
    return contract


class GateError(ValueError):
    """Only fixed local codes may be exported; native/provider errors stay private."""

    def __init__(self, code, **details):
        super().__init__(code)
        self.details = details


def require(condition, code):
    if not condition:
        raise GateError(code)


def identity(contract):
    # The resume cursor/write roots and newly allocated Run may change between
    # phases. The independently pinned participants, CLI and role handoff may not.
    result = {key: contract[key] for key in (
        "adapter", "cli", "runtime", "workspace", "operator", "coordinator",
        "runtime_config", "role_skill", "handoff", "skill_read_evidence")}
    # Preserve v1 identity hashes; v2 timing policy cannot change between phases.
    if contract["schema_version"] == 2:
        result.update(schema_version=2, freshness=contract["freshness"])
        if "domain_binding" in contract:
            result["domain_binding"] = contract["domain_binding"]
        if "startup_anchor" in contract["observation"]:
            result["startup_anchor"] = contract["observation"]["startup_anchor"]
        if contract["adapter"] == TUI_ADAPTER:
            result["tui_binding"] = {k: contract["observation"][k] for k in ("profile", "caller_receipt")}
    return result


def validate(contract):
    require(isinstance(contract, dict), "invalid_startup_contract")
    version = contract.get("schema_version")
    require(type(version) is int and version in (1, 2), "unsupported_startup_schema")
    fields = {
        "schema_version", "adapter", "cli", "runtime", "workspace", "operator",
        "coordinator", "runtime_config", "role_skill", "handoff", "skill_read_evidence",
        "observation", "run"}
    require(set(contract) == fields | ({"freshness"} if version == 2 else set())
            | ({"domain_binding"} if version == 2 and "domain_binding" in contract else set()),
            "invalid_startup_contract")
    if version == 2:
        freshness = contract["freshness"]
        require(isinstance(freshness, dict) and set(freshness) == {
            "context_max_age_seconds", "gate_receipt_ttl_seconds"}, "invalid_freshness_policy")
        for key, limit in (("context_max_age_seconds", 3600), ("gate_receipt_ttl_seconds", 300)):
            require(type(freshness[key]) is int and 1 <= freshness[key] <= limit,
                    "invalid_" + key)
    tui = contract["adapter"] == TUI_ADAPTER
    require(contract["adapter"] == "trae-exec-stream-v1" or (tui and version == 2),
            "unsupported_startup_adapter")
    require(isinstance(contract["runtime"], str) and contract["runtime"], "runtime_required")
    for key, fields in (("workspace", {"id", "path"}),
                        ("operator", {"terminal", "incarnation", "provider", "session"}),
                        ("coordinator", {"terminal", "incarnation", "session"})):
        value = contract[key]
        require(isinstance(value, dict) and set(value) == fields
                and all(isinstance(v, str) and v.strip() for v in value.values()),
                "invalid_" + key)
    workspace = path(contract["workspace"]["path"], directory=True)
    operator, coordinator = contract["operator"], contract["coordinator"]
    require(operator["terminal"] != coordinator["terminal"], "independent_terminal_required")
    require(operator["session"] != coordinator["session"], "independent_session_required")
    # Scope before reading; a skill from a neighbouring checkout is not the role.
    skill = path(contract["role_skill"]["path"])
    require(skill.is_relative_to(workspace) and skill.name == "SKILL.md",
            "role_skill_outside_workspace")
    for key in ("cli", "runtime_config", "role_skill", "handoff", "skill_read_evidence"):
        pinned(contract[key])
    from coordinator_domain import validate_handoff
    validate_handoff(contract)
    observation = contract["observation"]
    if tui:
        require(read_trae_execution(contract["runtime_config"]["path"]) == TUI_EXECUTION,
                "tui_runtime_config_required")
        require(isinstance(observation, dict) and set(observation) == {
            "profile", "caller_receipt", "log_root", "roots", "startup_anchor"}, "invalid_tui_observation")
        path(observation["profile"], directory=True)
        pinned(observation["caller_receipt"])
    else:
        require(isinstance(observation, dict) and set(observation) in (
                {"cursor", "log_root", "roots"},
                {"cursor", "log_root", "roots", "startup_anchor"} if version == 2 else set())
            and type(observation["cursor"]) is int and observation["cursor"] >= 0,
            "invalid_observation")
    if "startup_anchor" in observation:
        pinned(observation["startup_anchor"])
    path(observation["log_root"], directory=True)
    require(isinstance(observation["roots"], list) and observation["roots"]
            and all(isinstance(r, str) for r in observation["roots"])
            and len(set(observation["roots"])) == len(observation["roots"]), "invalid_write_roots")
    for root in observation["roots"]:
        path(root, directory=True)
    run = contract["run"]
    require(run is None or (isinstance(run, dict) and set(run) == {"id", "generation"}
            and isinstance(run["id"], str) and run["id"].startswith("run_")
            and type(run["generation"]) is int and run["generation"] > 0), "invalid_run")
    if "domain_binding" in contract:
        require(tui, "software_requires_strict_tui")
        from software_development import validate_binding
        validate_binding(contract["domain_binding"], contract)


def check_actor_context(contract, actor):
    """Reject conflicting native hints; absence is NOT external identity proof."""
    require(actor in ("operator", "coordinator"), "invalid_gate_actor")
    caller = os.environ.get("ORCA_TERMINAL_HANDLE")
    if actor == "coordinator":
        require(caller == contract["coordinator"]["terminal"], "coordinator_native_context_required")
    elif caller is not None:
        require(caller == contract["operator"]["terminal"], "operator_native_context_mismatch")


def require_operator_context(contract):
    """Require the bound native context; matching hints alone are not identity proof."""
    check_actor_context(contract, "operator")
    require(os.environ.get("ORCA_TERMINAL_HANDLE") == contract["operator"]["terminal"],
            "operator_mailbox_native_context_required")


def check_operator_mailbox(contract):
    """Read only the actual Operator's pending mail; never consume/ACK or inspect Run mail."""
    require_operator_context(contract)
    mailbox = native(contract["cli"]["path"], contract["runtime"],
                     ["orchestration", "check", "--terminal", contract["operator"]["terminal"], "--peek"])
    require(isinstance(mailbox, dict) and not mailbox.get("runId")
            and type(mailbox.get("count")) is int and isinstance(mailbox.get("messages"), list)
            and mailbox["count"] == len(mailbox["messages"]), "operator_mailbox_state_unavailable")
    require(mailbox["count"] == 0, "operator_pending_messages_require_review")


def run_gate(contract_ref, *, phase, actor, previous=None):
    raw = pinned(contract_ref)
    contract = parse(raw)
    validate(contract)
    version = contract["schema_version"]
    freshness = contract.get("freshness")
    context_max_age = freshness["context_max_age_seconds"] if freshness else 300
    require(phase in ("session", "first-dispatch", "run-readiness") and actor in ("operator", "coordinator"),
            "invalid_gate_phase_or_actor")
    require((phase == "session") == (contract["run"] is None), "phase_run_mismatch")
    require(phase != "session" or (actor == "operator" and previous is None),
            "session_gate_is_operator_only")
    core_sha = digest(canonical(identity(contract)))
    started = now()
    prior = None
    if phase in ("first-dispatch", "run-readiness"):
        require(previous is not None, "previous_operator_gate_required")
        prior = parse(pinned(previous))
        require(isinstance(prior, dict) and type(prior.get("schema_version")) is int
                and prior["schema_version"] == version and prior.get("kind") == KIND
                and prior.get("ok") is True and prior.get("actor") == "operator"
                and prior.get("phase") == ("session" if actor == "operator" else phase)
                and prior.get("identity_sha256") == core_sha,
                "previous_operator_gate_mismatch")
        require(timestamp(prior["started_at"]) <= timestamp(prior["completed_at"])
                <= timestamp(started), "invalid_previous_gate_time")
        if actor == "coordinator":
            require(prior.get("contract_sha256") == contract_ref["sha256"]
                    and timestamp(started) <= timestamp(prior["valid_until"]),
                    "operator_dispatch_gate_stale_or_changed")

    operator, coordinator = contract["operator"], contract["coordinator"]
    check_actor_context(contract, actor)
    # Never set/borrow ORCA_TERMINAL_HANDLE or query run-current on behalf of a
    # different terminal. The outer Operator uses read-only run-show instead.
    cli, runtime = contract["cli"]["path"], contract["runtime"]
    tui = contract["adapter"] == TUI_ADAPTER
    operator_evidence = None

    def snapshot():
        nonlocal operator_evidence
        status = native(cli, runtime, ["status"])["runtime"]
        require(status.get("appVersion") == "1.4.219" and status.get("state") == "ready",
                "runtime_not_ready_or_supported")
        terminal = native(cli, runtime, ["terminal", "show", "--terminal", operator["terminal"]])["terminal"]
        require(terminal.get("handle") == operator["terminal"]
                and terminal.get("incarnationId") == operator["incarnation"]
                and terminal.get("connected") is True and terminal.get("orphaned") is False,
                "operator_identity_changed")
        if tui:
            from operator_session import observe_identity
            from coordinator_tui_errors import TuiError
            try:
                operator_evidence = observe_identity(cli=cli, runtime=runtime, operator=operator,
                    workspace=terminal.get("worktreeId"), profile=contract["observation"]["profile"],
                    log_root=contract["observation"]["log_root"], max_age_seconds=context_max_age,
                    previous=operator_evidence)
            except TuiError as exc:
                raise GateError(str(exc)) from exc
        if phase == "session":
            return None
        expected = contract["run"]
        run = native(cli, runtime, ["orchestration", "run-show", "--id", expected["id"]])["run"]
        require(run.get("id") == expected["id"]
                and run.get("coordinator_handle") == coordinator["terminal"]
                and type(run.get("consumer_generation")) is int
                and run["consumer_generation"] == expected["generation"], "run_ownership_changed")
        if actor == "operator":
            created_start, created_end = (creation_bounds(run["created_at"]) if version == 2 else
                                          (timestamp(run["created_at"]), None))
            require(timestamp(prior["completed_at"]) <= created_start
                    <= timestamp(now()), "run_predates_session_gate")
            if version == 2:
                # The session receipt is historical evidence at dispatch, but it
                # must still have been valid when the Coordinator created the Run.
                require(created_end <= timestamp(prior["valid_until"]),
                        "run_created_after_session_gate_expired")
        workers = native(cli, runtime, ["orchestration", "worker-list", "--run", expected["id"],
                                        "--include-remote"])
        page = workers.get("page", {})
        require(workers.get("scope", {}).get("run") == expected["id"]
                and workers.get("workers") == [] and type(page.get("total")) is int
                and page["total"] == 0 and page.get("hasMore") is False,
                "first_dispatch_inventory_not_empty_or_incomplete")
        return {key: run[key] for key in ("id", "coordinator_handle", "consumer_generation", "created_at")}

    if tui and actor == "operator":
        check_operator_mailbox(contract)
    before = snapshot()
    if contract["adapter"] == TUI_ADAPTER:
        from trae_tui import observe as observe_tui
        observer = observe_tui
        extra = {k: contract["observation"][k] for k in ("profile", "caller_receipt")}
    else:
        observer = observe
        extra = dict(cursor=contract["observation"]["cursor"], run=None)
    evidence = observer(cli=cli, runtime=runtime, terminal=coordinator["terminal"],
        incarnation=coordinator["incarnation"], workspace=contract["workspace"]["id"],
        cwd=contract["workspace"]["path"],
        log_root=contract["observation"]["log_root"], roots=contract["observation"]["roots"],
        expected_thread=coordinator["session"], **extra,
        trae_runtime_config=contract["runtime_config"]["path"],
        context_max_age_seconds=context_max_age,
        startup_anchor=contract["observation"].get("startup_anchor"))
    require(evidence["thread_id"] == coordinator["session"], "coordinator_session_changed")
    if actor == "coordinator":
        if contract["adapter"] == TUI_ADAPTER:
            from coordinator_strict import caller_result
            initial = caller_result(parse(pinned(contract["observation"]["caller_receipt"])), runtime)
            live = caller_result(native(cli, runtime, ["orchestration", "strict-caller-check"]), runtime)
            require(live["caller"] == initial["caller"], "tui_live_caller_changed")
        current = native(cli, runtime, ["orchestration", "run-current", "--from", coordinator["terminal"]])
        require(current.get("run", {}).get("id") == contract["run"]["id"], "native_run_binding_changed")
    require(snapshot() == before, "ownership_changed_during_gate")
    # Recheck pinned inputs after the observation window; a pin is not a lease.
    require(pinned(contract_ref) == raw, "startup_contract_changed")
    validate(contract)
    if previous is not None:
        pinned(previous)
    if tui and actor == "operator":
        check_operator_mailbox(contract)
    completed = now()
    require(timestamp(started) <= timestamp(completed), "gate_clock_moved_backwards")
    context_expires = timestamp(evidence["observed_at"]) + timedelta(seconds=context_max_age)
    age = (timestamp(completed) - timestamp(evidence["observed_at"])).total_seconds()
    if not 0 <= age <= context_max_age:
        raise GateError("session_evidence_expired_during_gate" if version == 1 else
                        "session_context_expired_during_gate",
                        age_seconds=age, max_age_seconds=context_max_age)
    valid_until = context_expires
    if freshness:
        valid_until = min(valid_until, timestamp(completed) +
                          timedelta(seconds=freshness["gate_receipt_ttl_seconds"]))
    if actor == "coordinator":
        valid_until = min(valid_until, timestamp(prior["valid_until"]))
        require(timestamp(completed) <= valid_until, "operator_dispatch_gate_expired_during_gate")
    result = {"schema_version": version, "kind": KIND, "ok": True, "phase": phase, "actor": actor,
            "decision": "session_verified" if phase == "session" else phase.replace("-", "_") + "_identity_verified",
            "contract_sha256": contract_ref["sha256"], "identity_sha256": core_sha,
            "previous_sha256": previous["sha256"] if previous else None,
            "started_at": started, "completed_at": completed, "valid_until": valid_until.isoformat(),
            "binding": identity(contract), "run": before,
            "session_evidence_sha256": digest(canonical(evidence)),
            "enforcement": "local_workflow_gate_not_runtime_interceptor",
            "execution_authorized": False}
    if freshness:
        result.update(freshness=freshness, context_observed_at=evidence["observed_at"],
                      context_age_seconds=age, context_expires_at=context_expires.isoformat())
    if tui:
        result.update(operator_session_evidence_sha256=digest(canonical(operator_evidence)),
                      operator_session_trust=operator_evidence["trust"],
                      operator_mailbox_checked=actor == "operator")
    return result


def contract_main(argv=None):
    parser = argparse.ArgumentParser(description=(
        "Build a new session startup contract with fixed v2 / 1800s / 180s defaults. "
        "Local validation only, not a gate receipt; no native calls or file writes."))
    parser.add_argument("--input", required=True,
                        help="reviewed new-contract fields, without schema_version or freshness")
    parser.add_argument("--input-sha256", required=True)
    args = parser.parse_args(argv)
    try:
        result = build_session_contract(parse(pinned({"path": args.input,
                                                     "sha256": args.input_sha256})))
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
        # Do not export paths or arbitrary input/parser messages.
        print(json.dumps({"schema_version": 1, "kind": "coordinator_startup_contract_build",
                          "ok": False, "decision": "stop",
                          "error": str(exc) if isinstance(exc, GateError) else "startup_contract_build_failed"}))
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def cli_main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--contract", required=True)
    parser.add_argument("--contract-sha256", required=True)
    parser.add_argument("--phase", choices=("session", "first-dispatch", "run-readiness"), required=True)
    parser.add_argument("--actor", choices=("operator", "coordinator"), required=True)
    parser.add_argument("--previous-receipt")
    parser.add_argument("--previous-sha256")
    args = parser.parse_args(argv)
    try:
        require(bool(args.previous_receipt) == bool(args.previous_sha256), "previous_pin_required")
        previous = ({"path": args.previous_receipt, "sha256": args.previous_sha256}
                    if args.previous_receipt else None)
        result = run_gate({"path": args.contract, "sha256": args.contract_sha256},
                          phase=args.phase, actor=args.actor, previous=previous)
    except (OSError, ValueError, KeyError, TypeError, AttributeError, subprocess.SubprocessError) as exc:
        # No raw native output, paths, model text or provider error in stdout.
        result = {"schema_version": 1, "kind": KIND, "ok": False,
                  "decision": "stop", "error": str(exc) if isinstance(exc, GateError) else "startup_gate_failed"}
        if isinstance(exc, ContextFreshnessError):
            result.update(error=exc.code, age_seconds=exc.age_seconds,
                          max_age_seconds=exc.max_age_seconds)
        elif isinstance(exc, GateError):
            result.update(exc.details)
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["ok"] else 2

"""Check and start the first Worker in one Coordinator tool invocation.

Local workflow fence, not a runtime transaction. Never retries a mutation or
refreshes an Operator receipt on behalf of the Operator.
"""

import argparse
from datetime import timedelta
import json
import os
from pathlib import Path
import subprocess
import time
import uuid

from coordinator_io import (bound_lock, file_ref, now, parse, path, pinned,
                            publish_new, timestamp, validate_ref)
from coordinator_startup import GateError, require, run_gate, validate
from coordinator_worker_plan import build_plan
from trae_coordinator import ContextFreshnessError, native


NATURAL_EXPIRY_REFUSAL_ERRORS = {
    "operator_dispatch_gate_stale_or_changed",
    "operator_dispatch_gate_expired_during_gate",
}


def classify_first_dispatch_acceptance(*, ok=False, error=None):
    """Classify first-dispatch evidence for live acceptance reporting.

    This deliberately separates a successful dispatch chain from the TTL
    scenario.  A short remaining window before natural expiry is a NON_HIT for
    `first-dispatch-ttl`; it cannot later be converted to PASS by refreshing the
    gate and dispatching a Worker.
    """
    if ok:
        return {"attempt_outcome": "dispatch_succeeded",
                "first_dispatch_ttl_acceptance": "NOT_A_TTL_HIT",
                "ttl_hit": False,
                "requires_timing_evidence": False,
                "explanation": "dispatch success is support evidence for the first-dispatch chain, not the TTL scenario"}
    if error == "first_dispatch_window_insufficient_refresh_operator_gate":
        return {"attempt_outcome": "insufficient_window",
                "first_dispatch_ttl_acceptance": "NON_HIT",
                "ttl_hit": False,
                "requires_timing_evidence": False,
                "explanation": "remaining gate window was too short before natural expiry; later refresh/dispatch cannot replay the TTL scene"}
    if error in NATURAL_EXPIRY_REFUSAL_ERRORS:
        return {"attempt_outcome": "expired",
                "first_dispatch_ttl_acceptance": "TTL_CANDIDATE_REQUIRES_EVIDENCE",
                "ttl_hit": None,
                "requires_timing_evidence": True,
                "explanation": "candidate natural-expiry refusal; acceptance still requires timing evidence and zero Worker/Dispatch side effects"}
    return {"attempt_outcome": "other_stop" if error else "not_evaluated",
            "first_dispatch_ttl_acceptance": "NOT_EVALUATED",
            "ttl_hit": None,
            "requires_timing_evidence": False,
            "explanation": "not a first-dispatch TTL classification event"}


def load(request_ref):
    request = parse(pinned(request_ref))
    guard = request.get("first_dispatch")
    require(isinstance(guard, dict) and set(guard) == {"contract", "operator_gate", "state_root"},
            "first_dispatch_config_required")
    for key in ("contract", "operator_gate"):
        validate_ref(guard[key])
    contract = parse(pinned(guard["contract"]))
    validate(contract)
    require(contract["schema_version"] == 2 and contract["run"] is not None,
            "first_dispatch_v2_run_required")
    require(request.get("cli") == contract["cli"]["path"]
            and request.get("run") == contract["run"]["id"], "first_dispatch_request_binding_mismatch")
    root = path(guard["state_root"], directory=True)
    require(any(root.is_relative_to(Path(r)) for r in contract["observation"]["roots"]),
            "first_dispatch_state_outside_roots")
    # Keep native argv validation/escaping in the existing planner.
    worker = {key: value for key, value in request.items() if key != "first_dispatch"}
    worker.setdefault("timeout_ms", 60000)
    try:
        plan = build_plan(worker)
    except ValueError as exc:
        # Surface fixed-profile failures before any gate/intent/native mutation.
        raise GateError(str(exc)) from None
    return guard, contract, root, plan, worker["timeout_ms"] / 1000 + 15, worker


def observe_isolated_workspace(contract, worker, *, call=native):
    isolation = worker.get("write_isolation")
    if isolation is None:
        return None
    selector = worker["placement"]["worktree"]
    observed = call(contract["cli"]["path"], contract["runtime"],
                    ["worktree", "show", "--worktree", selector])
    workspace = observed.get("worktree", {})
    expected_id = selector[3:]
    expected_root = Path(isolation["workspace_root"])
    observed_root = Path(workspace.get("path", ""))
    try:
        resolved_root = observed_root.resolve(strict=True)
    except (OSError, RuntimeError):
        require(False, "write_isolation_workspace_binding_mismatch")
    require(workspace.get("id") == expected_id
            and observed_root == expected_root and resolved_root == expected_root,
            "write_isolation_workspace_binding_mismatch")
    return {"id": expected_id, "path": str(expected_root)}


def verify_accepted(ref, *, contract_ref):
    """Historical native acceptance, not merely a successful Coordinator gate."""
    value = parse(pinned(ref))
    require(value.get("ok") is True and value.get("kind") == "coordinator_first_dispatch",
            "first_dispatch_acceptance_required")
    guard, contract, root, plan, _, _ = load(value["request"])
    require(ref == file_ref(root / "dispatched.json") and guard["contract"] == contract_ref,
            "first_dispatch_acceptance_binding_changed")
    intent = parse(pinned(file_ref(root / "dispatch-intent.json")))
    require(intent.get("request") == value["request"] and intent.get("gate") == value["gate"]
            and intent.get("operator_gate") == guard["operator_gate"]
            and intent.get("request_id") == value["request_id"]
            and intent.get("resolved_profile") == value["resolved_profile"] == plan["resolved_profile"]
            and value["response"] == file_ref(root / "dispatch-response.json"),
            "first_dispatch_acceptance_binding_changed")
    reply = parse(pinned(value["response"]))
    gate = parse(pinned(value["gate"]))
    from coordinator_startup import KIND, identity
    from coordinator_io import canonical, digest
    prior = parse(pinned(guard["operator_gate"]))
    for receipt, actor in ((gate, "coordinator"), (prior, "operator")):
        require(receipt.get("kind") == KIND and receipt.get("schema_version") == 2
                and receipt.get("ok") is True and receipt.get("phase") == "first-dispatch"
                and receipt.get("actor") == actor and receipt.get("contract_sha256") == contract_ref["sha256"]
                and receipt.get("identity_sha256") == digest(canonical(identity(contract)))
                and receipt.get("run", {}).get("coordinator_handle") == contract["coordinator"]["terminal"]
                and receipt["run"].get("id") == contract["run"]["id"]
                and receipt["run"].get("consumer_generation") == contract["run"]["generation"],
                "first_dispatch_acceptance_gate_changed")
    require(timestamp(prior["completed_at"]) <= timestamp(gate["started_at"])
            <= timestamp(gate["completed_at"]) <= timestamp(gate["valid_until"])
            <= timestamp(prior["valid_until"]), "first_dispatch_acceptance_time_changed")
    require(reply.get("mutation", {}).get("requestId") == value["request_id"]
            and reply.get("state") == "ready" and reply.get("stage") == "input_accepted"
            and reply.get("runId") == contract["run"]["id"]
            and isinstance(reply.get("dispatchId"), str) and reply["dispatchId"]
            and isinstance(reply.get("taskId"), str) and reply["taskId"]
            and gate.get("contract_sha256") == contract_ref["sha256"]
            and gate.get("previous_sha256") == guard["operator_gate"]["sha256"]
            and gate.get("run", {}).get("id") == contract["run"]["id"]
            and gate["run"].get("consumer_generation") == contract["run"]["generation"],
            "first_dispatch_native_outcome_unconfirmed")
    require(timestamp(gate["completed_at"]) <= timestamp(value["requested_at"])
            <= timestamp(value["received_at"]) < timestamp(value["valid_until"])
            == timestamp(gate["valid_until"]), "first_dispatch_acceptance_time_changed")
    request = parse(pinned(value["request"]))
    require("task" not in request or reply["taskId"] == request["task"], "first_dispatch_native_task_changed")
    return value


def dispatch(request_ref, *, call=native, query=native, before_dispatch=lambda: None):
    guard, contract, root, plan, timeout, worker = load(request_ref)
    with bound_lock(root, guard["contract"], "first-dispatch"):
        intent = root / "dispatch-intent.json"
        require(not os.path.lexists(intent), "first_dispatch_attempt_requires_reconciliation")
        placement = observe_isolated_workspace(contract, worker, call=query)
        # Reuses the role-separated gate, including empty historical inventory,
        # current settings, native caller, owner/generation and all input pins.
        gate = run_gate(guard["contract"], phase="first-dispatch", actor="coordinator",
                        previous=guard["operator_gate"])
        gate_path = root / ("coordinator-gate-" + uuid.uuid4().hex + ".json")
        publish_new(gate_path, gate)
        gate_ref = file_ref(gate_path)
        cutoff = timestamp(gate["valid_until"])
        checked_at = timestamp(now())
        stop = time.monotonic() + (cutoff - checked_at).total_seconds()
        require(timestamp(gate["completed_at"]) <= checked_at
                and checked_at + timedelta(seconds=timeout) < cutoff,
                "first_dispatch_window_insufficient_refresh_operator_gate")
        require(load(request_ref) == (guard, contract, root, plan, timeout, worker),
                "first_dispatch_inputs_changed")
        require(observe_isolated_workspace(contract, worker, call=query) == placement,
                "write_isolation_workspace_changed")
        pinned(guard["operator_gate"])
        pinned(gate_ref)
        request_id = str(uuid.uuid4())
        args = [*plan["argv"][1:-1], "--retry-request", request_id]
        before_dispatch()
        # Durable before mutation: a timeout/crash is unknown, never permission
        # to resend, even with fresh gates or another Worker request.
        publish_new(intent, {"request": request_ref, "gate": gate_ref,
                             "operator_gate": guard["operator_gate"], "request_id": request_id,
                             "resolved_profile": plan["resolved_profile"],
                             "write_isolation_workspace": placement})
        requested = timestamp(now())
        require(checked_at <= requested and requested + timedelta(seconds=timeout) < cutoff
                and time.monotonic() + timeout < stop,
                "first_dispatch_expired_before_start_requires_reconciliation")
        try:
            before_dispatch()
            requested = timestamp(now())
            require(checked_at <= requested and requested + timedelta(seconds=timeout) < cutoff
                    and time.monotonic() + timeout < stop,
                    "first_dispatch_expired_before_start_requires_reconciliation")
            reply = call(contract["cli"]["path"], contract["runtime"], args,
                         timeout_seconds=timeout)
            received = timestamp(now())
            publish_new(root / "dispatch-response.json", reply)
            require(requested <= received < cutoff and time.monotonic() < stop,
                    "first_dispatch_response_after_expiry")
            require(reply.get("mutation", {}).get("requestId") == request_id,
                    "first_dispatch_response_mismatch")
            # Preserve the full native receipt. A failed/unknown native result
            # must not be converted into a successful first-dispatch handoff.
            require(reply.get("state") == "ready" and reply.get("stage") == "input_accepted"
                    and reply.get("runId") == contract["run"]["id"]
                    and isinstance(reply.get("dispatchId"), str) and reply["dispatchId"]
                    and isinstance(reply.get("taskId"), str) and reply["taskId"],
                    "first_dispatch_native_outcome_unconfirmed")
            result = {"ok": True, "kind": "coordinator_first_dispatch", "gate": gate_ref,
                      "request": request_ref, "request_id": request_id,
                      "resolved_profile": plan["resolved_profile"],
                      "response": file_ref(root / "dispatch-response.json"),
                      "requested_at": requested.isoformat(), "received_at": received.isoformat(),
                      "valid_until": gate["valid_until"], "native_gate_atomic": False,
                      "execution_authorized": False,
                      "first_dispatch_acceptance": classify_first_dispatch_acceptance(ok=True)}
            publish_new(root / "dispatched.json", result)
            return result
        except (OSError, ValueError, KeyError, TypeError, AttributeError, subprocess.SubprocessError) as exc:
            raise GateError("first_dispatch_attempt_requires_reconciliation",
                            cause=str(exc) if isinstance(exc, GateError) else "native_outcome_unknown") from None


def cli_main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--request", required=True)
    parser.add_argument("--request-sha256", required=True)
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args(argv)
    try:
        require(args.execute, "first_dispatch_explicit_execute_required")
        result = dispatch({"path": args.request, "sha256": args.request_sha256})
    except (OSError, ValueError, KeyError, TypeError, AttributeError, subprocess.SubprocessError) as exc:
        result = {"ok": False, "decision": "stop", "execution_authorized": False,
                  "error": str(exc) if isinstance(exc, GateError) else "first_dispatch_failed"}
        if isinstance(exc, ContextFreshnessError):
            result.update(error=exc.code, age_seconds=exc.age_seconds,
                          max_age_seconds=exc.max_age_seconds)
        elif isinstance(exc, GateError):
            result.update(exc.details)
        result["first_dispatch_acceptance"] = classify_first_dispatch_acceptance(
            error=result.get("error"))
        if result["error"] in {"operator_dispatch_gate_stale_or_changed",
                               "operator_dispatch_gate_expired_during_gate",
                               "first_dispatch_window_insufficient_refresh_operator_gate"}:
            result["next_step"] = "operator_recheck_same_run_preserve_old_receipts"
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["ok"] else 2

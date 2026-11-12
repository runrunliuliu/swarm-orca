"""One bounded, same-native-caller startup handshake. No Worker dispatch or recovery.

The Operator audits/pins readiness, then publishes a complete immutable gate.
The Coordinator waits and checks/creates/readbacks in one live tool invocation.
This is a local workflow, NOT an atomic native gate+create transaction.
"""

import argparse
from datetime import timedelta
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import time
import uuid

from coordinator_io import file_ref, now, parse, path, pinned, publish_new, timestamp
from coordinator_creation_time import creation_bounds, next_creation_second
import publication_wait
import tui_adapter
from coordinator_startup import GateError, require_operator_context, run_gate, validate
from coordinator_strict import StrictCheckError, caller_result, check_session, require
from trae_coordinator import native
from bootstrap_s5 import protect, checkpoint, cli_options, cli_owner, plan_commands


def load(ref):
    config = parse(pinned(ref))
    if config.get("schema_version") == 4:
        require(set(config) == {"schema_version", "base_config", "lifecycle_spec"},
                "strict_activation_invalid")
        base, contract, initial, directory = load(config["base_config"])
        require(base["schema_version"] in (1, 2, 3) and "base_config" not in base, "strict_activation_nested")
        spec = parse(pinned(config["lifecycle_spec"]))
        from startup_execution import validate as validate_execution
        validate_execution(spec["execution"])
        require(spec["schema_version"] == 2, "strict_activation_spec_invalid")
        require(ref["path"] == str(directory.parent / "lifecycle" / "activation.json")
                and config["lifecycle_spec"]["path"] == str(directory.parent / "lifecycle" / "spec.json"),
                "strict_activation_path_invalid")
        return dict(base, lifecycle_spec=config["lifecycle_spec"], base_config=config["base_config"]), contract, initial, directory
    validate_config_shape(config)
    contract = parse(pinned(config["contract"]))
    initial, directory = validate_inputs(config, contract)
    if config["schema_version"] in (2, 3):
        from coordinator_strict_delivery import request
        from coordinator_request_prepare import config_for, contract_for
        expected, _, _, _ = request(config["request"], allow_started=True)
        require(expected["schema_version"] == config["schema_version"] + 2,
                "strict_prepare_request_version_mismatch")
        require(config == config_for(config["request"], expected, contract_for(expected)),
                "strict_start_request_config_mismatch")
        if config["schema_version"] == 3:
            from coordinator_request_prepare import verify_prepared_commit
            verify_prepared_commit(config["request"], expected, ref)
    if config["schema_version"] != 3:
        from coordinator_prepared_commit import COMMIT_NAME
        require(not os.path.lexists(directory / COMMIT_NAME), "strict_prepare_commit_downgrade")
        request_path = directory.parent / "strict-config-request.json"
        if os.path.lexists(request_path):
            require(parse(pinned(file_ref(request_path))).get("schema_version") != 5,
                    "strict_prepare_commit_downgrade")
    return config, contract, initial, directory


def require_config_review(ref, config, contract, directory):
    """New generated configs cannot bypass review by directly invoking the gate waiter."""
    if "base_config" in config:
        ref = config["base_config"]
    if config["schema_version"] in (2, 3):
        from coordinator_request_prepare import verify_prepared, verify_review
        from coordinator_strict_delivery import request
        expected, _, _, initial = request(config["request"], allow_started=True)
        preparation = file_ref(directory / "prepared-inputs.json")
        verify_prepared(config["request"], expected, initial, ref, preparation, allow_started=True)
        verify_review(config["request"], ref, preparation,
                      file_ref(directory.parent / "strict-config-review.json"), contract)


def validate_config_shape(config):
    require(isinstance(config, dict), "strict_start_config_invalid")
    version = config.get("schema_version")
    require(set(config) == {
        "schema_version", "contract", "caller_receipt", "readiness_evidence", "directory",
        "objective", "max_workers", "deadline", "request_id"} | ({"request"} if version in (2, 3) else set())
        and type(version) is int and version in (1, 2, 3),
        "strict_start_config_invalid")


def validate_inputs(config, contract, *, unpublished=False):
    """Shared checks for an in-memory preparation and a published start config."""
    validate_config_shape(config)
    validate(contract)
    require(contract["schema_version"] == 2 and contract["run"] is None,
            "strict_session_requires_v2_session_contract")
    initial = caller_result(parse(pinned(config["caller_receipt"])), contract["runtime"])
    if tui_adapter.is_tui(contract["adapter"]):
        require(config["caller_receipt"] == contract["observation"]["caller_receipt"],
                "tui_caller_pin_changed")
    require(initial["caller"]["terminalHandle"] == contract["coordinator"]["terminal"],
            "strict_start_caller_mismatch")
    require(isinstance(config["objective"], str) and config["objective"].strip()
            and "\0" not in config["objective"] and len(config["objective"].encode()) <= 16384,
            "strict_start_objective_required")
    require(type(config["max_workers"]) is int and config["max_workers"] > 0,
            "strict_start_max_workers_required")
    if "domain_binding" in contract:
        from software_development import scoped_json
        task = scoped_json(contract["domain_binding"]["contract"], contract["observation"]["roots"])
        require(config["objective"] == task["objective"]
                and config["max_workers"] == task["policy"]["max_workers"],
                "software_startup_task_changed")
    require(isinstance(config["request_id"], str)
            and str(uuid.UUID(config["request_id"])) == config["request_id"],
            "strict_start_request_id_invalid")
    timestamp(config["deadline"])
    if unpublished:
        from coordinator_request_prepare import output_directory
        directory = output_directory(config["directory"], absent=True)
    else:
        directory = path(config["directory"], directory=True)
    require(any(directory.is_relative_to(Path(root)) for root in contract["observation"]["roots"]),
            "strict_start_directory_outside_roots")
    refs = config["readiness_evidence"]
    require(isinstance(refs, list) and refs and contract["skill_read_evidence"] in refs,
            "strict_start_readiness_evidence_required")
    for item in refs:
        raw = pinned(item)
        # An observer's settings receipt is not proof of reading the role skill.
        if item == contract["skill_read_evidence"]:
            try:
                evidence = parse(raw)
            except ValueError:
                evidence = None  # Raw native tool transcript is also accepted for human audit.
            require(not isinstance(evidence, dict) or not (
                evidence.get("kind") in ("trae_startup_anchor", "trae_session_observation")
                or {"thread_id", "effective", "log_path"} <= evidence.keys()),
                "strict_start_skill_evidence_is_observation")
    return initial, directory


def validate_start_window(config, *, checked_at=None):
    """Absolute startup deadline, separate from context age and gate receipt TTL."""
    remaining = (timestamp(config["deadline"]) - timestamp(
        now() if checked_at is None else checked_at)).total_seconds()
    require(remaining > 0, "strict_start_deadline_expired")
    require(remaining <= 900, "strict_start_wait_must_be_bounded_to_900_seconds")
    return remaining


def require_unstarted_attempt(directory):
    """Presence is a replay fence, not proof of native success or failure.

    Check mutation evidence first, even after deadline expiry or Run release.
    lstat also catches dangling links; only ENOENT permits proceeding. Exclusive
    publication remains the race fence, so this check grants no retry authority.
    """
    for names, code in (
        (("create-intent.json", "create-response.json", "created.json"),
         "strict_start_create_requires_reconciliation"),
        (("ready.json", "publication-intent.json", "operator-gate.json", "gate-ready.json"),
         "strict_start_attempt_already_started"),
    ):
        for name in names:
            try:
                (directory / name).lstat()
            except FileNotFoundError:
                continue
            raise StrictCheckError(code)


def live(config, contract, initial):
    require(os.environ.get("ORCA_TERMINAL_HANDLE") == contract["coordinator"]["terminal"],
            "strict_coordinator_native_context_required")
    proof = native(contract["cli"]["path"], contract["runtime"],
                   ["orchestration", "strict-caller-check"])
    require(caller_result(proof, contract["runtime"])["caller"] == initial["caller"],
            "strict_launch_authority_changed")
    require(timestamp(now()) < timestamp(config["deadline"]), "strict_start_deadline_expired")


def plan(ref, *, check_operator_context=False):
    config, contract, _, directory = load(ref)
    from bootstrap_s5 import current
    guard = current.get()
    if guard is not None and guard.action == "prepare" and "lifecycle_spec" not in config:
        return plan_commands(dict(ok=True, state="awaiting_lifecycle", next_owner="operator",
            execution_authorized=False, base_config=ref,
            next_entry=str(Path(__file__).resolve().with_name("operator_startup.py")),
            next_action="prepare schema v2 with explicit execution, workers, original bootstrap_owner and sender",
            output_dir=str(directory.parent / "lifecycle")))
    lifecycle = require_lifecycle(ref, config, directory)
    require_unstarted_attempt(directory)
    validate_start_window(config)
    if check_operator_context:
        require_operator_context(contract)
    entry = [sys.executable, "-B", str(Path(__file__).resolve().with_name("coordinator_launch.py"))]
    ready_path = directory / "ready.json"
    gate_ready_path = directory / "gate-ready.json"
    gate_path = directory / "operator-gate.json"
    wait = [*entry, "strict-start-wait", "--config", ref["path"],
            "--config-sha256", ref["sha256"], "--execute"]
    publish = [*entry, "strict-start-publish", "--config", ref["path"],
               "--config-sha256", ref["sha256"], "--ready", str(ready_path),
               "--ready-sha256", "OPERATOR_REVIEWED_READY_SHA256", "--execute"]
    operator_check = [*entry, "strict-start-plan", "--config", ref["path"],
                      "--config-sha256", ref["sha256"], "--check-operator-context"]
    result = plan_commands({"ok": True, "execution_authorized": False, "wait_argv": wait,
            "wait_command": shlex.join(wait), "operator_publish_argv": publish,
            "operator_publish_contract": config["contract"],
            "operator_publish_identity": contract["operator"],
            "operator_check_argv": operator_check,
            "operator_context_checked": check_operator_context,
            "operator_publish_ready_path": str(ready_path),
            "operator_publish_expected_bundle": {
                "path": str(gate_ready_path), "kind": "strict_start_gate_publication",
                "ready_path": str(ready_path), "gate_path": str(gate_path)},
            "phase_waits": [
                {"phase": "coordinator_waiter_ready",
                 "producer": "strict-start-wait --execute in the live Coordinator context",
                 "consumer": "Operator",
                 "wait_for": "ready.json",
                 "path": str(ready_path),
                 "note": "tui-idle is not a readiness gate for this phase"},
                {"phase": "operator_gate_publication",
                 "producer": "strict-start-publish --execute in the Operator context",
                 "consumer": "strict-start-wait",
                 "wait_for": "gate-ready.json",
                 "path": str(gate_ready_path),
                 "note": "The waiter observes only this file, not terminal text pasted into the TUI"}],
            "deadline": config["deadline"], "max_workers": config["max_workers"],
            "requirements": ["Independently audit authorization, Operator identity and full skill/tool evidence",
                             "Deliver this plan to operator_publish_identity bound by operator_publish_contract; only that Operator executes operator_publish_argv in its own native session. No ordinary-shell fallback",
                             "Operator runs operator_check_argv in its own native context before the Coordinator starts its waiter; matching context is not identity proof, authorization or a gate",
                             "Do not set or borrow ORCA_TERMINAL_HANDLE; the outer executor prepares, audits and hands off, never publishes on behalf of the Operator",
                             "Report the exact blocker and preserve evidence on failure. Do not start a new attempt automatically",
                             "Run waiter in the continuously live Coordinator's own native tool context",
                             "Follow phase files/events: wait for ready.json, then publish with operator_publish_argv, then waiter consumes gate-ready.json",
                             "Do not treat tui-idle as a generic readiness signal for strict-start phases",
                             "Operator pins ready.json before publishing; never glob, paste a receipt into the TUI, or overwrite receipts",
                             "Start this attempt once; reconcile started/unknown outcomes without replay",
                             "No Worker dispatch until both existing first-dispatch gates pass"]})
    if "lifecycle_spec" in config:
        from startup_handoff import commands
        result["lifecycle_spec"] = config["lifecycle_spec"]
        result["lifecycle"] = lifecycle
        result["coordinator_handoff"] = commands(lifecycle, "materials", "coordinator")
        result["operator_handoff"] = commands(lifecycle, "review", "operator")
        result["startup_completion"] = "runtime_ready_not_run_created"
    return result


def require_lifecycle(ref, config, directory):
    from bootstrap_s5 import current
    activation = directory.parent / "lifecycle" / "activation.json"
    require(current.get() is None or "lifecycle_spec" in config, "strict_lifecycle_required")
    require(not os.path.lexists(activation) or ref == file_ref(activation), "strict_lifecycle_activation_required")
    if "lifecycle_spec" in config:
        from operator_startup import load as load_lifecycle
        lifecycle = file_ref(parse(pinned(config["lifecycle_spec"]))["lifecycle_path"])
        require(load_lifecycle(lifecycle)[0]["strict_start"] == ref, "strict_lifecycle_binding_changed")
        return lifecycle


@protect("publish", "operator", config=True)
def publish(ref, ready_ref):
    config, contract, initial, directory = load(ref)
    require_lifecycle(ref, config, directory)
    require_config_review(ref, config, contract, directory)
    validate_start_window(config)
    # Reject a misplaced invocation before reading readiness or claiming publication.
    # The real gate still rechecks identity/mailbox/pins/freshness; this is not a lease.
    require_operator_context(contract)
    require(ready_ref["path"] == str(directory / "ready.json"), "strict_start_ready_path_mismatch")
    ready = parse(pinned(ready_ref))
    require(ready.get("schema_version") == 1 and ready.get("kind") == "strict_start_ready"
            and ready.get("config_sha256") == ref["sha256"]
            and ready.get("caller") == initial["caller"]
            and ready.get("readiness_evidence") == config["readiness_evidence"]
            and timestamp(initial["checkedAt"]) <= timestamp(ready["ready_at"])
            <= timestamp(now()) < timestamp(config["deadline"]), "strict_start_ready_mismatch")
    # Intent and outputs are exclusive: a consumed failure/success is never replaced.
    publish_new(directory / "publication-intent.json", {
        "config_sha256": ref["sha256"], "ready": ready_ref, "started_at": now()})
    try:
        receipt = run_gate(config["contract"], phase="session", actor="operator")
        from bootstrap_s5 import current
        gate_path = directory / "operator-gate.json"
        if current.get() is not None:
            # Preserve admitted native outcome even if STOP won during run_gate.
            publish_new(gate_path, receipt)
            checkpoint()
        require(timestamp(ready["ready_at"]) <= timestamp(receipt["started_at"]),
                "strict_start_gate_predates_readiness")
        load(ref)
        pinned(ready_ref)
        require(timestamp(now()) < min(timestamp(receipt["valid_until"]), timestamp(config["deadline"])),
                "strict_start_gate_expired_before_publication")
        if current.get() is None:
            publish_new(gate_path, receipt)
        bundle = {"schema_version": 1, "kind": "strict_start_gate_publication", "ok": True,
                  "config_sha256": ref["sha256"], "ready": ready_ref, "gate": file_ref(gate_path)}
        publish_new(directory / "gate-ready.json", bundle)
    except (PermissionError, FileExistsError):
        # Access denial or another publisher's claim stops all further publication.
        raise
    except (OSError, ValueError, KeyError, TypeError, AttributeError, subprocess.SubprocessError) as exc:
        # Same exact channel, but a terminal failure. Never replace it with a later success.
        # A write failure here propagates; do not mask permission errors or change paths.
        publish_new(directory / "gate-ready.json", {
            "schema_version": 1, "kind": "strict_start_gate_publication", "ok": False,
            "config_sha256": ref["sha256"], "ready": ready_ref,
            "error": str(exc) if isinstance(exc, (GateError, StrictCheckError)) else "strict_start_gate_failed"})
        raise StrictCheckError("strict_start_gate_publication_failed") from None
    return {"ok": True, "publication": file_ref(directory / "gate-ready.json"),
            "execution_authorized": False}


@protect("create", "coordinator", config=True)
def wait_and_create(ref):
    config, contract, initial, directory = load(ref)
    lifecycle = require_lifecycle(ref, config, directory)
    require_unstarted_attempt(directory)
    require_config_review(ref, config, contract, directory)
    remaining = validate_start_window(config)
    stop = time.monotonic() + remaining
    live(config, contract, initial)
    cli, runtime = contract["cli"]["path"], contract["runtime"]
    current = native(cli, runtime, ["orchestration", "run-current"])
    require("run" in current and current["run"] is None, "strict_start_existing_run_requires_reconciliation")
    publish_new(directory / "ready.json", {
        "schema_version": 1, "kind": "strict_start_ready", "config_sha256": ref["sha256"],
        "caller": initial["caller"], "readiness_evidence": config["readiness_evidence"],
        "ready_at": now()})
    ready_ref = file_ref(directory / "ready.json")
    bundle_path = directory / "gate-ready.json"
    # Watch once, not per iteration: an event may only *shorten* this wait, so the deadline and
    # the `file_ref` re-check below still decide, and `watch()` returning None (inotify unavailable)
    # degrades to exactly the polling loop it replaces. The fallback period is the real worst-case
    # delivery latency, so it is logged instead of being implied.
    watcher = publication_wait.watch(bundle_path)
    try:
        while True:
            checkpoint()
            require(time.monotonic() < stop and timestamp(now()) < timestamp(config["deadline"]),
                    "strict_start_wait_expired")
            # Only ENOENT means wait. Invalid/failed publications and permission errors stop.
            try:
                bundle_ref = file_ref(bundle_path)
            except FileNotFoundError:
                publication_wait.idle(
                    watcher, min(publication_wait.FALLBACK_SECONDS, max(0.0, stop - time.monotonic())))
                continue
            break
    finally:
        publication_wait.log("start_gate", watcher)
        if watcher is not None:
            watcher.close()
    bundle = parse(pinned(bundle_ref))
    require(bundle.get("schema_version") == 1 and bundle.get("kind") == "strict_start_gate_publication"
            and bundle.get("ok") is True
            and bundle.get("config_sha256") == ref["sha256"] and bundle.get("ready") == ready_ref
            and isinstance(bundle.get("gate"), dict)
            and bundle["gate"].get("path") == str(directory / "operator-gate.json"),
            "strict_start_publication_mismatch")
    gate_ref = bundle["gate"]
    receipt = parse(pinned(gate_ref))
    require(timestamp(parse(pinned(ready_ref))["ready_at"]) <= timestamp(receipt["started_at"]),
            "strict_start_gate_predates_readiness")
    earliest = next_creation_second(receipt["completed_at"])
    cutoff = min(timestamp(receipt["valid_until"]), timestamp(config["deadline"]))
    require(timestamp(now()) < cutoff, "strict_operator_session_receipt_stale")
    # Leave a whole native second inside the gate; never widen the gate itself.
    require(earliest + timedelta(seconds=1) <= cutoff, "strict_start_no_safe_creation_window")
    while True:
        checkpoint()
        current_time = timestamp(now())
        require(time.monotonic() < stop and timestamp(receipt["completed_at"]) <= current_time < cutoff,
                "strict_operator_session_receipt_stale")
        if current_time >= earliest:
            break
        time.sleep(min(0.25, (earliest - current_time).total_seconds()))
    load(ref)
    checked = check_session(config["contract"], gate_ref, config["caller_receipt"])
    current = native(cli, runtime, ["orchestration", "run-current"])
    require("run" in current and current["run"] is None, "strict_start_existing_run_requires_reconciliation")
    live(config, contract, initial)
    load(ref)
    pinned(gate_ref)
    pinned(ready_ref)
    pinned(bundle_ref)
    require_config_review(ref, config, contract, directory)
    # Persist before the single mutation. A crash/timeout never authorizes another create.
    publish_new(directory / "create-intent.json", {
        "config": ref, "gate": gate_ref, "request_id": config["request_id"], "checked": checked})
    requested_at = timestamp(now())
    require(time.monotonic() < stop and earliest <= requested_at < cutoff
            and requested_at.replace(microsecond=0) + timedelta(seconds=1) <= cutoff,
            "strict_operator_session_receipt_stale")
    try:
        created = native(cli, runtime, ["orchestration", "run-create", "--strict-coordinator",
            "--objective", config["objective"], "--retry-request", config["request_id"]])
        received_at = timestamp(now())
        publish_new(directory / "create-response.json", created)
        run = created["run"]
        created_start, created_end = creation_bounds(run["created_at"])
        require(created.get("coordinatorPolicy") == "strict-v1"
                and isinstance(run.get("id"), str) and run["id"].startswith("run_")
                and run.get("objective") == config["objective"]
                and run.get("coordinator_handle") == contract["coordinator"]["terminal"]
                and type(run.get("consumer_generation")) is int and run["consumer_generation"] > 0
                and timestamp(receipt["completed_at"]) <= created_start <= received_at
                and created_end <= cutoff and requested_at <= received_at <= cutoff
                and time.monotonic() < stop,
                "strict_start_created_run_mismatch")
        readback = native(cli, runtime, ["orchestration", "run-show", "--id", run["id"]])["run"]
        current = native(cli, runtime, ["orchestration", "run-current"])["run"]
        for observed in (readback, current):
            require(all(observed.get(k) == run[k] for k in
                        ("id", "objective", "coordinator_handle", "consumer_generation", "created_at")),
                    "strict_start_run_readback_mismatch")
        live(config, contract, initial)
        result = {"ok": True, "kind": "strict_start_created", "run": run,
                  "config_sha256": ref["sha256"], "gate": gate_ref,
                  "request_id": config["request_id"], "workers_dispatched": False,
                  "first_dispatch_gates_required": True, "native_gate_atomic": False}
        if "lifecycle_spec" in config:
            from startup_handoff import commands
            result.update(lifecycle=lifecycle, lifecycle_spec=config["lifecycle_spec"],
                          runtime_ready=False, next_owner="coordinator",
                          next_action="materials", startup_handoff_complete=False,
                          handoff=commands(lifecycle, "materials", "coordinator"))
        publish_new(directory / "created.json", result)
        return result
    except (OSError, ValueError, KeyError, TypeError, AttributeError, subprocess.SubprocessError):
        # Runtime errors can mean the mutation committed. Never auto-retry or retire it.
        raise StrictCheckError("strict_start_create_requires_reconciliation") from None


def cli_main(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    cli_options(parser)
    parser.add_argument("mode", choices=("strict-start-plan", "strict-start-wait", "strict-start-publish"))
    parser.add_argument("--config", required=True)
    parser.add_argument("--config-sha256", required=True)
    parser.add_argument("--ready")
    parser.add_argument("--ready-sha256")
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--check-operator-context", action="store_true",
                        help="strict-start-plan only: require the bound Operator context without writes")
    args = parser.parse_args(argv)
    try:
        require(not args.check_operator_context or args.mode == "strict-start-plan",
                "strict_start_context_check_is_plan_only")
        ref = {"path": args.config, "sha256": args.config_sha256}
        if args.mode == "strict-start-plan":
            require(not args.execute, "strict_start_plan_is_read_only")
            result = plan_commands(plan(ref, check_operator_context=args.check_operator_context), cli_owner(args))
        else:
            require(args.execute, "strict_start_explicit_execute_required")
            result = (wait_and_create(ref, bootstrap_owner=cli_owner(args)) if args.mode == "strict-start-wait" else
                      publish(ref, {"path": args.ready, "sha256": args.ready_sha256}, bootstrap_owner=cli_owner(args)))
    except (OSError, ValueError, KeyError, TypeError, AttributeError, subprocess.SubprocessError) as exc:
        print(json.dumps({"ok": False, "decision": "stop",
                          "error": str(exc) if isinstance(exc, (GateError, StrictCheckError)) else "strict_start_failed"}))
        return 2
    print(json.dumps(result, ensure_ascii=False))
    return 0

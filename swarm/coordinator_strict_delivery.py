"""Fixed-path configuration delivery before the strict session gate.

No command execution, Run creation, gate issuance or authentication. The receiver
pins its own expectations before waiting; a publisher cannot choose new ones.
"""

import argparse
import json
from pathlib import Path
import shlex
import subprocess
import sys
import time
import uuid

from coordinator_io import (canonical, file_ref, now, parse, path, pinned,
                            publish_new, timestamp, validate_ref)
from coordinator_startup import GateError, build_session_contract, check_actor_context
from coordinator_strict import StrictCheckError, caller_result, require
from coordinator_strict_prepare import load_input
from coordinator_strict_start import load, live, plan, require_unstarted_attempt, validate_start_window
from bootstrap_s5 import protect, checkpoint, cli_options, cli_owner, plan_commands
import publication_wait


MODE = "continuous-native-file-v1"


def layout(bootstrap):
    """These paths are included in the launch plan/prompt, before readiness exists."""
    root = Path(bootstrap)
    return {"mode": MODE, "request_path": str(root / "strict-config-request.json"),
            "publication_path": str(root / "strict-config-ready.json"),
            "directory": str(root / "strict-start")}


def unique_refs(refs):
    require(isinstance(refs, list) and refs, "strict_config_evidence_required")
    result = []
    for ref in refs:
        validate_ref(ref)
        require(Path(ref["path"]).is_absolute(), "strict_config_evidence_path_invalid")
        if ref not in result:
            result.append(ref)
    return result


def request(ref, *, allow_started=False):
    value = parse(pinned(ref))
    return validate_request(value, ref["path"], allow_started=allow_started)


def validate_request(value, request_path, *, allow_started=False):
    """Also used before a new request is published; no native calls or writes."""
    require(isinstance(value, dict), "strict_config_request_invalid")
    version = value.get("schema_version")
    fields = {
        "schema_version", "mode", "cli", "runtime", "workspace", "coordinator",
        "caller_receipt", "readiness_evidence", "directory", "objective", "max_workers",
        "deadline", "request_id"}
    if version in (2, 3, 4, 5):
        fields |= {"session_observation", "startup_window"}
    if version in (3, 4, 5):
        fields |= {"task_source", "recovery_note"}
    if version in (4, 5):
        fields |= {"contract_fields"}
    require(type(version) is int and version in (1, 2, 3, 4, 5)
            and set(value) == fields and value["mode"] == MODE, "strict_config_request_invalid")
    if version in (4, 5):
        from coordinator_request_prepare import output_directory
        directory = output_directory(value["directory"])
    else:
        directory = path(value["directory"], directory=True)
    locations = layout(directory.parent)
    require(value["directory"] == locations["directory"]
            and request_path == locations["request_path"], "strict_config_request_path_mismatch")
    if version not in (4, 5):
        require(directory.stat().st_mode & 0o077 == 0, "strict_config_private_directory_required")
    if not allow_started:
        require_unstarted_attempt(directory)
        validate_start_window(value, checked_at=now())
    for key, fields in (("workspace", {"id", "path"}),
                        ("coordinator", {"terminal", "incarnation", "session"})):
        require(isinstance(value[key], dict) and set(value[key]) == fields
                and all(isinstance(v, str) and v.strip() for v in value[key].values()),
                "strict_config_binding_invalid")
    path(value["workspace"]["path"], directory=True)
    require(isinstance(value["runtime"], str) and value["runtime"].strip(),
            "strict_config_binding_invalid")
    pinned(value["cli"])
    initial = caller_result(parse(pinned(value["caller_receipt"])), value["runtime"])
    require(initial["caller"]["terminalHandle"] == value["coordinator"]["terminal"],
            "strict_config_caller_mismatch")
    # Trae provider IDs are UUIDs, never tab:leaf pane keys. This cheap guard also
    # protects historical/manual v1 requests without silently upgrading their pins.
    from trae_coordinator import UUID
    require(UUID.fullmatch(value["coordinator"]["session"]) is not None,
            "strict_config_provider_session_required")
    require(initial["caller"]["processIncarnation"].rsplit(":", 1)[-1]
            == value["coordinator"]["incarnation"], "strict_config_incarnation_mismatch")
    if version in (2, 3, 4, 5):
        from coordinator_strict_request import validate_binding, validate_window
        validate_binding(value, initial)
        validate_window(value)
    if version in (3, 4, 5):
        from coordinator_strict_request import task_objective
        require(value["objective"] == task_objective(value), "strict_config_task_objective_mismatch")
    require(isinstance(value["objective"], str) and value["objective"].strip()
            and "\0" not in value["objective"] and len(value["objective"].encode()) <= 16384
            and type(value["max_workers"]) is int and value["max_workers"] > 0,
            "strict_config_task_invalid")
    require(isinstance(value["request_id"], str)
            and str(uuid.UUID(value["request_id"])) == value["request_id"],
            "strict_config_request_id_invalid")
    # Do not re-read mutable original evidence after preparation. Its exact pins
    # are expectations, checked against the verified source -> snapshot mapping.
    unique_refs(value["readiness_evidence"])
    if version in (4, 5):
        from coordinator_request_prepare import exact_refs, source_contract
        exact_refs(value["readiness_evidence"])
        source_contract(value)
    return value, directory, Path(locations["publication_path"]), initial


def delivery_plan(ref):
    expected, _, publication, _ = request(ref)
    entry = [sys.executable, "-B", str(Path(__file__).resolve().with_name("coordinator_launch.py"))]
    wait = [*entry, "strict-config-wait", "--request", ref["path"],
            "--request-sha256", ref["sha256"]]
    return {"ok": True, "mode": MODE, "publication_path": str(publication),
            "wait_argv": wait, "wait_command": shlex.join(wait),
            "deadline": expected["deadline"], "execution_authorized": False,
            "requirements": ["Keep the same native exec process alive; terminal text is not delivery",
                             "Operator prepares from the request pin, records independent review, then publishes",
                             "Review the returned config and strict-start plan before running its waiter",
                             "Operator publishes the session gate only after strict-start ready.json"]}


def prepared(ref, config_ref, preparation_ref):
    expected, directory, _, initial = request(ref)
    if expected["schema_version"] in (4, 5):
        from coordinator_request_prepare import verify_prepared
        return verify_prepared(ref, expected, initial, config_ref, preparation_ref)
    require(config_ref.get("path") == str(directory / "start.json")
            and preparation_ref.get("path") == str(directory / "prepared-inputs.json"),
            "strict_config_prepared_path_mismatch")
    config, contract, _, actual_directory = load(config_ref)
    receipt = parse(pinned(preparation_ref))
    require(isinstance(receipt, dict) and set(receipt) == {
        "schema_version", "kind", "input", "contract_fields", "contract", "readiness_snapshots",
        "prepared_at", "operator_context", "operator_identity_verified", "execution_authorized"}
        and type(receipt["schema_version"]) is int and receipt["schema_version"] == 1
        and receipt["kind"] == "strict_start_prepared_inputs"
        and receipt["operator_identity_verified"] is False
        and receipt["execution_authorized"] is False,
        "strict_config_preparation_invalid")
    source = load_input(receipt["input"])
    require(receipt["contract_fields"] == source["contract_fields"]
            and receipt["contract"] == config["contract"]
            and config["contract"]["path"] == str(directory / "session-contract.json")
            and actual_directory == directory, "strict_config_provenance_mismatch")
    for key in ("caller_receipt", "directory", "objective", "max_workers", "deadline", "request_id"):
        require(canonical(config[key]) == canonical(source[key]) == canonical(expected[key]),
                "strict_config_attempt_mismatch")
    for key in ("cli", "runtime", "workspace", "coordinator"):
        require(contract[key] == expected[key], "strict_config_binding_mismatch")
    require(any(directory.parent.is_relative_to(Path(root))
                for root in contract["observation"]["roots"]),
            "strict_config_delivery_outside_roots")
    originals = unique_refs(source["readiness_evidence"])
    require(originals == unique_refs(expected["readiness_evidence"]),
            "strict_config_evidence_mismatch")
    mappings = [{"source": item, "snapshot": {
        "path": str(directory / f"readiness-{index:03d}.snapshot"), "sha256": item["sha256"]}}
        for index, item in enumerate(originals)]
    require(receipt["readiness_snapshots"] == mappings
            and config["readiness_evidence"] == [item["snapshot"] for item in mappings],
            "strict_config_snapshot_mapping_mismatch")
    fields = parse(pinned(source["contract_fields"]))
    skill = next((item["snapshot"] for item in mappings
                  if item["source"] == fields.get("skill_read_evidence")), None)
    require(skill is not None, "strict_config_skill_mapping_missing")
    # Rebuild through the original builder with only the documented snapshot
    # substitution. This never requires the mutable source file to remain current.
    rebuilt = build_session_contract(dict(fields, skill_read_evidence=skill))
    require(canonical(rebuilt) == canonical(contract), "strict_config_contract_mismatch")
    require(timestamp(initial["checkedAt"]) <= timestamp(receipt["prepared_at"])
            <= timestamp(now()) < timestamp(expected["deadline"]), "strict_config_time_invalid")
    request(ref)  # Recheck nested business/authorization pins after preparation validation.
    return expected, contract, initial, receipt


def activation_path(expected):
    """The lifecycle activation this request's own strict-start directory implies."""
    return Path(expected["directory"]).parent / "lifecycle" / "activation.json"


def require_lifecycle_prepared(activation):
    """A registered attempt may not publish a start config without its lifecycle.

    Historical (unregistered) attempts keep their exact behaviour: the guard only
    binds when an S5 guard is active for this call.
    """
    from bootstrap_s5 import current
    require(current.get() is None or activation.exists(), "strict_lifecycle_required")


@protect("deliver", "operator")
def deliver(ref, config_ref, preparation_ref, review_ref=None):
    """Operator explicitly publishes reviewed pins; never executes their content."""
    expected, _, target, _ = request(ref)
    # Fail before the review work, not after it. With a registered attempt owner the
    # publication below is impossible until `operator_startup.py prepare` has written
    # the lifecycle activation bound to this same base config, and attempt18 spent the
    # tail of its turn completing preparation and review only to be refused here. The
    # refusal and its authority are unchanged; only its position and cost are.
    activation = activation_path(expected)
    require_lifecycle_prepared(activation)
    expected, contract, _, _ = prepared(ref, config_ref, preparation_ref)
    check_actor_context(contract, "operator")
    publication = {"schema_version": 1, "kind": "strict_start_config_publication",
                   "request": ref, "config": config_ref, "preparation": preparation_ref,
                   "published_at": now()}
    if expected["schema_version"] in (4, 5):
        from coordinator_request_prepare import verify_review
        verify_review(ref, config_ref, preparation_ref, review_ref, contract,
                      published_at=publication["published_at"])
        publication.update(schema_version=2, review=review_ref)
    else:
        require(review_ref is None, "strict_config_legacy_review_unsupported")
    if activation.exists():
        active_ref = file_ref(activation)
        active, _, _, _ = load(active_ref)
        require(active.get("base_config") == config_ref, "strict_lifecycle_binding_changed")
        from coordinator_strict_start import require_lifecycle
        publication.update(schema_version=3, activation=active_ref,
                           lifecycle=require_lifecycle(active_ref, active, Path(expected["directory"])))
    validate_start_window(expected, checked_at=publication["published_at"])
    prepared(ref, config_ref, preparation_ref)
    if expected["schema_version"] in (4, 5):
        verify_review(ref, config_ref, preparation_ref, review_ref, contract,
                      published_at=publication["published_at"])
    try:
        publish_new(target, publication)
    except ValueError as exc:
        # The owner recorded an intent for this publication and did not write it.
        # Its own recorded bytes are the only admissible completion, so say which
        # entry to use instead of reporting a generic delivery failure (attempt20
        # ended here with `bootstrap_commit_requires_reconciliation`).
        if str(exc) == "bootstrap_commit_requires_reconciliation":
            raise ValueError("strict_config_publication_requires_reconcile") from None
        raise
    return {"ok": True, "publication": file_ref(target), "execution_authorized": False,
            "operator_identity_verified": False}


@protect("config-wait", "coordinator")
def wait_for_config(ref):
    expected, _, target, initial = request(ref)
    remaining = validate_start_window(expected, checked_at=now())
    stop = time.monotonic() + remaining
    # Only a read-only live caller check; never issue gates/create/dispatch here.
    live(expected, expected, initial)
    from observation_budget import ObservationBusy, ObservationTimeout
    # Watch once, not per iteration: an event may only *shorten* this wait, so the pinned re-check
    # and the deadline still decide. With no watcher (inotify unavailable here) the wait keeps the
    # pre-change 250 ms polling cadence, so that host behaves exactly as before; the fallback
    # period for a lost event bounds delivery, so it is logged.
    watcher = publication_wait.watch(target)
    try:
        while True:
            try:
                checkpoint()
            except (ObservationBusy, ObservationTimeout):
                # Owner contention or an expired local read budget is not a
                # publication verdict: aborting here reported "delivery failed"
                # while the Operator was still publishing. The loop deadline below
                # still bounds the wait, so keep polling.
                pass
            require(time.monotonic() < stop and timestamp(now()) < timestamp(expected["deadline"]),
                    "strict_config_wait_expired")
            pinned(ref)
            try:
                target.lstat()  # A dangling symlink is a failure, not a missing publication.
            except FileNotFoundError:
                publication_wait.idle(
                    watcher, min(publication_wait.FALLBACK_SECONDS, max(0.0, stop - time.monotonic())))
                continue
            publication_ref = file_ref(target)
            break
    finally:
        publication_wait.log("config_publication", watcher)
        if watcher is not None:
            watcher.close()
    publication = parse(pinned(publication_ref))
    modern = expected["schema_version"] in (4, 5)
    activated = publication.get("schema_version") == 3
    require(isinstance(publication, dict) and set(publication) == {
        "schema_version", "kind", "request", "config", "preparation", "published_at"}
        | ({"review"} if modern else set()) | ({"activation", "lifecycle"} if activated else set())
        and type(publication["schema_version"]) is int and publication["schema_version"] == (3 if activated else 2 if modern else 1)
        and publication["kind"] == "strict_start_config_publication"
        and publication["request"] == ref, "strict_config_publication_mismatch")
    _, contract, _, receipt = prepared(ref, publication["config"], publication["preparation"])
    if modern:
        from coordinator_request_prepare import verify_review
        verify_review(ref, publication["config"], publication["preparation"], publication["review"], contract,
                      published_at=publication["published_at"])
    require(timestamp(receipt["prepared_at"]) <= timestamp(publication["published_at"])
            <= timestamp(now()), "strict_config_time_invalid")
    active_ref = publication["activation"] if activated else publication["config"]
    result = plan(active_ref)
    if activated:
        require(result["lifecycle"] == publication["lifecycle"]
                and load(active_ref)[0]["base_config"] == publication["config"], "strict_lifecycle_binding_changed")
    live(expected, contract, initial)
    pinned(publication_ref)
    prepared(ref, publication["config"], publication["preparation"])
    if modern:
        verify_review(ref, publication["config"], publication["preparation"], publication["review"], contract,
                      published_at=publication["published_at"])
    require(time.monotonic() < stop, "strict_config_wait_expired")
    return {"ok": True, "kind": "strict_start_config_delivered", "publication": publication_ref,
            "config": active_ref, "preparation": publication["preparation"],
            "plan": result, "review_required": True, "execution_authorized": False}


def cli_main(argv):
    parser = argparse.ArgumentParser(description=__doc__)
    cli_options(parser)
    parser.add_argument("mode", choices=("strict-config-plan", "strict-config-publish", "strict-config-wait"))
    for name in ("request", "request-sha256"):
        parser.add_argument("--" + name, required=True)
    for name in ("config", "config-sha256", "preparation", "preparation-sha256", "review", "review-sha256"):
        parser.add_argument("--" + name)
    parser.add_argument("--execute", action="store_true", help="publish local config pins only")
    args = parser.parse_args(argv)
    try:
        ref = {"path": args.request, "sha256": args.request_sha256}
        if args.mode == "strict-config-publish":
            require(args.execute, "strict_config_explicit_execute_required")
            result = deliver(ref, {"path": args.config, "sha256": args.config_sha256},
                             {"path": args.preparation, "sha256": args.preparation_sha256},
                             {"path": args.review, "sha256": args.review_sha256}
                             if args.review or args.review_sha256 else None, bootstrap_owner=cli_owner(args))
        else:
            owner = cli_owner(args)
            if owner and args.mode == "strict-config-wait":
                require(args.execute, "strict_config_bootstrap_wait_execute_required")
            else:
                require(not args.execute, "strict_config_receiver_is_read_only")
            result = (plan_commands(delivery_plan(ref), owner) if args.mode == "strict-config-plan"
                      else wait_for_config(ref, bootstrap_owner=owner))
    except (OSError, ValueError, KeyError, TypeError, AttributeError, subprocess.SubprocessError) as exc:
        # A masked non-typed failure once reported "delivery failed" with no clue
        # (it was transient owner contention). Always keep the type and the
        # bounded protocol code; arbitrary text still never crosses the boundary.
        from bootstrap_transport import safe_reason
        print(json.dumps({"ok": False, "decision": "stop",
                          "error": str(exc) if isinstance(exc, (GateError, StrictCheckError))
                          else "strict_config_delivery_failed",
                          "error_type": type(exc).__name__, "reason": safe_reason(exc)}))
        return 2
    print(json.dumps(result, ensure_ascii=False))
    return 0

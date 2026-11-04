"""Operator-owned local preparation: reviewed readiness -> snapshots -> contract/config.

No native calls, gate, session authentication, authorization or launch. Existing
attempts and their evidence are never overwritten or automatically re-pinned.
"""

import argparse
import json
import os

from coordinator_io import file_ref, now, parse, pinned, publish_new
import coordinator_snapshots as snapshots_io
from coordinator_startup import GateError, build_session_contract, check_actor_context
from coordinator_strict import StrictCheckError, require
from coordinator_strict_start import plan, validate_inputs, validate_start_window


def load_input(ref):
    source = parse(pinned(ref))
    require(isinstance(source, dict) and set(source) == {
        "schema_version", "contract_fields", "caller_receipt", "readiness_evidence",
        "directory", "objective", "max_workers", "deadline", "request_id"}
        and type(source["schema_version"]) is int and source["schema_version"] == 1,
        "strict_prepare_input_invalid")
    return source


def reviewed(ref):
    source = load_input(ref)
    # This invokes the same fixed v2 / 1800s / 180s builder as startup-contract.
    contract = build_session_contract(parse(pinned(source["contract_fields"])))
    check_actor_context(contract, "operator")
    config = {key: value for key, value in source.items() if key != "contract_fields"}
    config["contract"] = None  # Filled only after publishing the snapshot-bound contract.
    _, directory = validate_inputs(config, contract)
    require(directory.stat().st_mode & 0o077 == 0, "strict_prepare_private_directory_required")
    validate_start_window(config, checked_at=now())
    # This attempt must be new, including when a previous prepare died partway through.
    require(not any(directory.iterdir()), "strict_prepare_directory_not_empty")
    return source, config, contract, directory


def prepare(ref):
    source, config, contract, directory = reviewed(ref)
    # Read and verify exact reviewed bytes BEFORE claiming an attempt. No re-hashing
    # of changed input to manufacture a new pin. Duplicate references share a snapshot.
    snapshots = snapshots_io.collect(config["readiness_evidence"])
    publish_new(directory / "prepare-intent.json", {
        "schema_version": 1, "kind": "strict_start_preparation_intent",
        "input": ref, "contract_fields": source["contract_fields"], "started_at": now()})
    mappings, frozen = snapshots_io.publish(directory, snapshots, prefix="readiness",
                                            publisher=publish_new)
    original_skill = contract["skill_read_evidence"]
    contract["skill_read_evidence"] = frozen[(original_skill["path"], original_skill["sha256"])]
    config["readiness_evidence"] = [entry["snapshot"] for entry in mappings]
    publish_new(directory / "session-contract.json", contract)
    config["contract"] = file_ref(directory / "session-contract.json")
    # Catch producer writes while preparing, not just before copying. A partial
    # failure stays on disk; it never becomes a consumable start config.
    pinned(ref)
    pinned(source["contract_fields"])
    snapshots_io.recheck(snapshots)
    check_actor_context(contract, "operator")
    validate_inputs(config, contract)
    pinned(config["contract"])
    validate_start_window(config, checked_at=now())
    receipt = {
        "schema_version": 1, "kind": "strict_start_prepared_inputs", "input": ref,
        "contract_fields": source["contract_fields"], "contract": config["contract"],
        "readiness_snapshots": mappings, "prepared_at": now(),
        "operator_context": ("terminal_hint_matches_not_identity_proof"
            if os.environ.get("ORCA_TERMINAL_HANDLE") is not None
            else "absent_requires_independent_identity_audit"),
        "operator_identity_verified": False, "execution_authorized": False}
    publish_new(directory / "prepared-inputs.json", receipt)
    # Handoff/commit point: only publish after snapshots, validation and provenance.
    publish_new(directory / "start.json", config)
    config_ref = file_ref(directory / "start.json")
    return {"ok": True, "kind": "strict_start_prepared", "execution_authorized": False,
            "operator_identity_verified": False, "operator_context": receipt["operator_context"],
            "config": config_ref, "contract": config["contract"],
            "preparation": file_ref(directory / "prepared-inputs.json"), "plan": plan(config_ref)}


def cli_main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True)
    parser.add_argument("--input-sha256", required=True)
    parser.add_argument("--execute", action="store_true", help="publish local files only")
    args = parser.parse_args(argv)
    try:
        require(args.execute, "strict_prepare_explicit_execute_required")
        result = prepare({"path": args.input, "sha256": args.input_sha256})
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
        print(json.dumps({"ok": False, "decision": "stop", "error": (
            str(exc) if isinstance(exc, (GateError, StrictCheckError)) else
            "strict_prepare_failed_preserve_attempt_and_check_pins")}))
        return 2
    print(json.dumps(result, ensure_ascii=False))
    return 0

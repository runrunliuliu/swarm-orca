"""Request-owned deterministic preparation; review is a declaration, never a live gate.

No native calls, retries or cleanup. New requests use an explicit commit marker;
partial directories are never ready. Historical directory commits remain readable.
"""

import argparse
import json
import os
from pathlib import Path
import tempfile

from coordinator_io import (canonical, digest, file_ref, now, parse, path, pinned,
                            publish_new, timestamp)
from coordinator_prepared_commit import (COMMIT_NAME, probe_storage,
                                         publish_bundle_new, verify_commit)
from coordinator_startup import (GateError, build_session_contract, check_actor_context,
                                 session_contract_value)
from coordinator_strict import StrictCheckError, require
import coordinator_snapshots as snapshots_io
from bootstrap_s5 import protect, cli_options, cli_owner


COPIED = ("caller_receipt", "readiness_evidence", "directory", "objective",
          "max_workers", "deadline", "request_id")


def output_directory(value, *, absent=False):
    require(isinstance(value, str) and Path(value).is_absolute(), "absolute_path_required")
    target = Path(value)
    parent = path(str(target.parent), directory=True)
    require(str(target) == value and target.name == "strict-start", "strict_config_request_path_mismatch")
    require(parent.stat().st_uid == os.getuid() and parent.stat().st_mode & 0o077 == 0,
            "strict_prepare_private_parent_required")
    try:
        target.lstat()
    except FileNotFoundError:
        return target
    require(not absent, "strict_prepare_target_exists")
    path(value, directory=True)
    require(target.stat().st_uid == os.getuid() and target.stat().st_mode & 0o077 == 0,
            "strict_prepare_private_directory_required")
    return target


def exact_refs(refs):
    from coordinator_strict_delivery import unique_refs
    require(unique_refs(refs) == refs, "strict_prepare_duplicate_evidence")
    return refs  # Never sort, expand embedded JSON, or normalize duplicates.


def source_contract(expected):
    fields = parse(pinned(expected["contract_fields"]))
    return source_contract_fields(expected, fields)


def source_contract_fields(expected, fields):
    """Same checks for unpublished candidate bytes and committed source files."""
    require(isinstance(fields, dict) and not {"schema_version", "freshness"} & fields.keys(),
            "new_contract_fields_required")
    for key in ("cli", "runtime", "workspace", "coordinator"):
        require(fields.get(key) == expected[key], "strict_prepare_contract_binding_mismatch")
    require(fields.get("skill_read_evidence") in exact_refs(expected["readiness_evidence"]),
            "strict_start_readiness_evidence_required")
    session_contract_value(fields)  # Reject a Run binding; never silently discard it.
    if "domain_binding" in fields:
        from software_development import scoped_json
        task = scoped_json(fields["domain_binding"]["contract"], fields["observation"]["roots"])
        if "task_deadline" in expected:
            require(expected["task_deadline"] == task["policy"]["deadline"], "software_deadline_changed")
    return fields


def mappings_for(expected):
    return [{"source": ref, "snapshot": {
        "path": str(Path(expected["directory"]) / f"readiness-{index:03d}.snapshot"),
        "sha256": ref["sha256"]}} for index, ref in enumerate(exact_refs(expected["readiness_evidence"]))]


def contract_for(expected):
    fields = source_contract(expected)
    skill = next(item["snapshot"] for item in mappings_for(expected)
                 if item["source"] == fields["skill_read_evidence"])
    return session_contract_value(dict(fields, skill_read_evidence=skill))


def json_ref(target, value):
    return {"path": str(target), "sha256": digest(canonical(value) + b"\n")}


def config_for(ref, expected, contract):
    return dict({key: expected[key] for key in COPIED},
                schema_version=3 if expected["schema_version"] == 5 else 2, request=ref,
                contract=json_ref(Path(expected["directory"]) / "session-contract.json", contract),
                readiness_evidence=[item["snapshot"] for item in mappings_for(expected)])


def validate_preparation_time(expected, initial, prepared_at):
    require(max(timestamp(initial["checkedAt"]), timestamp(expected["startup_window"]["prepared_at"]))
            <= timestamp(prepared_at) <= timestamp(now()) < timestamp(expected["deadline"]),
            "strict_config_time_invalid")


@protect("prepare", "operator")
def prepare_request(ref):
    progress = {"stage": "validate_request", "request": ref}
    try:
        return _prepare_request(ref, progress)
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
        # Preserve the exception type/errno for callers; CLI adds safe diagnostics.
        exc.prepare_diagnostic = dict(progress, checked_at=now(),
                                      errno=exc.errno if isinstance(exc, OSError) else None)
        raise


def _prepare_request(ref, progress):
    from coordinator_strict_delivery import request
    from coordinator_strict_start import validate_inputs, validate_start_window, plan
    expected, directory, _, initial = request(ref)
    require(expected["schema_version"] == 5, "strict_prepare_new_request_v5_required")
    progress["directory"] = str(directory)
    progress["commit_path"] = str(directory / COMMIT_NAME)
    output_directory(str(directory), absent=True)
    fields = source_contract(expected)
    original = build_session_contract(fields)
    check_actor_context(original, "operator")
    input_config = dict({key: expected[key] for key in COPIED}, schema_version=1, contract=None)
    validate_inputs(input_config, original, unpublished=True)
    require(any(directory.parent.is_relative_to(Path(root)) for root in original["observation"]["roots"]),
            "strict_config_delivery_outside_roots")
    # All deterministic checks and source reads precede even staging creation.
    snapshots = snapshots_io.collect(expected["readiness_evidence"])
    contract = contract_for(expected)
    config = config_for(ref, expected, contract)
    receipt = dict(schema_version=3, kind="strict_start_prepared_inputs", request=ref,
                   contract_fields=expected["contract_fields"], contract=config["contract"],
                   readiness_snapshots=mappings_for(expected), prepared_at=now(),
                   operator_identity_verified=False, execution_authorized=False)
    validate_preparation_time(expected, initial, receipt["prepared_at"])
    request(ref)
    validate_start_window(expected)
    storage_probe = probe_storage(directory.parent, progress)
    progress["stage"] = "create_staging"
    staging = Path(tempfile.mkdtemp(prefix=".strict-start-staging-", dir=directory.parent))
    progress["staging"] = str(staging)
    progress["stage"] = "publish_staging"
    staged, _ = snapshots_io.publish(staging, snapshots, prefix="readiness", publisher=publish_new)
    artifacts = {"session-contract.json": contract, "prepared-inputs.json": receipt, "start.json": config}
    for name, value in artifacts.items():
        publish_new(staging / name, value)
    # Read back exact bytes before exposing any final path. No staging paths in config.
    for item in staged:
        pinned(item["snapshot"])
    for name, value in artifacts.items():
        pinned(json_ref(staging / name, value))
    def recheck():
        snapshots_io.recheck(snapshots)
        request(ref)
        # The target may now exist but is not committed. Do not reinterpret it as ready.
        build_session_contract(source_contract(expected))
        check_actor_context(original, "operator")
        validate_start_window(expected)
        validate_preparation_time(expected, initial, receipt["prepared_at"])

    progress["stage"] = "validate_staging"
    recheck()
    validate_inputs(input_config, build_session_contract(source_contract(expected)), unpublished=True)
    for item in staged:
        pinned(item["snapshot"])
    for name, value in artifacts.items():
        pinned(json_ref(staging / name, value))
    members = [item["snapshot"] for item in mappings_for(expected)] + [
        json_ref(directory / name, value) for name, value in artifacts.items()]
    commit = publish_bundle_new(staging, directory, ref, members,
                                before_commit=recheck, progress=progress)
    progress["stage"] = "readback_plan"
    config_ref = file_ref(directory / "start.json")
    return dict(ok=True, kind="strict_start_prepared", execution_authorized=False,
                operator_identity_verified=False, review_required=True, config=config_ref,
                contract=config["contract"], preparation=file_ref(directory / "prepared-inputs.json"),
                commit=commit, storage_probe=storage_probe, plan=plan(config_ref))


def verify_prepared_commit(ref, expected, config_ref):
    directory = Path(expected["directory"])
    config = config_for(ref, expected, contract_for(expected))
    members = [item["snapshot"] for item in mappings_for(expected)] + [
        config["contract"], file_ref(directory / "prepared-inputs.json"), config_ref]
    return verify_commit(directory, ref, members)


def verify_prepared(ref, expected, initial, config_ref, preparation_ref, *, allow_started=False):
    from coordinator_strict_delivery import request
    from coordinator_strict_start import load
    directory = Path(expected["directory"])
    contract = contract_for(expected)
    config = config_for(ref, expected, contract)
    require(config_ref == json_ref(directory / "start.json", config)
            and preparation_ref.get("path") == str(directory / "prepared-inputs.json"),
            "strict_config_prepared_request_mismatch")
    actual, actual_contract, _, _ = load(config_ref)
    require(actual == config and actual_contract == contract, "strict_config_contract_mismatch")
    receipt = parse(pinned(preparation_ref))
    require(isinstance(receipt, dict) and set(receipt) == {
        "schema_version", "kind", "request", "contract_fields", "contract", "readiness_snapshots",
        "prepared_at", "operator_identity_verified", "execution_authorized"}
        and type(receipt["schema_version"]) is int
        and receipt["schema_version"] == (3 if expected["schema_version"] == 5 else 2)
        and receipt["kind"] == "strict_start_prepared_inputs" and receipt["request"] == ref
        and receipt["contract_fields"] == expected["contract_fields"]
        and receipt["contract"] == config["contract"]
        and receipt["readiness_snapshots"] == mappings_for(expected)
        and receipt["operator_identity_verified"] is False and receipt["execution_authorized"] is False,
        "strict_config_preparation_invalid")
    validate_preparation_time(expected, initial, receipt["prepared_at"])
    request(ref, allow_started=allow_started)
    return expected, contract, initial, receipt


def verify_review(ref, config_ref, preparation_ref, review_ref, contract, *, published_at=None):
    require(review_ref is not None, "strict_config_review_required")
    require(review_ref.get("path") == str(Path(ref["path"]).parent / "strict-config-review.json"),
            "strict_config_review_path_mismatch")
    review = parse(pinned(review_ref))
    require(isinstance(review, dict) and set(review) == {
        "schema_version", "kind", "request", "config", "preparation", "decision", "notes",
        "reviewed_at", "operator", "identity_verified", "execution_authorized"}
        and type(review["schema_version"]) is int and review["schema_version"] == 1
        and review["kind"] == "strict_config_review"
        and review["request"] == ref and review["config"] == config_ref
        and review["preparation"] == preparation_ref and review["operator"] == contract["operator"]
        and review["identity_verified"] is False and review["execution_authorized"] is False
        and isinstance(review["notes"], str) and review["notes"].strip()
        and "\0" not in review["notes"] and len(review["notes"].encode()) <= 16384,
        "strict_config_review_mismatch")
    require(timestamp(parse(pinned(preparation_ref))["prepared_at"]) <= timestamp(review["reviewed_at"])
            <= timestamp(now() if published_at is None else published_at) <= timestamp(now()),
            "strict_config_review_time_invalid")
    require(review["decision"] == "approve", "strict_config_review_rejected")
    return review


@protect("review", "operator")
def review_request(ref, *, decision, notes):
    from coordinator_strict_delivery import request, prepared
    expected, directory, _, _ = request(ref)
    require(expected["schema_version"] in (4, 5), "strict_prepare_request_version_invalid")
    config_ref, preparation_ref = file_ref(directory / "start.json"), file_ref(directory / "prepared-inputs.json")
    _, contract, _, _ = prepared(ref, config_ref, preparation_ref)
    check_actor_context(contract, "operator")
    require(decision in ("approve", "reject") and isinstance(notes, str) and notes.strip()
            and "\0" not in notes and len(notes.encode()) <= 16384, "strict_config_review_invalid")
    receipt = dict(schema_version=1, kind="strict_config_review", request=ref,
                   config=config_ref, preparation=preparation_ref, decision=decision, notes=notes,
                   reviewed_at=now(), operator=contract["operator"], identity_verified=False,
                   execution_authorized=False)
    prepared(ref, config_ref, preparation_ref)
    target = directory.parent / "strict-config-review.json"
    publish_new(target, receipt)
    return dict(ok=True, review=file_ref(target), decision=decision, execution_authorized=False)


def cli_main(argv=None, *, review=False):
    parser = argparse.ArgumentParser(description=__doc__)
    cli_options(parser)
    parser.add_argument("--request", required=True)
    parser.add_argument("--request-sha256", required=True)
    parser.add_argument("--execute", action="store_true")
    if review:
        parser.add_argument("--decision", choices=("approve", "reject"), required=True)
        parser.add_argument("--notes", required=True)
    args = parser.parse_args(argv)
    try:
        require(args.execute, "strict_prepare_explicit_execute_required")
        ref = {"path": args.request, "sha256": args.request_sha256}
        result = (review_request(ref, decision=args.decision, notes=args.notes, bootstrap_owner=cli_owner(args)) if review
                  else prepare_request(ref, bootstrap_owner=cli_owner(args)))
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
        result = dict(ok=False, decision="stop", error=(str(exc)
                      if isinstance(exc, (StrictCheckError, GateError))
                      else "strict_request_prepare_failed_preserve_attempt"),
                      execution_authorized=False)
        if hasattr(exc, "prepare_diagnostic"):
            result["diagnostic"] = exc.prepare_diagnostic
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["ok"] else 2

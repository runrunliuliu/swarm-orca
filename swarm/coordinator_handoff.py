"""Explicit Operator claim/return protocol; no command executor or training adapter.

The driver owns its journal. The named Operator publishes immutable receipts in
the requested directory without taking the driver's long-held loop lock.
"""

import os
from pathlib import Path
import re

from coordinator_io import (canonical, digest, file_ref, now, parse, pinned,
                            publish_new, require, scoped_refs, timestamp, validate_ref, write_new)


def validate_operator(value):
    require(isinstance(value, dict) and set(value) == {"id"}
            and isinstance(value["id"], str)
            and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}", value["id"]),
            "invalid_outer_operator")


def validate_history(history, root):
    require(isinstance(history, dict), "invalid_operator_history")
    for key, entry in history.items():
        require(isinstance(key, str) and re.fullmatch(r"[a-f0-9]{64}", key) and isinstance(entry, dict)
                and set(entry) == {"request", "acceptance", "result"}, "invalid_operator_history")
        for field, filename in (("request", "request.json"), ("acceptance", "accepted.json"),
                                ("result", "result.json")):
            ref = entry[field]
            if ref is None and field != "request":
                continue
            validate_ref(ref)
            require(ref["path"] == str(root / ("operator-" + key) / filename),
                    "operator_receipt_path_mismatch")
        require(entry["result"] is None or entry["acceptance"] is not None,
                "operator_result_without_acceptance")


def load_request(config, ref):
    request = parse(pinned(ref))
    require(isinstance(request, dict) and set(request) ==
            {"schema_version", "config", "operator_id", "created_at", "action"}
            and type(request["schema_version"]) is int and request["schema_version"] == 1,
            "invalid_operator_request")
    require(request["operator_id"] == config.data["outer_operator"]["id"]
            and request["config"] == {"path": config.filename, "sha256": config.sha256},
            "operator_request_binding_mismatch")
    action = request["action"]
    require(isinstance(action, dict) and set(action) == {"binding", "attempt", "incoming_checkpoint",
            "action_id", "action_sha256", "executor"}
            and action["binding"] == config.data["binding"] and action["executor"] == "outer-operator"
            and type(action["attempt"]) is int and action["attempt"] > 0,
            "operator_request_binding_mismatch")
    incoming = parse(pinned(action["incoming_checkpoint"]))["next_action"]
    require(incoming["owner"] == "outer-operator" and incoming["id"] == action["action_id"]
            and digest(canonical(incoming)) == action["action_sha256"], "operator_action_mismatch")
    directory = config.root / ("operator-" + action["action_sha256"])
    require(ref["path"] == str(directory / "request.json"), "operator_request_path_mismatch")
    require(timestamp(request["created_at"]) <= timestamp(now()), "operator_request_time_invalid")
    return request


def prepare(config, journal, action):
    """Reuse an already-issued action even after restarts or a planning-only review."""
    history = journal.data["operator_requests"]
    key = action["action_sha256"]
    if key not in history:
        directory = config.root / ("operator-" + key)
        directory.mkdir(mode=0o700)  # Orphaned directory is a reconciliation gate.
        target = directory / "request.json"
        write_new(target, {"schema_version": 1, "config": {"path": config.filename, "sha256": config.sha256},
                          "operator_id": config.data["outer_operator"]["id"], "created_at": now(),
                          "action": action})
        history[key] = {"request": file_ref(target), "acceptance": None, "result": None}
        journal.data["current"]["operator_request"] = history[key]["request"]
        journal.save()
        journal.event("operator_handoff_requested", **history[key])
    entry = history[key]
    request = load_request(config, entry["request"])
    require(request["action"]["action_sha256"] == key, "operator_action_mismatch")
    if journal.data["current"].get("operator_request") != entry["request"]:
        journal.data["current"]["operator_request"] = entry["request"]
        journal.save()
    return entry


def optional_receipt(directory, name, expected):
    target = directory / name
    if not os.path.lexists(target):
        require(expected is None, "operator_receipt_disappeared")
        return None, None
    ref = expected or file_ref(target)
    require(ref["path"] == str(target), "operator_receipt_path_mismatch")
    return parse(pinned(ref)), ref


def validate_report(config, report):
    require(isinstance(report, dict) and set(report) in ({"status", "evidence"},
            {"status", "evidence", "background"})
            and isinstance(report["status"], str)
            and report["status"] in {"executed", "not_executed", "failed", "unknown", "submitted"},
            "invalid_operator_report")
    require((report["status"] == "submitted") == ("background" in report), "invalid_operator_report")
    if report["status"] == "submitted":
        job = report["background"]
        require(isinstance(job, dict) and set(job) == {"operation_key", "job", "status"}
                and isinstance(job["operation_key"], str)
                and re.fullmatch(r"[a-f0-9]{64}", job["operation_key"])
                and isinstance(job["job"], str) and job["job"].strip()
                and job["status"] in {"queued", "running"}, "invalid_background_submission")
    scoped_refs(report["evidence"], config.progress_roots, config.excluded_evidence)
    require(report["status"] not in {"executed", "failed", "submitted"} or report["evidence"],
            "operator_execution_evidence_required")
    return report


def observe(config, entry):
    request = load_request(config, entry["request"])
    directory = Path(entry["request"]["path"]).parent
    accepted, acceptance_ref = optional_receipt(directory, "accepted.json", entry["acceptance"])
    result, result_ref = optional_receipt(directory, "result.json", entry["result"])
    refs = dict(entry, acceptance=acceptance_ref, result=result_ref)
    if accepted is None:
        require(result is None, "operator_result_without_acceptance")
        return "awaiting_operator_acceptance", refs, None
    require(isinstance(accepted, dict) and set(accepted) ==
            {"schema_version", "request", "operator_id", "accepted_at", "skills_read"}
            and type(accepted["schema_version"]) is int and accepted["schema_version"] == 1
            and accepted["request"] == entry["request"]
            and accepted["operator_id"] == request["operator_id"]
            and accepted["skills_read"] == [config.skills["coordinator"]],
            "operator_acceptance_mismatch")
    require(timestamp(request["created_at"]) <= timestamp(accepted["accepted_at"])
            <= timestamp(now()), "operator_acceptance_time_invalid")
    if result is None:
        return "awaiting_operator_result", refs, None
    require(isinstance(result, dict) and set(result) ==
            {"schema_version", "request", "acceptance", "reported_at", "report"}
            and type(result["schema_version"]) is int and result["schema_version"] == 1
            and result["request"] == entry["request"] and result["acceptance"] == acceptance_ref,
            "operator_result_mismatch")
    require(timestamp(accepted["accepted_at"]) <= timestamp(result["reported_at"])
            <= timestamp(now()), "operator_result_time_invalid")
    report = validate_report(config, parse(pinned(result["report"])))
    if report["status"] == "submitted":
        require(report["background"]["operation_key"] == digest(canonical({
            "driver": config.sha256, "action": request["action"]["action_sha256"]})),
            "background_operation_mismatch")
    return ("operator_outcome_unknown_requires_reconciliation" if report["status"] == "unknown"
            else "operator_result_ready"), refs, report


def poll(config, journal, entry):
    status, refs, report = observe(config, entry)
    if refs != entry:
        entry.update(refs)
        journal.save()
        journal.event(status, **refs)
    return status, {**refs, "report": report}


def accept(config, entry, operator_id, *, skills_read):
    request = load_request(config, entry["request"])
    require(operator_id == request["operator_id"], "operator_identity_mismatch")
    require(skills_read is True, "operator_skill_read_confirmation_required")
    target = Path(entry["request"]["path"]).with_name("accepted.json")
    try:
        publish_new(target, {"schema_version": 1, "request": entry["request"],
                            "operator_id": operator_id, "accepted_at": now(),
                            "skills_read": [config.skills["coordinator"]]})
    except FileExistsError:
        raise ValueError("operator_action_already_claimed") from None
    return file_ref(target)


def return_result(config, entry, operator_id, acceptance_sha256, report_ref):
    request = load_request(config, entry["request"])
    require(operator_id == request["operator_id"], "operator_identity_mismatch")
    status, refs, _ = observe(config, entry)
    require(status == "awaiting_operator_result", "operator_result_not_expected")
    require(refs["acceptance"]["sha256"] == acceptance_sha256, "operator_acceptance_mismatch")
    validate_report(config, parse(pinned(report_ref)))
    target = Path(entry["request"]["path"]).with_name("result.json")
    try:
        publish_new(target, {"schema_version": 1, "request": entry["request"],
                            "acceptance": refs["acceptance"], "reported_at": now(), "report": report_ref})
    except FileExistsError:
        raise ValueError("operator_result_already_returned") from None
    return file_ref(target)

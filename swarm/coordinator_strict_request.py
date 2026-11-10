"""Build a pinned startup request from reviewed observation/caller evidence.

``--check`` is read-only local validation. ``--execute`` performs the live
Coordinator caller check before one immutable local request publish; it still
does not issue authentication gates, create a Run, retry or dispatch Workers.
The Operator independently audits the observation and the live gate rechecks it.
A file pin is not a live identity or authorization proof.
"""

import argparse
from datetime import timedelta
import json
import os
from pathlib import Path

from coordinator_io import file_ref, now, parse, pinned, publish_new, timestamp
from coordinator_strict import StrictCheckError, caller_result, require
from coordinator_task_source import (STRICT_REQUEST_INPUT_SCHEMA_VERSION,
                                     STRICT_REQUEST_SCHEMA_VERSION,
                                     task_objective)
from trae_coordinator import UUID
import tui_adapter


HANDSHAKE_TIMEOUT_SECONDS = 900


def handshake_deadline(started, seconds, task_deadline):
    deadline = started + timedelta(seconds=seconds)
    if task_deadline is None:
        return deadline
    require(isinstance(task_deadline, str), "strict_config_task_deadline_invalid")
    try:
        return min(deadline, timestamp(task_deadline))
    except ValueError:
        raise StrictCheckError("strict_config_task_deadline_invalid") from None


def observed_coordinator(value, initial):
    observation = parse(pinned(value["session_observation"]))
    require(isinstance(observation, dict) and type(observation.get("schema_version")) is int
            and observation["schema_version"] == 1,
            "strict_config_session_observation_invalid")
    caller = initial["caller"]
    sid = observation.get("thread_id")
    require(isinstance(sid, str) and UUID.fullmatch(sid) is not None
            and observation.get("session_id") == sid,
            "strict_config_provider_session_required")
    require(observation.get("runtime_id") == value["runtime"]
            and observation.get("effective", {}).get("cwd") == value["workspace"]["path"],
            "strict_config_observation_scope_mismatch")
    kind = observation.get("kind")
    adapter = tui_adapter.kind_adapter(kind) if isinstance(kind, str) else None
    if adapter is not None:
        binding = observation["binding"]
        terminal = binding["terminal"]
        require(observation.get("adapter") == adapter
                and observation.get("caller_receipt") == value["caller_receipt"]
                and binding["runtime"]["runtimeId"] == value["runtime"]
                and binding["session_id"] == sid,
                "strict_config_observation_binding_mismatch")
        require(caller["processIncarnation"] == terminal["ptyId"] + ":" + terminal["incarnationId"],
                "strict_config_incarnation_mismatch")
    elif kind in ("trae_startup_anchor", "trae_session_observation"):
        require(observation.get("run_id") is None, "strict_config_observation_has_run")
        terminal = observation["terminal"]
    else:
        raise StrictCheckError("strict_config_session_observation_unsupported")
    require(terminal["handle"] == caller["terminalHandle"]
            and terminal["worktreeId"] == value["workspace"]["id"]
            and terminal["tabId"] + ":" + terminal["leafId"] == caller["paneKey"]
            and terminal.get("executionHostId") == "local"
            and caller["hostScope"].get("kind") == "local",
            "strict_config_observation_caller_mismatch")
    require(caller["processIncarnation"].rsplit(":", 1)[-1] == terminal["incarnationId"],
            "strict_config_incarnation_mismatch")
    return {"terminal": terminal["handle"], "incarnation": terminal["incarnationId"], "session": sid}


def validate_binding(value, initial):
    require(value["coordinator"] == observed_coordinator(value, initial),
            "strict_config_observation_binding_mismatch")


def validate_window(value):
    window = value["startup_window"]
    require(isinstance(window, dict) and set(window) == {
        "prepared_at", "handshake_timeout_seconds", "task_deadline"}, "strict_config_window_invalid")
    seconds = window["handshake_timeout_seconds"]
    require(type(seconds) is int and 0 < seconds <= HANDSHAKE_TIMEOUT_SECONDS,
            "strict_config_handshake_timeout_seconds_invalid")
    started = timestamp(window["prepared_at"])
    require(started <= timestamp(now()) and timestamp(value["deadline"]) == handshake_deadline(
        started, seconds, window["task_deadline"]),
        "strict_config_window_mismatch")


def prepare_request(ref):
    from coordinator_strict_delivery import MODE, layout, validate_request
    from coordinator_request_prepare import exact_refs, output_directory, source_contract
    from coordinator_startup import build_session_contract

    source = parse(pinned(ref))
    fields = {"schema_version", "cli", "runtime", "workspace", "caller_receipt",
              "session_observation", "readiness_evidence", "directory", "task_source", "recovery_note",
              "max_workers", "task_deadline", "request_id", "contract_fields"}
    require(isinstance(source, dict) and fields <= set(source)
            and set(source) <= fields | {"handshake_timeout_seconds"}
            and type(source["schema_version"]) is int
            and source["schema_version"] == STRICT_REQUEST_INPUT_SCHEMA_VERSION,
            "strict_config_request_input_invalid")
    objective = task_objective(source)
    seconds = source.get("handshake_timeout_seconds", HANDSHAKE_TIMEOUT_SECONDS)
    require(type(seconds) is int and 0 < seconds <= HANDSHAKE_TIMEOUT_SECONDS,
            "strict_config_handshake_timeout_seconds_invalid")
    initial = caller_result(parse(pinned(source["caller_receipt"])), source["runtime"])
    coordinator = observed_coordinator(source, initial)
    # Read all final readiness pins before starting the independent handshake clock.
    for item in exact_refs(source["readiness_evidence"]):
        pinned(item)
    contract = build_session_contract(source_contract(dict(source, coordinator=coordinator)))
    directory = output_directory(source["directory"], absent=True)
    target = Path(layout(directory.parent)["request_path"])
    for candidate in (target, Path(layout(directory.parent)["publication_path"]),
                      directory.parent / "strict-config-review.json"):
        try:
            candidate.lstat()
        except FileNotFoundError:
            continue
        raise StrictCheckError("strict_config_request_attempt_exists")
    started = now()
    # Never infer this timeout from a Worker's timeout_ms, context age or gate TTL.
    deadline = handshake_deadline(timestamp(started), seconds, source["task_deadline"])
    value = {key: item for key, item in source.items()
             if key not in ("task_deadline", "handshake_timeout_seconds")}
    value.update(schema_version=STRICT_REQUEST_SCHEMA_VERSION, mode=MODE,
                 coordinator=coordinator, objective=objective,
                 deadline=deadline.isoformat(), startup_window={
                     "prepared_at": started, "handshake_timeout_seconds": seconds,
                     "task_deadline": source["task_deadline"]})
    validate_request(value, str(target))
    return {"source": source, "value": value, "target": target,
            "contract": contract, "initial": initial}


def check_request(ref):
    prepared = prepare_request(ref)
    return {"ok": True, "kind": "strict_config_request_checked",
            "request_path": str(prepared["target"]),
            "deadline_preview": prepared["value"]["deadline"],
            "startup_window_preview": prepared["value"]["startup_window"],
            "deadline_fixed": False, "execution_authorized": False,
            "identity_verified": False}


def build_request(ref, *, require_live=False, bootstrap_admission=None, authority=None):
    from coordinator_strict_delivery import validate_request
    from coordinator_request_prepare import output_directory

    require((bootstrap_admission is None) == (authority is None),
            "strict_config_bootstrap_admission_pair_required")
    prepared = prepare_request(ref)
    source = prepared["source"]
    value = prepared["value"]
    target = prepared["target"]
    require(not os.path.lexists(target.parent / "attempt-binding.json") or bootstrap_admission is not None,
            "strict_config_bootstrap_admission_required")
    if require_live:
        from coordinator_strict_start import live
        live(value, prepared["contract"], prepared["initial"])
    def recheck():
        pinned(ref)
        # Recheck producer pins immediately before the exclusive commit point.
        for item in [source["session_observation"], source["caller_receipt"], source["contract_fields"],
                     *source["readiness_evidence"]]:
            pinned(item)
        validate_request(value, str(target))
        output_directory(source["directory"], absent=True)

    recheck()
    if bootstrap_admission is None:
        publish_new(target, value)
    else:
        from bootstrap_admission import commit_request
        commit_request(ref, prepared, bootstrap_admission, authority, recheck)
    return {"ok": True, "kind": "strict_config_request_prepared", "request": file_ref(target),
            "deadline": value["deadline"], "startup_window": value["startup_window"],
            "review_required": True, "execution_authorized": False, "identity_verified": False}


def cli_main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True)
    parser.add_argument("--input-sha256", required=True)
    parser.add_argument("--check", action="store_true", help="validate inputs without publishing")
    parser.add_argument("--execute", action="store_true",
                        help="publish one local request after live caller check")
    args = parser.parse_args(argv)
    try:
        require(args.check != args.execute, "strict_config_request_explicit_mode_required")
        ref = {"path": args.input, "sha256": args.input_sha256}
        result = check_request(ref) if args.check else build_request(ref, require_live=True)
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
        print(json.dumps({"ok": False, "decision": "stop", "error": str(exc)
                          if isinstance(exc, StrictCheckError) else "strict_config_request_failed"}))
        return 2
    print(json.dumps(result, ensure_ascii=False))
    return 0

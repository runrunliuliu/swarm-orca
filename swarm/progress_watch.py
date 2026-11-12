"""Read-only native RSI observer. Never dispatches, consumes Inbox, or recovers agents.

The only native commands are hard-coded queries. CLI subprocess cancellation on a
read timeout is not a native terminal/agent cancellation. Reports are private and
contain selected fields, never terminal previews, task bodies, or credential files.
"""
import argparse
from collections import Counter
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import selectors
import signal
import stat
import sys
import threading
import subprocess
import tempfile
import time

from coordinator_io import validate_ref
from coordinator_state import follow_launch

CLI_ENV = "ORCA_SERVER_CLI"
CLI = None  # Test-only injection for historical configurations without a contract.
PHASES = {"startup", "development", "review", "preflight", "training", "evaluation", "blocked", "completed"}


class ObservationError(Exception):
    pass


class StopObservation(ObservationError):
    """A persistent operator gate, never cleared by a process restart."""


def object_value(value):
    if not isinstance(value, dict):
        raise ObservationError("native_object_expected")
    return value


def object_rows(value):
    if not isinstance(value, list) or not all(isinstance(row, dict) for row in value):
        raise ObservationError("native_object_list_expected")
    return value


def reject_constant(_value):
    raise ValueError("nonfinite_json")


def decode_response(raw, code, runtime):
    try:
        data = json.loads(raw, parse_constant=reject_constant)
    except (ValueError, UnicodeError):
        # Some connection failures have only stderr. Never retry blindly.
        raise StopObservation("query_invalid_json") from None
    data = object_value(data)
    if code or data.get("ok") is not True:
        error = data.get("error")
        known = {"runtime_access_denied", "permission_denied", "connection_failed",
                 "runtime_unavailable", "not_connected", "runtime_not_ready"}
        reason = error.get("code") if isinstance(error, dict) else None
        raise StopObservation(reason if isinstance(reason, str) and reason in known else "native_query_failed")
    meta = data.get("_meta")
    if not isinstance(meta, dict) or meta.get("runtimeId") != runtime:
        raise StopObservation("runtime_mismatch")
    return object_value(data.get("result"))


def utc(now):
    return datetime.fromtimestamp(now, timezone.utc).isoformat()


def stamp(value):
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.timestamp() if parsed.tzinfo else None
    except (AttributeError, TypeError, ValueError):
        return None


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, allow_nan=False).encode()).hexdigest()


def file_json(path):
    # No symlinks, FIFOs or devices; read only the initial file size.
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise ValueError("not_regular")
        size = os.fstat(stream.fileno()).st_size
        raw = stream.read(size)
        if len(raw) != size:
            raise ValueError("file_truncated")
    result = json.loads(raw, parse_constant=reject_constant)
    if not isinstance(result, dict):
        raise ValueError("not_object")
    return result


def query(args, runtime, timeout=12, *, start_new_session=False):
    """Private stdout with a deadline; never export native bodies in errors.

    `approved` is the routing boundary for every caller that funnels native reads
    through this module (progress_watch itself, operator_monitor.native and the
    bootstrap/lifecycle fences). Adding a verb here is a reviewable widening of
    what those callers may query; keep it to read-only verbs and pin the routing
    with a test in tests/core/test_progress_watch.py so the widening is deliberate.
    """
    approved = (("status",), ("orchestration", "run-show"),
                ("orchestration", "worker-list"), ("orchestration", "task-list"),
                ("orchestration", "strict-caller-check"), ("terminal", "list"))
    if not any(tuple(args[:len(p)]) == p for p in approved):
        raise ObservationError("query_not_allowlisted")
    cli = resolve_cli(runtime)
    try:
        process = subprocess.Popen([cli, *args, "--json"], stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL, start_new_session=start_new_session)
    except OSError:
        raise StopObservation("native_client_unavailable") from None
    with process as child:
        raw = bytearray()
        deadline = time.monotonic() + timeout
        with selectors.DefaultSelector() as sel:
            sel.register(child.stdout, selectors.EVENT_READ)
            while sel.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    child.kill()
                    child.wait()
                    raise StopObservation("query_timeout")
                for key, _ in sel.select(min(remaining, 0.25)):
                    chunk = os.read(key.fd, 65536)
                    if not chunk:
                        sel.unregister(key.fileobj)
                    raw.extend(chunk)
            try:
                code = child.wait(timeout=max(0.01, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
                raise StopObservation("query_timeout")
        return decode_response(raw, code, runtime)


def collect(config, call=query):
    run_id, runtime = config["run"], config["runtime"]
    call(["status"], runtime)
    shown = object_value(call(["orchestration", "run-show", "--id", run_id], runtime))
    run = object_value(shown.get("run"))
    if run.get("id") != run_id:
        raise StopObservation("run_mismatch")
    rows, seen, cursor, total = [], set(), None, None
    while True:
        args = ["orchestration", "worker-list", "--run", run_id, "--include-remote"]
        if cursor is not None:
            args += ["--cursor", cursor]
        page = object_value(call(args, runtime))
        if object_value(page.get("scope")).get("run") != run_id:
            raise StopObservation("worker_scope_mismatch")
        meta = object_value(page.get("page"))
        if type(meta.get("total")) is not int or meta["total"] < 0 or type(meta.get("hasMore")) is not bool:
            raise ObservationError("worker_page_invalid")
        if total is not None and meta["total"] != total:
            raise ObservationError("inventory_changed_during_pagination")
        total = meta["total"]
        rows.extend(object_rows(page.get("workers")))
        if meta.get("hasMore") is False:
            break
        cursor = meta.get("nextCursor")
        if not isinstance(cursor, str) or not cursor or cursor in seen:
            raise ObservationError("worker_pagination_incomplete")
        seen.add(cursor)
    ids = [r.get("dispatchId") for r in rows]
    if not all(isinstance(value, str) and value for value in ids):
        raise ObservationError("worker_identity_invalid")
    if len(ids) != len(set(ids)) or len(ids) != total:
        raise ObservationError("worker_inventory_incomplete")
    tasks = object_value(call(["orchestration", "task-list", "--run", run_id, "--brief"], runtime))
    task_rows = object_rows(tasks.get("tasks"))
    if tasks.get("runId") != run_id or type(tasks.get("count")) is not int or tasks.get("count") != len(task_rows):
        raise ObservationError("task_inventory_incomplete")
    terminal_result = object_value(call(["terminal", "list", "--worktree", "id:" + config["workspace"]], runtime))
    if terminal_result.get("truncated") is not False:
        raise ObservationError("terminal_inventory_incomplete")
    terminals = object_rows(terminal_result.get("terminals"))
    return {
        "run": {k: run.get(k) for k in ("id", "consumer_generation", "coordinator_handle")},
        "coordinator_policy": shown.get("coordinatorPolicy"),
        "workers": sorted([{
            "dispatch": r["dispatchId"], "task": r.get("taskId"),
            "state": r.get("workerState"), "dispatch_status": r.get("dispatchStatus"),
            "resource": object_value(r.get("resource") if r.get("resource") is not None else {}).get("ownershipState"),
            "release": object_value(r.get("resource") if r.get("resource") is not None else {}).get("releaseState"),
            "liveness": object_value(object_value(r.get("projection", {})).get("liveness", {})).get("verdict", "unknown"),
        } for r in rows], key=lambda r: r["dispatch"]),
        "tasks": sorted([{"id": t["id"], "status": t.get("status")} for t in task_rows], key=lambda t: t["id"]),
        "terminals": [{k: t.get(k) for k in ("handle", "incarnationId", "worktreeId")} for t in terminals],
        "inventory_complete": True,
    }


def report_identity_matches(value, config, native):
    """Require the canonical schema-1 fields, each matching the live Run exactly."""
    if (type(value.get("schema_version")) is not int or value["schema_version"] != 1
            or {"run", "generation", "terminal"} & value.keys()):
        return False
    run = native["run"]
    if run["id"] != config["run"]:
        return False
    fields = (("run_id", str, config["run"]),
              ("consumer_generation", int, run["consumer_generation"]),
              ("coordinator_handle", str, run["coordinator_handle"]))
    return all(type(expected) is kind and bool(expected) and (kind is not int or expected > 0)
               and type(value.get(key)) is kind and value[key] == expected
               for key, kind, expected in fields)


def reported_authority(config, value, now):
    """Bound, fresh producer diagnostics; never independently verified authority.

    Deliberately do not import repository code or execute a configurable checker.
    In particular execution_authorized=False is NOT a denial signal.
    """
    binding = config.get("authority_binding")
    if binding is None:
        return {"status": "not_configured"}
    receipt = value.get("authority_check")
    if receipt is None:
        return {"status": "missing"}
    if (not isinstance(receipt, dict)
            or type(receipt.get("schema_version")) is not int or receipt["schema_version"] != 1
            or receipt.get("grants_authority") is not False):
        return {"status": "invalid"}
    if (receipt.get("run_id") != config["run"]
            or any(receipt.get(key) != binding[key]
                   for key in ("scope_id", "authority_sha256", "context_sha256"))):
        return {"status": "binding_mismatch"}
    checked, updated = stamp(receipt.get("checked_at")), stamp(value.get("updated_at"))
    if checked is None or updated is None or checked > now + 60 or checked > updated + 60:
        return {"status": "invalid"}
    if now - checked > 300 or updated - checked > 300:
        return {"status": "stale"}
    status = receipt.get("status")
    checkpoint = receipt.get("checkpoint_sha256")
    bound_checkpoint = (isinstance(checkpoint, str) and re.fullmatch(r"[0-9a-f]{64}", checkpoint)
                        and checkpoint == value.get("checkpoint_sha256"))
    if status == "consistent":
        if receipt.get("error_code") is not None or not bound_checkpoint:
            return {"status": "invalid"}
        return {"status": "reported_consistent", "independently_verified": False,
                "checkpoint_sha256": checkpoint, "checked_at": utc(checked)}
    if status != "failed" or not isinstance(receipt.get("error_code"), str) or not receipt["error_code"]:
        return {"status": "invalid"}
    if checkpoint is not None and not bound_checkpoint:
        return {"status": "invalid"}
    conflicts = {"authority_handoff_conflict", "authority_blocker_conflict", "platform_blocker_conflict",
                 "technical_blocker_conflict"}
    # Unknown errors remain failures; never echo arbitrary error messages/codes.
    code = receipt["error_code"]
    return {"status": "reported_conflict" if code in conflicts else "reported_check_failed",
            "independently_verified": False, "checked_at": utc(checked),
            "error_code": code if code in conflicts else "other_check_failure"}


def reported(config, native, now):
    try:
        value = file_json(config["progress_file"])
        if not report_identity_matches(value, config, native):
            return {"status": "identity_mismatch"}
        timestamp = stamp(value.get("updated_at"))
        if timestamp is None or timestamp > now + 60:
            return {"status": "invalid_timestamp"}
        phase = value.get("phase")
        if phase not in PHASES:
            return {"status": "invalid_phase"}
        training = value.get("training", {})
        if not isinstance(training, dict):
            return {"status": "missing_or_invalid"}
        observed = stamp(training.get("observed_at"))
        count = training.get("active_count")
        fresh = (observed is not None and 0 <= now - observed <= 300
                 and type(count) is int and count >= 0
                 and bool(training.get("scope")) and bool(training.get("evidence")))
        waiting = stamp(value.get("expected_wait_until"))
        # Free text, job requests, secrets and arbitrary evidence contents are not copied.
        return {"status": "reported",
                "phase": phase, "updated_at": utc(timestamp),
                "age_seconds": max(0, now - timestamp),
                "milestone_fingerprint": digest(value.get("milestone_id")),
                "has_milestone": bool(value.get("milestone_id")),
                "expected_wait_until": utc(waiting) if waiting is not None else None,
                "has_wait_reason": bool(value.get("wait_reason")),
                "has_blocker": bool(value.get("blocker")),
                "report_path": config["progress_file"],
                "authority": reported_authority(config, value, now),
                "training": {"active_count": count if fresh else None,
                             "observed_at": utc(observed) if observed is not None else None,
                             "evidence_status": "coordinator_reported_fresh" if fresh else "unknown_or_stale",
                             "step": training.get("step") if type(training.get("step")) is int else None}}
    except (OSError, ValueError, TypeError, KeyError):
        return {"status": "missing_or_invalid"}


def launch_evidence(config, native, report, now):
    """Evidence about the driver-selected launch, not loop or future-turn liveness."""
    result = {"status": "terminal_present_agent_exit_unknown",
              "scope": "driver_selected_launch_only",
              "plan_sha256": config["plan_sha256"],
              "started_at": config["launch_started_at"],
              "process_receipt": config["process_receipt"]}

    def status(value):
        return dict(result, status=value)

    owner = native["run"]["coordinator_handle"]
    if owner != config["terminal"]:
        return status("owner_changed_unverified")
    if (native["run"]["id"] != config["run"]
            or native["run"]["consumer_generation"] != config["expected_generation"]):
        return status("launch_identity_changed_unverified")
    matching = [t for t in native["terminals"] if t["handle"] == owner]
    if (len(matching) != 1 or matching[0]["incarnationId"] != config["incarnation"]
            or matching[0]["worktreeId"] != config["workspace"]):
        return status("terminal_missing_or_replaced")
    if config["launch_started_at"] is None:
        return status("launch_intent_not_observed_agent_exit_unknown")
    try:
        intent = file_json(config["process_intent"])
        started = stamp(config["launch_started_at"])
        if (started is None or started > now
                or intent.get("plan_sha256") != config["plan_sha256"]
                or intent.get("started_at") != config["launch_started_at"]
                or intent.get("phase") != "run"
                or intent.get("resume_session") != config["resume_session"]):
            return status("launch_binding_mismatch_agent_exit_unknown")
        receipt = file_json(config["process_receipt"])
        if any(key not in receipt or receipt[key] != intent.get(key)
               for key in ("plan_sha256", "started_at", "phase", "resume_session")):
            return status("launch_binding_mismatch_agent_exit_unknown")
        ended = stamp(receipt.get("ended_at"))
        if (receipt.get("observed_by") == "direct-parent-wait-not-signed-attestation"
                and type(receipt.get("exit_code")) is int
                and type(receipt.get("child_pid")) is int and receipt["child_pid"] > 0
                and ended is not None and started <= ended <= now):
            result.update(ended_at=utc(ended), exit_code=receipt["exit_code"],
                          child_pid=receipt["child_pid"])
            progress_at = stamp(report.get("updated_at"))
            if report.get("status") == "reported" and progress_at is not None and ended < progress_at <= now:
                # Newer progress conflicts with calling this the current agent's
                # exit. It is not proof of liveness or permission to auto-rebind.
                return status("launch_binding_stale_agent_exit_unknown")
            return status("exited_direct_parent_receipt")
    except (OSError, ValueError, TypeError):
        pass
    return result


def coordinator(config, native, report=None, now=None):
    now = time.time() if now is None else now
    report = reported(config, native, now) if report is None else report
    return observed_launch(config, native, report, {}, now)["status"]


def observed_launch(config, native, report, previous, now):
    try:
        resolved, driver = follow_launch(config, previous)
        started = stamp(driver["cursor"]["started_at"])
        if driver["cursor"]["started_at"] is not None and (started is None or started > now):
            raise ValueError("driver_intent_time_invalid")
        result = launch_evidence(resolved, native, report, now)
        return dict(result, driver=driver)
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
        # An invalid cursor cannot select evidence from a previous launch.
        reason = str(exc) if isinstance(exc, ValueError) else "invalid_driver_evidence"
        if re.fullmatch(r"[a-z][a-z0-9_]{0,100}", reason) is None:
            reason = "invalid_driver_evidence"
        return {"status": "driver_launch_evidence_unavailable_agent_exit_unknown",
                "scope": "driver_selected_launch_only", "reason": reason}


def status_views(config, native, report, lifecycle, native_at, business_at, now):
    report_status = report.get("status", "unknown")
    report_age = report.get("age_seconds") if report_status == "reported" else None
    if report_status != "reported":
        report_freshness = "unavailable"
    elif report_age > 900 and report.get("phase") != "completed":
        report_freshness = "stale"
    else:
        report_freshness = "current"
    return {
        "native_lifecycle": {
            "status": "current",
            "source": "native_query",
            "updated_at": utc(now),
            "last_change_at": utc(native_at),
            "run": native["run"],
            "tasks": native["tasks"],
            "workers": native["workers"]},
        "coordinator_report": {
            "status": report_status,
            "phase": report.get("phase"),
            "updated_at": report.get("updated_at"),
            "age_seconds": report_age,
            "freshness": report_freshness,
            "last_milestone_change_at": utc(business_at),
            "report_path": report.get("report_path")},
        "execution_state": {
            "source": "native_lifecycle",
            "coordinator_lifecycle": lifecycle,
            "run_id": native["run"].get("id"),
            "consumer_generation": native["run"].get("consumer_generation"),
            "active_dispatches": len([w for w in native["workers"]
                                      if w["dispatch_status"] not in {"completed", "failed", "cancelled"}])},
        "acceptance_state": {
            "status": "not_evaluated",
            "source": "not_derived_from_execution_or_progress_status"},
        "summary_freshness": report_freshness}


def summarize(config, native, report, previous, now):
    alerts = []
    evidence = observed_launch(config, native, report, previous, now)
    lifecycle = evidence["status"]
    driver_cursor = evidence.get("driver", {}).get("cursor")
    stale = bool(previous.get("launch_binding_stale"))
    stale_attempt = previous.get("stale_driver_attempt")
    if (driver_cursor is not None and driver_cursor["started_at"] is not None
            and stale_attempt is not None and driver_cursor["attempt"] > stale_attempt
            and lifecycle in {"terminal_present_agent_exit_unknown", "exited_direct_parent_receipt",
                              "launch_binding_stale_agent_exit_unknown"}):
        stale = False  # Only an exact, verified later launch supersedes the old conflict.
    if lifecycle == "exited_direct_parent_receipt" and stale:
        lifecycle = evidence["status"] = "launch_binding_stale_agent_exit_unknown"
    if lifecycle != "terminal_present_agent_exit_unknown":
        alerts.append(lifecycle)
    generation = native["run"]["consumer_generation"]
    if generation != config["expected_generation"]:
        alerts.append("consumer_generation_changed")
    workers = native["workers"]
    active = [w for w in workers if w["dispatch_status"] not in {"completed", "failed", "cancelled"}]
    uncertain = [w for w in workers if w["resource"] == "owned" and w["liveness"] not in {"exited", "live"}]
    occupied = {w["dispatch"] for w in active + uncertain}
    occupied.update(w["dispatch"] for w in workers if w["resource"] == "owned" and w["liveness"] == "live")
    if len(occupied) > config["max_workers"]:
        alerts.append("worker_limit_exceeded")
    native_fp = digest({"tasks": native["tasks"], "workers": workers})
    native_changed = native_fp != previous.get("native_fingerprint")
    native_at = now if native_changed else previous.get("native_changed_epoch", now)
    milestone = report.get("milestone_fingerprint") if report.get("has_milestone") else previous.get("milestone_fingerprint")
    business_at = now if milestone != previous.get("milestone_fingerprint") else previous.get("reported_progress_epoch", now)
    if report.get("status") != "reported":
        alerts.append("progress_report_unavailable")
    else:
        phase = report["phase"]
        authority_status = report.get("authority", {}).get("status", "not_configured")
        if authority_status == "reported_conflict":
            alerts.append("reported_authority_conflict")
        elif authority_status == "reported_check_failed":
            alerts.append("reported_authority_check_failed")
        elif authority_status not in {"reported_consistent", "not_configured"}:
            alerts.append("authority_check_unavailable")
        wait_until = stamp(report.get("expected_wait_until"))
        waiting = report["has_wait_reason"] and wait_until is not None and now < wait_until
        if phase == "blocked":
            alerts.append("coordinator_reports_blocked")
        if report["age_seconds"] > 900 and phase != "completed":
            alerts.append("progress_report_stale")
        if phase in {"training", "evaluation"}:
            if report["training"]["evidence_status"] != "coordinator_reported_fresh":
                alerts.append("training_visibility_unknown")
            if not waiting and now - business_at > 900:
                alerts.append("phase_progress_needs_diagnosis")
        elif phase not in {"completed", "blocked"} and not waiting and now - max(native_at, business_at) > 900:
            alerts.append("development_inactivity_diagnostic_not_death")
        if report["training"]["active_count"] is not None and report["training"]["active_count"] > 1:
            alerts.append("reported_training_limit_exceeded")
    state = {"native_fingerprint": native_fp, "native_changed_epoch": native_at,
             "milestone_fingerprint": milestone, "reported_progress_epoch": business_at,
             "launch_binding_stale": stale or lifecycle == "launch_binding_stale_agent_exit_unknown",
             "peak_observed_occupied": max(previous.get("peak_observed_occupied", 0), len(occupied))}
    cursor = driver_cursor or previous.get("driver_cursor")
    if cursor is not None:
        state["driver_cursor"] = cursor
    if state["launch_binding_stale"]:
        if driver_cursor is not None and lifecycle == "launch_binding_stale_agent_exit_unknown":
            stale_attempt = driver_cursor["attempt"]
        if stale_attempt is not None:
            state["stale_driver_attempt"] = stale_attempt
    views = status_views(config, native, report, lifecycle, native_at, business_at, now)
    snapshot = {"schema_version": 1, "observed_at": utc(now), "runtime": config["runtime"],
                "run": native["run"], "native_query_status": "complete", "coordinator": lifecycle,
                "configured_launch": evidence,
                "worker_attempts_run_total": len(workers), "active_dispatches": len(active),
                "conservative_occupied": len(occupied), "owned_unknown": len(uncertain),
                "max_workers": config["max_workers"],
                "attempt_peak_observed_occupied": state["peak_observed_occupied"],
                "worker_states": dict(Counter(w["dispatch_status"] for w in workers)),
                "tasks": native["tasks"], "workers": workers, "reported_progress": report,
                "status_views": views,
                "last_native_change_at": utc(native_at), "last_reported_milestone_change_at": utc(business_at),
                "alerts": sorted(set(alerts)),
                "limits": "read-only; process presence is not progress; reported training is not independent occupancy proof; usage not measured"}
    return snapshot, state


def atomic(path, value):
    payload = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
    fd, temporary = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        parent = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(parent)
        finally:
            os.close(parent)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def append(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as stream:
        stream.write(json.dumps(value, ensure_ascii=False, sort_keys=True) + "\n")
        stream.flush()
        os.fsync(stream.fileno())


def markdown(snapshot):
    report = snapshot.get("reported_progress", {})
    views = snapshot.get("status_views", {})
    native_view = views.get("native_lifecycle", {})
    report_view = views.get("coordinator_report", {})
    execution_view = views.get("execution_state", {})
    acceptance_view = views.get("acceptance_state", {})
    return ("# RSI read-only progress\n\n"
            f"Observed: {snapshot['observed_at']}\n\n"
            f"Native queries: {snapshot['native_query_status']}\n\n"
            f"Execution state (native lifecycle): {execution_view or snapshot.get('coordinator', 'unknown')}\n\n"
            f"Native lifecycle updated: {native_view.get('updated_at', 'unknown')}; last change: {native_view.get('last_change_at', snapshot.get('last_native_change_at', 'unknown'))}\n\n"
            f"Coordinator: {snapshot.get('coordinator', 'unknown')}\n\n"
            f"Observed launch (see scope): {snapshot.get('configured_launch', 'unknown')}\n\n"
            f"Run: {snapshot.get('run')}\n\n"
            f"Workers: active={snapshot.get('active_dispatches')}, conservative occupied={snapshot.get('conservative_occupied')}, total attempts={snapshot.get('worker_attempts_run_total')}\n\n"
            f"Coordinator report: status={report_view.get('status', report.get('status', 'unknown'))}, freshness={report_view.get('freshness', 'unknown')}, updated={report_view.get('updated_at', report.get('updated_at', 'unknown'))}, age_seconds={report_view.get('age_seconds', report.get('age_seconds', 'unknown'))}\n\n"
            f"Reported phase: {report.get('phase', 'unknown')}; training: {report.get('training', 'unknown')}\n\n"
            f"Acceptance state: {acceptance_view.get('status', 'not_evaluated')} ({acceptance_view.get('source', 'not_derived_from_execution_or_progress_status')})\n\n"
            f"Authority diagnostic (producer-reported, not independently verified): {report.get('authority', {}).get('status', 'not_configured')}\n\n"
            f"Alerts: {', '.join(snapshot['alerts']) or 'none observed'}\n\n"
            "Read-only observer: no Inbox consumption, dispatch, submission, or automatic recovery. Unknown is not zero; idle is not dead.\n")


def resolve_cli(runtime):
    from startup_cli import resolve
    try:
        return resolve(runtime, legacy=CLI)
    except (ValueError, OSError) as exc:
        code = str(exc) if isinstance(exc, ValueError) else "startup_cli_unavailable"
        raise StopObservation(code) from None


def tick(config, directory, previous, now=None, call=query):
    now = time.time() if now is None else now
    try:
        # Presence, not parseability, is the gate. Restart never clears this file.
        if os.path.lexists(directory / "query-stop.json"):
            raise ObservationError("native_queries_stopped_operator_action_required")
        if call is query:
            from startup_cli import bind, watch_contract
            try:
                call = bind(call, watch_contract(config))
            except (ValueError, OSError, KeyError, TypeError):
                raise StopObservation("watch_startup_contract_invalid") from None
        native = collect(config, call)
        snapshot, state = summarize(config, native, reported(config, native, now), previous, now)
    except (ObservationError, OSError, ValueError, KeyError, TypeError) as exc:
        reason = str(exc) if isinstance(exc, ObservationError) else type(exc).__name__
        if isinstance(exc, StopObservation):
            atomic(directory / "query-stop.json", {"stopped_at": utc(now), "reason": reason,
                                                   "runtime": config["runtime"], "run": config["run"]})
        snapshot = {"schema_version": 1, "observed_at": utc(now), "runtime": config["runtime"],
                    "run": {"id": config["run"]}, "native_query_status": "unknown",
                    "alerts": [reason], "last_success_at": previous.get("last_success_at")}
        state = dict(previous)
    if snapshot["native_query_status"] == "complete":
        state["last_success_at"] = snapshot["observed_at"]
    current = set(snapshot["alerts"])
    prior = set(previous.get("alerts", []))
    for kind, changes in (("raised", current - prior), ("cleared", prior - current)):
        for alert in sorted(changes):
            append(directory / "alerts.jsonl", {"at": utc(now), "kind": kind, "alert": alert})
    state["alerts"] = sorted(current)
    atomic(directory / "status.json", snapshot)
    atomic(directory / "status.md", markdown(snapshot))
    append(directory / "snapshots.jsonl", snapshot)
    if now - previous.get("last_summary_epoch", 0) >= 300:
        append(directory / "summaries.jsonl", snapshot)
        state["last_summary_epoch"] = now
    elif "last_summary_epoch" in previous:
        # Successful collection builds fresh state; keep the summary clock even
        # on non-summary ticks so cadence also survives a clean process restart.
        state["last_summary_epoch"] = previous["last_summary_epoch"]
    atomic(directory / "state.json", state)
    return state


def validate_config(config):
    if not isinstance(config, dict) or set(config) - {"authority_binding"} != {
            "runtime", "run", "workspace", "terminal", "incarnation", "expected_generation",
            "max_workers", "progress_file", "driver_binding"}:
        raise ValueError("invalid_watch_config")
    guid = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
    patterns = [("runtime", guid), ("incarnation", guid),
                ("terminal", "term_" + guid), ("run", r"run_[0-9a-f]{12}")]
    for field, pattern in patterns:
        if not isinstance(config.get(field), str) or not re.fullmatch(pattern, config[field]):
            raise ValueError("invalid config field: " + field)
    for field in ("expected_generation", "max_workers"):
        if type(config.get(field)) is not int or config[field] < 1:
            raise ValueError("invalid config field: " + field)
    if "authority_binding" in config:
        binding = config["authority_binding"]
        if (not isinstance(binding, dict) or set(binding) != {"scope_id", "authority_sha256", "context_sha256"}
                or not isinstance(binding.get("scope_id"), str)
                or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}", binding["scope_id"])
                or any(not isinstance(binding.get(key), str) or not re.fullmatch(r"[0-9a-f]{64}", binding[key])
                       for key in ("authority_sha256", "context_sha256"))):
            raise ValueError("invalid authority binding")
    workspace = config.get("workspace")
    if not isinstance(workspace, str) or not re.fullmatch(guid + r"::/[^\x00-\x1f]+", workspace):
        raise ValueError("invalid workspace")
    driver = config["driver_binding"]
    validate_ref(driver)
    paths = {"progress_file": config["progress_file"], "driver_binding.path": driver["path"]}
    for field, value in paths.items():
        if not isinstance(value, str) or not value or any(ord(char) < 32 for char in value):
            raise ValueError("invalid config path: " + field)
        path = Path(value)
        if not path.is_absolute() or str(path.resolve()) != value:
            raise ValueError("noncanonical config path: " + field)


def bind_output(directory, config):
    binding = {"schema_version": 1, "config_sha256": digest(config)}
    try:
        old = file_json(directory / "binding.json")
    except FileNotFoundError:
        atomic(directory / "binding.json", binding)
    else:
        if old != binding:
            raise ValueError("output_binding_changed_manual_verification_required")


def validate_state(value):
    if "launch_binding_stale" in value and type(value["launch_binding_stale"]) is not bool:
        raise ValueError("invalid state")
    for field in ("native_changed_epoch", "reported_progress_epoch", "last_summary_epoch", "peak_observed_occupied"):
        if field in value and (type(value[field]) not in (int, float) or not math.isfinite(value[field]) or value[field] < 0):
            raise ValueError("invalid state")
    if "alerts" in value and (not isinstance(value["alerts"], list) or not all(isinstance(item, str) for item in value["alerts"])):
        raise ValueError("invalid state")
    if "driver_cursor" in value:
        cursor = value["driver_cursor"]
        if (not isinstance(cursor, dict) or set(cursor) != {"attempt", "plan_sha256", "started_at"}
                or type(cursor["attempt"]) is not int or cursor["attempt"] < 0
                or not isinstance(cursor["plan_sha256"], str)
                or not re.fullmatch(r"[0-9a-f]{64}", cursor["plan_sha256"])
                or (cursor["started_at"] is not None and stamp(cursor["started_at"]) is None)):
            raise ValueError("invalid driver cursor")
    if "stale_driver_attempt" in value:
        count = value["stale_driver_attempt"]
        if type(count) is not int or count < 0 or count > value.get("driver_cursor", {}).get("attempt", -1):
            raise ValueError("invalid stale driver attempt")
    return value


def idle_until_stopped(stop_waiting, seconds):
    """Block until a stop is requested or the tick interval elapses.

    Separated out so the wakeup count is assertable: one wait per tick, not one per 0.5 s shard,
    and a stop that arrives mid-tick is acted on at once instead of at the end of the shard.
    """
    return seconds > 0 and stop_waiting.wait(seconds)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    os.umask(0o077)
    config = file_json(args.config)
    try:
        validate_config(config)
    except ValueError as exc:
        parser.error(str(exc))
    directory = Path(args.output)
    if not directory.is_absolute() or str(directory.resolve()) != str(directory):
        parser.error("output must be an absolute private nonsymlink directory")
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    if directory.stat().st_mode & 0o077 or directory.stat().st_uid != os.getuid():
        parser.error("output must be private (0700)")
    lock = os.open(directory / "watch.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    bind_output(directory, config)
    try:
        previous = validate_state(file_json(directory / "state.json"))
    except FileNotFoundError:
        previous = {}
    stopped = False
    # Why an Event rather than a flag plus a 0.5 s shard: the loop only needs to know when to
    # stop, and a 60 s tick used to wake 120 times to find out. Waiting on the event wakes once,
    # and a SIGTERM is acted on immediately instead of at the end of the current shard.
    stop_waiting = threading.Event()

    def stop(_signal, _frame):
        nonlocal stopped
        stopped = True
        stop_waiting.set()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    while not stopped:
        started = time.monotonic()
        previous = tick(config, directory, previous)
        if args.once:
            break
        idle_until_stopped(stop_waiting, 60 - (time.monotonic() - started))
    os.close(lock)


if __name__ == "__main__":
    main()

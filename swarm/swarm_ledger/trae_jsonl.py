"""Read a precisely bound Trae TUI JSONL prefix, without launching a model/server.

Only token_usage_record.payload.usage is summed, by thread/turn/response identity.
Cumulative counters and keyed event_msg mirrors are diagnostics, never increments.
Supported producer versions do NOT establish normalized billing semantics.
"""

import hashlib
import io
import json
import os
from pathlib import Path
import stat

from supervisor.config import SafetyError, digest, require
from .ledger import elapsed, seconds, text_id, timestamp
from . import raw_usage, trae


def prefix(value):
    require(isinstance(value, dict) and type(value.get("bytes")) is int and value["bytes"] > 0,
            "verified nonempty Trae log prefix required")
    return {"bytes": value["bytes"], "sha256": raw_usage.sha256_id(value["sha256"])}


def binding(value):
    result = trae.scope(value)
    result["terminal_handle"] = text_id(value["terminal_handle"])
    result["verified_prefix"] = prefix(value["verified_prefix"])
    return result


def check_scope(ledger, runtime, run, agent, value):
    result = binding(value)
    trae.check_scope(ledger, runtime, run, agent, result)
    data = ledger.get(runtime, run)
    row = data["agents"][agent]
    # No inferred host: 'local' belongs to the selected Orca server, not this CLI.
    require(row.get("host") is not None and row["host"] == result["host"],
            "Trae JSONL requires a matching native execution host")
    require(row.get("terminal_handle") == result["terminal_handle"],
            "Trae JSONL terminal identity mismatch or unavailable")
    return result


def read_prefix(path, verified, previous=None):
    # O_NONBLOCK avoids hanging on a FIFO before the regular-file check.
    fd = os.open(Path(path), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as source:
        before = os.fstat(source.fileno())
        require(stat.S_ISREG(before.st_mode), "Trae JSONL must be a regular file")
        require(before.st_size > 0, "Trae JSONL empty")
        content = source.read(before.st_size)
        after = os.fstat(source.fileno())
    for anchor in (verified, previous):
        if anchor is not None:
            anchor = prefix(anchor)
            require(len(content) >= anchor["bytes"] and
                    hashlib.sha256(content[:anchor["bytes"]]).hexdigest() == anchor["sha256"],
                    "Trae JSONL prefix changed or truncated")
    stable = (len(content) == before.st_size == after.st_size and
              before.st_mtime_ns == after.st_mtime_ns and before.st_ctime_ns == after.st_ctime_ns)
    return content, {"bytes": len(content), "sha256": hashlib.sha256(content).hexdigest(), "stable": stable}


def event_time(record):
    value = timestamp(record.get("timestamp"))
    require(value is not None, "Trae usage timestamp required")
    return value


def request_id(payload, thread):
    return digest([thread, text_id(payload.get("turn_id")), text_id(payload.get("response_id"))])


def turn_timing(payload, thread, observed_at):
    """Only explicit provider timing fields; completion is not business success."""
    tid = text_id(payload.get("turn_id"))
    begin, finish = trae.unix_time(payload.get("started_at")), trae.unix_time(payload.get("completed_at"))
    elapsed(begin, finish)
    require(not begin or seconds(begin) <= seconds(observed_at), "turn starts after completion event")
    require(not finish or seconds(finish) <= seconds(observed_at), "turn ends after completion event")
    duration = payload.get("duration_ms")
    require(duration is None or type(duration) is int and duration >= 0, "invalid Trae turn duration")
    return {"id": tid, "thread_id": thread, "started_at": begin, "ended_at": finish,
            "duration_ms": duration, "status": "completed"}


def scan(path, bound, since, until, *, previous=None, content=None):
    bound = binding(bound)
    start, end = timestamp(since), timestamp(until)
    require(start is not None and end is not None, "bounded Trae JSONL window required")
    elapsed(start, end)
    require(seconds(start) < seconds(end), "Trae JSONL window must be nonempty")
    if content is None:
        content, capture = read_prefix(path, bound["verified_prefix"], previous)
    else:
        require(path is None and isinstance(content, bytes) and len(content) > 0,
                "invalid captured Trae JSONL prefix")
        for anchor in (bound["verified_prefix"], previous):
            if anchor is not None:
                anchor = prefix(anchor)
                require(len(content) >= anchor["bytes"] and
                        hashlib.sha256(content[:anchor["bytes"]]).hexdigest() == anchor["sha256"],
                        "Trae JSONL prefix changed or truncated")
        capture = {"bytes": len(content), "sha256": hashlib.sha256(content).hexdigest(), "stable": True}
    warnings = set() if capture["stable"] else {"source_changed_during_scan"}
    found_meta, offset, last_time, cumulative = False, 0, None, None
    seen, selected, mirrors, completions = {}, {}, [], []
    seen_turns, selected_turns = {}, {}
    time_warnings = {"turn_inventory_unverified"}  # task_complete alone cannot prove all turns were captured.
    last_usage = None
    producer_version = None
    for line in io.BytesIO(content):
        offset += len(line)
        if not line.endswith(b"\n"):
            warnings.add("partial_final_line")
            continue
        try:
            record = json.loads(line)
        except (ValueError, UnicodeDecodeError):
            warnings.add("malformed_record")
            continue
        if not isinstance(record, dict) or not isinstance(record.get("payload"), dict):
            warnings.add("malformed_record")
            continue
        kind, payload = record.get("type"), record["payload"]
        if kind == "session_meta":
            require(not found_meta, "multiple Trae session metadata records")
            require((payload.get("id"), payload.get("session_id"), payload.get("model_provider")) ==
                    (bound["thread_id"], bound["session_id"], "trae"), "Trae JSONL session identity mismatch")
            require(payload.get("originator") == "traex-tui",
                    "unsupported Trae JSONL producer/version")
            producer_version = payload.get("cli_version")
            raw_usage.trae_jsonl_contract(producer_version)
            require(offset <= bound["verified_prefix"]["bytes"], "Trae metadata outside verified prefix")
            found_meta = True
            continue
        is_usage = kind == "token_usage_record"
        is_mirror = kind == "event_msg" and payload.get("type") == "token_count"
        is_complete = kind == "event_msg" and payload.get("type") == "task_complete"
        if not (is_usage or is_mirror or is_complete):
            continue
        require(found_meta, "Trae usage before verified session metadata")
        # Child threads must not leak into the parent's accounting window.
        if payload.get("thread_id") not in (None, bound["thread_id"]):
            continue
        if payload.get("session_id") not in (None, bound["session_id"]):
            warnings.add("event_session_mismatch")
            continue
        try:
            ts = event_time(record)
            if is_usage:
                require(payload.get("thread_id") == bound["thread_id"] and
                        payload.get("session_id") == bound["session_id"], "missing Trae event identity")
                key = request_id(payload, bound["thread_id"])
                counts = raw_usage.counts(payload.get("usage"))
            elif is_mirror:
                # Unkeyed mirrors cannot safely be paired by ordinal or timestamp.
                if not payload.get("turn_id") or not payload.get("response_id"):
                    continue
                key = request_id(payload, bound["thread_id"])
                counts = raw_usage.counts(payload["info"]["last_token_usage"])
        except (SafetyError, ValueError, TypeError, KeyError, AttributeError, OverflowError):
            warnings.add("invalid_usage_record")
            continue
        if seconds(ts) > seconds(end):
            continue
        if is_complete:
            if seconds(ts) > seconds(start):
                completions.append(seconds(ts))
            try:
                turn = turn_timing(payload, bound["thread_id"], ts)
            except (SafetyError, ValueError, TypeError, KeyError, OSError, OverflowError):
                if seconds(ts) > seconds(start):
                    time_warnings.add("invalid_or_unidentified_turn_timing")
                continue
            tid = turn["id"]
            if tid in seen_turns:
                require(seen_turns[tid] == turn, "conflicting Trae turn timing duplicate")
                continue  # Includes re-emission of an earlier-window completion.
            seen_turns[tid] = turn
            if seconds(ts) <= seconds(start):
                continue
            if (turn["started_at"] and seconds(turn["started_at"]) < seconds(start)
                    or turn["ended_at"] and seconds(turn["ended_at"]) <= seconds(start)):
                time_warnings.add("turn_outside_window")
                continue
            if not turn["started_at"] or not turn["ended_at"] or turn["duration_ms"] is None:
                time_warnings.add("turn_timing_incomplete")
            if turn["started_at"] and turn["ended_at"] and turn["duration_ms"] is not None:
                wall_ms = elapsed(turn["started_at"], turn["ended_at"]) * 1000
                if abs(wall_ms - turn["duration_ms"]) > 1000:
                    time_warnings.add("turn_duration_mismatch")
                    turn = {**turn, "duration_ms": None}
            selected_turns[tid] = turn
            continue
        if is_mirror:
            if seconds(ts) > seconds(start):
                mirrors.append((key, counts))
            continue
        if key in seen:
            require(seen[key]["counts"] == counts, "conflicting Trae request duplicate")
            continue  # Re-emission in a later window is not another request.
        row = {"id": key, "record_sha256": digest([ts, counts]), "counts": counts}
        seen[key] = row
        if last_time is not None and seconds(ts) < last_time:
            warnings.add("out_of_order_usage")
        last_time = max(last_time or seconds(ts), seconds(ts))
        try:
            total = (raw_usage.counts(payload["thread_token_usage"])
                     if payload.get("thread_token_usage") is not None else None)
        except SafetyError:
            warnings.add("invalid_cumulative_counter")
            total = None  # Corrupt diagnostics must not discard valid request counters.
        if total is not None and len(seen) == 1 and any(
                total[k] is not None and counts[k] is not None and total[k] != counts[k]
                for k in raw_usage.FIELDS):
            warnings.add("initial_cumulative_mismatch")
        if total is not None and cumulative is not None:
            for field in raw_usage.FIELDS:
                cur, prev, inc = total[field], cumulative[field], counts[field]
                if cur is not None and prev is not None:
                    if cur < prev:
                        warnings.add("cumulative_counter_regression")
                    elif inc is not None and cur - prev != inc:
                        warnings.add("cumulative_delta_mismatch")
        cumulative = total
        if seconds(ts) <= seconds(start):
            continue
        selected[key] = row
        last_usage = max(last_usage or seconds(ts), seconds(ts))
        if any(counts[k] is None for k in ("input_tokens", "output_tokens", "total_tokens")):
            warnings.add("missing_raw_counters")
    require(found_meta, "no matching Trae session metadata")
    for key, counts in mirrors:
        if key not in seen:
            warnings.add("mirror_without_request_record")
        elif counts != seen[key]["counts"]:
            warnings.add("mirror_usage_mismatch")
    if not selected:
        warnings.add("no_usage_events_in_window")
    complete_seen = bool(last_usage is not None and completions and max(completions) >= last_usage)
    if not complete_seen:
        warnings.add("no_task_complete_after_usage")
    rows = sorted(selected.values(), key=lambda r: r["id"])
    turns = sorted(selected_turns.values(), key=lambda r: r["id"])
    if not turns:
        time_warnings.add("no_turn_timings")
    return {"provider": "trae", "session_id": bound["thread_id"], "since": start, "until": end,
            "tokens": {}, "complete": False, "source": "trae-jsonl:sha256:" + capture["sha256"],
            "warnings": sorted(warnings | {"counter_semantics_unverified"}),
            "turns": turns, "turn_timing_complete": False, "turn_timing_warnings": sorted(time_warnings),
            "trae_provenance": {"thread_id": bound["thread_id"], "session_tree_id": bound["session_id"],
                                "binding_source": bound["source"], "counter_semantics": "unverified",
                                "semantics_source": None, "thread_cli_version": producer_version},
            "raw_usage": {"contract": raw_usage.trae_jsonl_contract(producer_version), "counter_semantics": "unverified",
                          "binding": bound, "capture": capture, "task_complete_observed": complete_seen,
                          "requests": rows, **raw_usage.totals(rows)}}

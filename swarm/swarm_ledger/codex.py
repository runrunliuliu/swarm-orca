"""Bounded Codex JSONL usage reader; never exports transcript content.

Follows Orca 1.4.219's total/last-token snapshot rules. A window is (since, until].
Malformed records, unaccounted baselines and counter-only regressions stay partial.
"""

import hashlib
import json
from contextlib import nullcontext
from pathlib import Path

from supervisor.config import require
from .ledger import TOKEN_FIELDS, elapsed, seconds, timestamp, token_counts


def raw_counts(raw):
    if raw is None:
        return None
    require(isinstance(raw, dict), "invalid Codex token object")
    return token_counts({
        "input_tokens": raw.get("input_tokens"), "output_tokens": raw.get("output_tokens"),
        "cache_read_tokens": raw.get("cached_input_tokens", raw.get("cache_read_input_tokens")),
        "cache_write_tokens": None, "reasoning_tokens": raw.get("reasoning_output_tokens"),
    })


def monotonic(current, previous):
    return all(current[k] is None or previous[k] is None or current[k] >= previous[k]
               for k in TOKEN_FIELDS)


def resolve(total, last, previous):
    if total is not None and previous is not None and total == previous:
        return None, previous, None
    if total is not None and last is not None:
        if previous and not monotonic(total, previous):
            magnitude = lambda x: sum(x[k] or 0 for k in TOKEN_FIELDS)
            cur, prev, inc = magnitude(total), magnitude(previous), magnitude(last)
            if cur > 0 and prev > 0 and inc > 0 and (cur * 100 >= prev * 98 or cur + inc * 2 >= prev):
                return None, previous, "ambiguous_counter_regression"  # likely stale; don't claim exact completeness
        return last, total, None  # last is the increment, total is mutable baseline
    if total is not None and previous is not None:
        if not monotonic(total, previous):
            return None, total, "counter_reset_without_increment"
        delta = {k: total[k] - previous[k] if total[k] is not None and previous[k] is not None else None
                 for k in TOKEN_FIELDS}
        return token_counts(delta), total, None
    if total is not None:
        return None, total, "missing_initial_increment"  # never charge unseen pre-window history
    if last is not None:
        following = token_counts({k: previous[k] + last[k] if previous and previous[k] is not None
                                  and last[k] is not None else None for k in TOKEN_FIELDS}) if previous else None
        return last, following, None
    return None, previous, "missing_usage_payload"


def scan(path, session_id, since, until, *, source=None):
    start, end = timestamp(since), timestamp(until)
    elapsed(start, end)
    require(start is not None and end is not None, "bounded Codex window required")
    previous, found_session, last_time = None, False, None
    seen, warnings, increments = set(), set(), []
    sha = hashlib.sha256()
    # Read one consistent byte prefix; concurrent appends belong to the next scan.
    with (Path(path).open("rb") if source is None else nullcontext(source)) as source:
        remaining = source.seek(0, 2)
        source.seek(0)
        while remaining:
            line = source.readline(remaining)
            if not line:
                warnings.add("source_truncated_during_scan")
                break
            remaining -= len(line)
            sha.update(line)
            if not line.endswith(b"\n"):
                warnings.add("partial_final_line")
                continue
            try:
                record = json.loads(line)
            except (ValueError, UnicodeDecodeError):
                warnings.add("malformed_record")
                continue
            if not isinstance(record, dict):
                warnings.add("malformed_record")
                continue
            kind, payload = record.get("type"), record.get("payload")
            if not isinstance(payload, dict):
                continue
            if kind == "session_meta":
                require(payload.get("id") == session_id, "Codex session identity mismatch")
                found_session = True
            if kind != "event_msg" or payload.get("type") != "token_count" or payload.get("info") is None:
                continue
            require(found_session, "usage before verified session identity")
            try:
                ts = timestamp(record.get("timestamp"))
                require(ts is not None, "usage timestamp required")
                info = payload["info"]
                total, last = raw_counts(info.get("total_token_usage")), raw_counts(info.get("last_token_usage"))
            except (ValueError, TypeError, AttributeError, RuntimeError):
                warnings.add("invalid_usage_record")
                continue
            if seconds(ts) > seconds(end):
                continue
            event_key = json.dumps([ts, total, last], sort_keys=True)
            if event_key in seen:
                continue
            seen.add(event_key)
            if last_time is not None and seconds(ts) < last_time:
                warnings.add("out_of_order_usage")
                continue
            last_time = seconds(ts)
            delta, previous, warning = resolve(total, last, previous)
            if seconds(ts) <= seconds(start):
                continue  # still consumed for the cumulative baseline
            if warning:
                warnings.add(warning)
            if delta is not None:
                increments.append(delta)
    require(found_session, "no matching Codex session_meta")
    if not increments:
        warnings.add("no_usage_events_in_window")
    counts = {k: sum(d[k] for d in increments) if increments and all(d[k] is not None for d in increments)
              else None for k in TOKEN_FIELDS}
    return {"provider": "codex", "session_id": session_id, "since": start, "until": end,
            "tokens": counts, "source": "codex-jsonl:sha256:" + sha.hexdigest(),
            "complete": not warnings, "warnings": sorted(warnings)}

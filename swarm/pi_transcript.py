"""Read one Pi session transcript as role evidence; never a screen or title guess.

Pi writes an append-only JSONL transcript whose root record is
`{"type":"session","id":<uuid>,"cwd":…,"version":…}` and whose per-record chain
carries `id`/`parentId`. Assistant messages carry the effective
`model`/`provider`/`thinkingLevel` of that turn. That is the Pi equivalent of the
Trae `session_meta` + `turn_context` evidence this repository already verifies:
identity comes from the root record, effective settings from the newest assistant
message, freshness from the newest record.

Verification is deliberately strict and fail-closed. Shape changes (a different
root type, a broken parent chain, no assistant settings) are refused with a typed
code instead of being inferred from a filename, a title or a neighbouring log.
"""

from datetime import datetime, timezone
import hashlib
import json
import re

from coordinator_io import require, timestamp
from log_io import prefix_digest, prefix_lines
from swarm_ledger import runtime_binding

# Observed Pi transcript schema version (root `version` field). A lower version
# lacks the parent chain / assistant settings this reader requires.
MIN_VERSION = 3
UUID_PATTERN = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")


def session_id(value):
    require(isinstance(value, str) and UUID_PATTERN.fullmatch(value) is not None,
            "pi_session_id_invalid")
    return value


def read(path):
    """Read a finite, stable prefix and return its verified identity/settings.

    The prefix digest, device and inode are returned so a caller can pin exactly
    the bytes it verified and reject a later replacement or truncation.
    """
    rows, seen, previous_at, last_stamp = [], set(), None, None
    with runtime_binding.ordinary_file(path) as (source, info):
        digest = prefix_digest(source, info.st_size)
        source.seek(0)
        for line in prefix_lines(source, info.st_size):
            require(line.endswith(b"\n"), "pi_session_partial_append")
            record = json.loads(line)
            require(isinstance(record, dict), "pi_session_record_invalid")
            if not rows:
                _root(record)
            else:
                _chained(record, seen, previous_at, rows[-1]["id"], len(rows) == 1)
            previous_at, last_stamp = _when(record), record["timestamp"]
            seen.add(record.get("id"))
            rows.append(record)
        source.seek(0)
        require(hashlib.sha256(source.read(info.st_size)).hexdigest() == digest,
                "pi_session_changed_during_read")
    require(len(rows) > 1, "pi_session_settings_missing")
    root = rows[0]
    effective, settings_record = _effective(rows)
    return {"session_id": root["id"], "cwd": root["cwd"], "version": root["version"],
            "effective": effective,
            # Freshness is anchored to the record whose settings are accepted, not
            # to the newest line: appending a fresh non-assistant record must not
            # make stale settings look current.
            "observed_at": settings_record["timestamp"],
            "activity_at": last_stamp, "settings_record_id": settings_record["id"],
            "prefix": {"bytes": info.st_size, "sha256": digest},
            "file_identity": {"device": info.st_dev, "inode": info.st_ino}}


def _root(record):
    require(record.get("type") == "session" and record.get("parentId") is None,
            "pi_session_root_invalid")
    require(type(record.get("version")) is int and record["version"] >= MIN_VERSION,
            "pi_session_version_unsupported")
    session_id(record.get("id"))
    require(isinstance(record.get("cwd"), str) and record["cwd"].strip(),
            "pi_session_cwd_required")
    _when(record)


def _chained(record, seen, previous_at, previous_id, first_child):
    require(isinstance(record.get("type"), str) and record["type"].strip(),
            "pi_session_record_invalid")
    require(isinstance(record.get("id"), str) and record["id"] and record["id"] not in seen,
            "pi_session_record_identity_invalid")
    parent = record.get("parentId")
    # Pi's transcript is one linear chain that starts at a single null parent
    # (the session root record is separate). A second null start, a branch, a
    # dangling or forward link would let a standalone record carry the settings
    # the gate accepts, so the shape must stay linear.
    require(parent is None if first_child else parent == previous_id, "pi_session_chain_broken")
    require(previous_at is None or _when(record) >= previous_at,
            "pi_session_timestamps_not_monotonic")


def _when(record):
    require(isinstance(record.get("timestamp"), str), "pi_session_timestamp_required")
    return timestamp(record["timestamp"])


def _effective(rows):
    """Newest assistant turn is the observed settings; no cross-provider alias."""
    for record in reversed(rows):
        if record.get("type") != "message":
            continue
        message = record.get("message")
        require(isinstance(message, dict) and isinstance(message.get("role"), str),
                "pi_session_message_invalid")
        if message["role"] != "assistant":
            continue
        observed = {"model": message.get("model"), "model_provider": message.get("provider"),
                    "thinking_level": message.get("thinkingLevel")}
        require(all(isinstance(value, str) and value.strip() for value in observed.values()),
                "pi_session_settings_missing")
        return observed, record
    raise ValueError("pi_session_settings_missing")


def utc(record):
    """Parse one record timestamp for callers that need an aware datetime."""
    return datetime.fromisoformat(record["timestamp"]).astimezone(timezone.utc)

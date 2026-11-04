"""Trae App Server settlement snapshots, not a model runner.

Wire shapes are from traecli 0.209.1 generate-json-schema. Schema does not prove
counter semantics: inclusive session-cumulative counters need separate evidence.
Only an explicitly selected, already running server may be queried via proxy.
"""

from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import selectors
import stat
import subprocess
import tempfile
import time

from supervisor.config import SafetyError, require
from supervisor.store import private_directory
from .ledger import TOKEN_FIELDS, elapsed, seconds, text_id, timestamp, token_counts

RAW_FIELDS = ("inputTokens", "outputTokens", "cachedInputTokens",
              "cacheCreationInputTokens", "reasoningOutputTokens", "totalTokens")
SCOPE_FIELDS = ("runtime_id", "run_id", "agent_id", "host", "thread_id", "session_id", "source")


def sha(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def utc_now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def unix_time(value):
    if value is None:
        return None
    require(type(value) is int and value >= 0, "invalid Trae Unix timestamp")
    return datetime.fromtimestamp(value, timezone.utc).isoformat().replace("+00:00", "Z")


def scope(raw):
    require(isinstance(raw, dict), "Trae binding must be an object")
    value = {k: raw[k] for k in SCOPE_FIELDS}
    for k in SCOPE_FIELDS:
        if k != "host":
            text_id(value[k])
    host = value["host"]
    require(isinstance(host, dict) and set(host) == {"kind", "hostId"}, "explicit Trae execution host required")
    text_id(host["kind"])
    text_id(host["hostId"])
    return value


def check_scope(ledger, runtime, run, agent, binding):
    value = scope(binding)
    require((value["runtime_id"], value["run_id"], value["agent_id"]) == (runtime, run, agent),
            "Trae accounting scope mismatch")
    row = ledger.get(runtime, run)["agents"].get(agent)
    require(row is not None, "unknown Agent/Dispatch")
    require(row.get("provider") in (None, "trae"), "Trae provider mismatch")
    if row.get("host") is not None:
        require(row["host"] == value["host"], "Trae execution host mismatch")
    return value


def raw_counts(value):
    require(value is None or isinstance(value, dict), "invalid Trae token object")
    value = value or {}
    result = {k: value.get(k) for k in RAW_FIELDS}
    require(all(v is None or type(v) is int and v >= 0 for v in result.values()),
            "invalid Trae token counter")
    return result  # absent optional cache creation is unknown, not schema default zero


def snapshot(response, binding, started_at, observed_at, *, collector_version=None):
    """Whitelist metadata only. Never persist items, prompts, cwd, errors or paths."""
    binding = scope(binding)
    require(isinstance(response, dict) and isinstance(response.get("thread"), dict), "invalid thread/read result")
    thread = response["thread"]
    require((thread.get("id"), thread.get("sessionId")) == (binding["thread_id"], binding["session_id"]),
            "Trae thread/session identity mismatch")
    start, end = timestamp(started_at), timestamp(observed_at)
    require(start is not None and end is not None, "Trae observation times required")
    elapsed(start, end)
    created = unix_time(thread.get("createdAt"))
    require(created is not None and seconds(created) <= seconds(end), "invalid Trae thread creation time")
    turns = thread.get("turns")
    require(isinstance(turns, list), "thread/read must include turns")
    cleaned, ids = [], set()
    for turn in turns:
        require(isinstance(turn, dict), "invalid Trae turn")
        tid = text_id(turn["id"])
        require(tid not in ids, "duplicate Trae turn")
        ids.add(tid)
        require(turn.get("status") in ("completed", "failed", "interrupted", "inProgress"), "invalid Trae turn status")
        begin, finish = unix_time(turn.get("startedAt")), unix_time(turn.get("completedAt"))
        elapsed(begin, finish)
        duration = turn.get("durationMs")
        require(duration is None or type(duration) is int and duration >= 0, "invalid Trae turn duration")
        require(not finish or seconds(finish) <= seconds(end), "Trae turn ends after observation")
        cleaned.append({"id": tid, "status": turn["status"], "started_at": begin,
                        "ended_at": finish, "duration_ms": duration})
    status = thread.get("status")
    require(isinstance(status, dict) and status.get("type") in ("idle", "notLoaded", "active", "systemError"),
            "invalid Trae thread status")
    usage = response.get("tokenUsage")
    require(usage is None or isinstance(usage, dict), "invalid Trae usage")
    version = text_id(thread["cliVersion"])
    return {"schema_version": 1, "provider": "trae", "binding": binding,
            "read_started_at": start, "observed_at": end, "thread_created_at": created,
            "thread_status": status["type"], "thread_cli_version": version,
            "collector_version": collector_version, "tokens": raw_counts(usage.get("total") if usage else None),
            "turns": cleaned, "response_sha256": sha(response)}


def load_snapshot(path):
    with Path(path).open("rb") as source:
        content = source.read()
    return validate_snapshot(json.loads(content))


def validate_snapshot(value):
    require(isinstance(value, dict) and type(value.get("schema_version")) is int
            and value["schema_version"] == 1 and value.get("provider") == "trae",
            "unsupported Trae snapshot")
    binding = scope(value["binding"])
    start, end, created = (timestamp(value[k]) for k in ("read_started_at", "observed_at", "thread_created_at"))
    require(all((start, end, created)), "missing Trae snapshot time")
    elapsed(start, end)
    require(seconds(created) <= seconds(end), "invalid Trae creation time")
    require(value["thread_status"] in ("idle", "notLoaded", "active", "systemError"), "invalid Trae thread status")
    require(isinstance(value["turns"], list), "invalid Trae turns")
    turns, ids = [], set()
    for raw in value["turns"]:
        require(isinstance(raw, dict), "invalid Trae turn")
        tid = text_id(raw["id"])
        require(tid not in ids, "duplicate Trae turn")
        ids.add(tid)
        begin, finish = timestamp(raw.get("started_at")), timestamp(raw.get("ended_at"))
        elapsed(begin, finish)
        require(not begin or seconds(created) <= seconds(begin) <= seconds(end), "invalid Trae turn start")
        require(not finish or seconds(finish) <= seconds(end), "invalid Trae turn finish")
        duration = raw.get("duration_ms")
        require(duration is None or type(duration) is int and duration >= 0, "invalid Trae turn duration")
        require(raw.get("status") in ("completed", "interrupted", "failed", "inProgress"), "invalid Trae turn status")
        turns.append({"id": tid, "started_at": begin, "ended_at": finish,
                      "duration_ms": duration, "status": raw["status"]})
    checksum = value["response_sha256"]
    require(isinstance(checksum, str) and len(checksum) == 64 and all(c in "0123456789abcdef" for c in checksum),
            "invalid Trae response digest")
    collector = value.get("collector_version")
    require(collector is None or isinstance(collector, str), "invalid Trae collector version")
    return {"schema_version": 1, "provider": "trae", "binding": binding, "read_started_at": start,
            "observed_at": end, "thread_created_at": created, "thread_status": value["thread_status"],
            "thread_cli_version": text_id(value["thread_cli_version"]), "collector_version": collector,
            "response_sha256": checksum, "tokens": raw_counts(value["tokens"]), "turns": turns}


def write_snapshot(path, value):
    """Atomic exclusive create: never overwrite a baseline or a finalized receipt."""
    path = Path(path)
    require(path.is_absolute(), "absolute private snapshot path required")
    root = private_directory(path.parent)
    require(not path.exists() and not path.is_symlink(), "Trae snapshot already exists; choose a new checkpoint path")
    fd, name = tempfile.mkstemp(prefix=".trae-snapshot-", dir=root)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as target:
            json.dump(validate_snapshot(value), target, ensure_ascii=False, sort_keys=True, indent=2)
            target.write("\n")
            target.flush()
            os.fsync(target.fileno())
        os.link(name, path)  # fails if a competing writer created the destination
        directory = os.open(root, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        os.unlink(name)


def scan(current, baseline=None, *, dedicated=False, semantics="unverified", semantics_source=None):
    """Absolute window upsert: subtract one fixed pre-task snapshot, never sum total/last."""
    current = validate_snapshot(current)
    baseline = validate_snapshot(baseline) if baseline is not None else None
    binding = current["binding"]
    require(type(dedicated) is bool and (baseline is not None) != dedicated,
            "Trae needs baseline OR dedicated-session attestation")
    require(semantics in ("unverified", "cumulative-inclusive"), "unsupported Trae counter semantics")
    if semantics != "unverified":
        text_id(semantics_source)
    end = timestamp(current["observed_at"])
    start = timestamp(baseline["observed_at"] if baseline is not None else current["thread_created_at"])
    require(start is not None and end is not None and seconds(start) < seconds(end), "invalid Trae snapshot window")
    elapsed(timestamp(current["read_started_at"]), end)
    require(seconds(start) <= seconds(timestamp(current["read_started_at"])), "overlapping Trae reads")
    warnings, time_warnings = set(), set()
    if baseline is not None:
        require(scope(baseline["binding"]) == binding, "Trae baseline scope mismatch")
        require(baseline["thread_created_at"] == current["thread_created_at"], "Trae thread identity changed")
    for point in (current, baseline) if baseline is not None else (current,):
        require(point.get("provider") == "trae" and point.get("schema_version") == 1, "unsupported Trae snapshot")
        if point["thread_status"] not in ("idle", "notLoaded") or any(t["status"] == "inProgress" for t in point["turns"]):
            warnings.add("snapshot_not_quiescent")
            time_warnings.add("snapshot_not_quiescent")
    now = raw_counts(current["tokens"])
    before = raw_counts(baseline["tokens"]) if baseline is not None else dict.fromkeys(RAW_FIELDS, 0)
    delta = {k: now[k] - before[k] if now[k] is not None and before[k] is not None else None for k in RAW_FIELDS}
    if any(v is not None and v < 0 for v in delta.values()):
        warnings.add("counter_regression_or_reset")
    if semantics == "unverified":
        warnings.add("counter_semantics_unverified")
    if any(delta[k] is None for k in ("inputTokens", "outputTokens", "totalTokens")):
        warnings.add("missing_usage_or_baseline")
    if not warnings:
        try:
            for point in (now, before):
                token_counts(dict(zip((*TOKEN_FIELDS, "total_tokens"), (point[k] for k in RAW_FIELDS))))
            counts = token_counts(dict(zip((*TOKEN_FIELDS, "total_tokens"), (delta[k] for k in RAW_FIELDS))))
        except SafetyError:
            warnings.add("counter_semantics_mismatch")
    if warnings:
        counts = token_counts({})  # raw counters remain in the private snapshot, never claim a guessed subtotal
    old_turns = {t["id"]: t for t in baseline["turns"]} if baseline is not None else {}
    new_turns = {t["id"]: t for t in current["turns"]}
    require(len(new_turns) == len(current["turns"]), "duplicate Trae turn")
    if not old_turns.keys() <= new_turns.keys() or any(new_turns.get(k) != v for k, v in old_turns.items()):
        warnings.add("turn_history_changed")
        time_warnings.add("turn_history_changed")
        counts = token_counts({})
    turns = []
    for tid, turn in new_turns.items():
        if tid in old_turns:
            continue
        if turn["started_at"] is not None and seconds(turn["started_at"]) < seconds(start):
            time_warnings.add("turn_start_outside_window")
            continue  # integer-second Trae timestamps cannot precisely attribute a boundary turn
        if turn["started_at"] is None:
            time_warnings.add("turn_start_outside_or_unknown")
        if turn["ended_at"] is None or turn["duration_ms"] is None or turn["status"] == "inProgress":
            time_warnings.add("turn_timing_incomplete")
        if turn["started_at"] and turn["ended_at"] and turn["duration_ms"] is not None:
            wall_ms = elapsed(turn["started_at"], turn["ended_at"]) * 1000
            if abs(wall_ms - turn["duration_ms"]) > 1000:
                time_warnings.add("turn_duration_mismatch")
                turn = {**turn, "duration_ms": None}
        turns.append({**turn, "thread_id": binding["thread_id"]})
    if not turns:
        time_warnings.add("no_turn_timings")
    return {"provider": "trae", "session_id": binding["thread_id"], "since": start, "until": end,
            "tokens": counts, "complete": not warnings, "warnings": sorted(warnings),
            "source": "trae-snapshots:sha256:" + sha([current, baseline, dedicated, semantics, semantics_source]),
            "turns": turns, "turn_timing_complete": not time_warnings,
            "turn_timing_warnings": sorted(time_warnings),
            "trae_provenance": {"thread_id": binding["thread_id"], "session_tree_id": binding["session_id"],
                                "binding_source": binding["source"], "counter_semantics": semantics,
                                "semantics_source": semantics_source, "thread_cli_version": current["thread_cli_version"]}}


class ProxyReader:
    """Time-bounded JSONL RPC over the documented proxy. No shell or auto-start."""
    def __init__(self, cli, socket_path, *, timeout=20):
        self.cli, self.socket = str(cli), str(socket_path)
        require(Path(cli).is_absolute() and Path(socket_path).is_absolute(), "explicit absolute Trae CLI/socket required")
        st = Path(socket_path).stat()
        require(stat.S_ISSOCK(st.st_mode) and st.st_uid == os.getuid(), "Trae socket must be existing and user-owned")
        require(0 < timeout <= 55, "invalid Trae timeout")
        self.timeout = timeout

    def capture(self, binding):
        binding = scope(binding)
        try:
            version = subprocess.run([self.cli, "--version"], capture_output=True, timeout=self.timeout, text=True)
            require(version.returncode == 0 and version.stdout.splitlines()[0] == "traecli 0.209.1",
                    "Trae collector CLI version not validated (expected 0.209.1)")
            with subprocess.Popen([self.cli, "app-server", "proxy", "--sock", self.socket],
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0) as proc:
                try:
                    with selectors.DefaultSelector() as selector:
                        selector.register(proc.stdout, selectors.EVENT_READ)
                        self.proc, self.selector = proc, selector
                        self.buffer, self.read_bytes = bytearray(), 0
                        self.deadline = time.monotonic() + self.timeout
                        self.rpc(1, "initialize", {"clientInfo": {"name": "swarm_ledger", "version": "1"}})
                        self.send({"method": "initialized", "params": {}})
                        started = utc_now()
                        response = self.rpc(2, "thread/read", {"threadId": binding["thread_id"], "includeTurns": True})
                        return snapshot(response, binding, started, utc_now(), collector_version="0.209.1")
                finally:
                    # This is our byte-proxy child, never the server or a model worker.
                    if proc.poll() is None:
                        proc.terminate()
                        try:
                            proc.wait(timeout=2)
                        except subprocess.TimeoutExpired:
                            proc.kill()
                            proc.wait(timeout=2)
        except (OSError, subprocess.SubprocessError, ValueError, IndexError) as error:
            raise SafetyError("trae_read_transport_failed") from error

    def send(self, message):
        self.proc.stdin.write((json.dumps(message) + "\n").encode())
        self.proc.stdin.flush()

    def rpc(self, rid, method, params):
        require((rid, method) in ((1, "initialize"), (2, "thread/read")), "Trae accounting permits reads only")
        self.send({"id": rid, "method": method, "params": params})
        search_from = 0
        while True:
            require(time.monotonic() < self.deadline, "trae_read_timeout")
            newline = self.buffer.find(b"\n", search_from)
            if newline < 0:
                search_from = len(self.buffer)
                require(self.selector.select(max(0, self.deadline - time.monotonic())), "trae_read_timeout")
                chunk = os.read(self.proc.stdout.fileno(), 65536)
                require(chunk, "trae_proxy_closed")
                self.read_bytes += len(chunk)
                self.buffer.extend(chunk)
                continue
            line = self.buffer[:newline]
            del self.buffer[:newline + 1]
            search_from = 0
            message = json.loads(line)
            require(isinstance(message, dict), "invalid Trae RPC message")
            require(not ("method" in message and "id" in message), "unexpected Trae server request; no approval granted")
            if "id" not in message:
                continue  # notifications are not additive billing receipts
            require(type(message["id"]) is int and message["id"] == rid, "Trae RPC response mismatch")
            require("error" not in message and isinstance(message.get("result"), dict), "Trae RPC read failed")
            return message["result"]

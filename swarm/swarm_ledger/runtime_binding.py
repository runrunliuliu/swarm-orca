"""Opt-in Codex/Trae TUI runtime-state accounting; no /proc, secrets or lifecycle writes.

The runtime's persistent hook mapping is attribution evidence, not process attestation.
Only local 1.4.219 runtimes and same-user ordinary files are supported.
"""

from contextlib import contextmanager
import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
import socket
import stat

from supervisor.config import require, digest
from .codex import scan
from .ledger import seconds, timestamp
from . import runtime_trae

TERMINAL_FIELDS = ("handle", "worktreeId", "tabId", "leafId", "ptyId", "incarnationId",
                   "executionHostId", "agentIdentity")


def identifier(value):
    require(isinstance(value, str) and 0 < len(value) <= 4096 and
            not any(ord(c) < 32 for c in value), "runtime_state_invalid_identifier")
    return value


def canonical(value):
    path = Path(identifier(value))
    require(path.is_absolute() and path.resolve() == path, "runtime_state_noncanonical_path")
    require(not any(path == p or path.is_relative_to(p) for p in map(Path, ("/proc", "/sys", "/dev"))),
            "runtime_state_special_filesystem_forbidden")
    return path


@contextmanager
def ordinary_file(path, *, private=False):
    path = canonical(str(path))
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb", buffering=0) as source:
        info = os.fstat(source.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid(), "runtime_state_invalid_file_owner_or_type")
        require(not private or info.st_mode & 0o077 == 0, "runtime_state_file_not_private")
        require(info.st_size > 0, "runtime_state_file_empty")
        yield source, info


def read_state(path):
    with ordinary_file(path, private=True) as (source, info):
        raw = source.read(info.st_size)
        require(len(raw) == info.st_size, "runtime_state_file_truncated")
    value = json.loads(raw)
    require(isinstance(value, dict), "runtime_state_invalid_object")
    return value


def configuration(options):
    require(isinstance(options, dict) and options.get("provider") in ("codex", "trae") and
            options.get("format") == "runtime-state", "runtime_state_explicit_mode_required")
    require(options.get("final", False) is False, "runtime_state_cannot_finalize")
    require(options.get("host") == socket.gethostname(), "runtime_state_wrong_execution_host")
    for key in ("terminal_handle", "worktree_id"):
        identifier(options.get(key))
    profile, logs = canonical(options.get("profile")), canonical(options.get("log_root"))
    require(profile.is_dir() and logs.is_dir() and logs != Path("/"), "runtime_state_invalid_roots")
    age = options.get("max_hook_age_seconds", 86400)
    require(type(age) is int and 0 < age <= 86400, "runtime_state_invalid_max_hook_age")
    return profile, logs, age


def millis(value):
    require(type(value) in (int, float) and math.isfinite(value) and value > 0,
            "runtime_state_invalid_timestamp")
    return value / 1000


def observe(native, options, now):
    profile, logs, age = configuration(options)
    require(native.environment is None, "runtime_state_remote_route_unsupported")
    native.verify_runtime()
    status = native.read("status")
    require(status.get("target", {}).get("kind") == "local" and
            status.get("app", {}).get("running") is True, "runtime_state_requires_local_runtime")
    # Whitelist discovery metadata; authToken/transports must never enter receipts.
    discovery = read_state(profile / "orca-runtime.json")
    runtime = {k: discovery.get(k) for k in ("runtimeId", "pid", "startedAt")}
    require(runtime["runtimeId"] == native.runtime_id and type(runtime["pid"]) is int and
            runtime["pid"] > 0 and runtime["pid"] == status["app"].get("pid"),
            "runtime_state_runtime_mismatch")
    started = millis(runtime["startedAt"])
    require(started <= now, "runtime_state_future_runtime")
    row = native.read("terminal", "show", "--terminal", options["terminal_handle"])["terminal"]
    require(row.get("handle") == options["terminal_handle"] and row.get("worktreeId") == options["worktree_id"] and
            row.get("executionHostId") == "local" and row.get("agentIdentity") == options["provider"] and
            row.get("connected") is True and row.get("orphaned") is False,
            "runtime_state_terminal_unverifiable")
    terminal = {k: identifier(row.get(k)) for k in TERMINAL_FIELDS}
    pane = terminal["tabId"] + ":" + terminal["leafId"]
    hooks = read_state(profile / "agent-hooks" / "last-status.json")
    require(type(hooks.get("version")) is int and hooks["version"] == 2 and isinstance(hooks.get("entries"), dict),
            "runtime_state_unsupported_hook_schema")
    entry = hooks["entries"].get(pane)
    require(isinstance(entry, dict), "runtime_state_missing_pane")
    require(entry.get("worktreeId") == terminal["worktreeId"] and entry.get("tabId") == terminal["tabId"] and
            entry.get("source") == options["provider"] and entry.get("payload", {}).get("agentType") == options["provider"] and
            not entry.get("structuredHost") and not entry.get("restoredUnconfirmed") and not entry.get("isReplay"),
            "runtime_state_hook_identity_mismatch")
    if options["provider"] == "trae":
        launch_hash = entry.get("launchTokenHash")
        require(isinstance(launch_hash, str) and re.fullmatch(r"[0-9a-f]{64}", launch_hash),
                "runtime_state_invalid_launch_commitment")
        require(entry.get("connectionId") is None and not entry.get("providerSessionOnly") and
                not entry.get("toolAgentId"), "runtime_state_trae_hook_unverifiable")
    received, observed = millis(entry.get("receivedAt")), millis(entry.get("evidenceObservedAt"))
    require(started <= observed <= received <= now + 5 and now - observed <= age,
            "runtime_state_stale_or_future_hook")
    provider = entry.get("providerSession")
    require(isinstance(provider, dict) and provider.get("key") == "session_id", "runtime_state_missing_session")
    session = identifier(provider.get("id"))
    transcript = canonical(provider.get("transcriptPath"))
    require(transcript.is_relative_to(logs) and transcript.suffix == ".jsonl", "runtime_state_log_outside_root")
    identity = {"runtime": runtime, "terminal": terminal, "session_id": session,
                "transcript_path": str(transcript), "host": options["host"], "uid": os.getuid(),
                "profile": str(profile), "log_root": str(logs)}
    if options["provider"] == "trae":
        identity["launch_token_hash"] = launch_hash
    return identity, {"received_at_ms": entry["receivedAt"], "evidence_observed_at_ms": entry["evidenceObservedAt"]}


def capture(native, options, *, clock, previous=None, since=None, until=None, scope=None):
    began = clock()
    identity, hook = observe(native, options, began)
    if previous:
        require(previous["identity"] == identity, "runtime_state_session_or_incarnation_changed")
        require(hook["evidence_observed_at_ms"] >= previous["hook"]["evidence_observed_at_ms"] and
                hook["received_at_ms"] >= previous["hook"]["received_at_ms"], "runtime_state_hook_regressed")
    start, end = timestamp(since), timestamp(until)
    require((start is None) == (end is None), "runtime_state_invalid_window")
    if start is not None:
        require(seconds(start) < seconds(end) <= began, "runtime_state_invalid_window")
    path = Path(identity["transcript_path"])
    with ordinary_file(path) as (source, info):
        content = source.read(info.st_size)
        require(len(content) == info.st_size, "runtime_state_log_truncated")
        newline = content.find(b"\n")
        require(newline >= 0, "runtime_state_incomplete_session_meta")
        first = content[:newline]
        meta = json.loads(first)
        require(isinstance(meta, dict) and meta.get("type") == "session_meta" and
                isinstance(meta.get("payload"), dict) and meta["payload"].get("id") == identity["session_id"],
                "runtime_state_root_session_mismatch")
        if options["provider"] == "trae":
            runtime_trae.validate_meta(meta["payload"])
        else:
            require(meta["payload"].get("source") == "cli", "runtime_state_root_session_mismatch")
        file_identity = {"device": info.st_dev, "inode": info.st_ino}
        prefix = {"bytes": len(content), "sha256": hashlib.sha256(content).hexdigest()}
        if previous:
            require(previous["file_identity"] == file_identity, "runtime_state_log_replaced")
            old = previous["prefix"]
            require(len(content) >= old["bytes"] and hashlib.sha256(content[:old["bytes"]]).hexdigest() == old["sha256"],
                    "runtime_state_log_history_changed")
        sample = None
        if start:
            # Stable metadata anchor identifies the binding; the full prefix still pins every read byte.
            metadata_prefix = {"bytes": len(first) + 1,
                               "sha256": hashlib.sha256(content[:len(first) + 1]).hexdigest()}
            sample = (runtime_trae.sample(content, identity, meta["payload"], metadata_prefix, scope, start, end)
                      if options["provider"] == "trae" else
                      scan(None, identity["session_id"], start, end, source=io.BytesIO(content)))
        if sample is not None:
            sample.update(complete=False,
                          warnings=sorted(set(sample["warnings"]) | {"runtime_state_not_process_attested"}))
        source.seek(0)
        require(hashlib.sha256(source.read(len(content))).hexdigest() == prefix["sha256"],
                "runtime_state_log_changed_during_capture")
        current = path.stat()
        require((current.st_dev, current.st_ino) == (info.st_dev, info.st_ino) and path.resolve() == path,
                "runtime_state_log_replaced")
    after, after_hook = observe(native, options, clock())
    require(identity == after, "runtime_state_identity_changed_during_capture")
    require(after_hook["evidence_observed_at_ms"] >= hook["evidence_observed_at_ms"] and
            after_hook["received_at_ms"] >= hook["received_at_ms"], "runtime_state_hook_regressed")
    require(0 <= clock() - began < 50, "runtime_state_capture_too_slow")
    return {"identity": identity, "hook": after_hook, "prefix": prefix, "file_identity": file_identity,
            "observed_at": began, "sample": sample,
            "trust": "runtime-state-not-process-attested", "schema": "orca-runtime-binding-v1"}


def native_scope(ledger, native, options, scope):
    """Recheck the Run/Dispatch relation, never infer it from a pane or cwd."""
    require(scope["runtime_id"] == native.runtime_id, "runtime_state_scope_runtime_mismatch")
    if scope["run_id"] is None:
        return None
    rid, aid = scope["run_id"], scope["agent_id"]
    data = ledger.get(native.runtime_id, rid)
    actor = data["agents"][aid]
    run = native.read("orchestration", "run-show", "--id", rid)["run"]
    require(run.get("id") == rid and not run.get("legacy") and
            timestamp(run.get("created_at"), native=True) == data["started_at"],
            "runtime_state_native_run_mismatch")
    observed = {"run_id": rid, "run_started_at": data["started_at"]}
    if aid == "coordinator":
        handle = run.get("coordinator_handle")
        require(handle == data["coordinator_handle"], "runtime_state_native_actor_mismatch")
    else:
        receipt = native.read("orchestration", "worker-show", "--dispatch", aid)
        dispatch, worker = receipt["dispatch"], receipt["worker"]
        require(dispatch.get("id") == aid and dispatch.get("runId") == rid and
                worker.get("dispatchId") == aid and dispatch.get("hostScope") in ("local", runtime_trae.LOCAL_HOST) and
                dispatch.get("hostScope") == actor.get("host"),
                "runtime_state_native_dispatch_mismatch")
        launch = ((worker.get("startOptions") or {}).get("launch") or {}).get("effective") or {}
        require(launch.get("agent") == options["provider"] and actor.get("provider") == options["provider"],
                "runtime_state_native_provider_mismatch")
        handle = (receipt.get("terminal") or {}).get("handle")
        resource_handle = (receipt.get("terminalResource") or {}).get("terminalHandle")
        require(not handle or not resource_handle or handle == resource_handle,
                "runtime_state_native_terminal_conflict")
        handle = handle or resource_handle
        start, end = (timestamp(dispatch.get(k), native=True) for k in ("dispatchedAt", "completedAt"))
        require(handle == actor.get("terminal_handle") and dispatch.get("taskId") == actor["task_id"] and
                start == actor["started_at"] and end == actor["ended_at"], "runtime_state_native_actor_mismatch")
        observed.update(dispatch_id=aid, task_id=actor["task_id"], started_at=start, ended_at=end,
                        provider=options["provider"], host=actor["host"])
        if options["provider"] == "trae":
            require(actor["host"] == runtime_trae.LOCAL_HOST, "runtime_state_trae_native_host_required")
            observed["provider_session"] = receipt.get("providerSession")
    require(handle == options["terminal_handle"], "runtime_state_native_actor_mismatch")
    observed["terminal_handle"] = handle
    return observed


def collect(ledger, native, options, scope, *, since=None, until=None):
    configuration(options)
    require(ledger.store.db.in_transaction, "runtime_state_transaction_required")
    relation = native_scope(ledger, native, options, scope)
    key = "runtime-state-target:" + digest([native.runtime_id, options["terminal_handle"]])
    evidence = capture(native, options, clock=ledger.store.clock, previous=ledger.store.get(key),
                       since=since, until=until, scope=scope)
    require(relation == native_scope(ledger, native, options, scope), "runtime_state_scope_changed_during_capture")
    if relation is not None and options["provider"] == "trae":
        require(scope["agent_id"] != "coordinator", "runtime_state_trae_requires_worker_dispatch")
        runtime_trae.check_exact_session(relation, evidence)
    evidence["scope"] = scope
    evidence["native_scope"] = relation
    receipt_id = digest(evidence)
    ledger.store.put(key, {k: evidence[k] for k in ("identity", "hook", "prefix", "file_identity")})
    ledger.store.put("runtime-state-receipt:" + receipt_id, evidence)
    return evidence, "runtime-state:sha256:" + receipt_id


def preflight(ledger, native, options):
    with ledger.transaction():
        evidence, source = collect(ledger, native, options,
                                  {"runtime_id": native.runtime_id, "run_id": None, "agent_id": None})
    return {"source": source, "evidence": evidence, "usage_imported": False, "lifecycle_verified": False}


def ledger_sample(ledger, native, runtime, run, options):
    configuration(options)
    data = ledger.get(runtime, run)
    actor = data["agents"][options["agent_id"]]
    terminal = data["coordinator_handle"] if options["agent_id"] == "coordinator" else actor["terminal_handle"]
    require(terminal and terminal == options.get("terminal_handle") and actor.get("provider") in (None, options["provider"]),
            "runtime_state_native_actor_mismatch")
    if options["agent_id"] != "coordinator":
        require(actor.get("host") in ("local", runtime_trae.LOCAL_HOST), "runtime_state_remote_worker_unsupported")
    since = timestamp(options["since"])
    require(since and seconds(since) >= seconds(actor.get("started_at") or data["started_at"]),
            "runtime_state_window_before_actor")
    until = timestamp(options.get("until") or ledger.now())
    require(not actor.get("ended_at") or seconds(until) <= seconds(actor["ended_at"]),
            "runtime_state_window_after_actor")
    evidence, source = collect(ledger, native, options,
                              {"runtime_id": runtime, "run_id": run, "agent_id": options["agent_id"]},
                              since=since, until=until)
    sample = dict(evidence["sample"])
    # Raw Trae imports are keyed by the captured bytes; the receipt retains their runtime binding.
    if options["provider"] == "codex":
        sample["source"] = source
    return sample

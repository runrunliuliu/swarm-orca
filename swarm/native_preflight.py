"""Read-only native Swarm preflight with compact, sanitized receipts."""

from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from datetime import datetime, timedelta, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import re
import selectors
import stat
import subprocess
import threading
import time

from evidence_policy import age_limit, validate_v2, verify_probe
from log_io import prefix_lines


SAFE_NAME = re.compile(r"^[A-Za-z0-9_.-]{1,32}$")
NATIVE_ERROR_CODES = frozenset({
    "runtime_access_denied", "permission_denied", "runtime_unavailable",
    "terminal_handle_stale", "terminal_not_found", "worktree_not_found",
    "run_not_found", "runtime_error", "timeout",
})


class PreflightError(ValueError):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def _require(condition, code):
    if not condition:
        raise PreflightError(code)


def _digest(data):
    return hashlib.sha256(data).hexdigest()


def _json_digest(value):
    return _digest(json.dumps(value, sort_keys=True, separators=(",", ":")).encode())


def _read_bytes(path):
    path = Path(path)
    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as source:
        info = os.fstat(source.fileno())
        _require(stat.S_ISREG(info.st_mode), "input_not_regular_file")
        data = source.read(info.st_size)
        _require(len(data) == info.st_size, "input_truncated")
    return data


def read_json(path):
    try:
        value = json.loads(_read_bytes(path))
    except PermissionError as error:
        raise PreflightError("input_access_denied") from error
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, RecursionError) as error:
        raise PreflightError("invalid_json_input") from error
    _require(isinstance(value, dict), "json_object_required")
    return value


def _canonical_directory(value):
    path = Path(value)
    _require(path.is_absolute(), "absolute_directory_required")
    try:
        resolved = path.resolve(strict=True)
    except OSError as error:
        raise PreflightError("directory_unavailable") from error
    _require(resolved.is_dir() and resolved != Path(resolved.anchor), "task_directory_required")
    stat = resolved.stat()
    return resolved, {"path": str(resolved), "device": stat.st_dev, "inode": stat.st_ino}


def _parse_time(value):
    _require(isinstance(value, str) and value, "timestamp_required")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise PreflightError("invalid_timestamp") from error
    _require(parsed.tzinfo is not None, "timezone_required")
    return parsed.astimezone(timezone.utc)


def _safe_id(value, prefix):
    _require(isinstance(value, str) and value.startswith(prefix) and len(value) <= 256,
             "invalid_explicit_id")
    _require(all(32 <= ord(char) < 127 for char in value), "invalid_explicit_id")
    return value


def _path_input(value):
    _require(isinstance(value, str) and 0 < len(value) <= 4096
             and not any(ord(char) < 32 for char in value), "invalid_path")
    path = Path(value)
    _require(path.is_absolute(), "absolute_path_required")
    _require(not any(path == root or path.is_relative_to(root)
                     for root in map(Path, ("/proc", "/sys", "/dev"))),
             "special_filesystem_forbidden")
    return path


def validate_contract(contract):
    _require(isinstance(contract, dict), "contract_object_required")
    _require(type(contract.get("schema_version")) is int
             and contract["schema_version"] in (1, 2), "unsupported_contract_schema")
    allowed = {
        "schema_version", "cli", "runtime_id", "runtime_version", "run_id", "workspace",
        "terminal", "session", "paths", "baselines", "policy_files", "config_files", "evidence",
        "limits", "milestones", "runtime_state",
    }
    if contract["schema_version"] == 2:
        allowed |= {"adapter", "freshness", "preparation", "probe_roots"}
    _require(set(contract) == allowed, "invalid_contract_fields")
    cli = _path_input(contract["cli"])
    _require(cli.is_absolute() and cli.is_file(), "cli_unavailable")
    _require(isinstance(contract["runtime_id"], str) and contract["runtime_id"]
             and len(contract["runtime_id"]) <= 256, "invalid_runtime_id")
    _require(isinstance(contract["runtime_version"], str) and contract["runtime_version"],
             "runtime_version_required")
    _safe_id(contract["run_id"], "run_")
    workspace = contract["workspace"]
    terminal = contract["terminal"]
    session = contract["session"]
    _require(isinstance(workspace, dict), "invalid_workspace_contract")
    _require(isinstance(terminal, dict), "invalid_terminal_contract")
    _require(isinstance(session, dict), "invalid_session_contract")
    _require(set(workspace) == {"id", "path"}, "invalid_workspace_contract")
    _require(set(terminal) == {"handle", "incarnation_id", "agent"}, "invalid_terminal_contract")
    _require(isinstance(workspace["id"], str) and "::/" in workspace["id"]
             and len(workspace["id"]) <= 4096, "invalid_workspace_id")
    _path_input(workspace["path"])
    _safe_id(terminal["handle"], "term_")
    _require(isinstance(terminal["incarnation_id"], str) and terminal["incarnation_id"],
             "incarnation_required")
    if contract["schema_version"] == 2:
        validate_v2(contract, _require)
        for root in contract["probe_roots"]:
            _path_input(root)
    else:
        _require(terminal["agent"] == "codex", "unsupported_terminal_agent")
    _require(set(session) == {"id", "provider", "model", "effort", "sandbox_mode",
                             "approval_policy"}, "invalid_session_contract")
    _require(isinstance(session["id"], str) and session["id"], "session_id_required")
    _require(session["provider"] == terminal["agent"], "session_provider_changed")
    for key in ("model", "effort", "sandbox_mode", "approval_policy"):
        _require(isinstance(session[key], str) and session[key], "invalid_session_setting")
    _require(isinstance(contract["paths"], dict)
             and set(contract["paths"]) == {"cwd", "archive_dir"}, "invalid_path_contract")
    for value in contract["paths"].values():
        _path_input(value)
    runtime_state = contract["runtime_state"]
    _require(isinstance(runtime_state, dict) and set(runtime_state) == {"profile", "log_root"},
             "invalid_runtime_state_contract")
    for value in runtime_state.values():
        _path_input(value)
    for key in ("baselines", "policy_files", "config_files"):
        _require(isinstance(contract[key], list) and 1 <= len(contract[key]) <= 32,
                 "invalid_bounded_inputs")
    for value in contract["policy_files"] + contract["config_files"]:
        _path_input(value)
    names = set()
    for baseline in contract["baselines"]:
        _require(isinstance(baseline, dict), "invalid_baseline")
        _require(set(baseline) == {"name", "path", "head", "clean"}, "invalid_baseline")
        _require(isinstance(baseline["name"], str) and SAFE_NAME.fullmatch(baseline["name"]),
                 "invalid_baseline_name")
        _require(baseline["name"] not in names, "duplicate_baseline_name")
        names.add(baseline["name"])
        _path_input(baseline["path"])
        _require(isinstance(baseline["head"], str)
                 and re.fullmatch(r"[0-9a-f]{40,64}", baseline["head"]) is not None,
                 "invalid_baseline_head")
        _require(type(baseline["clean"]) is bool, "invalid_baseline_clean")
    evidence = contract["evidence"]
    _require(isinstance(evidence, dict), "invalid_evidence_contract")
    _require(set(evidence) == {"session", "file_tool"}, "invalid_evidence_contract")
    for value in evidence.values():
        _path_input(value)
    limits = contract["limits"]
    _require(isinstance(limits, dict), "invalid_limit_fields")
    limit_fields = {"per_check_timeout_ms", "max_parallel"}
    if contract["schema_version"] == 1:
        limit_fields.add("evidence_max_age_seconds")
    _require(set(limits) == limit_fields,
             "invalid_limit_fields")
    _require(type(limits["per_check_timeout_ms"]) is int
             and 500 <= limits["per_check_timeout_ms"] <= 30_000, "invalid_check_timeout")
    _require(type(limits["max_parallel"]) is int and 1 <= limits["max_parallel"] <= 8,
             "invalid_parallel_limit")
    if contract["schema_version"] == 1:
        _require(type(limits["evidence_max_age_seconds"]) is int
                 and 1 <= limits["evidence_max_age_seconds"] <= 900, "invalid_evidence_age")
    milestones = contract["milestones"]
    _require(isinstance(milestones, dict), "invalid_milestones")
    _require(set(milestones) == {"run_created_at", "coordinator_turn_started_at"},
             "invalid_milestones")
    _parse_time(milestones["run_created_at"])
    _parse_time(milestones["coordinator_turn_started_at"])
    return contract


def _default_runner(argv, timeout):
    """Drain both pipes incrementally under the caller's time deadline."""
    deadline = time.monotonic() + timeout
    with subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE) as child:
        output = {child.stdout: bytearray(), child.stderr: bytearray()}
        selector = selectors.DefaultSelector()
        try:
            for stream in output:
                os.set_blocking(stream.fileno(), False)
                selector.register(stream, selectors.EVENT_READ)
            while selector.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise subprocess.TimeoutExpired(argv, timeout)
                for key, _ in selector.select(remaining):
                    stream = key.fileobj
                    chunk = os.read(stream.fileno(), 65536)
                    if not chunk:
                        selector.unregister(stream)
                    else:
                        output[stream].extend(chunk)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise subprocess.TimeoutExpired(argv, timeout)
            child.wait(timeout=remaining)
            return subprocess.CompletedProcess(argv, child.returncode,
                                               bytes(output[child.stdout]),
                                               bytes(output[child.stderr]))
        finally:
            selector.close()
            if child.poll() is None:
                child.kill()
                child.wait()


def _native_json(cli, args, timeout, runner, runtime_id):
    try:
        completed = runner([cli, *args, "--json"], timeout)
    except subprocess.TimeoutExpired as error:
        raise PreflightError("native_timeout") from error
    except PermissionError as error:
        raise PreflightError("native_execution_denied") from error
    except OSError as error:
        raise PreflightError("native_unavailable") from error
    stdout = completed.stdout.encode() if isinstance(completed.stdout, str) else completed.stdout
    stdout = stdout or b""
    try:
        payload = json.loads(stdout)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise PreflightError("native_invalid_json") from error
    _require(isinstance(payload, dict), "native_invalid_json")
    if completed.returncode != 0 or payload.get("ok") is not True:
        error = payload.get("error") if isinstance(payload.get("error"), dict) else {}
        code = error.get("code")
        safe = code if isinstance(code, str) and code in NATIVE_ERROR_CODES else "failed"
        raise PreflightError("native_" + safe)
    meta = payload.get("_meta")
    _require(isinstance(meta, dict) and meta.get("runtimeId") == runtime_id,
             "native_runtime_identity_changed")
    return payload


def _runtime_check(contract, timeout, runner):
    value = _native_json(contract["cli"], ["status"], timeout, runner, contract["runtime_id"])
    result = value.get("result")
    _require(isinstance(result, dict), "malformed_runtime_response")
    runtime = result.get("runtime")
    _require(isinstance(runtime, dict), "malformed_runtime_response")
    _require(runtime.get("runtimeId") == contract["runtime_id"], "stale_runtime_identity")
    _require(runtime.get("appVersion") == contract["runtime_version"], "runtime_version_changed")
    _require(runtime.get("state") == "ready" and runtime.get("reachable") is True,
             "runtime_not_ready")
    app = result.get("app")
    target = result.get("target")
    _require(isinstance(app, dict) and app.get("running") is True
             and isinstance(target, dict) and target.get("kind") == "local",
             "runtime_state_requires_local_runtime")
    discovery = read_json(Path(contract["runtime_state"]["profile"]) / "orca-runtime.json")
    _require(discovery.get("runtimeId") == contract["runtime_id"]
             and type(discovery.get("pid")) is int and discovery["pid"] > 0
             and discovery["pid"] == app.get("pid"), "runtime_state_profile_changed")
    return {"runtime_id": runtime["runtimeId"], "version": runtime["appVersion"]}


def _workspace_check(contract, timeout, runner):
    expected = contract["workspace"]
    value = _native_json(contract["cli"],
                         ["worktree", "show", "--worktree", "id:" + expected["id"]],
                         timeout, runner, contract["runtime_id"])
    result = value.get("result")
    _require(isinstance(result, dict), "malformed_workspace_response")
    actual = result.get("worktree")
    _require(isinstance(actual, dict), "malformed_workspace_response")
    _require(actual.get("id") == expected["id"], "stale_workspace_identity")
    _require(isinstance(actual.get("path"), str), "malformed_workspace_response")
    _require(Path(actual.get("path", "")).resolve() == Path(expected["path"]).resolve(),
             "workspace_path_changed")
    _require(actual.get("isArchived") is not True, "workspace_archived")
    return {"workspace_id": actual["id"]}


def _terminal_check(contract, timeout, runner, now, checkpoint):
    expected = contract["terminal"]
    value = _native_json(contract["cli"],
                         ["terminal", "show", "--terminal", expected["handle"]], timeout, runner,
                         contract["runtime_id"])
    result = value.get("result")
    _require(isinstance(result, dict), "malformed_terminal_response")
    actual = result.get("terminal")
    _require(isinstance(actual, dict), "malformed_terminal_response")
    _require(actual.get("handle") == expected["handle"], "stale_terminal_identity")
    _require(actual.get("incarnationId") == expected["incarnation_id"],
             "stale_terminal_incarnation")
    _require(actual.get("worktreeId") == contract["workspace"]["id"],
             "terminal_workspace_changed")
    _require(actual.get("agentIdentity") == expected["agent"], "terminal_agent_changed")
    _require(actual.get("connected") is True and actual.get("orphaned") is False,
             "terminal_not_live")
    session = _current_session_check(contract, actual, now, checkpoint)
    return {"terminal_handle": actual["handle"], "incarnation_id": actual["incarnationId"],
            **session}


def _current_session_check(contract, terminal, now, checkpoint):
    """Fresh local Codex pane mapping and bounded, exact-log settings read."""
    _require(terminal.get("executionHostId") == "local"
             and all(isinstance(terminal.get(key), str) and terminal[key]
                     for key in ("tabId", "leafId")), "session_pane_unavailable")
    hooks = read_json(Path(contract["runtime_state"]["profile"])
                      / "agent-hooks" / "last-status.json")
    entries = hooks.get("entries")
    _require(hooks.get("version") == 2 and isinstance(entries, dict),
             "invalid_session_mapping")
    entry = entries.get(terminal["tabId"] + ":" + terminal["leafId"])
    _require(isinstance(entry, dict), "current_session_unavailable")
    payload = entry.get("payload")
    _require(entry.get("worktreeId") == contract["workspace"]["id"]
             and entry.get("tabId") == terminal["tabId"] and entry.get("source") == "codex"
             and isinstance(payload, dict) and payload.get("agentType") == "codex"
             and not any(entry.get(key) for key in
                         ("structuredHost", "restoredUnconfirmed", "isReplay")),
             "current_session_mapping_changed")
    observed, received = entry.get("evidenceObservedAt"), entry.get("receivedAt")
    _require(all(type(value) in (int, float) and math.isfinite(value) and value > 0
                 for value in (observed, received)), "invalid_session_mapping_time")
    _require(observed <= received <= now.timestamp() * 1000 + 5000
             and now.timestamp() - observed / 1000
             <= age_limit(contract, "session"), "stale_session_mapping")
    provider = entry.get("providerSession")
    expected = contract["session"]
    _require(isinstance(provider, dict) and provider.get("key") == "session_id"
             and provider.get("id") == expected["id"], "current_session_identity_changed")
    path = _path_input(provider.get("transcriptPath"))
    root = Path(contract["runtime_state"]["log_root"])
    _require(path.resolve(strict=True) == path and path.is_relative_to(root)
             and path.suffix == ".jsonl", "current_session_log_outside_root")
    checkpoint()
    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as source:
        info = os.fstat(source.fileno())
        _require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid(),
                 "current_session_log_unavailable")
        first = source.readline(info.st_size)
        _require(first.endswith(b"\n"),
                 "current_session_metadata_unavailable")
        meta = json.loads(first)
        _require(isinstance(meta, dict) and meta.get("type") == "session_meta"
                 and isinstance(meta.get("payload"), dict)
                 and meta["payload"].get("id") == expected["id"]
                 and meta["payload"].get("source") == "cli"
                 and meta["payload"].get("cwd") == contract["paths"]["cwd"],
                 "current_session_metadata_changed")
        # Scan the initial EOF, retaining only the latest complete context. A
        # busy turn can put valid settings arbitrarily far behind the log tail.
        context = None
        for line in prefix_lines(source, info.st_size - len(first)):
            checkpoint()
            if not line.endswith(b"\n"):
                continue
            value = json.loads(line)
            _require(isinstance(value, dict), "invalid_session_log_record")
            if value.get("type") == "turn_context":
                context = value.get("payload")
    _require(isinstance(context, dict), "current_session_settings_unavailable")
    sandbox = context.get("sandbox_policy")
    _require(isinstance(sandbox, dict)
             and sandbox.get("type") == expected["sandbox_mode"]
             and context.get("model") == expected["model"]
             and context.get("effort") == expected["effort"]
             and context.get("approval_policy") == expected["approval_policy"]
             and context.get("cwd") == contract["paths"]["cwd"],
             "current_session_settings_changed")
    return {"session_id": expected["id"],
            "observed_at": datetime.fromtimestamp(observed / 1000, timezone.utc).isoformat(),
            "session_context_sha256": _json_digest({
                key: context.get(key) for key in
                ("cwd", "model", "effort", "approval_policy", "sandbox_policy")})}


def _lifecycle_check(contract, timeout, runner):
    value = _native_json(
        contract["cli"],
        ["orchestration", "run-current", "--from", contract["terminal"]["handle"]],
        timeout, runner, contract["runtime_id"],
    )
    result = value.get("result")
    _require(isinstance(result, dict), "malformed_lifecycle_response")
    run = result.get("run")
    _require(isinstance(run, dict) and run.get("id") == contract["run_id"],
             "stale_lifecycle_identity")
    return {"run_id": run["id"]}


def _file_fingerprint(path, parse_json=False):
    data = _read_bytes(path)
    if parse_json:
        try:
            value = json.loads(data)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise PreflightError("invalid_config_json") from error
        _require(isinstance(value, dict), "invalid_config_json")
    resolved = Path(path).resolve(strict=True)
    return {"path": str(resolved), "sha256": _digest(data), "bytes": len(data)}


def _baseline_check(item, timeout, runner):
    repo, identity = _canonical_directory(item["path"])
    prefix = ["git", "--no-optional-locks", "-C", str(repo)]
    try:
        head = runner([*prefix, "rev-parse", "HEAD"], timeout)
        _require(head.returncode == 0, "baseline_unreadable")
        diff = runner([*prefix, "diff", "--no-ext-diff", "--no-textconv", "--binary",
                       "HEAD", "--"], timeout)
        _require(diff.returncode == 0, "baseline_unreadable")
        index = runner([*prefix, "diff", "--cached", "--no-ext-diff", "--no-textconv",
                        "--binary", "HEAD", "--"], timeout)
        _require(index.returncode == 0, "baseline_unreadable")
        untracked = runner([*prefix, "ls-files", "--others", "--exclude-standard", "-z"], timeout)
    except subprocess.TimeoutExpired as error:
        raise PreflightError("baseline_timeout") from error
    _require(head.returncode == 0 and diff.returncode == 0 and index.returncode == 0
             and untracked.returncode == 0,
             "baseline_unreadable")
    head_out = head.stdout.decode() if isinstance(head.stdout, bytes) else head.stdout
    diff_out = diff.stdout.encode() if isinstance(diff.stdout, str) else diff.stdout
    index_out = index.stdout.encode() if isinstance(index.stdout, str) else index.stdout
    untracked_out = (untracked.stdout.encode() if isinstance(untracked.stdout, str)
                     else untracked.stdout)
    actual_head = (head_out or "").strip()
    diff_out = diff_out or b""
    index_out = index_out or b""
    untracked_out = untracked_out or b""
    untracked_fingerprints = []
    for raw_name in filter(None, untracked_out.split(b"\0")):
        try:
            relative = Path(raw_name.decode(errors="strict"))
        except UnicodeDecodeError as error:
            raise PreflightError("invalid_untracked_path") from error
        _require(not relative.is_absolute() and ".." not in relative.parts,
                 "invalid_untracked_path")
        candidate = repo / relative
        data = _read_bytes(candidate)
        resolved = candidate.resolve(strict=True)
        _require(resolved.is_relative_to(repo), "untracked_path_escape")
        untracked_fingerprints.append({"path": _digest(raw_name), "content": _digest(data)})
    clean = not diff_out and not index_out and not untracked_fingerprints
    _require(actual_head == item["head"], "baseline_head_changed")
    _require(clean is item["clean"], "baseline_cleanliness_changed")
    return {**identity, "head": actual_head, "clean": clean,
            "tracked_diff_sha256": _digest(diff_out),
            "index_diff_sha256": _digest(index_out),
            "untracked_sha256": _json_digest(untracked_fingerprints)}


def _evidence_check(kind, path, contract, now):
    raw = _read_bytes(path)
    try:
        value = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise PreflightError("invalid_evidence_json") from error
    _require(isinstance(value, dict), "invalid_evidence_json")
    timestamp_key = "observed_at" if kind == "session" else "completed_at"
    observed = _parse_time(value.get(timestamp_key))
    age = (now - observed).total_seconds()
    limit = age_limit(contract, kind)
    # A future timestamp is not an ordinary expired receipt and cannot authorize refresh.
    _require(age >= -5, "future_" + kind + "_evidence")
    if kind == "session":
        handle = value.get("coordinator_handle", value.get("terminal_handle"))
        incarnation = value.get("incarnation_id", value.get("incarnation"))
        _require(value.get("runtime_id") == contract["runtime_id"], "session_runtime_changed")
        _require(value.get("run_id", value.get("run")) == contract["run_id"],
                 "session_run_changed")
        _require(handle == contract["terminal"]["handle"], "session_terminal_changed")
        _require(incarnation == contract["terminal"]["incarnation_id"],
                 "session_incarnation_changed")
        _require(value.get("trust") == "runtime-state-not-process-attested",
                 "unsupported_session_evidence")
        _require(value.get("session_id") == contract["session"]["id"],
                 "session_identity_changed")
        effective = value.get("effective")
        _require(isinstance(effective, dict), "session_settings_missing")
        sandbox = effective.get("sandbox_policy")
        sandbox = sandbox.get("type") if isinstance(sandbox, dict) else effective.get("sandbox_mode")
        expected = contract["session"]
        _require(effective.get("provider") == expected["provider"]
                 and effective.get("model") == expected["model"]
                 and effective.get("effort") == expected["effort"]
                 and sandbox == expected["sandbox_mode"]
                 and effective.get("approval_policy") == expected["approval_policy"],
                 "session_settings_changed")
    else:
        _require(value.get("passed") is True and value.get("batch_count") == 1,
                 "file_tool_probe_not_single_batch")
        roots = value.get("roots")
        tools = value.get("actual_tools")
        _require(isinstance(roots, list) and contract["paths"]["archive_dir"] in roots,
                 "file_tool_scope_changed")
        _require(isinstance(tools, list)
                 and all(isinstance(item, str) for item in tools)
                 and any("apply_patch" in item for item in tools)
                 and any("read" in item for item in tools)
                 and any("rename" in item for item in tools), "file_tool_probe_incomplete")
        explicit_identity = (
            value.get("runtime_id") == contract["runtime_id"]
            and value.get("run_id") == contract["run_id"]
            and value.get("terminal_handle") == contract["terminal"]["handle"]
            and value.get("incarnation_id") == contract["terminal"]["incarnation_id"]
            and value.get("session_id") == contract["session"]["id"]
        )
        session_hash = value.get("session_evidence_sha256")
        hash_identity = isinstance(session_hash, str) and re.fullmatch(r"[0-9a-f]{64}", session_hash)
        _require(explicit_identity or hash_identity, "file_tool_identity_unbound")
        if contract["schema_version"] == 2:
            _require(explicit_identity, "file_tool_identity_unbound")
            _require(isinstance(value.get("session_context_sha256"), str)
                     and re.fullmatch(r"[0-9a-f]{64}", value["session_context_sha256"]),
                     "file_tool_session_context_missing")
            verify_probe(value, contract, _read_bytes, _require)
    # Validate identity/proof before classifying a receipt as merely expired.
    _require(limit is None or age <= limit, "stale_" + kind + "_evidence")
    result = {"observed_at": observed.isoformat().replace("+00:00", "Z"),
              "sha256": _digest(raw)}
    if kind == "file_tool" and value.get("session_evidence_sha256") is not None:
        result["session_evidence_sha256"] = value["session_evidence_sha256"]
    if kind == "file_tool" and contract["schema_version"] == 2:
        result["session_context_sha256"] = value["session_context_sha256"]
    return result


def _error_receipt(code):
    return {"schema_version": 1, "kind": "native_adaptive_preflight", "ok": False,
            "decision": "stop", "errors": [{"check": "contract", "code": code}]}


def run_preflight(contract, *, reuse_receipt=None, runner=_default_runner, now=None,
                  monotonic=time.monotonic):
    contract = validate_contract(contract)
    now = now or datetime.now(timezone.utc)
    _require(now.tzinfo is not None, "timezone_required")
    now = now.astimezone(timezone.utc)
    started_mono = monotonic()
    started_at = now.isoformat().replace("+00:00", "Z")
    timeout = contract["limits"]["per_check_timeout_ms"] / 1000

    stable = {}
    volatile = {}
    errors = []
    cwd, stable["path.cwd"] = _canonical_directory(contract["paths"]["cwd"])
    archive, stable["path.archive_dir"] = _canonical_directory(contract["paths"]["archive_dir"])
    _require(cwd == Path(contract["workspace"]["path"]).resolve(), "cwd_workspace_mismatch")
    contract = dict(contract)
    contract["workspace"] = dict(contract["workspace"], path=str(cwd))
    contract["paths"] = {"cwd": str(cwd), "archive_dir": str(archive)}
    contract["runtime_state"] = dict(contract["runtime_state"])
    for key, path in contract["runtime_state"].items():
        resolved, stable["path.runtime_state." + key] = _canonical_directory(path)
        contract["runtime_state"][key] = str(resolved)

    tasks = {
        "volatile.runtime": lambda execute, check: _runtime_check(contract, timeout, execute),
        "volatile.workspace": lambda execute, check: _workspace_check(contract, timeout, execute),
        "volatile.terminal": lambda execute, check: _terminal_check(
            contract, timeout, execute, now, check),
        "volatile.lifecycle": lambda execute, check: _lifecycle_check(contract, timeout, execute),
        "volatile.session_evidence": lambda execute, check: _evidence_check(
            "session", contract["evidence"]["session"], contract, now),
        "volatile.file_tool_evidence": lambda execute, check: _evidence_check(
            "file_tool", contract["evidence"]["file_tool"], contract, now),
        "stable.cli": lambda execute, check: _file_fingerprint(contract["cli"]),
    }
    for index, path in enumerate(contract["policy_files"]):
        tasks[f"stable.policy.{index}"] = lambda execute, check, path=path: _file_fingerprint(path)
    for index, path in enumerate(contract["config_files"]):
        tasks[f"stable.config.{index}"] = (
            lambda execute, check, path=path: _file_fingerprint(path, parse_json=True))
    for item in contract["baselines"]:
        tasks["stable.baseline." + item["name"]] = (
            lambda execute, check, item=item: _baseline_check(item, timeout, execute))

    stopped = threading.Event()

    def checked(function):
        # One shared budget for the whole check, including sequential Git calls.
        deadline = time.monotonic() + timeout

        def checkpoint():
            _require(not stopped.is_set(), "check_cancelled")
            _require(time.monotonic() < deadline, "check_timeout")

        def execute(argv, requested_timeout):
            checkpoint()
            result = runner(argv, min(requested_timeout, max(0, deadline - time.monotonic())))
            checkpoint()
            return result

        try:
            checkpoint()
            result = function(execute, checkpoint)
            checkpoint()
            return result
        except Exception:
            stopped.set()
            raise

    # Submit at most one wave. Do not leave a queue that can start after denial.
    with ThreadPoolExecutor(max_workers=contract["limits"]["max_parallel"]) as pool:
        pending = {}
        remaining = iter(tasks.items())

        def fill():
            while not stopped.is_set() and len(pending) < contract["limits"]["max_parallel"]:
                try:
                    name, function = next(remaining)
                except StopIteration:
                    break
                pending[pool.submit(checked, function)] = name

        fill()
        while pending:
            done, _ = wait(pending, return_when=FIRST_COMPLETED)
            for future in sorted(done, key=lambda future: pending[future]):
                name = pending.pop(future)
                try:
                    result = future.result()
                    (stable if name.startswith("stable.") else volatile)[name] = result
                except PreflightError as error:
                    errors.append({"check": name, "code": error.code})
                except (OSError, KeyError, TypeError, ValueError, AttributeError, RecursionError):
                    errors.append({"check": name, "code": "check_failed"})
            fill()

    file_tool = volatile.get("volatile.file_tool_evidence", {})
    session = volatile.get("volatile.session_evidence", {})
    expected_session_hash = file_tool.get("session_evidence_sha256")
    if expected_session_hash is not None and expected_session_hash != session.get("sha256"):
        errors.append({"check": "volatile.file_tool_evidence",
                       "code": "file_tool_session_evidence_changed"})
    terminal = volatile.get("volatile.terminal")
    if contract["schema_version"] == 2 and file_tool and terminal:
        if file_tool["session_context_sha256"] != terminal["session_context_sha256"]:
            errors.append({"check": "volatile.file_tool_evidence",
                           "code": "file_tool_session_context_changed"})

    fingerprint = _json_digest({
        "schema_version": contract["schema_version"],
        "runtime_id": contract["runtime_id"],
        "runtime_version": contract["runtime_version"],
        "run_id": contract["run_id"],
        "workspace": contract["workspace"],
        "terminal": contract["terminal"],
        "session": contract["session"],
        "runtime_state": contract["runtime_state"],
        "limits": contract["limits"],
        "evidence_policy": {key: contract[key] for key in
                            ("adapter", "freshness", "probe_roots") if key in contract},
        "stable": {key: stable[key] for key in sorted(stable)},
    }) if all(name in stable for name in tasks if name.startswith("stable.")) else None
    reused = False
    if reuse_receipt is not None and fingerprint is not None:
        try:
            previous = read_json(reuse_receipt)
            prior_stable = previous.get("stable")
            reused = (previous.get("schema_version") == 1 and previous.get("ok") is True
                      and previous.get("kind") == "native_adaptive_preflight"
                      and isinstance(prior_stable, dict) and prior_stable.get("ok") is True
                      and prior_stable.get("fingerprint") == fingerprint)
        except PreflightError as error:
            if error.code == "input_access_denied":
                errors.append({"check": "reuse_receipt", "code": error.code})
            reused = False

    completed_mono = monotonic()
    completed_time = now + timedelta(seconds=completed_mono - started_mono)
    # Time spent checking must not extend the validity window of old observations.
    valid_until = []
    for name, kind in (("volatile.terminal", "session"),
                       ("volatile.session_evidence", "session"),
                       ("volatile.file_tool_evidence", "file_tool")):
        evidence = volatile.get(name)
        limit = age_limit(contract, kind)
        if evidence and limit is not None:
            valid_until.append(_parse_time(evidence["observed_at"]) + timedelta(seconds=limit))
            if (completed_time - _parse_time(evidence["observed_at"])).total_seconds() > limit:
                errors.append({"check": name, "code": "evidence_expired_during_preflight"})
    completed_at = completed_time.isoformat().replace(
        "+00:00", "Z")
    errors.sort(key=lambda item: (item["check"], item["code"]))
    ok = not errors
    ids = {
        "runtime_id": contract["runtime_id"], "run_id": contract["run_id"],
        "workspace_id": contract["workspace"]["id"],
        "terminal_handle": contract["terminal"]["handle"],
        "terminal_incarnation_id": contract["terminal"]["incarnation_id"],
        "session_id": contract["session"]["id"],
    }
    return {
        "schema_version": 1,
        "kind": "native_adaptive_preflight",
        "ok": ok,
        "decision": "dispatch_explicit_task_once" if ok else "stop",
        "ids": ids,
        "stable": {"ok": fingerprint is not None, "fingerprint": fingerprint,
                   "reuse": "matched_prior_receipt" if reused else "not_reused"},
        "volatile": {"ok": not any(error["check"].startswith("volatile.") for error in errors),
                     "fresh_checks": sorted(volatile)},
        "timing": {
            "run_created_at": contract["milestones"]["run_created_at"],
            "coordinator_turn_started_at": contract["milestones"]["coordinator_turn_started_at"],
            "preflight_started_at": started_at,
            "preflight_completed_at": completed_at,
            "preflight_duration_ms": round((completed_mono - started_mono) * 1000, 3),
            "dispatch_invoked_at": None,
            "worker_first_genuine_tool_at": None,
        },
        "limits": {"max_parallel": contract["limits"]["max_parallel"],
                   "per_check_timeout_ms": contract["limits"]["per_check_timeout_ms"]},
        "freshness": {"session_max_age_seconds": age_limit(contract, "session"),
                      "file_tool_max_age_seconds": age_limit(contract, "file_tool"),
                      "file_tool_revalidated": contract["schema_version"] == 2
                          and ok},
        "handoff": {
            "operator_confirmation_required": False if ok else None,
            "cache_is_live_proof": False,
            "worker_probe": ["apply_patch_write", "read", "rename", "read"],
            "worker_probe_batches": 1,
            "blocking_wait": (
                "Only when no independent authorized actionable work remains: "
                "orchestration check --wait with a bounded timeout"
            ),
            "automatic_retry_or_launch": False,
            "evidence_valid_until": min(valid_until).isoformat() if ok and valid_until else None,
            "rerun_after_delay_or_change": True,
        },
        "errors": errors,
    }


def cli_main(argv):
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--contract", required=True, type=Path)
    parser.add_argument("--reuse-receipt", type=Path)
    args = parser.parse_args(argv)
    try:
        receipt = run_preflight(read_json(args.contract), reuse_receipt=args.reuse_receipt)
    except PreflightError as error:
        receipt = _error_receipt(error.code)
    except (KeyError, OSError, TypeError, ValueError, AttributeError, RecursionError):
        receipt = _error_receipt("invalid_contract")
    print(json.dumps(receipt, sort_keys=True, separators=(",", ":")))
    return 0 if receipt["ok"] else 2

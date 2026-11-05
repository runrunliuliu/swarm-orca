"""Explicit Trae Coordinator plans and read-only exec session evidence.

TUI observation lives in trae_tui.py. This is NOT the Codex native-preflight adapter,
or process attestation. Identity starts at a fresh native terminal stream's
thread.started event, never a requested UUID, cwd, title or latest-log search.
"""

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import stat
import subprocess
import observation_budget as budget

from coordinator_launch import artifact_layout, canonical_directory, read_config
from coordinator_loop import phase_contract
from coordinator_input import bind_prompt
from log_io import prefix_digest, prefix_lines
from coordinator_write_roots import observe_write_roots

VERSION = "0.210.1"
EXEC_VERSIONS = (VERSION, "0.211.1")
TUI_VERSIONS = ("0.211.1", "0.212.1", "0.213.1")
SUPPORTED_VERSIONS = tuple(dict.fromkeys((*EXEC_VERSIONS, *TUI_VERSIONS)))
UUID = re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}")
LEGACY_EXECUTION = {"sandbox_mode": "workspace-write", "approval_policy": "never",
                    "launch_mode": "exec", "network_access": True}
AUTO_REVIEW_EXECUTION = {"sandbox_mode": "workspace-write", "approval_policy": "on-request",
                         "approvals_reviewer": "auto_review",
                         "launch_mode": "exec", "network_access": True}
TUI_EXECUTION = {**AUTO_REVIEW_EXECUTION, "launch_mode": "tui"}
TUI_ADAPTER = "trae-tui-runtime-v1"


class ContextFreshnessError(ValueError):
    """Known local timing failure; no provider/native error text is exported."""

    def __init__(self, age_seconds, max_age_seconds):
        super().__init__("actual turn settings stale")
        self.code = "session_context_in_future" if age_seconds < 0 else "session_context_stale"
        self.age_seconds = age_seconds
        self.max_age_seconds = max_age_seconds


def require(condition, message):
    if not condition:
        raise ValueError(message)


def regular_file(value):
    require(value is not None, "explicit file is required")
    path = Path(value)
    require(path.is_absolute(), "absolute file required")
    resolved = path.resolve(strict=True)
    require(resolved.is_file(), "regular file required")
    return resolved


def read_trae_runtime(runtime_config):
    require(runtime_config is not None, "explicit Trae runtime config required; no Codex mapping")
    config = json.loads(regular_file(runtime_config).read_text())
    require(set(config) == {"schema_version", "scope", "provider", "cli_version", "execution"}
            and config["provider"] == "trae" and config["cli_version"] in SUPPORTED_VERSIONS,
            "unsupported Trae runtime config/provider/version")
    execution = read_config(runtime_config, "execution")
    # Preserve explicit historical contracts; never silently switch their approvals.
    require(execution in (LEGACY_EXECUTION, AUTO_REVIEW_EXECUTION, TUI_EXECUTION)
            and execution.get("network_access") is True,
            "unsupported Trae execution policy")
    require(config["cli_version"] in (TUI_VERSIONS if execution == TUI_EXECUTION else EXEC_VERSIONS),
            "TUI adapter requires Trae 0.211.1, 0.212.1 or 0.213.1; exec requires 0.210.1 or 0.211.1")
    return config["cli_version"], execution


def read_trae_execution(runtime_config):
    _, execution = read_trae_runtime(runtime_config)
    return execution


def verify_trae_executable(executable, cli_version):
    """Prelaunch observation on this host, not native launch/process attestation."""
    from coordinator_io import now
    require(cli_version in SUPPORTED_VERSIONS, "unsupported Trae CLI version")
    path = regular_file(executable)

    def fingerprint():
        require(regular_file(executable) == path, "trae_executable_changed")
        with path.open("rb") as stream:
            before = os.fstat(stream.fileno())
            sha = prefix_digest(stream, before.st_size)
            after = os.fstat(stream.fileno())
        def identity(info):
            return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
        require(identity(before) == identity(after) == identity(path.stat())
                and regular_file(executable) == path, "trae_executable_changed")
        return {"path": str(path), "sha256": sha, "identity": identity(after)}

    before = fingerprint()
    reply = subprocess.run([str(path), "--version"], check=True, text=True,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
    lines = reply.stdout.splitlines()
    require(lines and lines[0] == "traecli " + cli_version, "trae_executable_version_mismatch")
    require(fingerprint() == before, "trae_executable_changed")
    return {"executable": str(executable), "resolved_path": str(path),
            "sha256": before["sha256"], "cli_version": cli_version, "observed_at": now(),
            "trust": "operator-local-prelaunch-not-process-attested"}


def build_trae_plan(*, trae, cwd, archive_dir, write_dirs, selection,
                    runtime_config, prompt_file, bootstrap_dir, resume_session,
                    replacement_run=None):
    require(trae is not None and Path(trae).is_absolute() and Path(trae).is_file(),
            "Trae requires its verified absolute executable")
    cli_version, execution = read_trae_runtime(runtime_config)
    tui = execution == TUI_EXECUTION
    require(not tui or (bootstrap_dir is not None and resume_session is None
                        and replacement_run is None), "TUI requires fresh native bootstrap; no recovery")
    require(selection == {"mode": "explicit", "agent": "trae", "model": "gpt-5.5",
                          "effort": "xhigh", "max_mode": True},
            "unsupported Trae Coordinator selection")
    require((bootstrap_dir is None) != (archive_dir is None),
            "choose exactly one bootstrap directory or real Run archive")
    if replacement_run is not None:
        require(isinstance(replacement_run, str)
                and re.fullmatch(r"run_[A-Za-z0-9_-]+", replacement_run) is not None,
                "replacement requires exact native Run ID")
        require(archive_dir is not None and bootstrap_dir is None and resume_session is None,
                "replacement starts a fresh session in the existing Run archive; no resume")
        require(canonical_directory(archive_dir).name == replacement_run,
                "replacement archive must match the existing Run")
    else:
        require((bootstrap_dir is not None) == (resume_session is None),
                "bootstrap starts fresh; Run phase requires exact resumed session")
    if resume_session is not None:
        require(UUID.fullmatch(resume_session) is not None, "exact resume UUID required")
        require(re.fullmatch(r"run_[A-Za-z0-9_-]+", Path(archive_dir).name) is not None,
                "Run archive must name a real native Run (verify receipt separately)")
    cwd = canonical_directory(cwd)
    prompt = regular_file(prompt_file)
    directories, roots = artifact_layout(bootstrap_dir or archive_dir, write_dirs)
    # --no-daemon is interactive-only in the supported Trae CLIs. Native exec has no such flag;
    # do not infer or attest its daemon implementation from this launch plan.
    argv = [str(trae), *(["--no-daemon", "--no-alt-screen"] if tui else
                         ["exec", "--json", "--color", "never"]), "--strict-config", "--cd", str(cwd),
            "--sandbox", "workspace-write", "--model", "gpt-5.5",
            "-c", "approval_policy=" + json.dumps(execution["approval_policy"]),
            "-c", 'sandbox_workspace_write.network_access=true',
            "-c", 'model_reasoning_effort="xhigh"', "-c", 'model_backend_variant="max"']
    if "approvals_reviewer" in execution:
        argv += ["-c", "approvals_reviewer=" + json.dumps(execution["approvals_reviewer"])]
    for root in roots:
        argv += ["--add-dir", root]
    if resume_session is not None:
        argv += ["resume", resume_session]
    argv += ["-"]
    phase = "replacement" if replacement_run else ("bootstrap" if bootstrap_dir else "run")
    native_agent_args = argv[1:-1]
    plan = {
        "scope": "swarm_coordinator_only", "adapter": TUI_ADAPTER if tui else "trae-exec-stream-v1",
        "phase": phase,
        "cli_version": cli_version,
        "selection": selection, "execution": execution, "cwd": str(cwd),
        "runtime_config": str(regular_file(runtime_config)),
        "artifact_dirs": directories, "task_write_roots": roots,
        "resume_session": resume_session, "prompt_file": str(prompt), "argv": argv,
        "native_launch": {
            "schema_version": 1,
            "method": "agent.launch",
            "agent": "trae",
            "target": {"kind": "existing", "worktree": str(cwd)},
            "cwd": str(cwd),
            "agent_args": " ".join(shlex.quote(arg) for arg in native_agent_args),
            "stdin_required": True,
            "stdin_sha256": None,
            "strict_eligible": False,
            "requires_runtime_support": "agent.launch stdin for reviewed Trae exec plans",
        },
        # No raw `< brief` command: that bypasses the delivered phase contract.
        # Save/review the plan and use trae_exec_capture.py in the same native PTY.
        "command": None,
        "preparation": None,
        "replacement_run": replacement_run,
        "prompt_fragment": (
            (
                "Explicit Coordinator replacement, not same-session resume. Before creating a "
                "replacement terminal/session, verify the selected runtime and Run policy "
                "support a safe native recovery protocol; this plan provides no takeover "
                "capability. strict-v1 has no safe rebind/adoption or crash takeover: stop "
                "this replacement path without launching or downgrading policy. Where native "
                "recovery is supported and authorized, before launch the "
                "operator must prove the previous Coordinator process exited, preserve its "
                "evidence and all Worker attempts, and verify current Run ownership. Launch "
                "once in a fresh native terminal; observe its unique new thread.started and "
                "effective settings before following that verified native recovery protocol "
                "to bind this terminal to " + replacement_run + ". Preserve native adoption "
                "receipts. Verify consumer-generation fencing and unchanged "
                "Worker assignments, then re-observe with the Run binding. No run-create, "
                "legacy takeover, identity copying, Worker retry or counter reset. Unknown "
                "Workers still occupy max_workers capacity. Rejection stops this path. "
            ) if replacement_run else ""
        ) + (
            "Trae exec Coordinator; no Codex preparation.functions_exec or runtime-state fallback. "
            "Use canonical cwd/write roots: " + json.dumps([str(cwd), *roots]) + ". "
            "Verify this execution contract with trae_coordinator.py --trae-runtime-config "
            + shlex.quote(str(regular_file(runtime_config))) + ". "
        ) + ((
            "Bootstrap may analyze the authorized task only enough to prove the independent "
            "session and required inputs. It MUST NOT create a native Run in this turn, even "
            "after actual session verification. The operator first runs the session startup "
            "gate, then prepares a separate Run-create handoff for this same Coordinator. "
        ) if phase == "bootstrap" else "") + (
            "Before dispatch reverify identity/effective settings "
            "and actual native edit/read/rename/read probes. Permission denial stops; no "
            "sandbox disabling, alternate paths/tools, runtime switching or blind retry. "
            "Planning neither launches a session nor proves permissions or model routing. "
        ) + phase_contract("recovery" if phase == "replacement" else phase),
    }
    plan = bind_prompt(plan, prompt)
    plan["native_launch"]["stdin_sha256"] = plan["input_contract"]["stdin_sha256"]
    return plan


def stream_thread(text):
    """Only structured events, never model prose mentioning a session ID."""
    ids = []
    for line in text.splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if isinstance(event, dict) and event.get("type") == "operator.stream_error":
            raise ValueError("captured startup stream is invalid")
        if isinstance(event, dict) and event.get("type") == "operator.child_exited":
            require(not event.get("stream_errors"), "captured startup stream is invalid")
        if isinstance(event, dict) and event.get("type") == "thread.started":
            sid = event.get("thread_id")
            require(isinstance(sid, str) and UUID.fullmatch(sid), "invalid emitted thread ID")
            ids.append(sid)
    require(len(ids) == 1, "need exactly one fresh thread.started event")
    return ids[0]


@budget.observed("session_log")
def verify_log(path, *, thread_id, cwd, roots, now=None, max_age=300, execution=None,
               cli_version=VERSION):
    # The driver also verifies historical turns using their precise (possibly
    # zero) duration. Integer-only policy belongs to the startup contract, not
    # this shared log reader.
    require(type(max_age) in (int, float) and 0 <= max_age < float("inf"),
            "invalid context max age")
    execution = LEGACY_EXECUTION if execution is None else execution
    require(cli_version in SUPPORTED_VERSIONS, "unsupported Trae CLI version")
    require(execution in (LEGACY_EXECUTION, AUTO_REVIEW_EXECUTION, TUI_EXECUTION)
            and execution.get("network_access") is True,
            "unsupported Trae execution policy")
    path = Path(path)
    require(path.is_absolute() and path.resolve(strict=True) == path,
            "log must be canonical; no symlink log")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid()
                and info.st_size > 0, "log owner/type/size unsupported")
        meta, record = None, None
        digest = hashlib.sha256()
        for line in prefix_lines(stream, info.st_size):
            digest.update(line)
            if not line.endswith(b"\n"):
                continue  # A concurrent partial append is not evidence.
            value = json.loads(line)
            require(isinstance(value, dict), "invalid session log record")
            if meta is None:
                meta = value
            if value.get("type") == "turn_context":
                record = value
        require(prefix_digest(stream, info.st_size) == digest.hexdigest(),
                "log changed during observation")
        current = path.stat()
        require(path.resolve(strict=True) == path
                and (current.st_dev, current.st_ino) == (info.st_dev, info.st_ino),
                "log replaced during observation")
    require(meta is not None, "complete metadata record required")
    payload = meta.get("payload", {})
    tui = execution == TUI_EXECUTION
    require(cli_version in (TUI_VERSIONS if tui else EXEC_VERSIONS),
            "unsupported Trae version for execution mode")
    origin_matches = (payload.get("source") in (None, "cli")
                      and payload.get("originator") == "traex-tui"
                      and payload.get("agent_id") is None) if tui else (
                          payload.get("source") == "exec" and payload.get("originator") == "codex_exec")
    require(meta.get("type") == "session_meta" and payload.get("id") == thread_id
            and payload.get("session_id") == thread_id
            and payload.get("model_provider") == "trae"
            and payload.get("cli_version") == cli_version and payload.get("cwd") == str(cwd)
            and origin_matches
            and payload.get("parent_thread_id") is None,
            "actual session metadata mismatch")
    require(record is not None, "actual turn settings unavailable")
    actual = record["payload"]
    sandbox = actual.get("sandbox_policy", {})
    require(actual.get("model") in ("gpt-5.5", "GPT-5.5")
            and actual.get("model_provider") == "trae" and actual.get("effort") == "xhigh"
            and actual.get("model_backend_variant") == "max"
            and actual.get("cwd") == str(cwd)
            and actual.get("approval_policy") == execution["approval_policy"]
            and sandbox.get("type") == "workspace-write"
            and sandbox.get("network_access") is True, "actual session settings mismatch")
    if "approvals_reviewer" in execution:
        # This CLI serializes auto_review as guardian_subagent in config/turn records.
        require(actual.get("approvals_reviewer") in ("auto_review", "guardian_subagent"),
                "actual session approvals reviewer missing or mismatched")
    write_root_evidence = observe_write_roots(cwd, sandbox, roots)
    observed = datetime.fromisoformat(record["timestamp"].replace("Z", "+00:00"))
    now = now or datetime.now(timezone.utc)
    age = (now - observed).total_seconds()
    if not 0 <= age <= max_age:
        raise ContextFreshnessError(age, max_age)
    return {"thread_id": thread_id, "session_id": payload.get("session_id"),
            "write_root_evidence": write_root_evidence,
            "cli_version": cli_version, "observed_at": record["timestamp"],
            "effective": {k: actual.get(k) for k in (
                "model", "model_provider", "effort", "model_backend_variant", "cwd",
                "approval_policy", "approvals_reviewer", "sandbox_policy")},
            "log_path": str(path), "prefix_bytes": info.st_size,
            "prefix_sha256": digest.hexdigest(),
            "log_device": info.st_dev, "log_inode": info.st_ino,
            "trust": "native-terminal-stream-and-session-log-not-process-attested"}


NATIVE_RPC_TIMEOUT_SECONDS = 15


@budget.observed("native_rpc")
def native(cli, runtime, args, *, timeout_seconds=NATIVE_RPC_TIMEOUT_SECONDS):
    from operator_continuity_route import runtime as transport_runtime
    from startup_cli import check_explicit
    runtime = transport_runtime(runtime)
    check_explicit(cli, runtime)
    with budget.stage(budget.query_name(args)):
        reply = subprocess.run([cli, *args, "--json"], check=True, text=True,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=budget.timeout(timeout_seconds))
    value = json.loads(reply.stdout)
    require(value.get("ok") is True and value.get("_meta", {}).get("runtimeId") == runtime,
            "native query failed or runtime changed")
    return value["result"]


def observe(*, cli, runtime, terminal, incarnation, workspace, cwd, cursor,
            log_root, roots, expected_thread=None, run=None, trae_runtime_config=None,
            context_max_age_seconds=300, startup_anchor=None):
    from coordinator_io import parse, pinned
    cli_version, execution = (read_trae_runtime(trae_runtime_config)
                              if trae_runtime_config is not None
                              else (VERSION, LEGACY_EXECUTION))
    require(execution != TUI_EXECUTION, "TUI requires explicit trae_tui observer; no stream fallback")
    require(Path(cli).is_absolute() and Path(cli).is_file(), "verified absolute CLI required")
    require(type(cursor) is int and cursor >= 0, "fresh start cursor required")
    def snapshot():
        status = native(cli, runtime, ["status"])
        require(status["runtime"]["appVersion"] == "1.4.219"
                and status["runtime"]["state"] == "ready", "unsupported or unready runtime")
        t = native(cli, runtime, ["terminal", "show", "--terminal", terminal])["terminal"]
        require(t.get("handle") == terminal and t.get("incarnationId") == incarnation
                and t.get("worktreeId") == workspace and t.get("executionHostId") == "local"
                and t.get("connected") is True and t.get("orphaned") is False,
                "native terminal identity/liveness mismatch")
        w = native(cli, runtime, ["worktree", "show", "--worktree", "id:" + workspace])
        require(w["worktree"]["id"] == workspace
                and Path(w["worktree"]["path"]).resolve() == Path(cwd), "workspace mismatch")
        if run:
            current = native(cli, runtime, ["orchestration", "run-current", "--from", terminal])
            require(current.get("run", {}).get("id") == run, "native Run ownership mismatch")
        return {k: t.get(k) for k in ("handle", "incarnationId", "worktreeId",
                                    "executionHostId", "tabId", "leafId")}
    before = snapshot()
    anchor = parse(pinned(startup_anchor)) if startup_anchor else None
    if anchor is not None:
        require(anchor.get("schema_version") == 1
                and anchor.get("kind") == "trae_startup_anchor"
                and anchor.get("runtime_id") == runtime and anchor.get("terminal") == before
                and anchor.get("stream_start_cursor") == cursor
                and anchor.get("thread_id") == expected_thread
                and isinstance(expected_thread, str) and UUID.fullmatch(expected_thread),
                "startup anchor identity mismatch")
        sid = anchor["thread_id"]
    else:
        chunks = []
        position = cursor
        end_cursor = None
        while True:
            read = native(cli, runtime, ["terminal", "read", "--terminal", terminal,
                                        "--cursor", str(position), "--limit", "1000"])
            output = read.get("terminal", {})
            require(output.get("source") == "stream", "native stream source required")
            require(int(output["oldestCursor"]) <= cursor, "startup stream was evicted")
            tail = output.get("tail")
            require(isinstance(tail, list) and all(isinstance(line, str) for line in tail),
                    "native stream lines required")
            chunks.append("\n".join(tail))
            next_cursor = int(output["nextCursor"])
            require(position <= next_cursor <= int(output["latestCursor"]),
                    "invalid stream cursor bounds")
            if end_cursor is None:
                end_cursor = int(output["latestCursor"])
            if not output.get("limited") or next_cursor >= end_cursor:
                break
            require(type(next_cursor) is int and next_cursor > position, "invalid stream cursor")
            position = next_cursor
        sid = stream_thread("\n".join(chunks))
    require(expected_thread is None or sid == expected_thread, "resumed thread changed")
    log_root = canonical_directory(log_root)
    matches = list(log_root.glob("*/*/*/rollout-*-" + sid + ".jsonl"))
    require(len(matches) == 1, "exact emitted thread log missing or ambiguous")
    evidence = verify_log(matches[0], thread_id=sid, cwd=cwd, roots=roots,
                          execution=execution, cli_version=cli_version,
                          max_age=context_max_age_seconds)
    if anchor is not None:
        require(all(evidence[k] == anchor.get(k) for k in
                    ("log_path", "log_device", "log_inode", "cli_version"))
                and type(anchor.get("prefix_bytes")) is int
                and 0 < anchor["prefix_bytes"] <= evidence["prefix_bytes"],
                "startup anchor log replaced or truncated")
        fd = os.open(matches[0], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as source:
            info = os.fstat(source.fileno())
            require(stat.S_ISREG(info.st_mode)
                    and (info.st_dev, info.st_ino) == (anchor["log_device"], anchor["log_inode"])
                    and prefix_digest(source, anchor["prefix_bytes"]) == anchor.get("prefix_sha256"),
                    "startup anchor log prefix changed")
        current = matches[0].stat()
        require((current.st_dev, current.st_ino) == (anchor["log_device"], anchor["log_inode"]),
                "startup anchor log replaced")
        pinned(startup_anchor)
    require(snapshot() == before, "native identity changed during observation")
    return {"schema_version": 1, "kind": "trae_startup_anchor" if anchor is None else "trae_session_observation",
            "runtime_id": runtime, "terminal": before, "run_id": run,
            "stream_start_cursor": cursor, **evidence}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("cli", "runtime", "terminal", "incarnation", "workspace", "cwd", "log-root"):
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--cursor", type=int, required=True)
    parser.add_argument("--root", action="append", dest="roots", default=[])
    parser.add_argument("--expected-thread")
    parser.add_argument("--run")
    parser.add_argument("--startup-anchor")
    parser.add_argument("--startup-anchor-sha256")
    parser.add_argument("--save-startup-anchor", type=Path,
                        help="atomically save the first verified observation; never overwrite")
    parser.add_argument("--trae-runtime-config", type=Path,
                        help="Exact launch execution contract; omitted only for legacy never runs")
    try:
        from coordinator_io import path, publish_new
        args = vars(parser.parse_args())
        output = args.pop("save_startup_anchor")
        anchor, sha = args.pop("startup_anchor"), args.pop("startup_anchor_sha256")
        require(bool(anchor) == bool(sha), "startup anchor pin required")
        require(not (output and anchor), "cannot recapture a startup anchor")
        if output:
            path(str(output.parent), directory=True)
            require(not output.exists() and not output.is_symlink(), "startup anchor already exists")
        result = observe(**args, startup_anchor={"path": anchor, "sha256": sha} if anchor else None)
        if output:
            publish_new(output, result)
        print(json.dumps(result, ensure_ascii=False))
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as exc:
        # Do not include captured provider/native stdout or credentials.
        print(json.dumps({"ok": False, "decision": "stop", "error": str(exc)}))
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

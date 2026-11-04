"""Authorized Linux host collector; never run inside an Agent identity context.

Foreground Unix-socket service. No lifecycle calls, automatic retries, key generation,
privilege changes, remote transport or model invocations. See session-binding.md.
"""

import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import socket
import stat
import struct
import sys
import time

from supervisor.config import SafetyError, require
from supervisor.store import Store, lock
from .binding import Client, crypto, encoded, receive, validate_request
from .codex import scan
from .ledger import seconds
from .native import Reader


def bounded(path, limit):
    with Path(path).open("rb") as source:
        value = source.read(limit + 1)
    require(len(value) <= limit, "binding_input_too_large")
    return value


class Proc:
    """Host-only adapter; fake proc roots are injected by offline tests, not CLI flags."""
    def __init__(self, uid, executables, log_roots, max_bytes=None, *, root=Path("/proc")):
        self.uid, self.executables, self.log_roots = uid, set(executables), [Path(p) for p in log_roots]
        self.max_bytes, self.root = max_bytes, Path(root)

    def process(self, pid):
        directory = self.root / str(pid)
        require(directory.stat().st_uid == self.uid, "binding_process_uid_changed")
        raw = bounded(directory / "stat", 16384).decode()
        # comm may contain spaces and ')'; starttime is field 22 (offset 19 after comm).
        fields = raw[raw.rfind(")") + 2:].split()
        require(len(fields) > 19 and fields[19].isdigit(), "binding_invalid_process_stat")
        executable = os.readlink(directory / "exe")
        require(executable in self.executables, "binding_executable_changed")
        return {"pid": int(pid), "start_ticks": fields[19], "uid": self.uid, "executable": executable,
                "boot_id": bounded(self.root / "sys/kernel/random/boot_id", 128).decode().strip()}

    def matches(self, pid, terminal):
        raw = bounded(self.root / str(pid) / "environ", 1024 * 1024)
        values = [part.split(b"=", 1)[1] for part in raw.split(b"\0")
                  if part.startswith(b"ORCA_TERMINAL_HANDLE=")]
        require(len(values) <= 1, "binding_duplicate_terminal_environment")
        return values == [terminal.encode()]

    def discover(self, terminal):
        candidates = []
        for directory in self.root.iterdir():
            if not directory.name.isdigit():
                continue
            try:
                if directory.stat().st_uid != self.uid:
                    continue
                executable = os.readlink(directory / "exe")
            except FileNotFoundError:
                continue  # unrelated process exited before becoming a candidate
            if executable not in self.executables:
                continue
            before = self.process(directory.name)
            if not self.matches(directory.name, terminal):
                continue
            seen = set()
            for descriptor in (directory / "fd").iterdir():
                target = os.readlink(descriptor)
                if not target.endswith(".jsonl"):
                    continue
                path = Path(target)
                require(path.is_absolute() and path.resolve() == path and
                        any(path.is_relative_to(root) for root in self.log_roots), "binding_log_outside_roots")
                with descriptor.open("rb") as source:
                    info = os.fstat(source.fileno())
                    require(stat.S_ISREG(info.st_mode) and info.st_uid == self.uid, "binding_invalid_log_owner")
                    file_id = (info.st_dev, info.st_ino)
                    if file_id in seen:
                        continue
                    seen.add(file_id)
                    line = source.readline(info.st_size)
                require(line.endswith(b"\n"), "binding_incomplete_session_meta")
                record = json.loads(line)
                meta = record.get("payload", {})
                require(record.get("type") == "session_meta" and isinstance(meta.get("id"), str) and
                        meta["id"], "binding_missing_session_meta")
                origin = meta.get("source")
                if isinstance(origin, dict) and "subagent" in origin:
                    continue  # independently accounted children must never become the root
                require(origin == "cli", "binding_unrecognized_session_origin")
                identity = {**before, "session_id": meta["id"], "device": info.st_dev, "inode": info.st_ino,
                            "meta_sha256": hashlib.sha256(line).hexdigest()}
                candidates.append((identity, descriptor, path))
            require(before == self.process(directory.name) and self.matches(directory.name, terminal),
                    "binding_process_changed")
        require(len(candidates) == 1, "binding_missing_or_ambiguous_root")
        return candidates[0]

    def capture(self, terminal, since, until, previous=None):
        identity, descriptor, path = self.discover(terminal)
        with descriptor.open("rb") as source:
            info = os.fstat(source.fileno())
            require((info.st_dev, info.st_ino) == (identity["device"], identity["inode"]) and
                    info.st_size > 0, "binding_log_changed_or_empty")
            # Optional operator resource policy, not an implementation ceiling.
            require(self.max_bytes is None or info.st_size <= self.max_bytes,
                    "binding_log_exceeds_configured_max_bytes")
            content = source.read(info.st_size)
            require(len(content) == info.st_size, "binding_log_truncated")
            prefix = {"bytes": len(content), "sha256": hashlib.sha256(content).hexdigest()}
            require(hashlib.sha256(content[:content.index(b"\n") + 1]).hexdigest() == identity["meta_sha256"],
                    "binding_metadata_changed")
            if previous:
                require(previous["identity"] == identity, "binding_process_or_session_changed")
                old = previous["prefix"]
                require(len(content) >= old["bytes"] and hashlib.sha256(content[:old["bytes"]]).hexdigest() ==
                        old["sha256"], "binding_log_history_changed")
            sample = scan(None, identity["session_id"], since, until, source=io.BytesIO(content)) if since else None
            # Verify the captured prefix again, allowing only concurrent append.
            source.seek(0)
            require(hashlib.sha256(source.read(len(content))).hexdigest() == prefix["sha256"],
                    "binding_log_rewritten_during_capture")
        require(os.readlink(descriptor) == str(path) and descriptor.stat().st_ino == identity["inode"] and
                descriptor.stat().st_dev == identity["device"], "binding_descriptor_changed")
        after, _, _ = self.discover(terminal)
        require(after == identity, "binding_process_or_session_changed")
        return identity, prefix, sample


def configuration(path):
    path = Path(path)
    require(path.is_absolute() and path.resolve() == path, "binding_config_not_canonical")
    info = path.stat()
    require(info.st_uid == os.getuid() and info.st_mode & 0o077 == 0, "binding_config_not_private")
    config = json.loads(path.read_bytes())
    require(config.get("schema") == 1 and config.get("isolation_verified") is True,
            "binding_operator_isolation_attestation_required")
    require(config.get("host") == socket.gethostname(), "binding_wrong_execution_host")
    require(type(config.get("uid")) is int and config["uid"] >= 0, "binding_invalid_uid")
    for field in ("cli", "private_key", "state", "socket", "openssl"):
        value = Path(config[field])
        require(value.is_absolute() and value.resolve() == value, "binding_noncanonical_path")
    key = Path(config["private_key"]).stat()
    require(stat.S_ISREG(key.st_mode) and key.st_uid == os.getuid() and key.st_mode & 0o077 == 0,
            "binding_signer_key_not_private")
    for field in ("executables", "log_roots"):
        require(isinstance(config.get(field), list) and config[field], "binding_missing_process_allowlist")
        for name in config[field]:
            require(Path(name).is_absolute() and Path(name).resolve() == Path(name), "binding_noncanonical_allowlist")
    for field in ("worktree_ids", "run_ids", "preflight_terminals"):
        require(isinstance(config.get(field), list) and all(isinstance(v, str) and v for v in config[field]),
                "binding_invalid_enrollment")
    require(config["worktree_ids"], "binding_empty_worktree_allowlist")
    limit = config.get("max_log_bytes")
    require(limit is None or type(limit) is int and limit > 0,
            "binding_invalid_size_limit")
    return config


def target_key(runtime, terminal):
    return "binding-target:" + hashlib.sha256(encoded([runtime, terminal])).hexdigest()


def outside_agent():
    require(not any(os.environ.get(k) for k in ("ORCA_TERMINAL_HANDLE", "ORCA_PANE_KEY", "ORCA_AGENT_SESSION_ID")),
            "binding_collector_must_run_outside_agent")


def resume(config, store, terminal, reason):
    """Operator-only explicit retry authorization; cannot replace an established pin."""
    require(re.fullmatch(r"[a-z][a-z0-9_-]{0,79}", reason), "binding_invalid_recovery_reason_code")
    key = target_key(config["runtime_id"], terminal)
    prior = store.get(key)
    require(prior is not None and prior.get("blocked") is True, "binding_target_not_blocked")
    with store.transaction():
        store.event("binding_operator_resume", target=key, reason_code=reason, failure=prior)
        store.put(key, prior.get("previous"))


class Collector:
    def __init__(self, config, store, native, proc, *, clock=time.time):
        self.config, self.store, self.native, self.proc, self.clock = config, store, native, proc, clock

    def terminal(self, scope):
        self.native.verify_runtime()
        if scope["run_id"] is not None:
            rid = scope["run_id"]
            run = self.native.read("orchestration", "run-show", "--id", rid)["run"]
            require(run.get("id") == rid, "binding_run_mismatch")
            if scope["agent_id"] == "coordinator":
                handle = run.get("coordinator_handle")
            else:
                row = self.native.read("orchestration", "worker-show", "--dispatch", scope["agent_id"])
                dispatch, worker = row["dispatch"], row["worker"]
                require(dispatch.get("id") == scope["agent_id"] and dispatch.get("runId") == rid and
                        worker.get("dispatchId") == scope["agent_id"] and dispatch.get("hostScope") == "local",
                        "binding_dispatch_scope_mismatch")
                launch = worker.get("startOptions", {}).get("launch", {}).get("effective", {})
                require(launch.get("agent") == "codex", "binding_native_provider_mismatch")
                handle = row.get("terminal", {}).get("handle")
                other = row.get("terminalResource", {}).get("terminalHandle")
                require(not handle or not other or handle == other, "binding_native_terminal_conflict")
                handle = handle or other
            require(handle == scope["terminal_handle"], "binding_native_terminal_mismatch")
        row = self.native.read("terminal", "show", "--terminal", scope["terminal_handle"])["terminal"]
        require(row.get("handle") == scope["terminal_handle"] and row.get("worktreeId") == scope["worktree_id"] and
                row.get("executionHostId") == "local" and row.get("agentIdentity") == "codex" and
                row.get("connected") is True and row.get("ptyId") and row.get("incarnationId"),
                "binding_terminal_unverifiable")
        return {k: row[k] for k in ("handle", "worktreeId", "executionHostId", "agentIdentity", "ptyId", "incarnationId")}

    def capture(self, request):
        scope = validate_request(request)
        c = self.config
        require(scope["runtime_id"] == c["runtime_id"] and scope["host"] == c["host"] and
                scope["worktree_id"] in c["worktree_ids"], "binding_scope_not_enrolled")
        require(scope["run_id"] in c["run_ids"] if scope["run_id"] is not None else
                scope["terminal_handle"] in c["preflight_terminals"], "binding_target_not_enrolled")
        if request["since"] is not None:
            require(seconds(request["since"]) <= seconds(request["until"]) <= self.clock() + 5,
                    "binding_invalid_capture_window")
        # Pin by runtime + terminal, including across preflight -> Run and service restarts.
        key = target_key(scope["runtime_id"], scope["terminal_handle"])
        prior = self.store.get(key)
        require(prior is None or not prior.get("blocked"), "binding_target_latched_unverifiable")
        try:
            observed = self.clock()
            before = self.terminal(scope)
            require(prior is None or prior["terminal"] == before, "binding_terminal_incarnation_changed")
            identity, prefix, sample = self.proc.capture(scope["terminal_handle"], request["since"], request["until"], prior)
            require(before == self.terminal(scope), "binding_terminal_changed_during_capture")
            require(0 <= self.clock() - observed < 50, "binding_capture_too_slow")
            payload = {"schema": "orca-host-binding-v1", "request": request, "observed_at": observed,
                       "expires_at": observed + 60, "identity": {**identity, "terminal": before},
                       "prefix": prefix, "sample": sample}
            receipt = {"payload": payload, "signature": crypto(payload, c["private_key"], openssl=c["openssl"])}
            with self.store.transaction():
                self.store.put(key, {"identity": identity, "prefix": prefix, "terminal": before})
                self.store.put("binding-receipt:" + hashlib.sha256(encoded(receipt)).hexdigest(), receipt)
            return receipt
        except Exception as error:
            # Persist failure across restarts; never interpret it as terminal/process exit.
            reason = "binding_permission_denied" if isinstance(error, PermissionError) else (
                str(error) if isinstance(error, SafetyError) else "binding_capture_unverifiable")
            self.store.put(key, {"blocked": True, "reason": reason, "previous": prior})
            raise SafetyError(reason) from error


def handle_request(connection, config_path, config, store):
    """One bounded request; Unix peer authentication precedes native/process access."""
    _, uid, _ = struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
    require(uid == config["uid"], "binding_peer_uid_mismatch")
    request = receive(connection)
    updated = configuration(config_path)
    mutable = {"run_ids", "preflight_terminals"}
    require({k: v for k, v in updated.items() if k not in mutable} ==
            {k: v for k, v in config.items() if k not in mutable}, "binding_service_config_changed")
    collector = Collector(updated, store, Reader(config["cli"], config["runtime_id"], config.get("environment")),
                          Proc(config["uid"], config["executables"], config["log_roots"], config.get("max_log_bytes")))
    return collector.capture(request)


def serve(config_path):
    require(sys.platform == "linux", "binding_collector_requires_linux")
    outside_agent()
    config = configuration(config_path)
    store = Store(config["state"])
    endpoint = Path(config["socket"])
    try:
        # A distinct service principal can expose ONLY this socket to the Agent UID.
        # It must already possess the required rights; there is no privilege escalation.
        endpoint.parent.mkdir(mode=0o711, parents=True, exist_ok=True)
        directory = endpoint.parent.stat()
        require(endpoint.parent.resolve() == endpoint.parent and directory.st_uid == os.getuid() and
                directory.st_mode & 0o022 == 0, "binding_socket_directory_unsafe")
        with lock(store.root, "binding-service.lock"), socket.socket(socket.AF_UNIX) as server:
            # Never unlink an unknown/live endpoint to make startup succeed.
            require(not endpoint.exists() and not endpoint.is_symlink(), "binding_endpoint_exists")
            server.bind(str(endpoint))
            endpoint_id = endpoint.stat().st_ino
            try:
                if config["uid"] != os.getuid():
                    os.chown(endpoint, config["uid"], -1)
                os.chmod(endpoint, 0o600)
                server.listen(4)
                while True:
                    with server.accept()[0] as connection:
                        connection.settimeout(60)
                        try:
                            response = handle_request(connection, config_path, config, store)
                        except Exception as error:
                            response = {"error": str(error) if isinstance(error, SafetyError) else "binding_request_unverifiable"}
                        try:
                            connection.sendall(encoded(response) + b"\n")
                        except OSError:
                            pass  # result is journaled; next request requires a new challenge
            finally:
                if endpoint.exists() and endpoint.stat().st_ino == endpoint_id:
                    endpoint.unlink()
    finally:
        store.close()


def main(argv=None):
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("serve").add_argument("--config", required=True)
    commands.add_parser("status").add_argument("--config", required=True)
    recover = commands.add_parser("resume")
    for flag in ("config", "terminal-handle", "reason-code"):
        recover.add_argument("--" + flag, required=True)
    preflight = commands.add_parser("preflight")
    for flag in ("socket", "public-key", "runtime-id", "terminal-handle", "worktree-id", "host"):
        preflight.add_argument("--" + flag, required=True)
    args = parser.parse_args(argv)
    if args.command == "serve":
        serve(args.config)
    elif args.command in ("status", "resume"):
        outside_agent()
        config = configuration(args.config)
        store = Store(config["state"])
        try:
            if args.command == "resume":
                # Stop the service normally first. Never race it or delete a lock.
                with lock(store.root, "binding-service.lock"):
                    resume(config, store, args.terminal_handle, args.reason_code)
            print(json.dumps({"targets": store.entries("binding-target:"),
                              "receipt_count": len(store.entries("binding-receipt:"))}, sort_keys=True))
        finally:
            store.close()
    else:
        scope = {"runtime_id": args.runtime_id, "run_id": None, "agent_id": "coordinator", "provider": "codex",
                 "terminal_handle": args.terminal_handle, "worktree_id": args.worktree_id, "host": args.host}
        print(json.dumps(Client(args.socket, args.public_key).capture(scope), sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (Exception, KeyboardInterrupt) as error:
        print(json.dumps({"ok": False, "error": str(error) if isinstance(error, SafetyError) else "binding_service_unverifiable"}))
        sys.exit(78)

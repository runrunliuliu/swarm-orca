"""Offline host/proc/native fixtures + real Ed25519 + real Unix socket transport."""

import copy
from contextlib import redirect_stdout
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from supervisor.config import SafetyError
from supervisor.store import Store
from swarm_ledger.binding import Client, crypto, encoded, receive, verify, validate_request
from swarm_ledger.binding_host import Collector, Proc, configuration, handle_request, outside_agent, resume
from swarm_ledger.__main__ import main
from swarm_ledger.ledger import Ledger
from swarm_ledger.native import Reader
from swarm_ledger.report import export
from core.test_ledger import START, END, run, worker


class Native:
    def __init__(self):
        self.row = {"handle": "term-1", "worktreeId": "wt", "executionHostId": "local",
                    "agentIdentity": "codex", "connected": True, "ptyId": "pty", "incarnationId": "inc"}
        self.worker = worker()
        self.worker["dispatch"]["hostScope"] = "local"
        self.worker["terminal"]["handle"] = "term-1"
        self.calls = []

    def verify_runtime(self):
        self.calls.append(("status",))

    def read(self, *args):
        self.calls.append(args)
        if args[:2] == ("terminal", "show"):
            return {"terminal": copy.deepcopy(self.row)}
        if args[:2] == ("orchestration", "run-show"):
            return {"run": run()}
        if args[:2] == ("orchestration", "worker-show"):
            return copy.deepcopy(self.worker)
        raise AssertionError("not a read-only binding command")


class BindingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.keys = tempfile.TemporaryDirectory()
        cls.private = Path(cls.keys.name) / "private.pem"
        cls.public = Path(cls.keys.name) / "public.pem"
        subprocess.run(["/usr/bin/openssl", "genpkey", "-algorithm", "ED25519", "-out", str(cls.private)],
                       check=True, capture_output=True)
        subprocess.run(["/usr/bin/openssl", "pkey", "-in", str(cls.private), "-pubout", "-out", str(cls.public)],
                       check=True, capture_output=True)

    @classmethod
    def tearDownClass(cls):
        cls.keys.cleanup()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()
        self.procroot = self.root / "proc"
        boot = self.procroot / "sys/kernel/random"
        boot.mkdir(parents=True)
        (boot / "boot_id").write_text("boot-1\n")
        self.logs = self.root / "logs"
        self.logs.mkdir()
        self.directory = self.procroot / "42"
        (self.directory / "fd").mkdir(parents=True)
        self.executable = self.root / "codex"
        self.executable.touch()
        (self.directory / "exe").symlink_to(self.executable)
        self.process_stat()
        (self.directory / "environ").write_bytes(b"DO_NOT_EXPORT=SECRET\0ORCA_TERMINAL_HANDLE=term-1\0")
        self.log = self.session("root", "cli", "7")
        self.proc = Proc(os.getuid(), [str(self.executable)], [str(self.logs)], 1024 * 1024, root=self.procroot)
        self.native = Native()
        self.store = Store(self.root / "state")
        self.config = {"schema": 1, "host": socket.gethostname(), "runtime_id": "rt", "uid": os.getuid(),
                       "cli": "/bin/false", "private_key": str(self.private), "openssl": "/usr/bin/openssl",
                       "state": str(self.root / "state"), "socket": str(self.root / "socket"),
                       "executables": [str(self.executable)], "log_roots": [str(self.logs)],
                       "worktree_ids": ["wt"], "run_ids": ["run-1"], "preflight_terminals": ["term-1"],
                       "isolation_verified": True, "max_log_bytes": 1024 * 1024}
        self.collector = Collector(self.config, self.store, self.native, self.proc)
        self.scope = {"runtime_id": "rt", "run_id": "run-1", "agent_id": "coordinator", "provider": "codex",
                      "terminal_handle": "term-1", "worktree_id": "wt", "host": socket.gethostname()}
        self.request = {"scope": self.scope, "nonce": "1" * 64, "since": START, "until": END}

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def process_stat(self, start="100"):
        (self.directory / "stat").write_text("42 (codex worker ) name) " + " ".join(["S"] + ["0"] * 18 + [start]))

    def session(self, session_id, origin, descriptor):
        path = self.logs / (session_id + ".jsonl")
        records = [{"type": "session_meta", "payload": {"id": session_id, "source": origin, "cwd": "SECRET"}},
                   {"type": "event_msg", "timestamp": "2026-10-13T00:01:00Z", "payload": {
                       "type": "token_count", "info": {"total_token_usage": {"input_tokens": 12, "output_tokens": 3},
                                                        "last_token_usage": {"input_tokens": 12, "output_tokens": 3}}}}]
        path.write_bytes(b"".join(encoded(row) + b"\n" for row in records))
        (self.directory / "fd" / descriptor).symlink_to(path)
        return path

    def test_signed_capture_sanitized_and_children_excluded(self):
        self.session("child", {"subagent": {"review": "root"}}, "8")
        receipt = self.collector.capture(self.request)
        payload = verify(receipt, self.request, self.public)
        self.assertEqual(payload["identity"]["session_id"], "root")
        self.assertEqual(payload["sample"]["tokens"]["input_tokens"], 12)
        self.assertNotIn(b"SECRET", encoded(receipt))
        self.assertNotIn(b"environ", encoded(receipt))
        self.assertEqual(len(self.store.entries("binding-receipt:")), 1)

    @unittest.skipUnless(sys.platform == "linux", "Linux-only scoped live proc fixture")
    def test_real_proc_for_only_owned_fixture_child_no_model(self):
        # Do NOT enumerate other host processes. Expose only this test-owned child's proc entry.
        import select
        process = subprocess.Popen([sys.executable, "-c",
            "import sys; f=open(sys.argv[1], 'rb'); print('ready', flush=True); sys.stdin.readline()", str(self.log)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env={"ORCA_TERMINAL_HANDLE": "term-1"})
        try:
            ready, _, _ = select.select([process.stdout], [], [], 5)
            self.assertTrue(ready)
            self.assertEqual(process.stdout.readline().strip(), b"ready")
            root = self.root / "isolated-proc"
            root.mkdir()
            (root / str(process.pid)).symlink_to(Path("/proc") / str(process.pid))
            (root / "sys").symlink_to(self.procroot / "sys")
            proc = Proc(os.getuid(), [os.readlink(f"/proc/{process.pid}/exe")], [str(self.logs)], 1048576, root=root)
            identity, prefix, sample = proc.capture("term-1", START, END)
            self.assertEqual(identity["pid"], process.pid)
            self.assertEqual(identity["session_id"], "root")
            self.assertEqual(prefix["bytes"], self.log.stat().st_size)
            self.assertEqual(sample["tokens"]["input_tokens"], 12)
        finally:
            process.terminate()
            process.communicate(timeout=5)

    @unittest.skipUnless(sys.platform == "linux", "SO_PEERCRED is Linux-specific")
    def test_service_handler_peer_auth_config_reload_and_no_lifecycle_calls(self):
        config = {**self.config, "cli": str(Path("/bin/false").resolve())}
        path = self.root / "config.json"
        path.write_bytes(encoded(config))
        path.chmod(0o600)
        # The real socket carries credentials; native/proc access is injected offline.
        def call(initial, updated):
            path.write_bytes(encoded(updated))
            a, b = socket.socketpair()
            with a, b, patch("swarm_ledger.binding_host.Reader", return_value=self.native), \
                    patch("swarm_ledger.binding_host.Proc", return_value=self.proc):
                a.sendall(encoded(self.request) + b"\n")
                return handle_request(b, path, initial, self.store)
        self.assertEqual(verify(call(config, config), self.request, self.public)["identity"]["session_id"], "root")
        with self.assertRaisesRegex(SafetyError, "peer_uid"):
            call({**config, "uid": os.getuid() + 1}, config)
        with self.assertRaisesRegex(SafetyError, "service_config_changed"):
            call(config, {**config, "max_log_bytes": 100})
        with self.assertRaisesRegex(SafetyError, "not_enrolled"):
            call(config, {**config, "run_ids": []})

    def test_service_agent_context_rejected_not_cleared(self):
        with patch.dict(os.environ, {"ORCA_TERMINAL_HANDLE": "term-1"}):
            with self.assertRaisesRegex(SafetyError, "outside_agent"):
                outside_agent()
            self.assertEqual(os.environ["ORCA_TERMINAL_HANDLE"], "term-1")

    def test_invalid_socket_frames_and_unsigned_error_are_not_evidence(self):
        for payload in (b'{}\n{}\n', b'{}', b'x' * 65537):
            a, b = socket.socketpair()
            with a, b:
                a.sendall(payload)
                a.shutdown(socket.SHUT_WR)
                with self.assertRaisesRegex(SafetyError, "invalid_frame"):
                    receive(b)

    def test_later_binding_failure_rolls_back_identity_and_receipt(self):
        ledger = Ledger(self.root / "ledger")
        ledger.sync("rt", run(), [])
        ledger.close()
        receipt = self.collector.capture(self.request)
        options = {"provider": "codex", "format": "host-receipt", "agent_id": "coordinator", "socket": "unused",
                   "public_key": str(self.public), "host": socket.gethostname(), "worktree_id": "wt",
                   "since": START, "until": END}
        path = self.root / "bindings.json"
        path.write_bytes(encoded([options, {**options, "provider": "invalid"}]))
        args = ["--state", str(self.root / "ledger"), "sync", "--runtime-id", "rt", "--run", "run-1",
                "--cli", "/verified/orca", "--bindings", str(path)]
        with patch("swarm_ledger.__main__.Reader.collect", return_value=(run(), [])), \
                patch.object(Client, "capture", return_value=receipt):
            with self.assertRaisesRegex(SafetyError, "unsupported"):
                main(args)
        ledger = Ledger(self.root / "ledger")
        try:
            self.assertEqual(ledger.store.entries("host-binding:"), {})
            self.assertEqual(ledger.store.entries("host-receipt:"), {})
            self.assertEqual(ledger.get("rt", "run-1")["agents"]["coordinator"]["samples"], {})
        finally:
            ledger.close()

    def test_signature_tamper_wrong_key_nonce_scope_expiry_future(self):
        receipt = self.collector.capture(self.request)
        tampered = copy.deepcopy(receipt)
        tampered["payload"]["identity"]["session_id"] = "fake"
        with self.assertRaisesRegex(SafetyError, "signature"):
            verify(tampered, self.request, self.public)
        for key, value in (("nonce", "2" * 64), ("scope", {**self.scope, "run_id": "run-2"})):
            with self.subTest(key=key), self.assertRaisesRegex(SafetyError, "scope_or_nonce"):
                verify(receipt, {**self.request, key: value}, self.public)
        for now in (time.time() + 61, time.time() - 10):
            with self.assertRaisesRegex(SafetyError, "expired_or_future"):
                verify(receipt, self.request, self.public, now=now)
        other = self.root / "other.pem"
        subprocess.run(["/usr/bin/openssl", "genpkey", "-algorithm", "ED25519", "-out", str(other)], check=True, capture_output=True)
        with self.assertRaisesRegex(SafetyError, "signature"):
            verify(receipt, self.request, other)

    def test_signed_inconsistent_usage_rejected(self):
        receipt = self.collector.capture(self.request)
        receipt["payload"]["sample"]["session_id"] = "child"
        receipt["signature"] = crypto(receipt["payload"], self.private)
        with self.assertRaisesRegex(SafetyError, "sample_scope"):
            verify(receipt, self.request, self.public)

    def test_request_missing_extra_bad_nonce_and_window(self):
        for request in ({}, {**self.request, "file": "/secret"}, {**self.request, "nonce": "1"},
                        {**self.request, "since": None}, {**self.request, "scope": {**self.scope, "provider": "trae"}}):
            with self.subTest(request=request), self.assertRaises(SafetyError):
                validate_request(request)
        with self.assertRaisesRegex(SafetyError, "capture_window"):
            self.collector.capture({**self.request, "since": END, "until": START})

    def test_preflight_then_run_uses_same_identity_pin(self):
        request = {**self.request, "scope": {**self.scope, "run_id": None}, "since": None, "until": None}
        receipt = self.collector.capture(request)
        self.assertIsNone(verify(receipt, request, self.public)["sample"])
        self.process_stat("101")
        with self.assertRaisesRegex(SafetyError, "process_or_session_changed"):
            self.collector.capture(self.request)

    def test_scope_enrollment_before_native_or_proc(self):
        for field, value in (("runtime_id", "foreign"), ("host", "foreign"), ("worktree_id", "foreign"), ("run_id", "foreign")):
            with self.subTest(field=field), self.assertRaisesRegex(SafetyError, "not_enrolled"):
                self.collector.capture({**self.request, "scope": {**self.scope, field: value}})
        self.assertEqual(self.native.calls, [])

    def test_terminal_native_identity_fields_are_mandatory(self):
        for field, value in (("worktreeId", "foreign"), ("executionHostId", "ssh:remote"), ("agentIdentity", "trae"),
                             ("incarnationId", None), ("connected", False), ("handle", "foreign")):
            with self.subTest(field=field), patch.dict(self.native.row, {field: value}):
                with self.assertRaisesRegex(SafetyError, "terminal_unverifiable"):
                    self.collector.terminal(self.scope)

    def test_native_worker_dispatch_and_provider_crosscheck(self):
        scope = {**self.scope, "agent_id": "dispatch-1"}
        self.assertEqual(self.collector.terminal(scope)["handle"], "term-1")
        for field, value in (("runId", "other"), ("id", "other"), ("hostScope", "ssh:other")):
            with self.subTest(field=field), patch.dict(self.native.worker["dispatch"], {field: value}):
                with self.assertRaisesRegex(SafetyError, "dispatch_scope"):
                    self.collector.terminal(scope)
        self.native.worker["worker"]["startOptions"]["launch"]["effective"]["agent"] = "trae"
        with self.assertRaisesRegex(SafetyError, "provider_mismatch"):
            self.collector.terminal(scope)

    def test_denied_environ_latches_and_restart_does_not_retry(self):
        with patch.object(self.proc, "matches", side_effect=PermissionError("SECRET PATH")):
            with self.assertRaisesRegex(SafetyError, "binding_permission_denied"):
                self.collector.capture(self.request)
        self.assertEqual(self.store.entries("binding-receipt:"), {})
        self.store.close()
        self.store = Store(self.root / "state")
        restarted = Collector(self.config, self.store, self.native, self.proc)
        with patch.object(self.proc, "capture") as capture:
            with self.assertRaisesRegex(SafetyError, "latched_unverifiable"):
                restarted.capture(self.request)
            capture.assert_not_called()
        self.assertNotIn("SECRET", json.dumps(self.store.entries("binding-target:")))

    def test_explicit_resume_preserves_pin_and_failure_history(self):
        self.collector.capture(self.request)
        self.process_stat("101")
        with self.assertRaises(SafetyError):
            self.collector.capture(self.request)
        resume(self.config, self.store, "term-1", "operator_verified_access")
        with self.assertRaisesRegex(SafetyError, "process_or_session_changed"):
            self.collector.capture(self.request)
        self.assertEqual(self.store.db.execute("SELECT count(*) FROM events").fetchone()[0], 1)

    def test_initial_permission_failure_can_be_explicitly_resumed(self):
        with patch.object(self.proc, "capture", side_effect=PermissionError()):
            with self.assertRaises(SafetyError):
                self.collector.capture(self.request)
        resume(self.config, self.store, "term-1", "operator_verified_access")
        self.assertEqual(self.collector.capture(self.request)["payload"]["identity"]["session_id"], "root")

    def test_ambiguous_roots_missing_root_and_unknown_origin(self):
        second = self.session("root2", "cli", "8")
        with self.assertRaisesRegex(SafetyError, "ambiguous"):
            self.proc.discover("term-1")
        (self.directory / "fd/8").unlink()
        second.unlink()
        with self.assertRaisesRegex(SafetyError, "ambiguous"):
            self.proc.discover("wrong-terminal")
        self.log.write_bytes(encoded({"type": "session_meta", "payload": {"id": "root", "source": "unknown"}}) + b"\n")
        with self.assertRaisesRegex(SafetyError, "session_origin"):
            self.proc.discover("term-1")

    def test_child_only_is_not_root(self):
        (self.directory / "fd/7").unlink()
        self.session("child", {"subagent": "review"}, "8")
        with self.assertRaisesRegex(SafetyError, "ambiguous"):
            self.proc.discover("term-1")

    def test_duplicate_fds_deduplicated(self):
        (self.directory / "fd/8").symlink_to(self.log)
        self.assertEqual(self.proc.discover("term-1")[0]["session_id"], "root")

    def test_uid_executable_root_and_size(self):
        with patch.object(self.proc, "uid", os.getuid() + 1):
            with self.assertRaisesRegex(SafetyError, "uid_changed"):
                self.proc.process("42")
        with patch.object(self.proc, "executables", set()):
            with self.assertRaisesRegex(SafetyError, "executable_changed"):
                self.proc.process("42")
        with patch.object(self.proc, "log_roots", [self.root / "elsewhere"]):
            with self.assertRaisesRegex(SafetyError, "outside_roots"):
                self.proc.discover("term-1")
        with patch.object(self.proc, "max_bytes", 1):
            with self.assertRaisesRegex(SafetyError, "configured_max_bytes"):
                self.proc.capture("term-1", START, END)

    def test_incarnation_change_during_capture(self):
        original = self.proc.capture
        def changing(*args):
            value = original(*args)
            self.native.row["incarnationId"] = "new"
            return value
        with patch.object(self.proc, "capture", side_effect=changing):
            with self.assertRaisesRegex(SafetyError, "terminal_changed_during_capture"):
                self.collector.capture(self.request)

    def test_pid_change_during_scan(self):
        from swarm_ledger.codex import scan
        def changing(*args, **kwargs):
            value = scan(*args, **kwargs)
            self.process_stat("999")
            return value
        with patch("swarm_ledger.binding_host.scan", side_effect=changing):
            with self.assertRaisesRegex(SafetyError, "process_or_session_changed"):
                self.proc.capture("term-1", START, END)

    def test_prefix_append_allowed_rewrite_and_truncation_rejected(self):
        identity, prefix, _ = self.proc.capture("term-1", START, END)
        previous = {"identity": identity, "prefix": prefix}
        original = self.log.read_bytes()
        with self.log.open("ab") as output:
            output.write(encoded({"type": "response_item", "payload": {"secret": "SECRET"}}) + b"\n")
        self.assertGreater(self.proc.capture("term-1", START, END, previous)[1]["bytes"], prefix["bytes"])
        for content in (original[:-20], original.replace(b'"input_tokens":12', b'"input_tokens":13')):
            self.log.write_bytes(content)
            with self.assertRaisesRegex(SafetyError, "history_changed"):
                self.proc.capture("term-1", START, END, previous)

    def test_same_size_rewrite_during_scan_rejected(self):
        from swarm_ledger.codex import scan
        def changing(*args, **kwargs):
            value = scan(*args, **kwargs)
            self.log.write_bytes(self.log.read_bytes().replace(b'"input_tokens":12', b'"input_tokens":13'))
            return value
        with patch("swarm_ledger.binding_host.scan", side_effect=changing):
            with self.assertRaisesRegex(SafetyError, "rewritten_during_capture"):
                self.proc.capture("term-1", START, END)

    def test_unknown_usage_remains_unknown(self):
        self.log.write_bytes(self.log.read_bytes().splitlines(keepends=True)[0])
        payload = self.collector.capture(self.request)["payload"]
        self.assertIsNone(payload["sample"]["tokens"]["input_tokens"])
        self.assertFalse(payload["sample"]["complete"])

    def test_slow_capture_not_signed_fresh(self):
        with patch.object(self.collector, "clock", side_effect=[time.time(), time.time(), time.time() + 55]):
            with self.assertRaisesRegex(SafetyError, "capture_too_slow"):
                self.collector.capture(self.request)

    def test_host_config_private_and_explicit_isolation(self):
        path = self.root / "config.json"
        config = {**self.config, "cli": str(Path("/bin/false").resolve())}
        path.write_bytes(encoded(config))
        path.chmod(0o600)
        self.assertEqual(configuration(path), config)
        for field, value in (("host", "elsewhere"), ("uid", -1), ("isolation_verified", False)):
            path.write_bytes(encoded({**config, field: value}))
            with self.assertRaises(SafetyError):
                configuration(path)
        path.write_bytes(encoded(config))
        path.chmod(0o644)
        with self.assertRaisesRegex(SafetyError, "not_private"):
            configuration(path)

    def test_host_log_limit_is_optional_without_implementation_ceiling(self):
        path = self.root / "config.json"
        base = {**self.config, "cli": str(Path("/bin/false").resolve())}
        del base["max_log_bytes"]
        for config in (base, {**base, "max_log_bytes": None},
                       {**base, "max_log_bytes": 1024 * 1024 * 1024}):
            path.write_bytes(encoded(config))
            path.chmod(0o600)
            self.assertEqual(configuration(path), config)
        for value in (0, -1, True, "unlimited"):
            path.write_bytes(encoded({**base, "max_log_bytes": value}))
            with self.subTest(value=value), self.assertRaisesRegex(SafetyError, "invalid_size_limit"):
                configuration(path)

    def test_metadata_larger_than_64_kib_is_supported(self):
        content = self.log.read_bytes()
        first, rest = content.split(b"\n", 1)
        meta = json.loads(first)
        meta["payload"]["extra"] = "x" * (128 * 1024)
        self.log.write_bytes(encoded(meta) + b"\n" + rest)
        self.assertEqual(self.proc.discover("term-1")[0]["session_id"], "root")

    def test_default_proc_accepts_log_larger_than_256_mib(self):
        row = encoded({"type": "response_item", "payload": {"text": "x" * (1024 * 1024)}}) + b"\n"
        with self.log.open("ab") as target:
            for _ in range(257):
                target.write(row)
        proc = Proc(self.proc.uid, self.proc.executables, self.proc.log_roots, root=self.proc.root)
        identity, prefix, _ = proc.capture("term-1", START, END)
        self.assertEqual(identity["session_id"], "root")
        self.assertEqual(prefix["bytes"], self.log.stat().st_size)

    def test_reader_only_adds_readonly_terminal_show(self):
        def runner(argv, **kwargs):
            return subprocess.CompletedProcess(argv, 0, json.dumps({"ok": True, "result": {"terminal": self.native.row},
                                                                    "_meta": {"runtimeId": "rt"}}))
        reader = Reader("/verified/orca", "rt", runner=runner, env={})
        self.assertEqual(reader.read("terminal", "show", "--terminal", "term-1")["terminal"]["handle"], "term-1")
        with self.assertRaisesRegex(SafetyError, "read-only"):
            reader.read("terminal", "create")

    def test_socket_client_replay_and_no_proc_dependency(self):
        receipt = self.collector.capture(self.request)
        endpoint = str(self.root / "socket")
        with socket.socket(socket.AF_UNIX) as server:
            server.bind(endpoint)
            server.listen(1)
            def stale_reply():
                with server.accept()[0] as connection:
                    receive(connection)
                    connection.sendall(encoded(receipt) + b"\n")
            thread = threading.Thread(target=stale_reply)
            thread.start()
            try:
                with patch.object(Proc, "capture", side_effect=AssertionError("consumer must not read proc")):
                    with self.assertRaisesRegex(SafetyError, "nonce"):
                        Client(endpoint, self.public).capture(self.scope, START, END)
            finally:
                thread.join(5)
            self.assertFalse(thread.is_alive())

    def test_offline_end_to_end_socket_signed_receipt_atomic_ledger(self):
        endpoint = str(self.root / "socket")
        options = [{"provider": "codex", "format": "host-receipt", "agent_id": "coordinator", "socket": endpoint,
                    "public_key": str(self.public), "host": socket.gethostname(), "worktree_id": "wt", "since": START, "until": END}]
        path = self.root / "bindings.json"
        path.write_bytes(encoded(options))
        args = ["--state", str(self.root / "ledger"), "sync", "--runtime-id", "rt", "--run", "run-1",
                "--cli", "/verified/orca", "--bindings", str(path)]
        failures = []
        # The host SQLite connection stays on its owning (main) thread.
        def consumer():
            try:
                with patch("swarm_ledger.__main__.Reader.collect", return_value=(run(), [])), redirect_stdout(io.StringIO()):
                    self.assertEqual(main(args), 0)
            except BaseException as error:
                failures.append(error)
        with socket.socket(socket.AF_UNIX) as server:
            server.settimeout(5)
            server.bind(endpoint)
            server.listen(1)
            thread = threading.Thread(target=consumer)
            thread.start()
            with server.accept()[0] as connection:
                request = receive(connection)
                connection.sendall(encoded(self.collector.capture(request)) + b"\n")
            thread.join(10)
        self.assertFalse(thread.is_alive())
        self.assertEqual(failures, [])
        ledger = Ledger(self.root / "ledger")
        try:
            report = ledger.report("rt", "run-1")
            self.assertEqual(report["summary"]["known_tokens"]["total_tokens"], 15)
            self.assertEqual(report["summary"]["usage_status"], "incomplete")
            self.assertEqual(len(ledger.store.entries("host-receipt:")), 1)
            export(ledger, self.root / "export")
            evidence = list((self.root / "export").rglob("host-bindings.json"))
            self.assertEqual(len(evidence), 1)
            self.assertEqual(len(json.loads(evidence[0].read_text())), 1)
        finally:
            ledger.close()
        options[0]["final"] = True
        path.write_bytes(encoded(options))
        with patch("swarm_ledger.__main__.Reader.collect", return_value=(run(), [])):
            with self.assertRaisesRegex(SafetyError, "cannot_finalize"):
                main(args)


if __name__ == "__main__":
    unittest.main()

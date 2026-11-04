import copy
from contextlib import redirect_stdout
import io
import json
import os
from pathlib import Path
import socket
import tempfile
import unittest
from unittest.mock import patch

from supervisor.config import SafetyError, digest
from swarm_ledger import runtime_binding as binding
from swarm_ledger.__main__ import main
from swarm_ledger.ledger import Ledger, seconds
from swarm_ledger.report import export
from test_ledger import START, END, event, run, worker


NOW = seconds(END) + 60


class Native:
    runtime_id = "rt"
    environment = None

    def __init__(self):
        self.calls = []
        self.on_read = lambda argv: None
        self.run = run()
        self.worker = worker(ended=None)
        self.worker["dispatch"]["hostScope"] = "local"
        self.worker["terminal"]["handle"] = "term-1"
        self.status = {"target": {"kind": "local"}, "app": {"running": True, "pid": 123},
                       "runtime": {"runtimeId": "rt", "state": "ready", "reachable": True, "appVersion": "1.4.219"}}
        self.terminal = {"handle": "term-1", "worktreeId": "worktree-1", "tabId": "tab-1", "leafId": "leaf-1",
                         "ptyId": "pty-1", "incarnationId": "incarnation-1", "executionHostId": "local",
                         "agentIdentity": "codex", "connected": True, "orphaned": False,
                         "preview": "SECRET preview"}

    def read(self, *argv):
        self.calls.append(argv)
        self.on_read(argv)
        if argv == ("status",):
            return copy.deepcopy(self.status)
        if argv == ("terminal", "show", "--terminal", "term-1"):
            return {"terminal": copy.deepcopy(self.terminal)}
        if argv == ("orchestration", "run-show", "--id", "run-1"):
            return {"run": copy.deepcopy(self.run)}
        if argv == ("orchestration", "worker-show", "--dispatch", "dispatch-1"):
            return copy.deepcopy(self.worker)
        raise AssertionError("unexpected native operation: " + str(argv))

    def verify_runtime(self):
        return self.read("status")["runtime"]

    def collect(self, rid):
        assert rid == "run-1"
        return copy.deepcopy(self.run), [copy.deepcopy(self.worker)]


class RuntimeBindingFixture:
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()
        self.profile = self.root / "profile"
        (self.profile / "agent-hooks").mkdir(parents=True, mode=0o700)
        self.logs = self.root / "sessions"
        self.logs.mkdir(mode=0o700)
        self.log = self.logs / "session.jsonl"
        self.meta = {"type": "session_meta", "payload": {"id": "session-1", "source": "cli", "cwd": "SECRET cwd"}}
        self.records = [self.meta, event(0, 0, 0), event(2, 100, 100),
                        {"type": "response_item", "payload": {"text": "SECRET transcript"}}]
        self.write_log()
        self.runtime = {"runtimeId": "rt", "pid": 123, "startedAt": (seconds(START) - 60) * 1000,
                        "authToken": "SECRET token", "transports": {"secret": "SECRET transport"}}
        self.entry = {"worktreeId": "worktree-1", "tabId": "tab-1", "source": "codex",
                      "payload": {"agentType": "codex", "prompt": "SECRET prompt"},
                      "receivedAt": (NOW - 20) * 1000, "evidenceObservedAt": (NOW - 30) * 1000,
                      "providerSession": {"key": "session_id", "id": "session-1", "transcriptPath": str(self.log)}}
        self.hooks = {"version": 2, "entries": {"tab-1:leaf-1": self.entry}, "extra": "SECRET hooks"}
        self.write_states()
        self.options = {"provider": "codex", "format": "runtime-state", "host": socket.gethostname(),
                        "profile": str(self.profile), "log_root": str(self.logs), "terminal_handle": "term-1",
                        "worktree_id": "worktree-1", "agent_id": "coordinator", "since": START, "until": END}
        self.native = Native()
        self.ledger = Ledger(self.root / "state", clock=lambda: NOW)
        self.ledger.sync("rt", self.native.run, [self.native.worker])

    def tearDown(self):
        self.ledger.close()
        self.tmp.cleanup()

    def write_json(self, path, data):
        path.write_text(json.dumps(data))
        path.chmod(0o600)

    def write_log(self):
        self.log.write_text("".join(json.dumps(r) + "\n" for r in self.records))
        self.log.chmod(0o600)

    def write_states(self):
        self.write_json(self.profile / "orca-runtime.json", self.runtime)
        self.write_json(self.profile / "agent-hooks" / "last-status.json", self.hooks)

    def capture(self, **kwargs):
        return binding.capture(self.native, self.options, clock=lambda: NOW, **kwargs)

    def import_sample(self):
        with self.ledger.transaction():
            result = binding.ledger_sample(self.ledger, self.native, "rt", "run-1", self.options)
            self.ledger.usage("rt", "run-1", self.options["agent_id"], result)
            return result


class RuntimeBindingTests(RuntimeBindingFixture, unittest.TestCase):
    def test_preflight_redacted_no_usage_or_lifecycle_import(self):
        before = self.ledger.report("rt", "run-1")
        value = binding.preflight(self.ledger, self.native, self.options)
        self.assertFalse(value["usage_imported"])
        self.assertFalse(value["lifecycle_verified"])
        self.assertIsNone(value["evidence"]["sample"])
        self.assertEqual(value["evidence"]["trust"], "runtime-state-not-process-attested")
        self.assertNotIn("SECRET", json.dumps(value))
        self.assertNotIn("SECRET", json.dumps(self.ledger.store.entries("runtime-state-")))
        self.assertEqual(before, self.ledger.report("rt", "run-1"))
        self.assertTrue(all(c == ("status",) or c[:2] == ("terminal", "show") for c in self.native.calls))

    def test_usage_partial_and_receipt_export(self):
        result = self.import_sample()
        self.assertEqual(result["tokens"]["input_tokens"], 100)
        self.assertEqual(result["tokens"]["output_tokens"], 50)
        self.assertFalse(result["complete"])
        self.assertIn("runtime_state_not_process_attested", result["warnings"])
        report = self.ledger.report("rt", "run-1")
        self.assertEqual(report["summary"]["known_tokens"]["total_tokens"], 150)
        self.assertIsNone(report["summary"]["total_tokens"])
        export(self.ledger, self.root / "out")
        receipt_path = next((self.root / "out").rglob("runtime-bindings.json"))
        receipts = json.loads(receipt_path.read_text())
        receipt_id = result["source"].removeprefix("runtime-state:sha256:")
        self.assertEqual(digest(receipts[receipt_id]), receipt_id)
        self.assertEqual(receipts[receipt_id]["native_scope"]["terminal_handle"], "term-1")
        self.assertFalse(receipts[receipt_id]["sample"]["complete"])
        self.assertNotIn("SECRET", "".join(p.read_text() for p in (self.root / "out").rglob("*") if p.is_file()))

    def test_no_proc_or_host_collector(self):
        real_open = os.open

        def guarded(path, *args, **kwargs):
            self.assertFalse(str(path).startswith(("/proc", "/sys", "/dev")))
            return real_open(path, *args, **kwargs)

        with patch.object(binding.os, "open", side_effect=guarded), \
                patch("swarm_ledger.__main__.host_binding.ledger_sample", side_effect=AssertionError("fallback")):
            self.import_sample()

    def test_explicit_mode_host_final_roots_and_age(self):
        changes = [("provider", "unknown"), ("format", "jsonl"), ("host", "other-host"), ("final", True),
                   ("final", 0), ("profile", "/proc"), ("log_root", "/dev"), ("log_root", "/"),
                   ("max_hook_age_seconds", 0), ("max_hook_age_seconds", 86401), ("max_hook_age_seconds", True),
                   ("terminal_handle", ""), ("worktree_id", "bad\nidentifier")]
        for key, value in changes:
            with self.subTest(key=key, value=value), self.assertRaises(SafetyError):
                binding.configuration({**self.options, key: value})

    def test_wrong_runtime_route_pid_and_terminal_identity(self):
        cases = [(self.runtime, "runtimeId", "other"), (self.runtime, "pid", 456),
                 (self.native.status["target"], "kind", "remote"), (self.native.status["app"], "running", False),
                 *((self.native.terminal, key, value) for key, value in
                   (("connected", False), ("orphaned", True), ("worktreeId", "wrong"),
                    ("agentIdentity", "trae"), ("executionHostId", "ssh:host"), ("ptyId", None)))]
        for obj, key, value in cases:
            old = obj[key]
            obj[key] = value
            self.write_states()
            with self.subTest(key=key), self.assertRaises(SafetyError):
                self.capture()
            obj[key] = old
        self.write_states()
        self.native.environment = "remote"
        with self.assertRaisesRegex(SafetyError, "remote_route"):
            self.capture()

    def test_hook_schema_pane_provider_and_session(self):
        cases = [(self.hooks, "version", 1), (self.hooks, "entries", {}),
                 (self.entry, "source", "claude"), (self.entry, "tabId", "wrong"),
                 (self.entry, "worktreeId", "wrong"), (self.entry, "structuredHost", True),
                 (self.entry, "restoredUnconfirmed", True), (self.entry, "isReplay", True),
                 (self.entry["providerSession"], "key", "thread_id"),
                 (self.entry["providerSession"], "id", "wrong"),
                 (self.entry["providerSession"], "transcriptPath", str(self.root / "elsewhere.jsonl"))]
        for obj, key, value in cases:
            old, present = obj.get(key), key in obj
            obj[key] = value
            self.write_states()
            with self.subTest(key=key), self.assertRaises(SafetyError):
                self.capture()
            if present:
                obj[key] = old
            else:
                del obj[key]

    def test_hook_time_boundaries(self):
        baseline = copy.deepcopy(self.entry)
        for observed, received in ((NOW - 86401, NOW), (seconds(START) - 61, NOW),
                                   (NOW + 6, NOW + 6), (NOW, NOW - 1), (None, NOW)):
            self.entry.update(evidenceObservedAt=observed * 1000 if observed else None, receivedAt=received * 1000)
            self.write_states()
            with self.subTest(observed=observed), self.assertRaises(SafetyError):
                self.capture()
        self.entry.update(baseline)
        self.options["max_hook_age_seconds"] = 30
        self.write_states()
        self.capture()
        self.options["max_hook_age_seconds"] = 29
        with self.assertRaisesRegex(SafetyError, "stale"):
            self.capture()

    def test_child_unknown_and_wrong_session_meta_rejected(self):
        for key, value in (("source", {"subagent": "worker"}), ("source", "exec"),
                           ("source", None), ("id", "other")):
            original = self.meta["payload"][key]
            self.meta["payload"][key] = value
            self.write_log()
            with self.subTest(key=key, value=value), self.assertRaisesRegex(SafetyError, "root_session"):
                self.capture()
            self.meta["payload"][key] = original

    def test_private_regular_owned_canonical_files(self):
        state = self.profile / "orca-runtime.json"
        state.chmod(0o644)
        with self.assertRaisesRegex(SafetyError, "not_private"):
            self.capture()
        state.chmod(0o600)
        alias = self.root / "alias"
        alias.symlink_to(self.profile, target_is_directory=True)
        with self.assertRaisesRegex(SafetyError, "noncanonical"):
            binding.configuration({**self.options, "profile": str(alias)})
        with patch.object(binding.os, "getuid", return_value=os.getuid() + 1), \
                self.assertRaisesRegex(SafetyError, "owner_or_type"):
            self.capture()

    def test_state_larger_than_16_mib_is_supported(self):
        self.hooks["extra"] = "x" * (17 * 1024 * 1024)
        self.write_states()
        result = self.capture()
        self.assertEqual(result["identity"]["session_id"], "session-1")

    def test_metadata_larger_than_64_kib_is_supported(self):
        self.meta["payload"]["extra"] = "x" * (128 * 1024)
        self.write_log()
        self.assertEqual(self.capture()["identity"]["session_id"], "session-1")

    def test_log_larger_than_128_mib_is_supported(self):
        row = json.dumps({"type": "response_item", "payload": {"text": "x" * (1024 * 1024)}}).encode() + b"\n"
        with self.log.open("ab") as target:
            for _ in range(129):
                target.write(row)
        result = self.capture(since=START, until=END)
        self.assertEqual(result["prefix"]["bytes"], self.log.stat().st_size)
        self.assertEqual(result["sample"]["tokens"]["input_tokens"], 100)

    def test_append_allowed_but_rewrite_truncate_replace_rejected(self):
        before = self.capture()
        self.records.append(event(3, 200, 100))
        self.write_log()
        after = self.capture(previous=before, since=START, until=END)
        self.assertEqual(after["sample"]["tokens"]["input_tokens"], 200)
        self.records[1] = event(0, 1, 1)
        self.write_log()
        with self.assertRaisesRegex(SafetyError, "history_changed"):
            self.capture(previous=after)
        self.records = [self.meta]
        self.write_log()
        with self.assertRaisesRegex(SafetyError, "history_changed"):
            self.capture(previous=after)
        original = self.capture()
        replacement = self.logs / "replacement.jsonl"
        replacement.write_bytes(self.log.read_bytes())
        replacement.replace(self.log)
        with self.assertRaisesRegex(SafetyError, "log_replaced"):
            self.capture(previous=original)

    def test_preflight_pin_survives_reopen_and_blocks_session_or_incarnation_change(self):
        binding.preflight(self.ledger, self.native, self.options)
        self.ledger.close()
        self.ledger = Ledger(self.root / "state", clock=lambda: NOW)
        self.native.terminal["incarnationId"] = "next-incarnation"
        with self.assertRaisesRegex(SafetyError, "session_or_incarnation"):
            self.import_sample()
        self.native.terminal["incarnationId"] = "incarnation-1"
        self.entry["providerSession"]["id"] = "new-session"
        self.write_states()
        with self.assertRaisesRegex(SafetyError, "session_or_incarnation"):
            self.import_sample()

    def test_hook_regression_and_during_capture_identity_change(self):
        before = self.capture()
        self.entry["receivedAt"] -= 1000
        self.write_states()
        with self.assertRaisesRegex(SafetyError, "hook_regressed"):
            self.capture(previous=before)
        self.native.calls.clear()

        def change(argv):
            if argv[:2] == ("terminal", "show") and self.native.calls.count(argv) == 2:
                self.native.terminal["incarnationId"] = "changed"

        self.native.on_read = change
        with self.assertRaisesRegex(SafetyError, "identity_changed_during"):
            self.capture()

    def test_log_rewrite_during_scan_rejected(self):
        real_scan = binding.scan

        def rewrite(*args, **kwargs):
            result = real_scan(*args, **kwargs)
            self.records[1] = event(0, 1, 1)
            self.write_log()
            return result

        with patch.object(binding, "scan", side_effect=rewrite), \
                self.assertRaisesRegex(SafetyError, "changed_during_capture"):
            self.capture(since=START, until=END)

    def test_invalid_and_future_window_and_slow_capture(self):
        for begin, end in ((START, None), (END, START), (END, END), (START, "2026-10-13T00:12:00Z")):
            with self.subTest(begin=begin, end=end), self.assertRaises(SafetyError):
                self.capture(since=begin, until=end)
        with self.assertRaisesRegex(SafetyError, "too_slow"):
            binding.capture(self.native, self.options, clock=iter([NOW, NOW + 50, NOW + 50]).__next__)

    def test_empty_malformed_and_partial_logs_remain_unknown(self):
        self.records = [self.meta]
        self.write_log()
        with self.log.open("ab") as stream:
            stream.write(b"not-json\n{partial")
        result = self.import_sample()
        self.assertIsNone(result["tokens"]["input_tokens"])
        self.assertIn("no_usage_events_in_window", result["warnings"])
        self.assertIn("malformed_record", result["warnings"])
        self.assertIn("partial_final_line", result["warnings"])

    def test_native_run_rebinding_refused_before_and_after_capture(self):
        self.native.run["coordinator_handle"] = "other"
        with self.assertRaisesRegex(SafetyError, "native_actor"):
            self.import_sample()
        self.native.run["coordinator_handle"] = "term-1"

        def change(argv):
            if argv[:2] == ("terminal", "show"):
                self.native.run["coordinator_handle"] = "other"

        self.native.on_read = change
        with self.assertRaisesRegex(SafetyError, "native_actor"):
            self.import_sample()
        self.assertEqual(self.ledger.store.entries("runtime-state-"), {})

    def test_worker_scope_checks_and_actor_window(self):
        self.options.update(agent_id="dispatch-1", since="2026-10-13T00:01:00Z")
        self.assertEqual(self.import_sample()["tokens"]["input_tokens"], 100)
        for key, value in (("runId", "other"), ("id", "other"), ("taskId", "other"), ("hostScope", "ssh:other")):
            old = self.native.worker["dispatch"][key]
            self.native.worker["dispatch"][key] = value
            with self.subTest(key=key), self.assertRaises(SafetyError):
                self.import_sample()
            self.native.worker["dispatch"][key] = old
        self.native.worker["worker"]["startOptions"]["launch"]["effective"]["agent"] = "trae"
        with self.assertRaisesRegex(SafetyError, "provider_mismatch"):
            self.import_sample()
        self.native.worker["worker"]["startOptions"]["launch"]["effective"]["agent"] = "codex"
        self.options["since"] = START
        with self.assertRaisesRegex(SafetyError, "window_before_actor"):
            self.import_sample()

    def test_completed_actor_requires_bounded_end(self):
        self.native.worker["dispatch"]["completedAt"] = "2026-10-13T00:05:00Z"
        self.ledger.sync("rt", self.native.run, [self.native.worker])
        self.options.update(agent_id="dispatch-1", since="2026-10-13T00:01:00Z")
        with self.assertRaisesRegex(SafetyError, "window_after_actor"):
            self.import_sample()
        self.options["until"] = "2026-10-13T00:05:00Z"
        self.import_sample()

    def test_transaction_rollback_removes_new_receipts_pins_and_usage(self):
        before = self.ledger.report("rt", "run-1")
        with self.assertRaisesRegex(SafetyError, "later_invalid_binding"):
            with self.ledger.transaction():
                self.import_sample()
                raise SafetyError("later_invalid_binding")
        self.assertEqual(self.ledger.store.entries("runtime-state-"), {})
        self.assertEqual(before, self.ledger.report("rt", "run-1"))

    def test_permission_error_does_not_retry_or_fallback(self):
        with patch.object(binding.os, "open", side_effect=PermissionError("denied")) as mocked:
            with self.assertRaises(PermissionError):
                binding.preflight(self.ledger, self.native, self.options)
        self.assertEqual(mocked.call_count, 1)
        self.assertEqual(self.ledger.store.entries("runtime-state-"), {})

    def test_cli_preflight_sync_and_later_failure_atomic(self):
        options_path = self.root / "options.json"
        state = self.root / "cli-state"
        self.write_json(options_path, self.options)
        with patch("swarm_ledger.__main__.Reader", return_value=self.native), \
                patch("swarm_ledger.__main__.Ledger", side_effect=lambda path: Ledger(path, clock=lambda: NOW)), \
                patch("swarm_ledger.__main__.host_binding.ledger_sample", side_effect=AssertionError("fallback")):
            with redirect_stdout(io.StringIO()) as output:
                main(["--state", str(state), "runtime-preflight", "--runtime-id", "rt", "--cli", "fake",
                      "--binding", str(options_path)])
            self.assertFalse(json.loads(output.getvalue())["usage_imported"])
            self.write_json(options_path, [self.options])
            args = ["--state", str(state), "sync", "--runtime-id", "rt", "--run", "run-1", "--cli", "fake",
                    "--bindings", str(options_path)]
            with redirect_stdout(io.StringIO()) as output:
                main(args)
            self.assertEqual(json.loads(output.getvalue())["summary"]["known_tokens"]["total_tokens"], 150)
            check = Ledger(state)
            before = check.store.entries("")
            check.close()
            self.records.append(event(3, 200, 100))
            self.write_log()
            self.write_json(options_path, [self.options, {"provider": "invalid"}])
            with self.assertRaisesRegex(SafetyError, "unsupported usage binding"):
                main(args)
            check = Ledger(state)
            self.assertEqual(before, check.store.entries(""))
            check.close()


if __name__ == "__main__":
    unittest.main()

import copy
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

from native_preflight import PreflightError, _default_runner, cli_main, run_preflight


NOW = datetime(2026, 10, 15, 10, 0, 10, tzinfo=timezone.utc)


class FakeRunner:
    def __init__(self, contract, *, delay=0):
        self.contract = contract
        self.delay = delay
        self.calls = []
        self.timeouts = []
        self.active = 0
        self.max_active = 0
        self.lock = threading.Lock()
        self.fail = {}
        self.responses = {}
        self.runtime_id = contract["runtime_id"]
        self.runtime_version = contract["runtime_version"]
        self.heads = {item["path"]: item["head"] for item in contract["baselines"]}
        self.diff = {item["path"]: b"" for item in contract["baselines"]}
        self.index = {item["path"]: b"" for item in contract["baselines"]}
        self.untracked = {item["path"]: b"" for item in contract["baselines"]}

    def __call__(self, argv, timeout):
        key = tuple(argv[1:-1] if argv[-1:] == ["--json"] else argv[1:])
        with self.lock:
            self.calls.append(tuple(argv))
            self.timeouts.append(timeout)
            self.active += 1
            self.max_active = max(self.max_active, self.active)
        try:
            if self.delay:
                time.sleep(self.delay)
            if key in self.fail:
                value = {"ok": False, "error": self.fail[key],
                         "_meta": {"runtimeId": self.runtime_id}}
                return subprocess.CompletedProcess(argv, 1, json.dumps(value).encode(), b"PRIVATE RAW")
            if key in self.responses:
                return subprocess.CompletedProcess(
                    argv, 0, json.dumps(self.responses[key]).encode(), b"")
            if argv[0] == "git":
                repo = argv[3]
                if argv[4:] == ["rev-parse", "HEAD"]:
                    return subprocess.CompletedProcess(argv, 0, (self.heads[repo] + "\n").encode(), b"")
                if argv[4:5] == ["diff"]:
                    output = self.index[repo] if "--cached" in argv else self.diff[repo]
                    return subprocess.CompletedProcess(argv, 0, output, b"")
                return subprocess.CompletedProcess(argv, 0, self.untracked[repo], b"")
            if key == ("status",):
                result = {"runtime": {"runtimeId": self.runtime_id,
                                      "appVersion": self.runtime_version,
                                      "state": "ready", "reachable": True},
                          "target": {"kind": "local"}, "app": {"running": True, "pid": 123}}
            elif key[:2] == ("worktree", "show"):
                result = {"worktree": {"id": self.contract["workspace"]["id"],
                                       "path": self.contract["workspace"]["path"],
                                       "isArchived": False}}
            elif key[:2] == ("terminal", "show"):
                result = {"terminal": {"handle": self.contract["terminal"]["handle"],
                                       "incarnationId": self.contract["terminal"]["incarnation_id"],
                                       "worktreeId": self.contract["workspace"]["id"],
                                       "agentIdentity": self.contract["terminal"]["agent"],
                                       "connected": True, "orphaned": False,
                                       "executionHostId": "local", "tabId": "tab-1",
                                       "leafId": "leaf-1",
                                       "preview": "SECRET PREVIEW"}}
            elif key[:2] == ("orchestration", "run-current"):
                result = {"run": {"id": self.contract["run_id"], "private": "SECRET"}}
            else:
                raise AssertionError(argv)
            value = {"ok": True, "result": result, "_meta": {"runtimeId": self.runtime_id}}
            return subprocess.CompletedProcess(argv, 0, json.dumps(value).encode(), b"")
        finally:
            with self.lock:
                self.active -= 1


class NativePreflightTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.cwd = self.root / "repo"
        self.archive = self.root / "archive"
        self.swarm = self.cwd / "swarm"
        self.cwd.mkdir()
        self.archive.mkdir()
        self.swarm.mkdir()
        self.cli = self.root / "orca-server-cli"
        self.cli.write_text("#!/bin/sh\n")
        self.policy = self.root / "policy.md"
        self.policy.write_text("policy-v1\n")
        self.config = self.root / "config.json"
        self.config.write_text('{"schema_version":1}\n')
        self.session = self.root / "session.json"
        self.probe = self.root / "probe.json"
        self.profile = self.root / "profile"
        self.hooks = self.profile / "agent-hooks" / "last-status.json"
        self.hooks.parent.mkdir(parents=True)
        self.log_root = self.root / "logs"
        self.log_root.mkdir()
        self.log = self.log_root / "exact-session.jsonl"
        self.workspace_id = "repo-id::" + str(self.cwd)
        self.contract = {
            "schema_version": 1,
            "cli": str(self.cli),
            "runtime_id": "runtime-current",
            "runtime_version": "1.4.219",
            "run_id": "run_current",
            "workspace": {"id": self.workspace_id, "path": str(self.cwd)},
            "terminal": {"handle": "term_current", "incarnation_id": "inc-current",
                         "agent": "codex"},
            "session": {"id": "session-current", "provider": "codex", "model": "gpt-test",
                        "effort": "high", "sandbox_mode": "danger-full-access",
                        "approval_policy": "never"},
            "paths": {"cwd": str(self.cwd), "archive_dir": str(self.archive)},
            "runtime_state": {"profile": str(self.profile), "log_root": str(self.log_root)},
            "baselines": [
                {"name": "root", "path": str(self.cwd), "head": "1" * 40, "clean": True},
                {"name": "swarm", "path": str(self.swarm), "head": "2" * 40, "clean": True},
            ],
            "policy_files": [str(self.policy)],
            "config_files": [str(self.config)],
            "evidence": {"session": str(self.session), "file_tool": str(self.probe)},
            "limits": {"per_check_timeout_ms": 1000, "max_parallel": 3,
                       "evidence_max_age_seconds": 60},
            "milestones": {"run_created_at": "2026-10-15T09:59:00Z",
                           "coordinator_turn_started_at": "2026-10-15T09:59:30Z"},
        }
        self.write_runtime_state()
        self.write_evidence()

    def write_runtime_state(self, contract=None):
        contract = contract or self.contract
        (self.profile / "orca-runtime.json").write_text(json.dumps({
            "runtimeId": contract["runtime_id"], "pid": 123,
        }))
        self.hooks.write_text(json.dumps({"version": 2, "entries": {"tab-1:leaf-1": {
            "worktreeId": contract["workspace"]["id"], "tabId": "tab-1", "source": "codex",
            "payload": {"agentType": "codex"},
            "evidenceObservedAt": NOW.timestamp() * 1000 - 1000,
            "receivedAt": NOW.timestamp() * 1000,
            "providerSession": {"key": "session_id", "id": contract["session"]["id"],
                                "transcriptPath": str(self.log)},
        }}}))
        self.log.write_text("\n".join(json.dumps(record) for record in [
            {"type": "session_meta", "payload": {"id": contract["session"]["id"],
                                                  "source": "cli", "cwd": str(self.cwd)}},
            {"type": "turn_context", "payload": {
                "cwd": str(self.cwd), "model": contract["session"]["model"],
                "effort": contract["session"]["effort"],
                "sandbox_policy": {"type": contract["session"]["sandbox_mode"]},
                "approval_policy": contract["session"]["approval_policy"],
            }},
        ]) + "\n")

    def write_evidence(self, *, session_at="2026-10-15T10:00:00Z", probe_at=None,
                       archive=None):
        probe_at = probe_at or session_at
        self.session.write_text(json.dumps({
            "observed_at": session_at,
            "trust": "runtime-state-not-process-attested",
            "runtime_id": self.contract["runtime_id"],
            "run_id": self.contract["run_id"],
            "coordinator_handle": self.contract["terminal"]["handle"],
            "incarnation_id": self.contract["terminal"]["incarnation_id"],
            "session_id": self.contract["session"]["id"],
            "effective": {
                "provider": self.contract["session"]["provider"],
                "model": self.contract["session"]["model"],
                "effort": self.contract["session"]["effort"],
                "sandbox_policy": {"type": self.contract["session"]["sandbox_mode"]},
                "approval_policy": self.contract["session"]["approval_policy"],
            },
        }))
        self.probe.write_text(json.dumps({
            "completed_at": probe_at, "passed": True, "batch_count": 1,
            "roots": [str(archive or self.archive)],
            "actual_tools": ["apply_patch:create", "exec:read", "exec:rename", "exec:read"],
            "runtime_id": self.contract["runtime_id"],
            "run_id": self.contract["run_id"],
            "terminal_handle": self.contract["terminal"]["handle"],
            "incarnation_id": self.contract["terminal"]["incarnation_id"],
            "session_id": self.contract["session"]["id"],
        }))

    def run_case(self, contract=None, runner=None, **kwargs):
        contract = contract or self.contract
        runner = runner or FakeRunner(contract)
        ticks = iter([1.0, 1.125])
        return run_preflight(contract, runner=runner, now=NOW,
                             monotonic=lambda: next(ticks), **kwargs)

    def test_bounded_parallel_compact_sanitized_and_read_only(self):
        runner = FakeRunner(self.contract, delay=0.01)
        before = sorted(str(path.relative_to(self.root)) for path in self.root.rglob("*"))
        result = self.run_case(runner=runner)
        after = sorted(str(path.relative_to(self.root)) for path in self.root.rglob("*"))
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["decision"], "dispatch_explicit_task_once")
        self.assertGreaterEqual(runner.max_active, 2)
        self.assertLessEqual(runner.max_active, 3)
        self.assertEqual(before, after)
        encoded = json.dumps(result, sort_keys=True)
        self.assertLess(len(encoded), 3000)
        self.assertNotIn("SECRET", encoded)
        self.assertNotIn("preview", encoded.lower())
        self.assertFalse(result["handoff"]["cache_is_live_proof"])
        self.assertEqual(result["handoff"]["worker_probe_batches"], 1)
        self.assertIn("Only when no independent authorized actionable work remains",
                      result["handoff"]["blocking_wait"])
        self.assertIn("orchestration check --wait", result["handoff"]["blocking_wait"])
        self.assertIsNone(result["timing"]["dispatch_invoked_at"])
        self.assertIsNone(result["timing"]["worker_first_genuine_tool_at"])
        git_calls = [call for call in runner.calls if call[0] == "git"]
        self.assertTrue(git_calls)
        self.assertTrue(all(call[1] == "--no-optional-locks" for call in git_calls))
        self.assertFalse(any("status" in call for call in git_calls))

    def test_native_failure_is_sanitized_and_never_retried(self):
        runner = FakeRunner(self.contract)
        key = ("terminal", "show", "--terminal", "term_current")
        runner.fail[key] = {"code": "runtime_access_denied", "message": "PRIVATE RAW"}
        result = self.run_case(runner=runner)
        self.assertFalse(result["ok"])
        self.assertEqual(result["decision"], "stop")
        self.assertIn({"check": "volatile.terminal", "code": "native_runtime_access_denied"},
                      result["errors"])
        terminal_calls = [call for call in runner.calls if call[1:3] == ("terminal", "show")]
        self.assertEqual(len(terminal_calls), 1)
        self.assertNotIn("PRIVATE RAW", json.dumps(result))
        self.assertFalse(result["handoff"]["automatic_retry_or_launch"])

    def test_cli_malformed_contract_is_a_sanitized_failure(self):
        malformed = self.root / "malformed.json"
        malformed.write_text(json.dumps({"schema_version": 1}))
        with mock.patch("builtins.print") as output:
            self.assertEqual(cli_main(["--contract", str(malformed)]), 2)
        value = json.loads(output.call_args.args[0])
        self.assertFalse(value["ok"])
        self.assertEqual(value["decision"], "stop")
        self.assertEqual(value["errors"][0]["check"], "contract")

        nested = copy.deepcopy(self.contract)
        nested["session"] = []
        malformed.write_text(json.dumps(nested))
        with mock.patch("builtins.print") as output:
            self.assertEqual(cli_main(["--contract", str(malformed)]), 2)
        self.assertFalse(json.loads(output.call_args.args[0])["ok"])

    def test_stale_terminal_identity_stops_dispatch(self):
        runner = FakeRunner(self.contract)
        runner.contract = copy.deepcopy(self.contract)
        runner.contract["terminal"]["incarnation_id"] = "stale-incarnation"
        result = self.run_case(runner=runner)
        self.assertFalse(result["ok"])
        self.assertIn({"check": "volatile.terminal", "code": "stale_terminal_incarnation"},
                      result["errors"])

    def test_malformed_native_response_is_a_compact_failure(self):
        runner = FakeRunner(self.contract)
        runner.responses[("status",)] = {"ok": True, "result": [],
                                            "_meta": {"runtimeId": self.contract["runtime_id"]}}
        result = self.run_case(runner=runner)
        self.assertFalse(result["ok"])
        self.assertIn({"check": "volatile.runtime", "code": "malformed_runtime_response"},
                      result["errors"])
        self.assertNotIn("Traceback", json.dumps(result))

    def test_session_settings_and_file_tool_identity_are_required(self):
        session = json.loads(self.session.read_text())
        session["effective"]["model"] = "wrong-model"
        self.session.write_text(json.dumps(session))
        result = self.run_case()
        self.assertIn({"check": "volatile.session_evidence", "code": "session_settings_changed"},
                      result["errors"])

        self.write_evidence()
        probe = json.loads(self.probe.read_text())
        for key in ("runtime_id", "run_id", "terminal_handle", "incarnation_id"):
            del probe[key]
        self.probe.write_text(json.dumps(probe))
        result = self.run_case()
        self.assertIn({"check": "volatile.file_tool_evidence",
                       "code": "file_tool_identity_unbound"}, result["errors"])

        probe["session_evidence_sha256"] = hashlib.sha256(self.session.read_bytes()).hexdigest()
        self.probe.write_text(json.dumps(probe))
        self.assertTrue(self.run_case()["ok"])

    def test_stable_fingerprint_invalidates_every_required_input_class(self):
        runner = FakeRunner(self.contract)
        base = self.run_case(runner=runner)
        receipt = self.root / "prior.json"
        receipt.write_text(json.dumps(base))
        matched = self.run_case(runner=FakeRunner(self.contract), reuse_receipt=receipt)
        self.assertEqual(matched["stable"]["reuse"], "matched_prior_receipt")

        def changed_result(contract=None, runner=None):
            value = self.run_case(contract=contract, runner=runner, reuse_receipt=receipt)
            self.assertTrue(value["ok"], value)
            self.assertEqual(value["stable"]["reuse"], "not_reused")
            self.assertNotEqual(value["stable"]["fingerprint"], base["stable"]["fingerprint"])

        self.cli.write_text("#!/bin/sh\n# changed\n")
        changed_result(runner=FakeRunner(self.contract))
        self.cli.write_text("#!/bin/sh\n")

        runtime_contract = copy.deepcopy(self.contract)
        runtime_contract["runtime_id"] = "runtime-restarted"
        self.write_evidence()
        session_value = json.loads(self.session.read_text())
        session_value["runtime_id"] = "runtime-restarted"
        self.session.write_text(json.dumps(session_value))
        probe_value = json.loads(self.probe.read_text())
        probe_value["runtime_id"] = "runtime-restarted"
        self.probe.write_text(json.dumps(probe_value))
        runtime_runner = FakeRunner(runtime_contract)
        runtime_runner.runtime_id = "runtime-restarted"
        self.write_runtime_state(runtime_contract)
        changed_result(runtime_contract, runtime_runner)
        self.write_runtime_state()
        self.write_evidence()

        self.policy.write_text("policy-v2\n")
        changed_result(runner=FakeRunner(self.contract))
        self.policy.write_text("policy-v1\n")

        self.config.write_text('{"schema_version":1,"changed":true}\n')
        changed_result(runner=FakeRunner(self.contract))
        self.config.write_text('{"schema_version":1}\n')

        other_archive = self.root / "other-archive"
        other_archive.mkdir()
        path_contract = copy.deepcopy(self.contract)
        path_contract["paths"]["archive_dir"] = str(other_archive)
        self.write_evidence(archive=other_archive)
        changed_result(path_contract, FakeRunner(path_contract))
        self.write_evidence()

        baseline_contract = copy.deepcopy(self.contract)
        baseline_contract["baselines"][0]["head"] = "3" * 40
        baseline_runner = FakeRunner(baseline_contract)
        changed_result(baseline_contract, baseline_runner)

    def test_dirty_fingerprint_hashes_tracked_and_untracked_content(self):
        contract = copy.deepcopy(self.contract)
        contract["baselines"][0]["clean"] = False
        first = FakeRunner(contract)
        first.diff[str(self.cwd)] = b"tracked content one"
        base = self.run_case(contract, first)
        self.assertTrue(base["ok"], base)
        receipt = self.root / "dirty-prior.json"
        receipt.write_text(json.dumps(base))

        second = FakeRunner(contract)
        second.diff[str(self.cwd)] = b"tracked content two"
        changed = self.run_case(contract, second, reuse_receipt=receipt)
        self.assertTrue(changed["ok"], changed)
        self.assertEqual(changed["stable"]["reuse"], "not_reused")

        untracked_contract = copy.deepcopy(self.contract)
        untracked_contract["baselines"][0]["clean"] = False
        new_file = self.cwd / "new.txt"
        new_file.write_text("first")
        third = FakeRunner(untracked_contract)
        third.untracked[str(self.cwd)] = b"new.txt\0"
        prior = self.run_case(untracked_contract, third)
        receipt.write_text(json.dumps(prior))
        new_file.write_text("second")
        fourth = FakeRunner(untracked_contract)
        fourth.untracked[str(self.cwd)] = b"new.txt\0"
        changed = self.run_case(untracked_contract, fourth, reuse_receipt=receipt)
        self.assertTrue(changed["ok"], changed)
        self.assertEqual(changed["stable"]["reuse"], "not_reused")

    def test_cached_stable_receipt_never_proves_fresh_evidence(self):
        base = self.run_case()
        receipt = self.root / "prior.json"
        receipt.write_text(json.dumps(base))
        self.write_evidence(session_at="2026-10-15T09:00:00Z")
        self.contract["limits"]["max_parallel"] = 1
        result = self.run_case(reuse_receipt=receipt)
        self.assertFalse(result["ok"])
        self.assertEqual(result["stable"]["reuse"], "not_reused")
        self.assertIn({"check": "volatile.session_evidence", "code": "stale_session_evidence"},
                      result["errors"])
        self.assertFalse(result["volatile"]["ok"])

    def test_each_native_success_envelope_requires_exact_runtime(self):
        keys = [
            ("status",),
            ("worktree", "show", "--worktree", "id:" + self.workspace_id),
            ("terminal", "show", "--terminal", "term_current"),
            ("orchestration", "run-current", "--from", "term_current"),
        ]
        self.contract["limits"]["max_parallel"] = 1
        for key in keys:
            for meta in (None, [], {}, {"runtimeId": "foreign-runtime"}):
                with self.subTest(key=key, meta=meta):
                    runner = FakeRunner(self.contract)
                    response = json.loads(runner([str(self.cli), *key, "--json"], 1).stdout)
                    if meta is None:
                        del response["_meta"]
                    else:
                        response["_meta"] = meta
                    runner.responses[key] = response
                    result = self.run_case(runner=runner)
                    self.assertFalse(result["ok"])
                    self.assertIn("native_runtime_identity_changed",
                                  [item["code"] for item in result["errors"]])

    def test_denied_first_query_does_not_start_subsequent_checks(self):
        self.contract["limits"]["max_parallel"] = 1
        runner = FakeRunner(self.contract)
        runner.fail[("status",)] = {"code": "runtime_access_denied", "message": "SECRET"}
        result = self.run_case(runner=runner)
        self.assertFalse(result["ok"])
        self.assertEqual(runner.calls, [(str(self.cli), "status", "--json")])
        self.assertIsNone(result["stable"]["fingerprint"])

    def test_running_baseline_does_not_start_next_command_after_failure(self):
        self.contract["limits"]["max_parallel"] = 2
        git_started = threading.Event()
        real_event = threading.Event
        events = []

        def event_factory():
            event = real_event()
            events.append(event)
            return event

        def denied_workspace(*args):
            self.assertTrue(git_started.wait(1))
            raise PreflightError("native_runtime_access_denied")

        fake = FakeRunner(self.contract)

        def runner(argv, timeout):
            if argv[0] == "git":
                git_started.set()
                self.assertTrue(events[0].wait(1))  # shared cancellation signal
            return fake(argv, timeout)

        with mock.patch("native_preflight.threading.Event", side_effect=event_factory), \
                mock.patch("native_preflight._workspace_check", side_effect=denied_workspace):
            result = self.run_case(runner=runner)
        self.assertFalse(result["ok"])
        git_calls = [call for call in fake.calls if call[0] == "git"]
        self.assertEqual(len(git_calls), 1)
        self.assertEqual(git_calls[0][4:], ("rev-parse", "HEAD"))

    def test_baseline_commands_share_one_decreasing_deadline(self):
        self.contract["limits"]["max_parallel"] = 1
        clock = [100.0]
        fake = FakeRunner(self.contract)

        def runner(argv, timeout):
            value = fake(argv, timeout)
            clock[0] += 0.2
            return value

        with mock.patch("native_preflight.time.monotonic", side_effect=lambda: clock[0]):
            result = self.run_case(runner=runner)
        self.assertTrue(result["ok"], result)
        for baseline in self.contract["baselines"]:
            budgets = [budget for call, budget in zip(fake.calls, fake.timeouts)
                       if call[0] == "git" and call[3] == baseline["path"]]
            self.assertEqual(len(budgets), 4)
            for actual, expected in zip(budgets, (1.0, 0.8, 0.6, 0.4)):
                self.assertAlmostEqual(actual, expected)

    def test_failed_baseline_command_does_not_run_later_commands(self):
        self.contract["limits"]["max_parallel"] = 1
        fake = FakeRunner(self.contract)

        def runner(argv, timeout):
            value = fake(argv, timeout)
            if argv[0] == "git":
                value.returncode = 1
            return value

        result = self.run_case(runner=runner)
        self.assertFalse(result["ok"])
        self.assertEqual(len([call for call in fake.calls if call[0] == "git"]), 1)

    def test_malformed_prior_receipts_are_non_reusable_hints(self):
        receipt = self.root / "prior.json"
        for stable in (None, [], "invalid", {}):
            with self.subTest(stable=stable):
                receipt.write_text(json.dumps({"schema_version": 1, "ok": True,
                                               "kind": "native_adaptive_preflight",
                                               "stable": stable}))
                result = self.run_case(reuse_receipt=receipt)
                self.assertTrue(result["ok"], result)
                self.assertEqual(result["stable"]["reuse"], "not_reused")
        for raw in ('{"kind":"native_adaptive_preflight"}', '[]', '{broken'):
            receipt.write_text(raw)
            self.assertEqual(self.run_case(reuse_receipt=receipt)["stable"]["reuse"], "not_reused")

    def test_nested_malformed_contracts_fail_compactly_before_execution(self):
        malformed = self.root / "malformed.json"
        mutations = [
            ("baselines", [None]), ("baselines", [dict(self.contract["baselines"][0], head=[])]),
            ("workspace", []), ("paths", {"cwd": [], "archive_dir": str(self.archive)}),
            ("runtime_state", None), ("policy_files", [[]]), ("config_files", [12]),
            ("evidence", {"session": None, "file_tool": str(self.probe)}),
            ("schema_version", True),
        ]
        for key, value in mutations:
            with self.subTest(key=key, value=value):
                contract = copy.deepcopy(self.contract)
                contract[key] = value
                malformed.write_text(json.dumps(contract))
                with mock.patch("builtins.print") as output:
                    self.assertEqual(cli_main(["--contract", str(malformed)]), 2)
                encoded = output.call_args.args[0]
                self.assertLess(len(encoded), 500)
                self.assertFalse(json.loads(encoded)["ok"])
                self.assertNotIn("Traceback", encoded)

    def test_current_pane_session_and_latest_settings_are_rechecked(self):
        mapping = json.loads(self.hooks.read_text())
        mapping["entries"]["tab-1:leaf-1"]["providerSession"]["id"] = "replacement-session"
        self.hooks.write_text(json.dumps(mapping))
        result = self.run_case()
        self.assertIn("current_session_identity_changed", [e["code"] for e in result["errors"]])
        self.write_runtime_state()
        previous = self.log.read_text()
        newer = json.loads(previous.splitlines()[-1])
        newer["payload"]["model"] = "changed-live-model"
        self.log.write_text(previous + json.dumps(newer) + "\n")
        result = self.run_case()
        self.assertIn("current_session_settings_changed", [e["code"] for e in result["errors"]])

    def test_probe_requires_provider_session_or_matching_evidence_hash(self):
        for session_id in (None, "other-session"):
            self.write_evidence()
            probe = json.loads(self.probe.read_text())
            if session_id is None:
                del probe["session_id"]
            else:
                probe["session_id"] = session_id
            self.probe.write_text(json.dumps(probe))
            result = self.run_case()
            self.assertIn("file_tool_identity_unbound", [e["code"] for e in result["errors"]])
        probe["session_evidence_sha256"] = hashlib.sha256(self.session.read_bytes()).hexdigest()
        self.probe.write_text(json.dumps(probe))
        self.assertTrue(self.run_case()["ok"])
        probe["session_evidence_sha256"] = "0" * 64
        self.probe.write_text(json.dumps(probe))
        self.assertFalse(self.run_case()["ok"])

    def test_index_only_changes_affect_cleanliness_and_fingerprint(self):
        runner = FakeRunner(self.contract)
        runner.index[str(self.cwd)] = b"index-only change"
        self.assertFalse(self.run_case(runner=runner)["ok"])
        self.contract["baselines"][0]["clean"] = False
        original = self.run_case(runner=runner)
        self.assertTrue(original["ok"], original)
        receipt = self.root / "prior.json"
        receipt.write_text(json.dumps(original))
        runner.index[str(self.cwd)] = b"different staged content"
        changed = self.run_case(runner=runner, reuse_receipt=receipt)
        self.assertTrue(changed["ok"], changed)
        self.assertNotEqual(original["stable"]["fingerprint"], changed["stable"]["fingerprint"])
        self.assertEqual(changed["stable"]["reuse"], "not_reused")

    def test_context_before_4_mib_tail_is_still_verified(self):
        row = json.dumps({"type": "response_item", "payload": {"text": "x" * (1024 * 1024)}}) + "\n"
        with self.log.open("a") as target:
            for _ in range(5):
                target.write(row)
            target.write('{"type":"turn_context"')  # In-flight record is not evidence.
        result = self.run_case()
        self.assertTrue(result["ok"], result)

    def test_completion_timestamp_uses_injected_clock(self):
        result = self.run_case()
        self.assertEqual(result["timing"]["preflight_completed_at"], "2026-10-15T10:00:10.125000Z")
        self.assertEqual(result["timing"]["preflight_duration_ms"], 125)


class BoundedRunnerTests(unittest.TestCase):
    def test_real_subprocess_drains_both_streams(self):
        result = _default_runner([sys.executable, "-c",
                                  "import os; os.write(1,b'a'*512); os.write(2,b'b'*512)"], 2)
        self.assertEqual(result.stdout, b"a" * 512)
        self.assertEqual(result.stderr, b"b" * 512)

    def test_streams_larger_than_2_mib_are_drained_and_child_reaped(self):
        original_popen = subprocess.Popen
        for stream in (1, 2):
            with self.subTest(stream=stream):
                children = []

                def spawn(*args, **kwargs):
                    child = original_popen(*args, **kwargs)
                    children.append(child)
                    return child

                with mock.patch("native_preflight.subprocess.Popen", side_effect=spawn):
                    result = _default_runner([sys.executable, "-c",
                        f"import sys; s=sys.stdout if {stream} == 1 else sys.stderr; "
                        "s.buffer.write(b'x'*(3*1024*1024))"], 5)
                self.assertEqual(result.stdout if stream == 1 else result.stderr,
                                 b"x" * (3 * 1024 * 1024))
                self.assertEqual(len(children), 1)
                self.assertIsNotNone(children[0].returncode)

    def test_real_timeout_reaps_child(self):
        original_popen = subprocess.Popen
        children = []

        def spawn(*args, **kwargs):
            child = original_popen(*args, **kwargs)
            children.append(child)
            return child

        with mock.patch("native_preflight.subprocess.Popen", side_effect=spawn):
            with self.assertRaises(subprocess.TimeoutExpired):
                _default_runner([sys.executable, "-c", "import time; time.sleep(3)"], 0.05)
        self.assertIsNotNone(children[0].returncode)


if __name__ == "__main__":
    unittest.main()

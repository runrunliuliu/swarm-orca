"""Deterministic action budgets; no runtime, model, or business mutation."""

from contextlib import redirect_stderr, redirect_stdout
import io
import json
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import observation_budget as budget
from bootstrap_control import AuthorityClient
from coordinator_tui_errors import failure
from trae_coordinator import native
from trae_tui import Queries


class BudgetTests(unittest.TestCase):
    def setUp(self):
        self.tick = 100.0
        clock = patch.object(budget, "time", SimpleNamespace(monotonic=lambda: self.tick))
        clock.start()
        self.addCleanup(clock.stop)
        self.log = io.StringIO()
        stderr = redirect_stderr(self.log)
        stderr.__enter__()
        self.addCleanup(stderr.__exit__, None, None, None)

    def test_nested_budget_never_renews_and_restores_after_failure(self):
        with budget.scope(10):
            self.tick += 4
            with budget.scope(100):
                self.assertEqual(budget.timeout(15), 6)
            with self.assertRaises(budget.ObservationTimeout):
                with budget.limit(2):
                    self.tick += 3
                    budget.check()
            self.assertEqual(budget.timeout(15), 3)
        self.assertFalse(budget.active())
        self.assertEqual(budget.timeout(15), 15)

    def test_expired_scope_does_not_call_and_no_raw_error_leaks(self):
        call = Mock(side_effect=subprocess.TimeoutExpired(["secret-argv"], 1, output="private"))
        with self.assertRaises(budget.ObservationTimeout) as caught:
            with budget.scope(60), budget.stage("readiness"):
                call()
        result = failure(caught.exception, "fallback")
        self.assertEqual(result["error"], "tui_turn_end_observation_timeout")
        self.assertEqual(result["stage"], "turn_end/readiness")
        self.assertFalse(result["execute_action"])
        self.assertNotIn("secret", json.dumps(result) + self.log.getvalue())
        with self.assertRaises(budget.ObservationTimeout):
            with budget.scope(1):
                self.tick += 1
                budget.call_with_timeout(call, "cli", "runtime", [], 10)
        call.assert_called_once()

    def test_invalid_budgets_rejected(self):
        for value in (0, -1, True, float("nan"), float("inf")):
            with self.subTest(value=value), self.assertRaises(ValueError):
                with budget.scope(value):
                    self.fail("entered")
        self.assertFalse(budget.active())

    def test_native_nested_observer_and_legacy_adapter_share_remaining(self):
        reply = SimpleNamespace(stdout=json.dumps(dict(ok=True, _meta=dict(runtimeId="r"), result={})))
        with patch("trae_coordinator.subprocess.run", return_value=reply) as run:
            native("cli", "r", ["status"])
            self.assertEqual(run.call_args.kwargs["timeout"], 15)
            with budget.scope(10):
                self.tick += 2
                Queries("cli", "r").read("status")
                self.assertEqual(run.call_args.kwargs["timeout"], 8)
                # Cross-runtime adapters intentionally preserve the three-arg API.
                from operator_continuity_route import coordinator_call
                budget.call_with_timeout(coordinator_call(native), "cli", "r", ["status"], 3)
                self.assertEqual(run.call_args.kwargs["timeout"], 3)
                self.assertEqual(budget.timeout(15), 8)
        self.assertFalse(budget.active())

    def client(self):
        client = object.__new__(AuthorityClient)
        client.deadline, client.read_only_poll = None, False
        client.control = "control"
        return client

    def test_owner_read_timeout_is_not_swallowed_by_query(self):
        client = self.client()
        with patch("bootstrap_control.time", SimpleNamespace(monotonic=lambda: self.tick)):
            def rpc(*args, **kwargs):
                self.assertEqual(client.deadline, 104)
                self.assertTrue(client.read_only_poll)
                raise TimeoutError("private owner error")
            with patch.object(client, "_rpc", side_effect=rpc) as call:
                with self.assertRaises(budget.ObservationTimeout):
                    with budget.scope(4):
                        client.query("control", {})
                call.assert_called_once()
        self.assertIsNone(client.deadline)
        self.assertFalse(client.read_only_poll)

    def test_mutation_semantics_unchanged_outside_observation(self):
        client = self.client()
        with patch.object(client, "_rpc", side_effect=TimeoutError) as rpc:
            with self.assertRaisesRegex(ValueError, "bootstrap_tool_timeout_requires_reconciliation"):
                client.rpc("commit")
            rpc.assert_called_once()
            rpc.reset_mock()
            with budget.scope():
                with self.assertRaisesRegex(ValueError, "observation_budget_mutation_forbidden"):
                    client.rpc("commit")
            rpc.assert_not_called()

    def test_readiness_propagates_deadline_instead_of_not_ready(self):
        import operator_readiness as readiness
        def expired(*args, **kwargs):
            self.tick += 61
            budget.check()
        with patch.object(readiness, "continuation", side_effect=expired):
            with self.assertRaises(budget.ObservationTimeout):
                with budget.scope():
                    readiness.check({}, {})
        with patch.object(readiness, "load", return_value=({"startup_lifecycle": {}}, {}, None)), \
                patch("operator_startup.load", return_value=({}, None, None, None)), \
                patch("operator_startup.read_state", side_effect=expired):
            with self.assertRaises(budget.ObservationTimeout):
                with budget.scope():
                    readiness.for_continuation({})

    def test_log_loop_stops_between_reads(self):
        from log_io import prefix_digest
        outer = self
        class SlowFile(io.BytesIO):
            def read(self, size=-1):
                outer.tick += 2
                return super().read(size)
        with self.assertRaises(budget.ObservationTimeout):
            with budget.scope(1):
                prefix_digest(SlowFile(b"abc"), 3)

    def test_cli_emits_final_json_and_stage_diagnostics(self):
        import coordinator_tui_continue as continuation
        def stalled(*args, **kwargs):
            raise subprocess.TimeoutExpired(["private-argv"], 15)
        stdout = io.StringIO()
        with patch("coordinator_tui_turn_end._turn_end", side_effect=stalled), redirect_stdout(stdout):
            code = continuation.main(["turn-end", "--config", "/unused", "--config-sha256", "a" * 64])
        self.assertEqual(code, 2)
        self.assertEqual(json.loads(stdout.getvalue())["error"], "tui_turn_end_observation_timeout")
        rows = [json.loads(line) for line in self.log.getvalue().splitlines()]
        self.assertEqual([row["phase"] for row in rows], ["begin", "failed"])
        self.assertNotIn("private-argv", stdout.getvalue() + self.log.getvalue())

    def test_real_local_child_is_bounded_by_remaining_budget(self):
        # Isolated Python child, not an Orca command. subprocess.run kills/reaps it.
        with self.assertRaises(budget.ObservationTimeout):
            with budget.scope(0.1):
                native(sys.executable, "unused", ["-c", "import time; time.sleep(10)"])

    def test_scope_restores_after_interrupt(self):
        with self.assertRaises(KeyboardInterrupt):
            with budget.scope(), budget.limit(1), budget.stage("interrupted"):
                raise KeyboardInterrupt()
        self.assertFalse(budget.active())
        self.assertEqual(budget.timeout(15), 15)
        with budget.scope():
            self.assertEqual(budget.timeout(15), 15)

    def test_runtime_discovery_inherits_budget(self):
        from coordinator_tui_continue import discover_runtime
        with patch("coordinator_tui_continue.subprocess.run", side_effect=subprocess.TimeoutExpired("private", 2)) as run:
            with self.assertRaises(budget.ObservationTimeout):
                with budget.scope(2):
                    discover_runtime("cli")
            self.assertEqual(run.call_args.kwargs["timeout"], 2)

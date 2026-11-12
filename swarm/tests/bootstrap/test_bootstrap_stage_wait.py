"""Stage waiting as one bounded call: no owner, no polling loop, no invented paths."""

import io
import json
import os
import socket
from contextlib import redirect_stdout, redirect_stderr
from datetime import timedelta
from pathlib import Path
import subprocess
import threading
import unittest
from unittest import mock

import bootstrap_protocol
import bootstrap_stage_wait
from bootstrap_protocol import EVENTS, layout, stage_path
from coordinator_io import file_ref
import bootstrap.test_bootstrap_events as events_tests
import wait_for_file


class StageWaitTests(unittest.TestCase):
    def setUp(self):
        # A real attempt image (binding, fixed inputs, marker chain), not a stub: the stage wait
        # is only meaningful against the evidence layout the binding pins.
        self.events = events_tests.BootstrapEventsTests()
        self.events.setUp()
        self.addCleanup(self.events.doCleanups)
        self.root = self.events.root
        self.paths = self.events.paths
        self.clock = self.events.clock
        self.binding = self.events.binding

    def no_wait(self, *args, **kwargs):
        raise AssertionError("this case must answer without spending the window")

    def wait(self, **updates):
        args = dict(bootstrap=str(self.root), expect_attempt="attempt-test",
                    binding_sha256=self.binding["sha256"], stage=1, clock=self.clock,
                    waiter=self.no_wait)
        args.update(updates)
        return bootstrap_stage_wait.wait_stage(**args)

    def test_stage_path_only_comes_from_the_layout_table(self):
        expected = layout(self.root)
        value = {"paths": expected}
        for stage, event in enumerate(EVENTS, 1):
            self.assertEqual(stage_path(value, stage), expected[event])
        # The table is the only source: changing `PATHS` changes `layout()`, so a binding that
        # pinned the old layout stops matching instead of silently naming the old file.
        with mock.patch.dict(bootstrap_protocol.PATHS, {EVENTS[0]: "events/moved.json"}):
            self.assertNotEqual(layout(self.root)[EVENTS[0]], expected[EVENTS[0]])
        self.assertEqual(stage_path(value, 1), expected[EVENTS[0]])

    def test_layout_drift_is_refused_rather_than_waited_on(self):
        self.events.chain(0)
        with mock.patch.dict(bootstrap_protocol.PATHS, {EVENTS[0]: "events/moved.json"}):
            result = self.wait(stage=1)
        # The binding pins `paths == layout(root)`; when the table moves, the pin is what breaks,
        # and that is a refusal (2), not a 300 s wait for a path nothing will ever write.
        self.assertEqual(result["exit"], 2, result)
        self.assertEqual(result["reason"], "fixed_layout_mismatch")

    def test_stage_zero_and_non_integers_are_refused(self):
        value = {"paths": layout(self.root)}
        for bad in (0, 5, -1, True, "1", None, 1.0):
            with self.subTest(stage=bad):
                with self.assertRaisesRegex(ValueError, "bootstrap_stage_invalid"):
                    stage_path(value, bad)
        with self.assertRaisesRegex(ValueError, "fixed_layout_mismatch"):
            stage_path({}, 1)
        with self.assertRaisesRegex(ValueError, "fixed_layout_mismatch"):
            stage_path({"paths": {}}, 1)

    def test_already_satisfied_answers_zero_without_a_window(self):
        self.events.chain(2)
        result = self.wait(stage=1)
        self.assertEqual(result["exit"], 0)
        self.assertTrue(result["ok"])
        self.assertTrue(result["already_satisfied"])
        self.assertEqual(result["validated_count"], 2)
        self.assertEqual(result["outcome"], "validated")
        self.assertFalse(result["execution_authorized"])
        # The evidence Ref is what the tool read, not a re-derivation by the caller.
        self.assertEqual(result["ref"], file_ref(self.paths[EVENTS[0]]))

    def test_a_later_stage_is_reached_by_waiting_once_then_validating(self):
        self.events.chain(0)
        seen = []

        def waiter(target, mode, timeout_ms):
            seen.append((target, mode, timeout_ms))
            self.events.chain(1)
            return wait_for_file.PRESENT, {}

        result = self.wait(stage=1, waiter=waiter, timeout_ms=30000)
        self.assertEqual(result["exit"], 0, result)
        self.assertFalse(result["already_satisfied"])
        self.assertEqual(result["validated_count"], 1)
        self.assertEqual(seen, [(self.paths[EVENTS[0]], "appear", 30000)])
        self.assertEqual(result["ref"], file_ref(self.paths[EVENTS[0]]))

    def test_a_marker_published_during_the_wait_is_newer_than_the_entry_clock(self):
        # Live finding: the clock was captured on entry and reused after the wake, so a marker the
        # owner published *during* this call was "newer than now" and answered 5
        # `marker_time_mismatch` — the exact case this tool exists for. The clock is re-read after
        # the wake; an injected clock stays fixed.
        self.events.chain(0)
        fixture = self.events.clock
        entry = (fixture - timedelta(seconds=5)).isoformat()
        after = (fixture + timedelta(seconds=5)).isoformat()
        stamps = iter([entry, after])

        def waiter(target, mode, timeout_ms):
            self.events.chain(1)
            return wait_for_file.PRESENT, {}

        with mock.patch.object(bootstrap_stage_wait, "now", lambda: next(stamps)):
            result = self.wait(stage=1, waiter=waiter, timeout_ms=30000, clock=None)
        self.assertEqual(result["exit"], 0, result)
        self.assertFalse(result["already_satisfied"])
        self.assertEqual(result["validated_count"], 1)

    def test_deadline_is_the_result_and_never_progress(self):
        self.events.chain(0)
        result = self.wait(stage=1, waiter=lambda *a: (wait_for_file.TIMEOUT, {}))
        self.assertEqual(result["exit"], 124)
        self.assertEqual(result["reason"], "bootstrap_wait_stage_timeout")
        self.assertNotIn("ref", result)
        self.assertFalse(os.path.lexists(self.root / "events"))

    def test_unreachable_attempt_answers_four_immediately(self):
        result = self.wait(bootstrap=str(self.root / "not-there"))
        self.assertEqual(result["exit"], 4)
        self.assertEqual(result["reason"], "bootstrap_wait_stage_unreachable")

    def test_missing_binding_file_is_unreachable_not_a_wait(self):
        (self.root / "attempt-binding.json").unlink()
        result = self.wait()
        self.assertEqual(result["exit"], 4)
        self.assertEqual(result["diagnostics"], {"attempt_binding": "missing"})

    def test_a_missing_pinned_input_is_not_reported_as_a_missing_binding(self):
        # Live finding: the attempt's binding was intact, but the workspace/skill it pins had been
        # removed. Both are unreachable, but blaming the binding sends the operator to the wrong
        # file. The token must name what is actually gone.
        Path(self.events.b["fixed_inputs"]["role_skill"]["path"]).unlink()
        result = self.wait()
        self.assertEqual(result["exit"], 4)
        self.assertEqual(result["diagnostics"], {"pinned_input": "missing"})

    def test_binding_pin_and_attempt_mismatch_are_usage_errors(self):
        self.events.chain(0)
        wrong_pin = self.wait(binding_sha256="0" * 64)
        self.assertEqual(wrong_pin["exit"], 2)
        self.assertEqual(wrong_pin["reason"], "file_pin_changed")
        wrong_attempt = self.wait(expect_attempt="someone-else")
        self.assertEqual(wrong_attempt["exit"], 2)
        self.assertEqual(wrong_attempt["reason"], "attempt_mismatch")

    def test_gap_is_present_but_unvalidated_and_reads_once(self):
        self.events.put(EVENTS[1], {})
        calls = []
        original = bootstrap_stage_wait._check

        def counted(*args, **kwargs):
            calls.append(args[2])
            return original(*args, **kwargs)

        with mock.patch.object(bootstrap_stage_wait, "_check", counted):
            result = self.wait()
        self.assertEqual(result["exit"], 5, result)
        self.assertEqual(result["reason"], "marker_sequence_gap")
        self.assertEqual(calls, ["attempt-test"])
        self.assertNotIn("ref", result)

    def test_refusal_happens_before_the_window_is_spent(self):
        # A stage that cannot appear must not consume 300 s of a caller's deadline first.
        self.events.chain(0)
        (self.root / "events").write_text("not a directory")
        result = self.wait()
        self.assertEqual(result["exit"], 4, result)
        self.assertEqual(result["diagnostics"], {"stage_path": "stage_parent_not_a_directory"})

    def test_only_exit_zero_carries_the_progress_fields(self):
        # `already_satisfied`/`validated_count` are the two flavours of success, not a progress
        # signal a failure may hand back: a chain length attached to a 124 is exactly what a caller
        # would carry forward as "we got to stage k". Design 3.2.2, review R4.
        usage = self.wait(binding_sha256="0" * 64)
        unreachable = self.wait(bootstrap=str(self.root / "not-there"))
        self.events.chain(0)
        timeout = self.wait(stage=1, waiter=lambda *a: (wait_for_file.TIMEOUT, {}))
        self.events.chain(1)
        satisfied = self.wait(stage=1)
        self.events.put(EVENTS[1], {})
        unvalidated = self.wait(stage=2)
        for name, payload in (("2", usage), ("4", unreachable), ("124", timeout), ("5", unvalidated)):
            with self.subTest(exit=name):
                self.assertNotIn("validated_count", payload)
                self.assertNotIn("already_satisfied", payload)
                self.assertNotIn("ref", payload)
                self.assertEqual(payload["exit"], int(name), payload)
        for field in ("already_satisfied", "validated_count", "ref", "elapsed_ms"):
            self.assertIn(field, satisfied)
        self.assertEqual(satisfied["validated_count"], 1)

    def test_real_waiter_wakes_when_the_marker_is_published(self):
        # The only case in this module that uses a real clock and the real inotify waiter, on
        # purpose: it is the one thing a fake waiter cannot prove (that `wait_for_file` actually
        # wakes on a same-client publish). Everything else injects the waiter.
        self.events.chain(0)
        timer = threading.Timer(0.2, self.events.chain, kwargs=dict(count=1))
        timer.start()
        try:
            result = self.wait(stage=1, waiter=wait_for_file.wait, timeout_ms=10000)
        finally:
            timer.cancel()
        self.assertEqual(result["exit"], 0, result)
        self.assertFalse(result["already_satisfied"])

    def test_no_owner_socket_and_no_subprocess(self):
        self.events.chain(1)
        with mock.patch.object(socket, "socket", side_effect=AssertionError("no socket")):
            with mock.patch.object(subprocess, "Popen", side_effect=AssertionError("no process")):
                result = self.wait(stage=1)
        self.assertEqual(result["exit"], 0)
        # The owner's slot was never consulted, so its presence is irrelevant to this answer.
        self.assertFalse((self.root / "control" / "owner.json").exists())

    def test_cli_refuses_stage_zero_and_reports_unreachable_as_four(self):
        with redirect_stderr(io.StringIO()) as err:
            with self.assertRaises(SystemExit) as raised:
                bootstrap_stage_wait.cli_main([
                    "--bootstrap", str(self.root), "--expect-attempt", "attempt-test",
                    "--attempt-binding-sha256", self.binding["sha256"], "--stage", "0"])
        self.assertEqual(raised.exception.code, 2)
        self.assertIn("--stage must be in 1..4", err.getvalue())
        out = io.StringIO()
        with redirect_stdout(out), redirect_stderr(io.StringIO()):
            code = bootstrap_stage_wait.cli_main([
                "--bootstrap", str(self.root / "not-there"), "--expect-attempt", "attempt-test",
                "--attempt-binding-sha256", self.binding["sha256"], "--stage", "1", "--json"])
        self.assertEqual(code, 4)
        self.assertEqual(json.loads(out.getvalue())["reason"], "bootstrap_wait_stage_unreachable")


if __name__ == "__main__":
    unittest.main()

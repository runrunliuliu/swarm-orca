"""Native envelope/exit-code boundary; no Orca process or messages are created."""

import copy
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

from coordinator_io import canonical, read_json
import operator_monitor as monitor
import progress_watch as watch
from terminal_idle_wait import (BLOCKED_REASONS, MAX_NATIVE_WAIT_MS, MIN_RPC_TIMEOUT_SECONDS,
                                NATIVE_WAIT_MS, IdleWaitResult, decode_idle_wait, idle_wait_args,
                                idle_wait_ms, idle_wait_target, min_rpc_timeout_seconds)


CAPTURE = read_json(Path(__file__).parents[1] / "fixtures/terminal-idle-timeout.json")
RUNTIME = CAPTURE["response"]["_meta"]["runtimeId"]
TERMINAL = "term-fixture"


def wait_response(runtime=RUNTIME, terminal=TERMINAL, **changes):
    wait = dict(handle=terminal, condition="tui-idle", satisfied=True, status="running", exitCode=None)
    wait.update(changes)
    return dict(ok=True, _meta=dict(runtimeId=runtime), result=dict(wait=wait))


class IdleWaitTests(unittest.TestCase):
    def setUp(self):
        cli = patch.object(watch, "CLI", "/test/orca-server-cli")
        cli.start()
        self.addCleanup(cli.stop)

    def native(self, body, code=0, args=None, timeout=12):
        reply = subprocess.CompletedProcess([], code, canonical(body))
        with patch.object(monitor.subprocess, "run", return_value=reply):
            return monitor.native(args or idle_wait_args(TERMINAL), RUNTIME, timeout)

    def test_real_timeout_capture_is_pending(self):
        self.assertEqual(self.native(CAPTURE["response"], CAPTURE["returncode"]),
                         IdleWaitResult("pending", "tui_idle_timeout"))

    def test_ready_and_all_known_blocked_aliases(self):
        self.assertEqual(self.native(wait_response()), IdleWaitResult("ready"))
        for reason in BLOCKED_REASONS:
            with self.subTest(reason=reason):
                self.assertEqual(self.native(wait_response(satisfied=False, blockedReason=reason), 1),
                                 IdleWaitResult("interaction_required", reason))

    def test_runtime_is_validated_before_accepting_timeout_or_block(self):
        for body in (CAPTURE["response"], wait_response(satisfied=False, blockedReason="agent-approval-prompt")):
            for meta in (None, {}, {"runtimeId": "other"}, {"runtimeId": True}):
                bad = copy.deepcopy(body)
                bad["_meta"] = meta
                with self.subTest(meta=meta), self.assertRaisesRegex(watch.StopObservation, "runtime_mismatch"):
                    self.native(bad, 1)

    def test_malformed_envelopes_fail_closed(self):
        for body in (None, [], {}, {"ok": 1}, {"ok": "true"},
                     dict(wait_response(), error={}), dict(wait_response(), result=[])):
            with self.subTest(body=body), self.assertRaises(watch.StopObservation):
                self.native(body)
        for raw in (b"not-json", b"\xff", b'{"ok":true,"ok":false}', b'{"ok":NaN}', b'{"ok":Infinity}'):
            with self.subTest(raw=raw), self.assertRaisesRegex(watch.StopObservation, "query_invalid_json"):
                decode_idle_wait(raw, 0, RUNTIME, TERMINAL)

    def test_structured_wait_fields_are_required_and_typed(self):
        for field in ("handle", "condition", "satisfied", "status", "exitCode"):
            body = wait_response()
            del body["result"]["wait"][field]
            with self.subTest(missing=field), self.assertRaises(watch.StopObservation):
                self.native(body)
        for changes in ({"handle": "other"}, {"condition": "exit"}, {"satisfied": 1},
                        {"satisfied": "true"}, {"status": []}, {"status": "other"},
                        {"exitCode": True}, {"exitCode": "0"}, {"exitCode": 0.0},
                        {"blockedReason": None}, {"exitCause": "unknown"}):
            with self.subTest(changes=changes), self.assertRaises(watch.StopObservation):
                self.native(wait_response(**changes))

    def test_exited_or_unknown_is_never_idle_even_if_native_satisfied(self):
        for changes in ({"status": "exited", "exitCode": 0}, {"status": "unknown"}, {"exitCode": 0}):
            with self.subTest(changes=changes), self.assertRaisesRegex(watch.StopObservation, "not_running"):
                self.native(wait_response(**changes))

    def test_exit_code_and_result_must_agree(self):
        bodies = [(wait_response(), 1), (wait_response(), -9),
                  (wait_response(satisfied=False, blockedReason="agent-approval-prompt"), 0),
                  (wait_response(satisfied=False), 1),
                  (wait_response(satisfied=False, blockedReason="unknown-reason"), 1),
                  (wait_response(satisfied=False, blockedReason=[]), 1),
                  (CAPTURE["response"], 0), (CAPTURE["response"], 2)]
        for body, code in bodies:
            with self.subTest(body=body, code=code), self.assertRaises(watch.StopObservation):
                self.native(body, code)

    def test_transport_permission_and_runtime_errors_still_stop(self):
        for reason in ("runtime_timeout", "connection_failed", "runtime_access_denied", "permission_denied",
                       "runtime_unavailable", "terminal_handle_stale", "not_connected"):
            body = copy.deepcopy(CAPTURE["response"])
            body["error"]["code"] = reason
            with self.subTest(reason=reason), self.assertRaises(watch.StopObservation):
                self.native(body, 1)
        with patch.object(monitor.subprocess, "run", side_effect=subprocess.TimeoutExpired("wait", 12)):
            with self.assertRaises(subprocess.TimeoutExpired):
                monitor.native(idle_wait_args(TERMINAL), RUNTIME)

    def test_error_envelope_cannot_carry_a_result(self):
        with self.assertRaises(watch.StopObservation):
            self.native(dict(CAPTURE["response"], result={}), 1)

    def test_other_commands_and_wait_forms_keep_strict_decoder(self):
        args = idle_wait_args(TERMINAL)
        variants = [["terminal", "show", "--terminal", TERMINAL],
                    ["orchestration", "inbox", "--terminal", "run:test"],
                    args[:5] + ["exit"] + args[6:], args[:7] + ["0"],
                    args + ["--terminal", "other"], idle_wait_args("current"),
                    idle_wait_args("active"), args + ["--environment", "other"]]
        for command in variants:
            with self.subTest(command=command):
                self.assertIsNone(idle_wait_target(command))
                with self.assertRaises(watch.StopObservation):
                    self.native(CAPTURE["response"], 1, command)
                with self.assertRaises(watch.StopObservation):
                    self.native(wait_response(satisfied=False, blockedReason="agent-approval-prompt"), 1, command)
        with self.assertRaises(watch.StopObservation):
            watch.decode_response(canonical(CAPTURE["response"]), 1, RUNTIME)


class IdleWaitArgsTests(unittest.TestCase):
    """The builder and the argv reader must agree at every duration, not just the default."""

    def setUp(self):
        cli = patch.object(watch, "CLI", "/test/orca-server-cli")
        cli.start()
        self.addCleanup(cli.stop)

    def test_the_scheduler_default_is_byte_identical_to_the_previous_command(self):
        # Why: the scheduler's 1 s probe is not in this change's scope. If passing no argument
        # stopped producing this exact argv, the scheduler would silently start waiting longer.
        self.assertEqual(NATIVE_WAIT_MS, 1000)
        self.assertEqual(idle_wait_args(TERMINAL),
                         ["terminal", "wait", "--terminal", TERMINAL, "--for", "tui-idle",
                          "--timeout-ms", "1000"])

    def test_the_duration_is_a_parameter_with_a_ceiling(self):
        self.assertEqual(MAX_NATIVE_WAIT_MS, 300_000)
        self.assertEqual(idle_wait_args(TERMINAL, 300_000)[-1], "300000")
        for wait_ms in (0, -1, MAX_NATIVE_WAIT_MS + 1, True, "1000", 1000.0, None):
            with self.subTest(wait_ms=wait_ms), self.assertRaises(ValueError):
                idle_wait_args(TERMINAL, wait_ms)

    def test_recognition_reads_the_duration_instead_of_requiring_one_second(self):
        # Why: this reader decides whether a receipt may go to the lenient idle decoder. It used
        # to compare against the one argv the scheduler built, which would have sent every other
        # duration to the strict decoder - a fail-closed answer to a legal command.
        for wait_ms in (1000, 30_000, MAX_NATIVE_WAIT_MS):
            with self.subTest(wait_ms=wait_ms):
                args = idle_wait_args(TERMINAL, wait_ms)
                self.assertEqual(idle_wait_target(args), TERMINAL)
                self.assertEqual(idle_wait_ms(args), wait_ms)

    def test_an_argv_that_only_resembles_the_command_stays_unrecognised(self):
        base = ["terminal", "wait", "--terminal", TERMINAL, "--for", "tui-idle", "--timeout-ms"]
        cases = {
            "zero": base + ["0"],
            "negative": base + ["-1000"],
            "above the policy ceiling": base + [str(MAX_NATIVE_WAIT_MS + 1)],
            "exponent": base + ["1e3"],
            "float": base + ["1000.0"],
            "padded": base + [" 1000"],
            "leading zero": base + ["0100"],
            "signed": base + ["+1000"],
            "not a number": base + ["soon"],
            "unicode digits": base + ["\u0661\u0660\u0660\u0660"],
            "unquoted int": base + [1000],
            "extra flag": base + ["1000", "--environment", "other"],
            "preceding flag": ["--environment", "other"] + base + ["1000"],
            "another condition": base[:4] + ["--for", "exit"] + base[6:] + ["1000"],
            "another verb": ["terminal", "show"] + base[2:] + ["1000"],
            "short": base,
            "no terminal": ["terminal", "wait", "--for", "tui-idle", "--timeout-ms", "1000"],
        }
        for name, command in cases.items():
            with self.subTest(case=name):
                self.assertIsNone(idle_wait_target(command))
                self.assertIsNone(idle_wait_ms(command))
        for command in (None, "terminal wait", ["terminal", "wait"] , base + ["1000", "1000"]):
            with self.subTest(command=command):
                self.assertIsNone(idle_wait_target(command))

    def test_the_rpc_budget_scales_with_the_native_wait(self):
        # ceil(wait_ms / 1000) + 11: the CLI's native +5 s and its own startup/return +6 s.
        for wait_ms, budget in ((1000, 12), (1500, 13), (30_000, 41), (300_000, 311)):
            with self.subTest(wait_ms=wait_ms):
                self.assertEqual(min_rpc_timeout_seconds(wait_ms), budget)
        self.assertEqual(MIN_RPC_TIMEOUT_SECONDS, 12)

    def test_a_wait_that_outlives_its_budget_fails_closed_before_calling_out(self):
        # Why: an outer deadline shorter than the native wait truncates the receipt. Failing here
        # keeps "pending" and "hung" distinguishable instead of producing an undecodable reply.
        with patch.object(monitor.subprocess, "run") as run:
            with self.assertRaisesRegex(watch.StopObservation, "tui_idle_rpc_timeout_too_short"):
                monitor.native(idle_wait_args(TERMINAL, 300_000), RUNTIME)
        run.assert_not_called()
        with patch.object(monitor.subprocess, "run") as run:
            with self.assertRaisesRegex(watch.StopObservation, "tui_idle_rpc_timeout_too_short"):
                monitor.native(idle_wait_args(TERMINAL, 1500), RUNTIME)
        run.assert_not_called()

    def test_a_long_wait_is_decoded_when_the_budget_covers_it(self):
        reply = subprocess.CompletedProcess([], 0, canonical(wait_response()))
        with patch.object(monitor.subprocess, "run", return_value=reply):
            self.assertEqual(monitor.native(idle_wait_args(TERMINAL, 300_000), RUNTIME,
                                            min_rpc_timeout_seconds(300_000)),
                             IdleWaitResult("ready"))


if __name__ == "__main__":
    unittest.main()

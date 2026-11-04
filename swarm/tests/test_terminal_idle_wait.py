"""Native envelope/exit-code boundary; no Orca process or messages are created."""

import copy
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

from coordinator_io import canonical, read_json
import operator_monitor as monitor
import progress_watch as watch
from terminal_idle_wait import (BLOCKED_REASONS, IdleWaitResult, decode_idle_wait,
                                idle_wait_args, idle_wait_target)


CAPTURE = read_json(Path(__file__).parent / "fixtures/terminal-idle-timeout.json")
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

    def native(self, body, code=0, args=None):
        reply = subprocess.CompletedProcess([], code, canonical(body))
        with patch.object(monitor.subprocess, "run", return_value=reply):
            return monitor.native(args or idle_wait_args(TERMINAL), RUNTIME)

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
                    args[:5] + ["exit"] + args[6:], args[:7] + ["2000"],
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


if __name__ == "__main__":
    unittest.main()

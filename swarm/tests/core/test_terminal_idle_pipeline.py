"""main → tick → scheduler → native → decoder, with only native I/O/log fixtures.

Unlike direct scheduler mocks these tests retain exit status, envelope decoding,
persistent monitor-stop handling and the actual continuation outbox lifecycle.
"""

from contextlib import redirect_stdout
import copy
import io
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

from coordinator_io import canonical, read_json
import operator_monitor as monitor
import coordinator.test_coordinator_tui_scheduler as scheduler_tests
from core.test_terminal_idle_wait import CAPTURE, wait_response


class IdlePipelineTests(unittest.TestCase):
    def setUp(self):
        self.s = scheduler_tests.SchedulerTests()
        self.s.setUp()
        self.addCleanup(self.s.doCleanups)
        self.m, self.f = self.s.m, self.s.f
        # Native process I/O is mocked, but the contract executable preflight is real.
        Path(self.f.c["cli"]["path"]).chmod(0o700)
        self.waits = []

    def reply(self, kind="ready"):
        if kind in ("timeout", "runtime_timeout", "wrong_runtime"):
            body = copy.deepcopy(CAPTURE["response"])
            body["_meta"]["runtimeId"] = self.m.binding["runtime"]
            if kind == "wrong_runtime":
                body["_meta"]["runtimeId"] = "replacement"
            elif kind == "runtime_timeout":
                body["error"]["code"] = kind
            return 1, body
        changes = dict(satisfied=False, blockedReason="agent-approval-prompt") if kind == "approval" else {}
        return (1 if changes else 0), wait_response(self.m.binding["runtime"], self.m.binding["terminal"], **changes)

    def main(self, outcomes=(), *, hook=None, completed=True, observations=None, after_send=None):
        queue = iter(outcomes)
        observed_turns = iter(observations) if observations is not None else None

        def process(argv, **kwargs):
            self.assertEqual(argv[0], self.f.c["cli"]["path"])
            self.assertEqual(argv[-1], "--json")
            self.assertEqual(kwargs["timeout"], self.m.data["rpc_timeout_seconds"])
            self.assertIs(kwargs["start_new_session"], True)
            args = argv[1:-1]
            if args[:2] == ["terminal", "wait"]:
                self.waits.append(args)
                if hook:
                    hook(len(self.waits))
                value = next(queue, "ready")
                if isinstance(value, Exception):
                    raise value
                code, body = self.reply(value) if isinstance(value, str) else value
            else:
                code, body = 0, dict(ok=True, _meta=dict(runtimeId=self.m.binding["runtime"]),
                                     result=self.m.fake(args, self.m.binding["runtime"]))
                if after_send and args[:2] == ["orchestration", "send"]:
                    raise after_send
            return subprocess.CompletedProcess(argv, code, body if isinstance(body, bytes) else canonical(body))

        def inventory(args, runtime, timeout, *, start_new_session=False):
            self.assertIs(start_new_session, True)
            body = dict(ok=True, _meta=dict(runtimeId=runtime), result=self.m.fake(args, runtime, timeout))
            return monitor.watch.decode_response(canonical(body), 0, runtime)

        def observe(**_):
            value = next(observed_turns) if observed_turns is not None else self.s.ended if completed else None
            return copy.deepcopy(value) if value is not None else None

        with patch.object(monitor.subprocess, "run", side_effect=process), \
                patch.object(monitor.watch, "query", side_effect=inventory), \
                patch("trae_tui.observe", side_effect=observe), \
                redirect_stdout(io.StringIO()):
            # No replacement of native, tick, schedule, completed or decoder.
            return monitor.main(["--config", str(self.m.config_file), "--config-sha256",
                                 self.m.config.ref["sha256"], "--execute", "--confirm-skill-read", "--once"])

    def status(self):
        return read_json(self.m.state_root / "status.json")["scheduler"]

    def phase_case(self, kind, phase, *, observations=None):
        phases = ("initial", "recheck", "pre_send")
        self.assertEqual(self.main(["ready"] * phase + [kind], observations=observations), 0)
        self.assertEqual(self.status(), dict(
            state="interaction_required" if kind == "approval" else
                  "awaiting_real_turn_end" if phase == 0 else "reobserving",
            reason="agent-approval-prompt" if kind == "approval" else "tui_idle_timeout",
            phase=phases[phase]))
        self.assertEqual(len(self.waits), phase + 1)
        self.assertFalse((self.m.state_root / "monitor-stop.json").exists())
        journal = self.f.state / "scheduler.json"
        if journal.exists():
            self.assertIsNone(read_json(journal)["stop"])
        self.assertEqual(self.m.messages, [])
        if phase == 2:
            self.assertEqual(read_json(self.f.state / "outbox.json")["actions"], {})
            archives = list(self.f.state.glob("cancelled-*.json"))
            self.assertEqual(len(archives), 1)
            self.assertIs(read_json(archives[0])["entry"]["attempted"], False)
        # Independent invocations rebuild Config/locks/journals: restart or a
        # later idle tick can continue, but only one message may be sent.
        self.assertEqual(self.main(), 0)
        self.assertEqual(self.status()["state"], "continuation_enqueued")
        self.assertEqual(self.main(), 0)
        self.assertEqual(self.status()["state"], "awaiting_continuation")
        self.assertEqual(len(self.m.messages), 1)

    def test_timeout_initial(self):
        self.phase_case("timeout", 0, observations=[None])

    def test_timeout_recheck(self):
        self.phase_case("timeout", 1, observations=[self.s.ended, None])

    def test_timeout_pre_send_cancels_definitely_unsent_intent(self):
        self.phase_case("timeout", 2, observations=[self.s.ended, self.s.ended, None])

    def timeout_completed_case(self, phase):
        self.assertEqual(self.main(["ready"] * phase + ["timeout"]), 0)
        self.assertEqual(self.status()["state"], "continuation_enqueued")
        # A successful scheduler send observes the provider-completed turn at
        # the initial, recheck and pre-send boundaries. A native idle timeout at
        # any one boundary no longer stops the tick when the provider history is
        # complete, so all three waits are reached.
        self.assertEqual(len(self.waits), 3)
        self.assertEqual(len(self.m.messages), 1)

    def test_timeout_initial_uses_provider_completed_turn(self):
        self.timeout_completed_case(0)

    def test_timeout_recheck_uses_provider_completed_turn(self):
        self.timeout_completed_case(1)

    def test_timeout_pre_send_uses_provider_completed_turn(self):
        self.timeout_completed_case(2)

    def test_timeout_every_completion_check_uses_provider_completed_turn(self):
        self.assertEqual(self.main(["timeout", "timeout", "timeout"]), 0)
        self.assertEqual(self.status()["state"], "continuation_enqueued")
        self.assertEqual(len(self.waits), 3)
        self.assertEqual(len(self.m.messages), 1)

    def test_approval_initial(self):
        self.phase_case("approval", 0)

    def test_approval_recheck(self):
        self.phase_case("approval", 1)

    def test_approval_pre_send_cancels_definitely_unsent_intent(self):
        self.phase_case("approval", 2)

    def test_repeated_busy_and_approval_do_not_send_or_latch(self):
        cases = (("timeout", [None]), ("timeout", [None]), ("approval", None),
                 ("approval", None), ("timeout", [None]))
        for kind, observations in cases:
            self.assertEqual(self.main([kind], observations=observations), 0)
            self.assertEqual(self.m.messages, [])
            self.assertFalse((self.m.state_root / "monitor-stop.json").exists())

    def test_native_idle_without_task_complete_is_insufficient(self):
        self.assertEqual(self.main(completed=False), 0)
        self.assertEqual(self.status()["state"], "awaiting_real_turn_end")
        self.assertEqual(self.m.messages, [])

    def assert_stops(self, outcome, reason):
        self.assertEqual(self.main([outcome]), 2)
        latch = read_json(self.m.state_root / "monitor-stop.json")
        self.assertEqual(latch["reason"], reason)
        before = len(self.waits)
        self.assertEqual(self.main(), 2)  # no auto-clear after restart
        self.assertEqual(read_json(self.m.state_root / "monitor-stop.json"), latch)
        self.assertEqual(len(self.waits), before)
        self.assertEqual(self.m.messages, [])

    def test_transport_timeout_still_latches(self):
        self.assert_stops("runtime_timeout", "native_query_failed")

    def test_subprocess_deadline_still_latches(self):
        self.assert_stops(subprocess.TimeoutExpired("wait", 12), "TimeoutExpired")

    def test_runtime_mismatch_still_latches(self):
        self.assert_stops("wrong_runtime", "runtime_mismatch")

    def test_wrong_terminal_still_latches(self):
        body = wait_response(self.m.binding["runtime"], "replacement")
        self.assert_stops((0, body), "tui_idle_target_mismatch")

    def test_invalid_envelope_still_latches(self):
        self.assert_stops((1, {"ok": "false"}), "tui_idle_response_invalid")

    def test_invalid_json_still_latches(self):
        self.assert_stops((1, b"not-json"), "query_invalid_json")

    def test_permission_denial_still_latches(self):
        _, body = self.reply("timeout")
        body["error"]["code"] = "runtime_access_denied"
        self.assert_stops((1, body), "runtime_access_denied")

    def test_disconnect_still_latches(self):
        _, body = self.reply("timeout")
        body["error"]["code"] = "connection_failed"
        self.assert_stops((1, body), "connection_failed")

    def test_generation_change_during_timeout_is_not_hidden(self):
        def changed(_):
            self.m.run["consumer_generation"] += 1
        self.assertEqual(self.main(["timeout"], hook=changed), 2)
        self.assertEqual(read_json(self.m.state_root / "monitor-stop.json")["reason"], "monitor_coordinator_changed")
        self.assertEqual(self.m.messages, [])

    def test_owner_change_during_timeout_is_not_hidden(self):
        def changed(_):
            self.m.run["coordinator_handle"] = "replacement"
        self.assertEqual(self.main(["timeout"], hook=changed), 2)
        self.assertEqual(read_json(self.m.state_root / "monitor-stop.json")["reason"], "monitor_coordinator_changed")
        self.assertEqual(self.m.messages, [])

    def test_operator_replacement_during_timeout_is_not_hidden(self):
        def changed(_):
            self.m.operator_terminal["incarnationId"] = "replacement"
        self.assertEqual(self.main(["timeout"], hook=changed), 2)
        self.assertEqual(read_json(self.m.state_root / "monitor-stop.json")["reason"],
                         "monitor_operator_terminal_unverifiable")
        self.assertEqual(self.m.messages, [])

    def test_terminal_replacement_during_approval_is_not_hidden(self):
        def changed(_):
            self.m.terminal["incarnationId"] = "replacement"
        self.assertEqual(self.main(["approval"], hook=changed), 2)
        self.assertEqual(read_json(self.m.state_root / "monitor-stop.json")["reason"],
                         "monitor_coordinator_unverifiable")
        self.assertEqual(self.m.messages, [])

    def test_identity_change_during_presend_timeout_does_not_cancel_intent(self):
        def changed(count):
            if count == 3:
                self.m.run["consumer_generation"] += 1
        self.assertEqual(self.main(["ready", "ready", "timeout"], hook=changed), 2)
        self.assertEqual(read_json(self.m.state_root / "monitor-stop.json")["reason"], "monitor_coordinator_changed")
        self.assertEqual(list(self.f.state.glob("cancelled-*.json")), [])
        state = read_json(self.f.state / "outbox.json")
        self.assertIs(state["actions"][state["order"][0]]["attempted"], False)
        self.assertEqual(self.m.messages, [])

    def test_two_complete_mocked_native_cycles_with_busy_and_restart(self):
        self.assertEqual(self.main(["timeout"], observations=[None]), 0)
        for _ in range(2):
            self.assertEqual(self.main(), 0)
            self.assertEqual(self.main(), 0)
            self.s.execute()
            self.s.new_turn(("met", "actionable") if len(self.m.messages) == 1 else ("met", "met"))
        self.assertEqual(self.main(), 0)
        self.assertEqual(self.status()["route"], "acceptance_review")
        self.assertEqual(len(self.m.messages), 2)

    def test_crashed_send_then_busy_does_not_cancel_attempted_and_reconciles_once(self):
        class ProcessCrash(BaseException):
            pass
        with self.assertRaises(ProcessCrash):
            self.main(after_send=ProcessCrash())
        self.assertFalse((self.m.state_root / "monitor-stop.json").exists())
        before = read_json(self.f.state / "outbox.json")
        entry = before["actions"][before["order"][0]]
        self.assertIs(entry["attempted"], True)
        self.assertIsNone(entry["delivery"])
        for kind, observations in (("timeout", [None]), ("approval", None)):
            self.assertEqual(self.main([kind], observations=observations), 0)
            self.assertEqual(read_json(self.f.state / "outbox.json"), before)
            self.assertEqual(list(self.f.state.glob("cancelled-*.json")), [])
        # Existing pending native mail must not prevent request-show reconciliation.
        self.assertEqual(self.main(), 0)
        self.assertEqual(self.status()["state"], "continuation_enqueued")
        self.assertEqual(self.main(), 0)
        self.assertEqual(self.status()["state"], "awaiting_continuation")
        self.assertEqual(len(self.m.messages), 1)
        self.assertTrue(any(c[:2] == ["orchestration", "request-show"] for c in self.m.calls))

    def test_send_deadline_is_not_a_normal_wait_or_auto_restarted(self):
        self.assertEqual(self.main(after_send=subprocess.TimeoutExpired("send", 12)), 2)
        self.assertEqual(self.main(), 2)
        self.assertEqual(len(self.m.messages), 1)
        state = read_json(self.f.state / "outbox.json")
        entry = state["actions"][state["order"][0]]
        self.assertIs(entry["attempted"], True)
        self.assertIsNone(entry["delivery"])
        self.assertEqual(list(self.f.state.glob("cancelled-*.json")), [])

    def test_scheduler_outer_timeout_minimum_validated_before_state_write(self):
        for seconds in (1, 6, 11):
            self.m.data["rpc_timeout_seconds"] = seconds
            with self.subTest(seconds=seconds), self.assertRaisesRegex(ValueError, "tui_wait_timeout_too_short"):
                self.m.configure()
            self.assertFalse((self.m.state_root / "monitor-stop.json").exists())
            self.assertFalse((self.m.state_root / "state.json").exists())
        for seconds in (12, 60):
            self.m.data["rpc_timeout_seconds"] = seconds
            self.m.configure()
        self.m.data.update(continuation=None, rpc_timeout_seconds=1)
        self.m.configure()  # observation-only monitors retain their limits


if __name__ == "__main__":
    unittest.main()

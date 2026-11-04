"""Offline complete monitor→mailbox→Coordinator action cycles, no live sends."""

import copy
from datetime import timedelta
import errno
import os
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

from coordinator_io import (LockBusy, bound_lock, canonical, digest, now, parse, pinned,
                            read_json, replace_json, timestamp, try_bound_lock)
from coordinator_tui_continue import apply_review_clear
from coordinator_tui_scheduler import WaitNotReady, completed, schedule
from terminal_idle_wait import IdleWaitResult
from coordinator_tui_turn_end import turn_end
import operator_monitor as monitor
import test_coordinator_tui_continue as continuation
import test_coordinator_loop as loop
import test_operator_monitor as monitoring


class SchedulerTests(unittest.TestCase):
    def setUp(self):
        self.f = continuation.ContinuationTests()
        self.f.setUp()
        self.addCleanup(self.f.doCleanups)
        self.m = monitoring.MonitorTests()
        self.m.setUp()
        self.addCleanup(self.m.doCleanups)
        c = self.f.c
        self.m.binding = dict(runtime=c["runtime"], run=c["run"]["id"], generation=c["run"]["generation"],
                              terminal=c["coordinator"]["terminal"], incarnation=c["coordinator"]["incarnation"],
                              workspace=c["workspace"]["id"])
        self.m.data.update(binding=self.m.binding, watch_file=None, rpc_timeout_seconds=12)
        self.m.terminal = copy.deepcopy(self.f.t.term)
        self.m.run = dict(id=c["run"]["id"], coordinator_handle=c["coordinator"]["terminal"],
                          consumer_generation=c["run"]["generation"])
        self.f.config.update(schema_version=2, scheduler=self.m.sender)
        if getattr(self, "turn_protocol", None) is not None:
            self.f.config["turn_protocol"] = self.turn_protocol
        self.f.config_ref = self.f.t.ref("scheduled-config.json", self.f.config)
        self.m.data["continuation"] = self.f.config_ref
        with patch.object(monitor.watch, "CLI", c["cli"]["path"]):
            self.m.config = self.m.configure()
        self.cli_patch = patch.object(monitor.watch, "CLI", c["cli"]["path"])
        self.cli_patch.start()
        self.addCleanup(self.cli_patch.stop)
        self.snapshot = dict(workers=[], jobs={})
        self.ended = None
        self.new_turn()

    def new_turn(self, statuses=None, action_id=None):
        if statuses:
            self.f.record["checkpoint"] = loop.LoopTests().fixture(statuses=statuses)[1]
        if action_id:
            self.f.record["checkpoint"]["next_action"]["id"] = action_id
        self.f.bind_domain()
        domain = self.f.record["domain_check"]
        source = parse(pinned(domain["source"]))
        source["observed_at"] = now()
        domain["source"] = self.f.t.ref(f"bootstrap/scheduled-source-{self.f.domain_version}.json", source)
        receipt = parse(pinned(domain["receipt"]))
        receipt["authority_check"]["checkpoint_sha256"] = digest(canonical(source))
        domain["receipt"] = self.f.t.ref(f"bootstrap/scheduled-receipt-{self.f.domain_version}.json", receipt)
        self.f.record_path = self.f.t.f.bootstrap / f"scheduled-checkpoint-{self.f.domain_version}.json"
        self.f.rewrite_record(rebind=False)
        self.ended = dict(thread_id=self.f.c["coordinator"]["session"], completed_turn=dict(
            turn_id=f"turn-{self.f.domain_version}",
            context_at=(timestamp(source["observed_at"]) - timedelta(milliseconds=1)).isoformat(),
            completed_at=now(), prefix_bytes=self.f.domain_version, prefix_sha256="a" * 64))

    def tick(self, **kwargs):
        return schedule(self.m.config, self.snapshot, kwargs.pop("call", self.m.fake),
                        observe_turn=kwargs.pop("observe_turn", lambda *_: copy.deepcopy(self.ended)), **kwargs)

    def execute(self):
        with patch.dict(os.environ, ORCA_TERMINAL_HANDLE="term_test"):
            self.f.observer_mock.return_value["observed_at"] = now()
            self.assertTrue(self.f.step("claim")["execute_action"])
            self.assertFalse(self.f.step("claim")["execute_action"])
            proof = self.f.t.ref(f"bootstrap/proof-{self.f.domain_version}.json", {"actual": self.f.domain_version})
            result = self.f.t.ref(f"bootstrap/result-{self.f.domain_version}.json", dict(
                action_id=self.f.record["checkpoint"]["next_action"]["id"], checkpoint=self.f.record_ref,
                status="executed", evidence=[proof]))
            self.assertEqual(self.f.step("settle", result_ref=result)["state"], "settled")
        for message in self.m.messages:
            message["read"] = 1  # native ACK fixture, NOT a scheduler operation

    def audit(self):
        def query(cli, runtime, args):
            if args[:2] == ["orchestration", "check"]:
                return dict(runId="run_test", count=0, messages=[], hasOutstandingDelivery=False)
            return self.f.query(cli, runtime, args)
        with patch.dict(os.environ, ORCA_TERMINAL_HANDLE="term_test"):
            return turn_end(self.f.config_ref, call=query)

    def test_settled_action_id_rejected_before_yield_then_two_cycles_finish(self):
        original_config = self.f.config_ref.copy()
        self.tick()
        self.execute()
        # Real failure shape: fresh source/receipt/head, but the action is the
        # one just settled. A new timestamp/hash is not a new continuation.
        self.new_turn()
        before = {p.name: p.read_bytes() for p in self.f.state.iterdir()}
        head = read_json(self.f.config["checkpoint_head"])
        for _ in range(2):
            with self.assertRaisesRegex(ValueError, "tui_scheduler_checkpoint_not_advanced"):
                self.audit()
        self.assertEqual({p.name: p.read_bytes() for p in self.f.state.iterdir()}, before)
        self.assertEqual(read_json(self.f.config["checkpoint_head"]), head)
        self.assertEqual(len(self.m.messages), 1)
        self.assertFalse((self.m.state_root / "monitor-stop.json").exists())

        # The same Coordinator corrects the domain checkpoint before ending its
        # turn. No reset/reinitialization/replay is needed in this offline case.
        self.new_turn(("met", "actionable"))
        self.assertEqual(self.audit()["outcome"], "scheduler_will_check_real_turn_end")
        self.tick()
        self.execute()
        self.new_turn(("met", "met"))
        self.assertEqual(self.audit()["decision"], "complete")
        self.assertEqual(self.tick()["route"], "acceptance_review")
        self.assertEqual(self.f.config_ref, original_config)
        self.assertEqual(len(self.m.messages), 2)
        self.assertEqual(len(self.m.receipts), 2)

    def test_turn_end_rejects_older_settled_id_even_with_changed_action(self):
        old_id = self.f.record["checkpoint"]["next_action"]["id"]
        self.tick()
        self.execute()
        self.new_turn(("met", "actionable"))
        self.tick()
        self.execute()
        self.new_turn(action_id=old_id)
        before = {p.name: p.read_bytes() for p in self.f.state.iterdir()}
        with self.assertRaisesRegex(ValueError, "tui_scheduler_checkpoint_not_advanced"):
            self.audit()
        self.assertEqual({p.name: p.read_bytes() for p in self.f.state.iterdir()}, before)
        self.assertEqual(len(self.m.messages), 2)

    def test_scheduler_still_refuses_reused_settled_id_if_turn_end_is_skipped(self):
        self.tick()
        self.execute()
        self.new_turn()
        before = (self.f.state / "outbox.json").read_bytes()
        with self.assertRaisesRegex(ValueError, "tui_scheduler_checkpoint_not_advanced"):
            self.tick()
        self.assertEqual((self.f.state / "outbox.json").read_bytes(), before)
        self.assertEqual(len(self.m.messages), 1)

    def test_two_automatic_continuations_without_model_enqueue_or_turn_end(self):
        for _ in range(3):
            self.tick()
        self.assertEqual(len(self.m.messages), 1)
        self.assertIn("Do not enqueue yourself", str(self.m.calls))
        self.assertIn("run coordinator_tui_continue.py turn-end", str(self.m.calls))
        self.assertIn("do not reinitialize or rewrite timestamps", str(self.m.calls))
        self.execute()
        self.new_turn(("met", "actionable"))
        self.tick()
        self.assertEqual(len(self.m.messages), 2)
        self.execute()
        self.new_turn(("met", "met"))
        result = self.tick()
        self.assertEqual(result["route"], "acceptance_review")
        self.assertEqual(self.tick(), result)
        self.assertEqual(len(self.m.messages), 2)
        self.assertFalse(any(c[:2] in (["terminal", "send"], ["orchestration", "check"],
                                      ["orchestration", "worker-start"]) for c in self.m.calls))

    def test_initialized_config_two_cycles_and_monitor_restart(self):
        from coordinator_tui_prepare import prepare
        from coordinator_tui_continue import load
        root = self.f.t.f.bootstrap
        root.chmod(0o700)
        inputs = {k: self.f.config[k] for k in (
            "contract", "dispatch_gate", "acceptance", "deadline", "scheduler")}
        inputs.update(schema_version=1, output_dir=str(root / "initialized"),
                      **{k: self.f.record["domain_check"][k] for k in ("source", "receipt")})
        with patch.dict(os.environ, ORCA_TERMINAL_HANDLE="term_test"):
            initialized = prepare(self.f.t.ref("bootstrap/init-inputs.json", inputs), call=self.f.query)
        self.f.config_ref = initialized["config"]
        self.f.config, _, self.f.state = load(self.f.config_ref)
        self.f.record_ref = initialized["checkpoint"]
        self.m.data["continuation"] = self.f.config_ref
        self.m.config = self.m.configure()

        def tick():
            return self.m.cli("--execute", "--confirm-skill-read", "--once")

        with patch("coordinator_tui_scheduler.schedule", side_effect=lambda *args: self.tick()):
            for statuses in (None, ("met", "actionable")):
                if statuses:
                    self.new_turn(statuses)
                    replace_json(Path(self.f.config["checkpoint_head"]), self.f.record_ref)
                count = len(self.m.messages)
                self.assertEqual(tick(), 0)
                journal = read_json(self.f.state / "outbox.json")
                self.assertEqual(tick(), 0)  # New monitor invocation, same persistent intent.
                self.assertEqual(read_json(self.f.state / "outbox.json"), journal)
                self.assertEqual(len(self.m.messages), count + 1)
                self.execute()
            self.new_turn(("met", "met"))
            replace_json(Path(self.f.config["checkpoint_head"]), self.f.record_ref)
            self.assertEqual(tick(), 0)
        self.assertEqual(len(self.m.messages), 2)
        self.assertEqual(len(self.m.receipts), 2)
        self.assertEqual(read_json(self.m.state_root / "status.json")["scheduler"]["route"],
                         "acceptance_review")
        self.assertFalse((self.m.state_root / "monitor-stop.json").exists())

    def test_initialized_no_deadline_two_cycles_and_monitor_restart(self):
        self.f.config["deadline"] = None
        self.test_initialized_config_two_cycles_and_monitor_restart()

    def test_monitor_loop_uses_scheduler_and_suppresses_generic_reminders(self):
        with patch("coordinator_tui_scheduler.schedule", side_effect=lambda m, s, c: self.tick()):
            self.assertEqual(monitor.tick(self.m.config, call=self.m.fake), "monitoring")
            self.assertEqual(monitor.tick(self.m.config, call=self.m.fake), "monitoring")
        self.assertEqual(self.m.state()["outbox"], [])
        self.assertEqual(len(self.m.messages), 1)
        self.assertEqual(read_json(self.m.state_root / "status.json")["scheduler"]["state"], "awaiting_continuation")

    def test_duplicate_initialization_wakeup_audited_before_two_cycles_and_restart(self):
        original_config = self.f.config_ref.copy()

        def audit():
            def query(cli, runtime, args):
                if args[:2] == ["orchestration", "check"]:
                    return dict(runId="run_test", count=0, messages=[], hasOutstandingDelivery=False)
                return self.f.query(cli, runtime, args)
            with patch.dict(os.environ, ORCA_TERMINAL_HANDLE="term_test"):
                return turn_end(self.f.config_ref, call=query)

        # Duplicate native mail starts another real turn after initialization.
        # Auditing before yield catches the stale head, without stopping monitor.
        self.f.observer_mock.return_value["observed_at"] = now()
        with self.assertRaisesRegex(ValueError, "tui_checkpoint_not_from_current_turn"):
            audit()
        self.assertEqual(list(self.f.state.iterdir()), [])
        self.assertEqual(self.m.messages, [])
        self.new_turn()
        with patch("coordinator_tui_scheduler.schedule", side_effect=lambda *args: self.tick()):
            for statuses in (None, ("met", "actionable")):
                if statuses:
                    self.new_turn(statuses)
                self.assertEqual(audit()["outcome"], "scheduler_will_check_real_turn_end")
                self.assertEqual(self.m.cli("--execute", "--confirm-skill-read", "--once"), 0)
                saved = read_json(self.f.state / "outbox.json")
                self.assertEqual(self.m.cli("--execute", "--confirm-skill-read", "--once"), 0)
                self.assertEqual(read_json(self.f.state / "outbox.json"), saved)
                self.execute()
            self.new_turn(("met", "met"))
            self.assertEqual(audit()["decision"], "complete")
            self.assertEqual(self.m.cli("--execute", "--confirm-skill-read", "--once"), 0)
        self.assertEqual(self.f.config_ref, original_config)
        self.assertEqual(len(self.m.messages), 2)
        self.assertEqual(len(self.m.receipts), 2)
        self.assertFalse((self.m.state_root / "monitor-stop.json").exists())

    def test_real_lock_busy_monitor_restart_and_two_continuations(self):
        # Real kernel locks; only native queries/messages and completed turns are fixtures.
        def cli():
            return self.m.cli("--execute", "--confirm-skill-read", "--once")
        with patch("coordinator_tui_scheduler.schedule", side_effect=lambda *args: self.tick()):
            for statuses in (None, ("met", "actionable")):
                if statuses:
                    self.new_turn(statuses)
                with bound_lock(self.f.state, self.f.config_ref, "tui-continuation"):
                    before = {p.name: p.read_bytes() for p in self.f.state.iterdir()}
                    count = len(self.m.messages)
                    for _ in range(2):  # A monitor restart while the Coordinator still owns the lock.
                        self.assertEqual(cli(), 0)
                        self.assertEqual(read_json(self.m.state_root / "status.json")["scheduler"],
                            {"state": "reobserving", "reason": "tui_continuation_lock_busy"})
                        self.assertFalse((self.m.state_root / "monitor-stop.json").exists())
                    self.assertEqual({p.name: p.read_bytes() for p in self.f.state.iterdir()}, before)
                    self.assertEqual(len(self.m.messages), count)
                self.assertEqual(cli(), 0)
                after = read_json(self.f.state / "outbox.json")
                self.assertEqual(cli(), 0)  # Restart after send must retain the same UUID/receipt.
                self.assertEqual(read_json(self.f.state / "outbox.json"), after)
                self.assertEqual(len(self.m.messages), count + 1)
                self.execute()
            self.new_turn(("met", "met"))
            self.assertEqual(cli(), 0)
        self.assertEqual(len(self.m.messages), 2)
        self.assertEqual(len(self.m.receipts), 2)
        status = read_json(self.m.state_root / "status.json")["scheduler"]
        self.assertEqual(status["route"], "acceptance_review")
        self.assertFalse((self.m.state_root / "monitor-stop.json").exists())

    def test_scheduler_wait_observation_does_not_hold_continuation_lock(self):
        acquisitions = []
        def observe(*_):
            with try_bound_lock(self.f.state, self.f.config_ref, "tui-continuation") as acquired:
                acquisitions.append(acquired)
            return None
        self.assertEqual(self.tick(observe_turn=observe)["state"], "awaiting_real_turn_end")
        self.assertEqual(acquisitions, [True])
        self.assertEqual(self.m.messages, [])

    def test_body_blocking_io_error_still_persists_stop(self):
        for kind in (BlockingIOError, LockBusy):
            def failed_observation(*_):
                raise kind(errno.EAGAIN, "body")
            with self.subTest(kind=kind), self.assertRaises(kind):
                self.tick(observe_turn=failed_observation)
        with patch("coordinator_tui_scheduler.read_outbox", side_effect=BlockingIOError(errno.EAGAIN, "read")), \
                patch("coordinator_tui_scheduler.schedule", side_effect=lambda *args: self.tick()):
            self.assertEqual(self.m.cli("--execute", "--confirm-skill-read", "--once"), 2)
        self.assertEqual(read_json(self.m.state_root / "monitor-stop.json")["reason"], "BlockingIOError")
        self.assertEqual(self.m.cli("--execute", "--confirm-skill-read", "--once"), 2)
        self.assertEqual(self.m.messages, [])

    def test_busy_or_missing_completion_never_sends(self):
        self.assertEqual(self.tick(observe_turn=lambda *_: None)["state"], "awaiting_real_turn_end")
        self.assertEqual(self.m.messages, [])

    def test_completed_accepts_provider_turn_after_native_timeout(self):
        with patch("coordinator_tui_scheduler.observe") as observe:
            observe.return_value = self.ended
            self.assertEqual(completed(self.f.c, lambda *_: IdleWaitResult("pending", "tui_idle_timeout")),
                             self.ended)
            self.assertTrue(observe.call_args.kwargs["completed_turn"])
            observe.reset_mock()
            observe.return_value = None
            with self.assertRaises(WaitNotReady):
                completed(self.f.c, lambda *_: IdleWaitResult("pending", "tui_idle_timeout"))
            observe.assert_called_once()

    def test_completed_does_not_bypass_interaction_or_malformed_idle(self):
        with patch("coordinator_tui_scheduler.observe") as observe:
            with self.assertRaises(WaitNotReady):
                completed(self.f.c, lambda *_: IdleWaitResult("interaction_required", "agent-approval-prompt"))
            observe.assert_not_called()
            with self.assertRaises(WaitNotReady):
                completed(self.f.c, lambda *_: IdleWaitResult("pending", "other_pending_reason"))
            observe.assert_not_called()
            with self.assertRaisesRegex(ValueError, "idle_state_unavailable"):
                completed(self.f.c, lambda *_: {"wait": {}})
            observe.assert_not_called()
            observe.return_value = self.ended
            self.assertEqual(completed(self.f.c, lambda *_: IdleWaitResult("ready")), self.ended)
            self.assertTrue(observe.call_args.kwargs["completed_turn"])

    def test_missing_head_has_explicit_error_and_no_send(self):
        self.f.config["checkpoint_head"] = str(self.f.t.f.bootstrap / "missing-head.json")
        self.f.config_ref = self.f.t.ref("missing-head-config.json", self.f.config)
        self.m.data["continuation"] = self.f.config_ref
        with self.assertRaisesRegex(ValueError, "checkpoint_head_not_initialized"):
            self.m.configure()
        self.assertEqual(self.m.messages, [])

    def test_stale_checkpoint_missing_head_and_same_turn_rewrite_stop(self):
        self.ended["completed_turn"]["context_at"] = now()
        with self.assertRaisesRegex(ValueError, "not_from_completed_turn"):
            self.tick()
        self.new_turn()
        self.tick()
        old = copy.deepcopy(self.ended)
        self.new_turn(action_id="changed")
        self.ended["completed_turn"]["turn_id"] = old["completed_turn"]["turn_id"]
        with self.assertRaisesRegex(ValueError, "completed_turn_checkpoint_changed"):
            self.tick()
        self.assertEqual(len(self.m.messages), 1)

    def test_skipped_audit_still_persists_stale_checkpoint_stop_across_restart(self):
        self.ended["completed_turn"]["context_at"] = now()
        with patch("coordinator_tui_scheduler.schedule", side_effect=lambda *args: self.tick()):
            self.assertEqual(self.m.cli("--execute", "--confirm-skill-read", "--once"), 2)
            stopped = read_json(self.m.state_root / "monitor-stop.json")
            self.assertEqual(stopped["reason"], "tui_checkpoint_not_from_completed_turn")
            before = read_json(self.m.state_root / "state.json")
            self.assertEqual(self.m.cli("--execute", "--confirm-skill-read", "--once"), 2)
        self.assertEqual(read_json(self.m.state_root / "monitor-stop.json"), stopped)
        self.assertEqual(read_json(self.m.state_root / "state.json"), before)
        self.assertEqual(before["outbox"], [])
        self.assertEqual(before["sequence"], 0)
        self.assertEqual(self.m.messages, [])
        self.assertFalse((self.f.state / "outbox.json").exists())

    def test_unsettled_claim_waits_without_checkpoint_advance(self):
        self.tick()
        with patch.dict(os.environ, ORCA_TERMINAL_HANDLE="term_test"):
            self.f.observer_mock.return_value["observed_at"] = now()
            self.f.step("claim")
        self.assertEqual(self.tick()["state"], "awaiting_continuation")
        self.assertEqual(len(self.m.messages), 1)

    def test_sender_owner_and_retirement_changes_block_before_send(self):
        def retire(args, *rest):
            value = self.m.fake(args, *rest)
            if args[1:2] == ["run-show"]:
                value["strictRetirement"] = {"retired": True}
            return value
        with self.assertRaisesRegex(ValueError, "coordinator_changed"):
            self.tick(call=retire)
        with patch.dict(os.environ, ORCA_TERMINAL_HANDLE="term_test"):
            with self.assertRaisesRegex(ValueError, "own_operator_terminal"):
                self.tick()
        self.m.operator_terminal["incarnationId"] = "replacement"
        with self.assertRaisesRegex(ValueError, "operator_terminal_unverifiable"):
            self.tick()
        self.assertEqual(self.m.messages, [])

    def test_crash_reconciles_same_operator_receipt_never_repeats_send(self):
        def crash(args, *rest):
            reply = self.m.fake(args, *rest)
            if args[1:2] == ["send"]:
                raise subprocess.TimeoutExpired("send", 1)
            return reply
        with self.assertRaises(subprocess.TimeoutExpired):
            self.tick(call=crash)
        self.assertEqual(self.tick()["state"], "continuation_enqueued")
        self.assertEqual(len(self.m.messages), 1)

    def test_absent_send_receipt_never_replays(self):
        def crash(args, *rest):
            if args[1:2] == ["send"]:
                raise subprocess.TimeoutExpired("send", 1)
            return self.m.fake(args, *rest)
        with self.assertRaises(subprocess.TimeoutExpired):
            self.tick(call=crash)
        with self.assertRaisesRegex(ValueError, "requires_reconciliation"):
            self.tick()
        self.assertEqual(self.m.messages, [])

    def mail(self, read=0, **changes):
        return dict(dict(id="external", run_id="run_test", to_handle="run:run_test", read=read,
                         delivery_contract="current_delivery"), **changes)

    def test_native_mail_takes_priority_even_when_pending_window_full(self):
        self.m.messages = [self.mail()]
        self.assertEqual(self.tick()["state"], "awaiting_native_mail_processing")
        self.m.messages *= self.m.data["inbox_limit"]
        self.assertEqual(self.tick()["state"], "awaiting_native_mail_processing")
        self.assertEqual(len(self.m.receipts), 0)

    def test_acked_history_over_limit_is_quiet_but_old_unacked_delivery_blocks(self):
        self.m.messages = [self.mail(delivered_at=now())] + [self.mail(read=1)] * 250
        self.assertEqual(self.tick()["state"], "awaiting_native_mail_processing")
        self.assertEqual(self.m.messages[0]["read"], 0)
        self.m.messages[0]["read"] = 1
        self.assertEqual(self.tick()["state"], "continuation_enqueued")
        self.assertEqual(len(self.m.receipts), 1)

    def test_old_host_missing_marker_and_wrong_scope_fail_closed(self):
        for change in ({"filter": None}, {"filter": {"mode": "pending", "terminal": "run:other"}},
                       {"messages": [self.mail(read=1)], "count": 1}, {"count": True},
                       {"messages": [self.mail(run_id="other")], "count": 1}):
            def query(args, *rest):
                reply = self.m.fake(args, *rest)
                if args[1:2] == ["inbox"]:
                    reply.update(change)
                return reply
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, "pending_inbox"):
                self.tick(call=query)
        self.assertEqual(self.m.messages, [])

    def test_new_turn_races_send_validation(self):
        observations = iter([self.ended, self.ended, None])
        result = self.tick(observe_turn=lambda *_: next(observations))
        self.assertEqual(result, dict(state="reobserving", reason="tui_turn_changed_before_send"))
        self.assertEqual(read_json(self.f.state / "outbox.json")["actions"], {})
        archived = list(self.f.state.glob("cancelled-*.json"))
        self.assertEqual(len(archived), 1)
        self.assertIs(read_json(archived[0])["entry"]["attempted"], False)
        self.assertEqual(self.m.messages, [])
        self.new_turn(action_id="after-race")
        self.assertEqual(self.tick()["state"], "continuation_enqueued")

    def test_monitor_main_race_and_restart_do_not_latch_stop(self):
        observations = iter([self.ended, self.ended, None])
        with patch("coordinator_tui_scheduler.schedule", side_effect=lambda *_: self.tick(
                observe_turn=lambda *_: next(observations))):
            self.assertEqual(self.m.cli("--execute", "--confirm-skill-read", "--once"), 0)
        self.assertFalse((self.m.state_root / "monitor-stop.json").exists())
        self.assertEqual(self.m.messages, [])
        self.new_turn(action_id="restart")
        with patch("coordinator_tui_scheduler.schedule", side_effect=lambda *_: self.tick()):
            for _ in range(2):
                self.assertEqual(self.m.cli("--execute", "--confirm-skill-read", "--once"), 0)
        self.assertEqual(len(self.m.messages), 1)

    def test_same_thread_completed_turn_race_requeues_once_after_reobservation(self):
        count = 0
        def observe(*_):
            nonlocal count
            count += 1
            if count == 3:
                self.new_turn(action_id="next-completed")
            return copy.deepcopy(self.ended)
        self.assertEqual(self.tick(observe_turn=observe)["reason"], "tui_turn_changed_before_send")
        self.assertEqual(self.m.messages, [])
        self.assertEqual(self.tick()["state"], "continuation_enqueued")
        self.assertEqual(self.tick()["state"], "awaiting_continuation")
        self.assertEqual(len(self.m.messages), 1)

    def test_same_checkpoint_after_race_can_still_send(self):
        observations = iter([self.ended, self.ended, None])
        self.assertEqual(self.tick(observe_turn=lambda *_: next(observations))["state"], "reobserving")
        self.assertEqual(self.tick()["state"], "continuation_enqueued")
        self.assertEqual(len(self.m.messages), 1)


    def test_mail_or_head_change_before_send_reobserves(self):
        original = self.m.fake
        def query(args, *rest):
            if args[1:2] == ["inbox"] and (self.f.state / "outbox.json").exists():
                self.m.messages = [self.mail()]
            return original(args, *rest)
        self.assertEqual(self.tick(call=query)["reason"], "tui_mail_arrived_before_send")
        self.m.messages.clear()
        count = 0
        def observe(*_):
            nonlocal count
            count += 1
            old = copy.deepcopy(self.ended)
            if count == 3:
                self.new_turn(action_id="new-head")
            return old
        self.assertEqual(self.tick(observe_turn=observe)["reason"], "tui_checkpoint_superseded")
        self.assertEqual(len(self.m.receipts), 0)
        self.assertEqual(self.tick()["state"], "continuation_enqueued")

    def test_race_before_checkpoint_validation_reobserves(self):
        old = copy.deepcopy(self.ended)
        self.new_turn(action_id="external-turn")
        observations = iter([old, self.ended])
        self.assertEqual(self.tick(observe_turn=lambda *_: next(observations))["state"], "reobserving")
        self.assertEqual(self.m.messages, [])
        self.assertEqual(self.tick()["state"], "continuation_enqueued")

    def test_prepare_crash_and_archive_crash_recover_without_stale_pending(self):
        for crash_archive in (False, True):
            with self.subTest(crash_archive=crash_archive):
                with patch("coordinator_tui_scheduler.deliver_entry", side_effect=RuntimeError("crash")):
                    with self.assertRaisesRegex(RuntimeError, "crash"):
                        self.tick()
                pending = read_json(self.f.state / "outbox.json")
                request = pending["actions"][pending["order"][-1]]["request_id"]
                self.new_turn(action_id="recover-" + str(crash_archive))
                if crash_archive:
                    with patch("coordinator_tui_continue.replace_json", side_effect=RuntimeError("archive-crash")):
                        with self.assertRaisesRegex(RuntimeError, "archive-crash"):
                            self.tick()
                    self.assertEqual(read_json(self.f.state / "outbox.json"), pending)
                self.assertEqual(self.tick()["state"], "continuation_enqueued")
                archives = [read_json(p) for p in self.f.state.glob("cancelled-*.json")]
                self.assertEqual(sum(a["entry"]["request_id"] == request for a in archives), 1)
                self.execute()
                self.new_turn(action_id="next-" + str(crash_archive))

    def test_provider_identity_race_still_latches_stop(self):
        wrong = copy.deepcopy(self.ended)
        wrong["thread_id"] = "replacement"
        observations = iter([self.ended, self.ended, wrong])
        with patch("coordinator_tui_scheduler.schedule", side_effect=lambda *_: self.tick(
                observe_turn=lambda *_: next(observations))):
            self.assertEqual(self.m.cli("--execute", "--confirm-skill-read", "--once"), 2)
        self.assertEqual(read_json(self.m.state_root / "monitor-stop.json")["reason"],
                         "tui_provider_session_changed")
        self.assertEqual(self.m.cli("--execute", "--confirm-skill-read", "--once"), 2)
        self.assertEqual(self.m.messages, [])

    def test_wait_exact_dispatch_changes_or_already_complete_wake(self):
        self.new_turn(("waiting", "waiting"))
        self.f.record["checkpoint"]["next_action"]["prerequisites"] = ["orca-dispatch:d1"]
        self.new_turn()
        self.snapshot["workers"] = [dict(dispatch="d1", dispatch_status="dispatched", state="working")]
        self.assertEqual(self.tick()["state"], "waiting_dependencies")
        self.snapshot["workers"].append(dict(dispatch="unrelated", dispatch_status="completed"))
        self.assertEqual(self.tick()["state"], "waiting_dependencies")
        self.snapshot["workers"][0]["dispatch_status"] = "completed"
        self.assertEqual(self.tick()["state"], "continuation_enqueued")
        self.execute()

    def test_already_completed_dependency_wakes_on_first_poll(self):
        self.new_turn(("waiting", "waiting"))
        self.f.record["checkpoint"]["next_action"]["prerequisites"] = ["orca-dispatch:done"]
        self.new_turn()
        self.snapshot["workers"] = [dict(dispatch="done", dispatch_status="completed")]
        self.assertEqual(self.tick()["state"], "continuation_enqueued")

    def test_wait_exact_job_evidence_changes_wake_even_while_running(self):
        self.new_turn(("waiting", "waiting"))
        self.f.record["checkpoint"]["next_action"]["prerequisites"] = ["orca-job:" + "a" * 64]
        self.new_turn()
        self.snapshot["jobs"] = {"a" * 64: dict(status="running", evidence={"checkpoint": "one"})}
        self.assertEqual(self.tick()["state"], "waiting_dependencies")
        self.snapshot["jobs"]["a" * 64]["evidence"]["checkpoint"] = "two"
        self.assertEqual(self.tick()["state"], "continuation_enqueued")

    def test_new_processing_hashes_and_action_names_cannot_loop_forever(self):
        for index in range(3):
            self.assertEqual(self.tick()["state"], "continuation_enqueued")
            self.execute()  # Distinct proof hashes, but no acceptance advancement.
            self.new_turn(action_id=f"renamed-{index}")
        before = {p.name: p.read_bytes() for p in self.f.state.iterdir()}
        audit = self.audit()
        self.assertFalse(audit["ok"])
        self.assertFalse(audit["scheduler_stop_persisted"])
        self.assertEqual(audit["error"], "tui_scheduler_no_acceptance_progress")
        self.assertEqual({p.name: p.read_bytes() for p in self.f.state.iterdir()}, before)
        stop = self.tick()
        self.assertEqual(audit["scheduler_review"], stop)
        self.assertEqual(audit["progress"], stop["progress"])
        self.assertEqual(stop["reason"], "tui_scheduler_no_acceptance_progress")
        self.assertEqual(stop["progress"]["consecutive_without_acceptance_advance"], 3)
        self.assertEqual(len(self.m.messages), 3)
        self.assertEqual(self.tick(), stop)  # Same state after restart, no new send.
        # Even genuinely newly met work cannot silently clear a persisted gate.
        self.new_turn(("met", "actionable"))
        before = {p.name: p.read_bytes() for p in self.f.state.iterdir()}
        audit = self.audit()
        self.assertFalse(audit["ok"])
        self.assertTrue(audit["scheduler_stop_persisted"])
        self.assertEqual(audit["progress"]["consecutive_without_acceptance_advance"], 0)
        self.assertEqual(audit["scheduler_review"], stop)
        self.assertEqual(self.tick(), stop)
        self.assertEqual({p.name: p.read_bytes() for p in self.f.state.iterdir()}, before)
        self.assertIsNone(self.m.data["continuation"].get("business_acceptance"))

        clear_ref, clear = self.f.scheduler_review_clear_ref(stop)
        applied = apply_review_clear(self.f.config_ref, clear_ref)
        self.assertEqual(applied["state"], "scheduler_review_clear_applied")
        after_clear = self.audit()
        self.assertTrue(after_clear["ok"])
        self.assertEqual(after_clear["scheduler_review_clear"]["review"], clear)
        self.assertNotIn("scheduler_review", after_clear)
        self.assertEqual(self.tick()["state"], "continuation_enqueued")
        self.assertEqual(len(self.m.messages), 4)
        self.assertEqual(read_json(self.f.state / "scheduler.json")["stop"], stop)

    def historical_reviewed_unsent_head(self):
        for index in range(3):
            self.assertEqual(self.tick()["state"], "continuation_enqueued")
            self.execute()
            self.new_turn(action_id=f"historical-{index}")
        stop = self.tick()
        self.assertEqual(stop["reason"], "tui_scheduler_no_acceptance_progress")
        self.assertEqual(len(self.m.messages), 3)
        clear_ref, clear = self.f.scheduler_review_clear_ref(stop)
        applied = apply_review_clear(self.f.config_ref, clear_ref)
        self.assertEqual(applied["state"], "scheduler_review_clear_applied")
        old = copy.deepcopy(self.ended)
        self.ended = copy.deepcopy(old)
        self.ended["completed_turn"] = dict(turn_id="later-turn",
            context_at=(timestamp(now()) + timedelta(seconds=1)).isoformat(),
            completed_at=(timestamp(now()) + timedelta(seconds=2)).isoformat(),
            prefix_bytes=999, prefix_sha256="b" * 64)
        return stop, clear_ref, clear, old

    def test_reviewed_historical_unsent_head_waits_for_fresh_checkpoint_without_send(self):
        self.historical_reviewed_unsent_head()
        before_outbox = (self.f.state / "outbox.json").read_bytes()
        before_journal = read_json(self.f.state / "scheduler.json")
        before_messages = copy.deepcopy(self.m.messages)
        result = self.tick()
        self.assertEqual(result["state"], "awaiting_fresh_checkpoint")
        self.assertEqual(result["reason"], "historical_checkpoint_not_sendable")
        self.assertEqual((self.f.state / "outbox.json").read_bytes(), before_outbox)
        self.assertEqual(read_json(self.f.state / "scheduler.json"), before_journal)
        self.assertEqual(self.m.messages, before_messages)

    def test_settled_head_restart_observes_without_replay(self):
        self.assertEqual(self.tick()["state"], "continuation_enqueued")
        self.execute()
        before = (self.f.state / "outbox.json").read_bytes()
        first = self.tick()
        second = self.tick()
        self.assertEqual(first["state"], "settled_checkpoint_observed")
        self.assertEqual(second, first)
        self.assertEqual((self.f.state / "outbox.json").read_bytes(), before)
        self.assertEqual(len(self.m.messages), 1)

    def test_settled_operator_handoff_enqueues_one_review_without_replay(self):
        self.f.record["checkpoint"]["next_action"].update(
            id="operator-handoff", owner="outer-operator")
        self.new_turn()
        proof = self.f.t.ref("bootstrap/operator-proof-scheduler.json", {"operator": "done"})
        result_ref = self.f.t.ref("bootstrap/operator-result-scheduler.json", dict(
            action_id="operator-handoff", checkpoint=self.f.record_ref,
            status="executed", evidence=[proof]))
        with patch.dict(os.environ, {"ORCA_TERMINAL_HANDLE": "term-operator",
                                     "ORCA_PANE_KEY": "sender-tab:sender-leaf"}, clear=True):
            self.assertEqual(self.f.step("operator-settle", result_ref=result_ref,
                                         call=self.f.query)["state"], "operator_settled")
        terminal_stop = {"state": "review_required", "route": "operator_handoff",
                         "checkpoint": self.f.record_ref,
                         "business_acceptance": "not_evaluated"}
        replace_json(self.f.state / "scheduler.json", dict(config=self.f.config_ref,
                                                            stop=terminal_stop,
                                                            waits={}, turns={}))
        before = (self.f.state / "outbox.json").read_bytes()
        def fail_observe(*_):
            raise AssertionError("settled operator handoff should enqueue review before provider polling")
        first = self.tick(observe_turn=fail_observe)
        second = self.tick(observe_turn=fail_observe)
        self.assertEqual(first["state"], "operator_result_review_enqueued")
        self.assertEqual(first["result"], result_ref)
        self.assertEqual(second["state"], "awaiting_operator_result_review")
        self.assertEqual(second["delivery"], first["delivery"])
        self.assertEqual((self.f.state / "outbox.json").read_bytes(), before)
        journal = read_json(self.f.state / "scheduler.json")
        request = next(iter(journal["operator_review"].values()))
        self.assertTrue(request["attempted"])
        self.assertEqual(request["delivery"], first["delivery"])
        self.assertEqual(request["checkpoint"], self.f.record_ref)
        self.assertEqual(request["result"], result_ref)
        self.assertEqual(len(self.m.messages), 1)
        payload = parse(self.m.messages[0]["payload"].encode())
        self.assertEqual(payload["kind"], "coordinator_tui_operator_result_review_v1")
        self.assertEqual(payload["request"]["request_id"], request["request_id"])

    def test_completed_workflow_projection_can_drive_next_scheduler_cycle(self):
        self.assertEqual(self.tick()["state"], "continuation_enqueued")
        self.execute()
        old = self.f.record_ref
        outbox = read_json(self.f.state / "outbox.json")
        entry = next(iter(outbox["actions"].values()))
        result = entry["result"]
        self.new_turn(("met", "actionable"))
        next_ref = self.f.record_ref
        replace_json(Path(self.f.config["checkpoint_head"]), next_ref)
        receipt_ref = self.f.t.ref("bootstrap/workflow-completed-scheduler.json", dict(
            schema_version=1, kind="coordinator-delivery-workflow", config=self.f.config_ref,
            checkpoint=old, request_id=entry["request_id"], result=result,
            next_checkpoint=next_ref, processed=self.f.t.ref("bootstrap/processed.json", {"ok": True}),
            receipt_path=str(self.f.t.f.bootstrap / "workflow-completed-scheduler.json"),
            recovery=None,
            delivery=dict(runId="run_test", deliveryId="delivery-test", count=1,
                          messages=[{"id": entry["delivery"]["message_id"]}]),
            ack=dict(runId="run_test", acknowledged="delivery-test", messages=[], count=0,
                     hasOutstandingDelivery=False),
            turn_end=dict(ok=True, state="turn_end_checked", outcome="scheduler_will_check_real_turn_end",
                          checkpoint=next_ref, decision="continue"),
            completed_at=now()))
        key = digest(canonical(self.f.record["checkpoint"]["next_action"].get("previous", "unused")))
        key = digest(canonical(parse(pinned(result))["action_id"]))
        replace_json(self.f.state / ("workflow-" + key + ".json"), dict(
            schema_version=1, config=self.f.config_ref, checkpoint=old,
            request_id=entry["request_id"], recovery=None, completed_receipt=receipt_ref))
        # The current observed provider turn is later than the checkpoint source;
        # the scheduler must rely on the exact completed workflow receipt, not
        # reject the head as if it were an unreviewed historical checkpoint.
        self.ended["completed_turn"] = dict(turn_id="after-workflow-finish",
            context_at=(timestamp(now()) + timedelta(seconds=1)).isoformat(),
            completed_at=(timestamp(now()) + timedelta(seconds=2)).isoformat(),
            prefix_bytes=999, prefix_sha256="c" * 64)
        self.assertEqual(self.tick()["state"], "continuation_enqueued")
        self.assertEqual(len(self.m.messages), 2)

    def test_historical_wait_requires_binding_and_valid_settlement(self):
        self.historical_reviewed_unsent_head()
        journal = read_json(self.f.state / "scheduler.json")
        saved_turns = journal["turns"]
        journal["turns"] = {}
        replace_json(self.f.state / "scheduler.json", journal)
        with self.assertRaisesRegex(ValueError, "historical_turn_binding_missing"):
            self.tick()
        journal["turns"] = saved_turns
        replace_json(self.f.state / "scheduler.json", journal)

        outbox = read_json(self.f.state / "outbox.json")
        first = outbox["actions"][outbox["order"][0]]
        bad = parse(pinned(first["result"]))
        bad["action_id"] = "wrong-action"
        first["result"] = self.f.t.ref("bootstrap/bad-settlement-result.json", bad)
        replace_json(self.f.state / "outbox.json", outbox)
        with self.assertRaisesRegex(ValueError, "invalid_settlement"):
            self.tick()

    def test_scheduler_review_clear_is_exact_and_does_not_clear_new_stop(self):
        for index in range(3):
            self.tick()
            self.execute()
            self.new_turn(action_id=f"same-bound-{index}")
        stop = self.tick()
        wrong_ref, _ = self.f.scheduler_review_clear_ref(stop, "wrong-review-clear.json",
                                                         checkpoint=self.f.record["domain_check"]["source"])
        with self.assertRaisesRegex(ValueError, "tui_scheduler_review_clear_invalid"):
            apply_review_clear(self.f.config_ref, wrong_ref)
        self.new_turn(("met", "actionable"))
        clear_ref, _ = self.f.scheduler_review_clear_ref(stop)
        apply_review_clear(self.f.config_ref, clear_ref)
        self.tick()
        self.execute()
        for index in range(2):
            self.new_turn(action_id=f"after-cleared-{index}")
            self.assertEqual(self.tick()["state"], "continuation_enqueued")
            self.execute()
        self.new_turn(action_id="after-cleared-stop")
        new_stop = self.tick()
        self.assertEqual(new_stop["reason"], "tui_scheduler_no_acceptance_progress")
        self.assertNotEqual(new_stop, stop)
        self.assertEqual(read_json(self.f.state / "scheduler.json")["stop"], new_stop)

    def test_stale_review_clear_does_not_crash_terminal_review_observation(self):
        for index in range(3):
            self.tick()
            self.execute()
            self.new_turn(action_id=f"bounded-{index}")
        stop = self.tick()
        self.assertEqual(stop["reason"], "tui_scheduler_no_acceptance_progress")
        clear_ref, _ = self.f.scheduler_review_clear_ref(stop)
        apply_review_clear(self.f.config_ref, clear_ref)

        journal = read_json(self.f.state / "scheduler.json")
        terminal_stop = {"state": "review_required", "route": "alternatives_review",
                         "checkpoint": read_json(self.f.config["checkpoint_head"]),
                         "business_acceptance": "not_evaluated"}
        journal["stop"] = terminal_stop
        self.assertEqual(journal["stop"], terminal_stop)

        # Simulate an older journal that still contains the previous clear pin.
        # Observation must report the real terminal stop instead of validating
        # that stale pin against a stop class it cannot clear.
        journal["review_clear"] = clear_ref
        replace_json(self.f.state / "scheduler.json", journal)
        self.assertEqual(self.tick(), terminal_stop)

        # The same stale pin still cannot be applied as a real clear.
        with self.assertRaisesRegex(ValueError, "tui_scheduler_review_clear_unsupported_stop"):
            apply_review_clear(self.f.config_ref, clear_ref)

    def test_terminal_review_for_old_head_does_not_block_new_head(self):
        self.new_turn(("met", "met"))
        old_stop = self.tick()
        self.assertEqual(old_stop["route"], "acceptance_review")
        self.assertEqual(read_json(self.f.state / "scheduler.json")["stop"], old_stop)

        before_messages = len(self.m.messages)
        self.new_turn(("met", "actionable"), action_id="fresh-after-terminal-stop")
        result = self.tick()
        self.assertEqual(result["state"], "continuation_enqueued")
        self.assertEqual(len(self.m.messages), before_messages + 1)
        self.assertEqual(read_json(self.f.state / "scheduler.json")["stop"], old_stop)

    def test_new_met_requirement_resets_bound_but_not_evidence_reuse_check(self):
        for index in range(2):
            self.tick()
            self.execute()
            self.new_turn(action_id=f"work-{index}")
        self.tick()
        self.execute()
        self.new_turn(("met", "actionable"))
        audit = self.audit()
        self.assertTrue(audit["ok"])
        self.assertFalse(audit["scheduler_stop_persisted"])
        self.assertEqual(audit["progress"]["consecutive_without_acceptance_advance"], 0)
        self.assertEqual(self.tick()["state"], "continuation_enqueued")

    def test_counter_is_reconstructed_if_scheduler_journal_not_yet_published(self):
        from coordinator_tui_continue import validate_scheduler_progress
        for index in range(3):
            self.tick()
            self.execute()
            self.new_turn(action_id=f"work-{index}")
        result = validate_scheduler_progress(read_json(self.f.state / "outbox.json"), self.f.record)
        self.assertEqual(result["consecutive_without_acceptance_advance"], 3)

    def test_turn_end_reconstructs_bound_without_creating_scheduler_journal(self):
        for index in range(3):
            self.tick()
            self.execute()
            self.new_turn(action_id=f"work-{index}")
        # Simulated lost/unpublished journal in an isolated fixture, not recovery.
        (self.f.state / "scheduler.json").unlink()
        before = {p.name: p.read_bytes() for p in self.f.state.iterdir()}
        result = self.audit()
        self.assertFalse(result["ok"])
        self.assertEqual(result["progress"]["consecutive_without_acceptance_advance"], 3)
        self.assertEqual({p.name: p.read_bytes() for p in self.f.state.iterdir()}, before)

    def test_persisted_terminal_review_is_not_reported_as_pending_scheduler_check(self):
        self.new_turn(("met", "met"))
        self.assertTrue(self.audit()["ok"])
        stop = self.tick()
        self.assertEqual(stop["route"], "acceptance_review")
        audit = self.audit()
        self.assertFalse(audit["ok"])
        self.assertEqual(audit["error"], "tui_scheduler_stopped")
        self.assertEqual(audit["scheduler_review"], stop)
        self.assertTrue(audit["scheduler_stop_persisted"])

        self.new_turn(("met", "met"))
        self.assertEqual(self.audit()["outcome"], "scheduler_will_check_real_turn_end")

    def test_wait_and_duplicate_ticks_do_not_count_as_actions(self):
        from coordinator_tui_continue import read_outbox, validate_scheduler_progress
        self.new_turn(("waiting", "waiting"))
        self.f.record["checkpoint"]["next_action"]["prerequisites"] = ["orca-dispatch:d1"]
        self.new_turn()
        self.snapshot["workers"] = [dict(dispatch="d1", dispatch_status="dispatched", state="working")]
        for _ in range(5):
            self.assertEqual(self.tick()["state"], "waiting_dependencies")
        self.assertEqual(validate_scheduler_progress(read_outbox(self.f.state), self.f.record)
                         ["consecutive_without_acceptance_advance"], 0)
        self.snapshot["workers"][0]["dispatch_status"] = "completed"
        self.tick()
        for _ in range(5):
            self.assertEqual(self.tick()["state"], "awaiting_continuation")
        self.assertEqual(validate_scheduler_progress(read_outbox(self.f.state), self.f.record)
                         ["consecutive_without_acceptance_advance"], 0)
        self.assertEqual(len(self.m.messages), 1)

    def test_met_regression_and_redeclaration_do_not_reset_counter(self):
        from coordinator_tui_continue import validate_scheduler_progress
        self.new_turn(("met", "actionable"))
        self.tick()
        self.execute()
        self.new_turn(("actionable", "actionable"), action_id="regressed")
        state = read_json(self.f.state / "outbox.json")
        self.assertEqual(validate_scheduler_progress(state, self.f.record)
                         ["consecutive_without_acceptance_advance"], 1)
        # A repeated declaration of the already-met requirement is not first progress.
        self.new_turn(("met", "actionable"), action_id="same-met")
        self.assertEqual(validate_scheduler_progress(state, self.f.record)
                         ["consecutive_without_acceptance_advance"], 1)

    def test_completion_at_bound_routes_to_acceptance_review(self):
        self.f.record["checkpoint"]["next_action"]["path_ids"] = [
            p["id"] for p in self.f.record["checkpoint"]["paths"]]
        self.new_turn()
        for index in range(3):
            self.tick()
            self.execute()
            self.new_turn(action_id=f"step-{index}")
        self.new_turn(("met", "met"))
        self.assertEqual(self.tick()["route"], "acceptance_review")
        self.assertEqual(len(self.m.messages), 3)

    def test_invalid_native_refs_and_mixed_legacy_encoding_fail_closed(self):
        from coordinator_tui_dependencies import wait_spec
        from coordinator_tui_scheduler import dependencies
        for refs in ([], ["future-worker"], ["orca-dispatch:"], ["orca-job:bad key"], ["orca-job:bad\x7f"],
                     ["orca-dispatch:d1", "orca-dispatch:d1"]):
            with self.subTest(refs=refs), self.assertRaises(ValueError):
                wait_spec({"prerequisites": refs})
        with self.assertRaisesRegex(ValueError, "encodings_mixed"):
            wait_spec(dict(prerequisites=["orca-dispatch:d1"], dependencies=dict(dispatches=["d1"], jobs=[])))
        legacy = dict(dispatches=["d1"], jobs=[])
        self.assertEqual(wait_spec(dict(dependencies=legacy)), legacy)
        with self.assertRaisesRegex(ValueError, "dependency_unknown"):
            dependencies({"checkpoint": {"next_action": {"prerequisites": ["orca-dispatch:future"]}}},
                         self.snapshot)

    def test_recycled_execution_evidence_stops_automatic_loop(self):
        self.tick()
        self.execute()
        self.new_turn(("met", "actionable"))
        self.tick()
        self.execute()
        state = read_json(self.f.state / "outbox.json")
        first, second = (state["actions"][k] for k in state["order"])
        result = parse(pinned(second["result"]))
        result["evidence"] = parse(pinned(first["result"]))["evidence"]
        second["result"] = self.f.t.ref("bootstrap/recycled-result.json", result)
        replace_json(self.f.state / "outbox.json", state)
        self.new_turn(("met", "met"))
        with self.assertRaisesRegex(ValueError, "no_novel_execution_evidence"):
            self.audit()
        with self.assertRaisesRegex(ValueError, "no_novel_execution_evidence"):
            self.tick()
        self.assertEqual(len(self.m.messages), 2)

    def test_wait_missing_dependency_stops_and_blocked_routes_to_review(self):
        self.new_turn(("waiting", "waiting"))
        with self.assertRaisesRegex(ValueError, "wait_dependencies_required"):
            self.tick()
        # A different real turn, not a rewrite of the old completed checkpoint.
        self.new_turn(("blocked", "blocked"))
        self.assertEqual(self.tick()["route"], "alternatives_review")
        self.assertEqual(self.m.messages, [])

    def test_scheduler_mode_disallows_self_enqueue_and_turn_end_only_audits(self):
        with patch.dict(os.environ, ORCA_TERMINAL_HANDLE="term_test"):
            with self.assertRaisesRegex(ValueError, "owned_by_scheduler"):
                self.f.step()
            def query(cli, runtime, args):
                if args[:2] == ["orchestration", "check"]:
                    return dict(runId="run_test", count=0, messages=[], hasOutstandingDelivery=False)
                return self.f.query(cli, runtime, args)
            self.assertEqual(turn_end(self.f.config_ref, call=query)["outcome"], "scheduler_will_check_real_turn_end")
        self.assertEqual(self.m.messages, [])


if __name__ == "__main__":
    unittest.main()

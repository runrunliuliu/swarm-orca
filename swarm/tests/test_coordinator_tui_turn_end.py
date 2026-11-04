"""Bounded-action and unfinished-turn regression checks, using native fixtures only."""

import copy
from datetime import timedelta
import unittest
from unittest.mock import patch

from coordinator_io import canonical, digest, now, read_json, replace_json, timestamp
from coordinator_tui_continue import action_window, apply_review_clear, check, freshness, step
from coordinator_tui_turn_end import turn_end
import test_coordinator_tui_continue as continuation
import test_coordinator_loop as loop


class TurnEndTests(unittest.TestCase):
    def setUp(self):
        self.f = continuation.ContinuationTests()
        self.f.setUp()
        self.addCleanup(self.f.doCleanups)
        self.mailbox = dict(runId="run_test", messages=[], count=0, hasOutstandingDelivery=False)

    def query(self, cli, runtime, args):
        if args[:2] == ["orchestration", "check"]:
            self.assertEqual(args, ["orchestration", "check", "--run", "run_test", "--peek"])
            return copy.deepcopy(self.mailbox)
        return self.f.query(cli, runtime, args)

    def end(self):
        return turn_end(self.f.config_ref, call=self.query)

    def enqueue(self):
        result = self.f.step()
        self.mailbox.update(count=1, messages=[dict(id=result["delivery"]["message_id"])])
        return result

    def scheduler(self):
        self.f.config.update(schema_version=2, scheduler=dict(
            terminal="term_sender", incarnation="inc_sender", workspace="ws_sender"))
        self.f.config_ref = self.f.t.ref("scheduler-config.json", self.f.config)

    def publish_current_checkpoint(self, observed_at):
        # New immutable source/receipt/projection; never just change a timestamp
        # on the already pinned checkpoint from an earlier real turn.
        self.f.bind_domain()
        domain = self.f.record["domain_check"]
        source = dict(read_json(domain["source"]["path"]), observed_at=observed_at)
        domain["source"] = self.f.t.ref(f"bootstrap/current-source-{self.f.domain_version}.json", source)
        receipt = read_json(domain["receipt"]["path"])
        receipt["authority_check"]["checkpoint_sha256"] = digest(canonical(source))
        domain["receipt"] = self.f.t.ref(f"bootstrap/current-receipt-{self.f.domain_version}.json", receipt)
        self.f.record_path = self.f.t.f.bootstrap / f"current-projection-{self.f.domain_version}.json"
        self.f.rewrite_record(rebind=False)

    def test_scheduler_duplicate_wakeup_requires_current_checkpoint_without_reinitializing(self):
        self.scheduler()
        self.publish_current_checkpoint(now())
        original_config = self.f.config_ref.copy()
        original_head = read_json(self.f.config["checkpoint_head"])
        # A duplicate initialization message starts another real model turn.
        self.f.observer_mock.return_value["observed_at"] = now()
        self.assertTrue(check(self.f.config_ref, call=self.query)["ok"])
        with self.assertRaisesRegex(ValueError, "tui_checkpoint_not_from_current_turn"):
            self.end()
        self.assertEqual(read_json(self.f.config["checkpoint_head"]), original_head)
        self.assertEqual(list(self.f.state.iterdir()), [])
        self.assertEqual(self.f.sends, [])
        self.publish_current_checkpoint(now())
        for _ in range(2):
            self.assertEqual(self.end()["outcome"], "scheduler_will_check_real_turn_end")
        self.assertEqual(self.f.config_ref, original_config)
        self.assertEqual(list(self.f.state.iterdir()), [])

    def test_scheduler_missing_checkpoint_timestamp_fails_read_only(self):
        self.scheduler()
        with self.assertRaisesRegex(ValueError, "tui_checkpoint_turn_timestamp_required"):
            self.end()
        self.assertEqual(list(self.f.state.iterdir()), [])
        self.assertEqual(self.f.sends, [])

    def test_scheduler_future_checkpoint_fails_read_only(self):
        self.scheduler()
        self.publish_current_checkpoint((timestamp(now()) + timedelta(minutes=1)).isoformat())
        with self.assertRaisesRegex(ValueError, "tui_checkpoint_not_from_current_turn"):
            self.end()
        self.assertEqual(list(self.f.state.iterdir()), [])

    def test_scheduler_checkpoint_predating_dispatch_gate_fails(self):
        self.scheduler()
        old = (timestamp(now()) - timedelta(seconds=2)).isoformat()
        self.f.observer_mock.return_value["observed_at"] = old
        self.publish_current_checkpoint(old)
        with self.assertRaisesRegex(ValueError, "tui_checkpoint_predates_dispatch_gate"):
            self.end()
        self.assertEqual(list(self.f.state.iterdir()), [])

    def test_scheduler_same_context_timestamp_boundary_is_valid(self):
        self.scheduler()
        current = now()
        self.f.observer_mock.return_value["observed_at"] = current
        self.publish_current_checkpoint(current)
        self.assertEqual(self.end()["outcome"], "scheduler_will_check_real_turn_end")

    def test_runtime_epoch_rebind_uses_verified_runtime_for_mailbox_peek(self):
        self.scheduler()
        current = now()
        self.f.observer_mock.return_value["observed_at"] = current
        self.publish_current_checkpoint(current)
        calls = []

        def query(cli, runtime, args):
            calls.append((runtime, tuple(args)))
            if runtime == "runtime_test" and args[:2] == ["orchestration", "strict-caller-check"]:
                raise ValueError("native query failed or runtime changed")
            if args[:2] == ["orchestration", "check"]:
                self.assertEqual(runtime, "runtime_restarted")
            return self.query(cli, runtime, args)

        with patch("coordinator_tui_continue.subprocess.run", return_value=self.f.runtime_status()):
            self.assertEqual(turn_end(self.f.config_ref, call=query)["outcome"],
                             "scheduler_will_check_real_turn_end")
        self.assertTrue(any(runtime == "runtime_restarted"
                            and args[:2] == ("orchestration", "check")
                            for runtime, args in calls))
        self.assertFalse(any(runtime == "runtime_test" and args[:2] == ("orchestration", "check")
                             for runtime, args in calls))

    def test_scheduler_context_change_during_final_fence_is_rejected(self):
        self.scheduler()
        self.publish_current_checkpoint(now())
        fresh = dict(self.f.observer_mock.return_value)
        self.f.observer_mock.side_effect = [fresh, dict(fresh, observed_at=now())]
        with self.assertRaisesRegex(ValueError, "tui_turn_end_context_changed"):
            self.end()
        self.assertEqual(list(self.f.state.iterdir()), [])
        self.assertEqual(self.f.sends, [])

    def test_scheduler_turn_end_ignores_historical_terminal_stop_for_new_head(self):
        self.scheduler()
        self.publish_current_checkpoint(now())
        old_stop = dict(state="review_required", route="alternatives_review",
                        checkpoint=read_json(self.f.config["checkpoint_head"]),
                        business_acceptance="not_evaluated")
        replace_json(self.f.state / "scheduler.json", dict(config=self.f.config_ref, stop=old_stop,
                                                            waits={}, turns={}))

        self.publish_current_checkpoint(now())
        result = self.end()
        self.assertEqual(result["outcome"], "scheduler_will_check_real_turn_end")
        self.assertTrue(result["scheduler_stop_persisted"] is False)
        self.assertEqual(read_json(self.f.state / "scheduler.json")["stop"], old_stop)

    def test_scheduler_turn_end_stale_clear_does_not_crash_historical_stop(self):
        self.scheduler()
        self.publish_current_checkpoint(now())
        no_acceptance_stop = dict(state="review_required", reason="tui_scheduler_no_acceptance_progress",
                                  checkpoint=read_json(self.f.config["checkpoint_head"]),
                                  progress=dict(consecutive_without_acceptance_advance=3, limit=3,
                                                scope="declared_acceptance_only_not_semantic_verification"),
                                  business_acceptance="not_evaluated")
        replace_json(self.f.state / "scheduler.json", dict(config=self.f.config_ref,
                                                            stop=no_acceptance_stop,
                                                            waits={}, turns={}))
        clear_ref, _ = self.f.scheduler_review_clear_ref(no_acceptance_stop)
        apply_review_clear(self.f.config_ref, clear_ref)

        journal = read_json(self.f.state / "scheduler.json")
        old_terminal_stop = dict(state="review_required", route="alternatives_review",
                                 checkpoint=read_json(self.f.config["checkpoint_head"]),
                                 business_acceptance="not_evaluated")
        journal["stop"] = old_terminal_stop
        journal["review_clear"] = clear_ref
        replace_json(self.f.state / "scheduler.json", journal)

        self.publish_current_checkpoint(now())
        result = self.end()
        self.assertEqual(result["outcome"], "scheduler_will_check_real_turn_end")
        self.assertTrue(result["scheduler_stop_persisted"] is False)
        self.assertEqual(read_json(self.f.state / "scheduler.json"), journal)

        with self.assertRaisesRegex(ValueError, "tui_scheduler_review_clear_unsupported_stop"):
            apply_review_clear(self.f.config_ref, clear_ref)

    def test_scheduler_wait_blocked_and_complete_also_require_current_checkpoint(self):
        self.scheduler()
        for status in ("waiting", "blocked", "met"):
            with self.subTest(status=status):
                _, self.f.record["checkpoint"] = loop.LoopTests().fixture(statuses=(status, status))
                if status == "waiting":
                    self.f.record["checkpoint"]["next_action"]["prerequisites"] = ["orca-dispatch:d1"]
                self.publish_current_checkpoint(now())
                self.f.observer_mock.return_value["observed_at"] = now()
                with self.assertRaisesRegex(ValueError, "tui_checkpoint_not_from_current_turn"):
                    self.end()
                self.publish_current_checkpoint(now())
                self.assertEqual(self.end()["outcome"], "scheduler_will_check_real_turn_end")
        self.assertEqual(list(self.f.state.iterdir()), [])
        self.assertEqual(self.f.sends, [])

    def test_action_window_rejects_due_equal_or_invalid_estimates(self):
        observed = timestamp(now())
        deadline = (observed + timedelta(hours=1)).isoformat()
        with patch("coordinator_tui_continue.now", return_value=observed.isoformat()):
            timing = freshness(self.f.c, {"observed_at": observed.isoformat()}, deadline)
            self.assertTrue(action_window(timing, 719)["action_allowed"])
            for seconds in (720, 721):
                self.assertFalse(action_window(timing, seconds)["action_allowed"])
            for seconds in (True, 0, -1, float("nan"), float("inf")):
                with self.subTest(seconds=seconds), self.assertRaisesRegex(ValueError, "action_seconds"):
                    action_window(timing, seconds)
            self.assertFalse(action_window(dict(timing, checkpoint_due=True), 1)["action_allowed"])

    def test_due_check_and_claim_refuse_but_leave_enqueue_possible(self):
        due = timestamp(now()) + timedelta(seconds=500)
        with patch("coordinator_tui_continue.now", return_value=due.isoformat()):
            result = check(self.f.config_ref, action_seconds=60, call=self.f.query)
            self.assertFalse(result["action_allowed"])
            self.assertEqual(list(self.f.state.iterdir()), [])
            self.enqueue()
        self.f.observer_mock.return_value["observed_at"] = (due + timedelta(seconds=1)).isoformat()
        with patch("coordinator_tui_continue.now", return_value=(due + timedelta(seconds=2)).isoformat()):
            with self.assertRaisesRegex(ValueError, "action_window_insufficient"):
                step(self.f.config_ref, self.f.record_ref, mode="claim", call=self.f.query)
        entry = next(iter(read_json(self.f.state / "outbox.json")["actions"].values()))
        self.assertIsNone(entry["claimed_at"])
        self.assertEqual(len(self.f.sends), 1)

    def test_same_turn_claim_refused_without_mutating_outbox(self):
        self.enqueue()
        before = (self.f.state / "outbox.json").read_bytes()
        with self.assertRaisesRegex(ValueError, "new_real_turn_required"):
            step(self.f.config_ref, self.f.record_ref, mode="claim", call=self.f.query)
        self.assertEqual((self.f.state / "outbox.json").read_bytes(), before)
        self.assertTrue(self.f.step("claim")["execute_action"])
        self.assertFalse(self.f.step("claim")["execute_action"])

    def test_missing_continuation_fails_without_writes_or_sends(self):
        with self.assertRaisesRegex(ValueError, "continuation_required"):
            self.end()
        self.assertEqual(list(self.f.state.iterdir()), [])
        self.assertEqual(self.f.sends, [])

    def test_just_enqueued_turn_can_end_without_consuming_or_reminding(self):
        self.enqueue()
        before = (self.f.state / "outbox.json").read_bytes()
        for _ in range(3):
            self.assertEqual(self.end()["outcome"], "continuation_enqueued")
        self.assertEqual((self.f.state / "outbox.json").read_bytes(), before)
        self.assertEqual(len(self.f.sends), 1)
        self.assertEqual(self.mailbox["count"], 1)

    def test_next_turn_cannot_leave_same_continuation_unprocessed(self):
        self.enqueue()
        self.f.observer_mock.return_value["observed_at"] = now()
        for _ in range(2):
            with self.assertRaisesRegex(ValueError, "continuation_not_processed"):
                self.end()
        self.assertEqual(len(self.f.sends), 1)

    def test_outstanding_delivery_is_not_acknowledged_or_requeued(self):
        self.enqueue()
        self.mailbox["hasOutstandingDelivery"] = True
        before = (self.f.state / "outbox.json").read_bytes()
        with self.assertRaisesRegex(ValueError, "unprocessed_delivery"):
            self.end()
        self.assertEqual((self.f.state / "outbox.json").read_bytes(), before)
        self.assertEqual(len(self.f.sends), 1)

    def test_claim_without_settle_is_unknown_not_complete(self):
        self.enqueue()
        self.f.step("claim")
        with self.assertRaisesRegex(ValueError, "unsettled_action"):
            self.end()

    def test_old_or_wrong_runtime_peek_cannot_certify_empty_mailbox(self):
        self.enqueue()
        for mailbox in ({"runId": "run_test", "messages": [], "count": 0},
                        dict(self.mailbox, runId="other"), dict(self.mailbox, count=True)):
            self.mailbox = mailbox
            with self.assertRaisesRegex(ValueError, "mailbox_state_unavailable"):
                self.end()

    def test_enqueued_receipt_without_pending_native_message_is_not_a_wakeup(self):
        self.enqueue()
        self.mailbox.update(count=0, messages=[])
        with self.assertRaisesRegex(ValueError, "wakeup_missing"):
            self.end()

    def test_complete_and_blocked_need_domain_review_and_no_pending_mail(self):
        for status in ("met", "blocked"):
            _, self.f.record["checkpoint"] = loop.LoopTests().fixture(statuses=(status, status))
            self.f.rewrite_record()
            result = self.end()
            self.assertEqual(result["outcome"], "domain_review_required")
            self.assertFalse(result["execute_action"])
            self.mailbox.update(count=1, messages=[dict(id="late")])
            with self.assertRaisesRegex(ValueError, "pending_mail"):
                self.end()
            self.mailbox.update(count=0, messages=[])

    def test_wait_is_not_certified_from_declared_barriers_alone(self):
        _, self.f.record["checkpoint"] = loop.LoopTests().fixture(statuses=("waiting", "waiting"))
        self.f.record["checkpoint"]["next_action"]["prerequisites"] = ["orca-dispatch:d1"]
        self.f.rewrite_record()
        with self.assertRaisesRegex(ValueError, "dependency_wakeup_requires_native_verification"):
            self.end()

    def test_head_change_during_final_fence_stops(self):
        self.enqueue()
        fresh = copy.deepcopy(self.f.observer_mock.return_value)
        count = 0
        def observe(**kwargs):
            nonlocal count
            count += 1
            if count == 2:
                from coordinator_io import replace_json
                replace_json(self.f.t.f.bootstrap / "head.json", {})
            return fresh
        self.f.observer_mock.side_effect = observe
        with self.assertRaisesRegex(ValueError, "state_changed"):
            self.end()

    def test_cli_check_window_failure_is_nonzero_and_read_only(self):
        with patch("coordinator_tui_continue.check", return_value={"ok": True, "action_allowed": False}):
            status, result = self.f.cli("check", "--action-seconds", "60")
        self.assertEqual(status, 2)
        self.assertFalse(result["action_allowed"])
        self.assertEqual(list(self.f.state.iterdir()), [])

    def test_cli_turn_end_refusal_is_redacted_and_nonzero(self):
        with patch("coordinator_tui_turn_end.turn_end", side_effect=ValueError("secret")):
            status, result = self.f.cli("turn-end")
        self.assertEqual(status, 2)
        self.assertEqual(result["error"], "tui_continuation_stopped_preserve_receipts")

    def test_cli_structured_progress_refusal_is_nonzero(self):
        refusal = dict(ok=False, state="review_required", error="tui_scheduler_no_acceptance_progress",
                       progress=dict(consecutive_without_acceptance_advance=3, limit=3))
        with patch("coordinator_tui_turn_end.turn_end", return_value=refusal):
            status, result = self.f.cli("turn-end")
        self.assertEqual(status, 2)
        self.assertEqual(result, refusal)
        self.assertEqual(list(self.f.state.iterdir()), [])

    def test_scheduler_config_mismatch_and_malformed_stop_fail_read_only(self):
        self.scheduler()
        self.publish_current_checkpoint(now())
        for change, error in ((dict(config={}), "tui_scheduler_config_changed"),
                              (dict(stop={"reason": "secret"}), "tui_scheduler_journal_invalid")):
            journal = dict(config=self.f.config_ref, stop=None, waits={}, turns={})
            journal.update(change)
            replace_json(self.f.state / "scheduler.json", journal)
            before = {p.name: p.read_bytes() for p in self.f.state.iterdir()}
            with self.assertRaisesRegex(ValueError, error):
                self.end()
            self.assertEqual({p.name: p.read_bytes() for p in self.f.state.iterdir()}, before)
        self.assertEqual(self.f.sends, [])

    def test_scheduler_final_fence_rejects_journal_creation_update_or_removal(self):
        self.scheduler()
        self.publish_current_checkpoint(now())
        for mutation in ("create", "update", "remove"):
            with self.subTest(mutation=mutation):
                journal = dict(config=self.f.config_ref, stop=None, waits={}, turns={})
                target = self.f.state / "scheduler.json"
                if mutation != "create":
                    replace_json(target, journal)
                fresh = dict(self.f.observer_mock.return_value)
                calls = 0

                def observe(**kwargs):
                    nonlocal calls
                    calls += 1
                    if calls == 2:
                        if mutation == "remove":
                            target.unlink()
                        else:
                            journal["turns"] = {"new-turn": {}}
                            replace_json(target, journal)
                    return fresh

                self.f.observer_mock.side_effect = observe
                with self.assertRaisesRegex(ValueError, "tui_turn_end_state_changed"):
                    self.end()
        self.assertEqual(self.f.sends, [])

    def test_scheduler_final_fence_rejects_outbox_change(self):
        self.scheduler()
        self.publish_current_checkpoint(now())
        fresh = dict(self.f.observer_mock.return_value)
        calls = 0

        def observe(**kwargs):
            nonlocal calls
            calls += 1
            if calls == 2:
                replace_json(self.f.state / "outbox.json", dict(actions={"new": dict(
                    checkpoint=self.f.record_ref, request_id="new", attempted=False,
                    delivery=None, claimed_at=None, result=None)}, order=["new"]))
            return fresh

        self.f.observer_mock.side_effect = observe
        with self.assertRaisesRegex(ValueError, "tui_turn_end_state_changed"):
            self.end()
        self.assertEqual(self.f.sends, [])

    def test_two_complete_continuations_then_complete_turn_end(self):
        for i, statuses in enumerate((("met", "actionable"), ("met", "met"))):
            self.enqueue()
            self.assertEqual(self.end()["outcome"], "continuation_enqueued")
            claimed = self.f.step("claim")
            self.assertTrue(claimed["execute_action"])
            result = self.f.t.ref(f"bootstrap/result-{i}.json", dict(
                action_id=claimed["action"]["id"], checkpoint=self.f.record_ref, status="executed",
                evidence=[self.f.t.ref(f"bootstrap/proof-{i}.json", {"changed": i})]))
            self.assertEqual(self.f.step("settle", result_ref=result)["state"], "settled")
            self.assertFalse(self.f.step("claim")["execute_action"])
            # Model the native ack after successful evidence settlement, before the next enqueue.
            self.mailbox.update(count=0, messages=[], hasOutstandingDelivery=False)
            _, self.f.record["checkpoint"] = loop.LoopTests().fixture(statuses=statuses)
            self.f.bind_domain()
            from coordinator_io import replace_json
            self.f.record_ref = self.f.t.ref(f"bootstrap/next-{i}.json", self.f.record)
            replace_json(self.f.t.f.bootstrap / "head.json", self.f.record_ref)
        self.assertEqual(self.end()["decision"], "complete")
        self.assertEqual(len(self.f.sends), 2)

    def test_new_local_errors_include_safe_recovery(self):
        from coordinator_tui_errors import failure, TuiError
        for code in ("tui_action_window_insufficient", "tui_continuation_new_real_turn_required",
                     "tui_turn_end_unprocessed_delivery", "tui_turn_end_unsettled_action",
                     "tui_turn_end_mailbox_state_unavailable", "tui_hook_stale_or_future",
                     "tui_checkpoint_not_from_current_turn", "tui_checkpoint_turn_timestamp_required",
                     "tui_checkpoint_predates_dispatch_gate", "tui_scheduler_checkpoint_not_advanced"):
            result = failure(TuiError(code), "fallback")
            self.assertEqual(result["error"], code)
            self.assertIn("recovery", result)


if __name__ == "__main__":
    unittest.main()

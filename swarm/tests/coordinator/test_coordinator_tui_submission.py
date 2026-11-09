"""Versioned submission/recovery fixtures. No live sessions or native mutations."""

import copy
import contextlib
import io
import os
from pathlib import Path
import unittest
from unittest.mock import patch

from coordinator_io import file_ref, now, read_json, replace_json
from coordinator_tui_scheduler import WaitNotReady
from terminal_idle_wait import IdleWaitResult
import coordinator_tui_workflow as workflow
import operator_monitor_recovery as recovery
import coordinator.test_coordinator_tui_scheduler as scheduler
import coordinator.test_coordinator_tui_workflow as legacy


class SubmissionTests(unittest.TestCase):
    def setUp(self):
        self.s = scheduler.SchedulerTests()
        self.s.turn_protocol = "workflow-v2"
        self.s.setUp()
        self.addCleanup(self.s.doCleanups)
        self.s.tick()
        self.w = legacy.WorkflowTests()
        self.w.init_workflow(self.s)
        self.addCleanup(self.w.doCleanups)
        self.f = self.w.f

    def submit(self):
        w = self.w
        return workflow.submit(self.f.config_ref, w.result, w.next_ref, w.processed,
                               str(w.receipt_path), call=w.query)

    def tick(self, **kwargs):
        with patch.dict(os.environ, self.s.m.environment, clear=True):
            return self.s.tick(**kwargs)

    def ended_after_delivery(self):
        ended = copy.deepcopy(self.s.ended)
        ended["completed_turn"].update(turn_id="post-delivery", context_at=now(), completed_at=now())
        self.s.ended = ended

    def test_prompt_and_complete_submission(self):
        self.assertIn("coordinator_tui_workflow.py submit", str(self.s.m.calls))
        self.assertTrue(self.w.begin()["execute_action"])
        self.assertFalse(self.w.begin()["execute_action"])
        self.w.evidence()
        result = self.submit()
        self.assertTrue(result["submission_accepted"])
        self.assertTrue(result["turn_end"]["ok"])
        self.assertEqual(read_json(self.w.receipt_path)["kind"], "coordinator-delivery-submission")
        pin = file_ref(self.w.receipt_path)
        self.assertTrue(self.submit()["submission_accepted"])
        self.assertEqual(file_ref(self.w.receipt_path), pin)
        self.assertEqual(len(self.w.mutations), 2)

    def test_post_ack_audit_timeout_preserves_acceptance_without_replay(self):
        import observation_budget as budget
        import subprocess
        self.w.begin()
        self.w.evidence()
        original = self.w.query
        def slow_audit(cli, runtime, args):
            if budget.active():
                raise subprocess.TimeoutExpired(["fixture"], 15)
            return original(cli, runtime, args)
        with patch.object(self.w, "query", side_effect=slow_audit):
            result = self.submit()
        self.assertTrue(result["submission_accepted"])
        self.assertFalse(result["ok"])
        self.assertEqual(result["turn_end"]["error"], "tui_turn_end_observation_timeout")
        self.assertTrue(self.w.acked)
        pin = file_ref(self.w.receipt_path)
        self.assertTrue(self.submit()["submission_accepted"])
        self.assertEqual(file_ref(self.w.receipt_path), pin)
        self.assertEqual(len(self.w.mutations), 2)

    def test_progress_review_does_not_prevent_valid_settlement_and_ack(self):
        self.w.begin()
        self.w.evidence()
        progress = dict(consecutive_without_acceptance_advance=3, limit=3,
                        scope="declared_acceptance_only_not_semantic_verification")
        with patch.object(workflow, "validate_scheduler_progress", return_value=progress):
            result = self.submit()
        self.assertTrue(result["submission_accepted"])
        self.assertFalse(result["ok"])
        self.assertEqual(result["turn_end"]["state"], "review_required")
        self.assertTrue(self.w.acked)
        self.assertEqual(read_json(self.f.config["checkpoint_head"]), self.w.next_ref)
        pin = file_ref(self.w.receipt_path)
        self.assertTrue(self.submit()["submission_accepted"])
        self.assertEqual(file_ref(self.w.receipt_path), pin)
        self.assertEqual(self.tick()["state"], "review_required")
        with self.assertRaisesRegex(ValueError, "tui_scheduler_stopped"):
            self.w.begin()
        self.assertEqual(len(self.s.m.messages), 1)

    def test_ack_response_loss_after_context_advance_only_reconciles(self):
        self.w.begin()
        self.w.evidence()
        self.w.fail_after = "ack"
        with self.assertRaises(TimeoutError):
            self.submit()
        self.f.observer_mock.return_value["observed_at"] = now()
        self.assertTrue(self.submit()["submission_accepted"])
        self.assertEqual(len(self.w.mutations), 2)

    def test_unknown_ack_never_replays(self):
        self.w.begin()
        self.w.evidence()
        self.w.fail_after = "ack"
        with self.assertRaises(TimeoutError):
            self.submit()
        self.w.receipts.clear()
        with self.assertRaisesRegex(ValueError, "native_outcome_unknown"):
            self.submit()
        self.assertFalse(self.w.receipt_path.exists())
        self.assertEqual(len(self.w.mutations), 2)

    def test_interrupted_ack_does_not_publish_head_or_allow_reexecution(self):
        self.w.begin()
        self.w.evidence()
        original = self.w.query

        def interrupted(cli, runtime, args):
            reply = original(cli, runtime, args)
            if "--ack" in args:
                reply["waitInterrupted"] = True
            return reply

        with patch.object(self.w, "query", side_effect=interrupted):
            for _ in range(2):
                with self.assertRaisesRegex(ValueError, "ack_unconfirmed"):
                    self.submit()
        self.assertEqual(len(self.w.mutations), 2)
        self.assertEqual(read_json(self.f.config["checkpoint_head"]), self.w.old)
        self.assertFalse(self.w.receipt_path.exists())

    def test_partial_batch_never_settles_or_acks(self):
        self.w.begin()
        self.w.evidence()
        processed = read_json(self.w.processed["path"])
        processed["messages"].pop()
        self.w.processed = self.f.t.ref("bootstrap/partial-batch.json", processed)
        with self.assertRaisesRegex(ValueError, "whole_delivery"):
            self.submit()
        self.assertFalse(self.w.acked)
        self.assertIsNone(next(iter(read_json(self.f.state / "outbox.json")["actions"].values()))["result"])

    def test_changed_submit_scope_is_rejected_after_acceptance(self):
        self.w.begin()
        self.w.evidence()
        self.submit()
        self.w.receipt_path = self.w.receipt_path.with_name("different-receipt.json")
        with self.assertRaisesRegex(ValueError, "finish_changed"):
            self.submit()
        self.assertFalse(self.w.receipt_path.exists())
        self.assertEqual(len(self.w.mutations), 2)

    def test_old_submit_retry_never_regresses_newer_head(self):
        self.w.begin()
        self.w.evidence()
        result = self.submit()
        self.s.new_turn(("met", "met"))
        newer = read_json(self.f.config["checkpoint_head"])
        again = self.submit()
        self.assertEqual(again["state"], "submission_already_accepted")
        self.assertEqual(again["receipt"], result["receipt"])
        self.assertEqual(read_json(self.f.config["checkpoint_head"]), newer)
        self.assertEqual(len(self.w.mutations), 2)

    def test_audit_failure_preserves_submission_and_does_not_consume_new_mail(self):
        self.w.begin()
        self.w.evidence()
        original = self.w.query

        def new_mail(cli, runtime, args):
            reply = original(cli, runtime, args)
            if args[:2] == ["orchestration", "check"] and "--retry-request" not in args and self.w.acked:
                reply.update(count=1, messages=[{"id": "new-pending-mail"}])
            return reply

        with patch.object(self.w, "query", side_effect=new_mail):
            result = self.submit()
        self.assertTrue(result["submission_accepted"])
        self.assertFalse(result["ok"])
        self.assertEqual(result["turn_end"]["error"], "tui_turn_end_pending_mail")
        self.assertTrue(self.w.receipt_path.exists())
        self.assertEqual(len(self.w.mutations), 2)

    def test_crash_after_head_can_complete_submission(self):
        self.w.begin()
        self.w.evidence()
        write = workflow.replace_json

        def crash(target, data):
            write(target, data)
            if str(target) == self.f.config["checkpoint_head"]:
                raise RuntimeError("after head")

        with patch.object(workflow, "replace_json", side_effect=crash):
            with self.assertRaisesRegex(RuntimeError, "after head"):
                self.submit()
        self.ended_after_delivery()
        self.assertEqual(self.tick()["execution_status"], "settled_submission_missing")
        self.assertEqual(len(self.s.m.messages), 1)
        self.assertTrue(self.submit()["submission_accepted"])
        self.assertEqual(len(self.w.mutations), 2)

    def test_crash_after_receipt_can_recover_without_overwrite(self):
        self.w.begin()
        self.w.evidence()
        publish = workflow.publish_new

        def crash(target, data):
            publish(target, data)
            if target == self.w.receipt_path:
                raise RuntimeError("after receipt")

        with patch.object(workflow, "publish_new", side_effect=crash):
            with self.assertRaisesRegex(RuntimeError, "after receipt"):
                self.submit()
        pin = file_ref(self.w.receipt_path)
        self.ended_after_delivery()
        self.assertEqual(self.tick()["state"], "continuation_incomplete")
        self.assertTrue(self.submit()["submission_accepted"])
        self.assertEqual(file_ref(self.w.receipt_path), pin)
        self.assertEqual(len(self.w.mutations), 2)

    def test_completed_workflow_provenance_allows_later_observed_turn(self):
        self.w.begin()
        self.w.evidence()
        self.submit()
        self.ended_after_delivery()
        self.assertEqual(self.tick()["state"], "continuation_enqueued")
        self.assertEqual(len(self.s.m.messages), 2)

    def test_failed_audit_cannot_supply_historical_head_provenance(self):
        self.w.begin()
        self.w.evidence()
        with patch.object(workflow, "turn_end", return_value={"ok": False, "state": "autonomy_not_ready"}):
            self.assertTrue(self.submit()["submission_accepted"])
        self.ended_after_delivery()
        with self.assertRaisesRegex(ValueError, "tui_checkpoint_not_from_completed_turn"):
            self.tick()
        self.assertEqual(len(self.s.m.messages), 1)

    def test_ended_without_begin_is_recorded_not_replayed(self):
        self.ended_after_delivery()
        state = read_json(self.f.state / "outbox.json")
        result = self.tick()
        self.assertEqual(result["state"], "continuation_incomplete")
        self.assertEqual(result["execution_status"], "not_claimed")
        self.assertEqual(self.tick(), result)
        self.assertEqual(read_json(self.f.state / "outbox.json"), state)
        self.assertEqual(len(self.s.m.messages), 1)
        self.assertEqual(self.w.mutations, [])

    def test_same_ended_turn_with_new_hook_keeps_original_diagnostic(self):
        self.ended_after_delivery()
        self.s.ended["hook"] = {"counter": 1}
        result = self.tick()
        self.s.ended["hook"]["counter"] = 2
        self.assertEqual(self.tick(), result)
        self.assertEqual(read_json(result["receipt"]["path"])["observation"]["hook"], {"counter": 1})

    def test_manual_settlement_and_fresh_head_cannot_replace_submission(self):
        self.w.begin()
        self.w.evidence()
        self.f.step("settle", ref=self.w.old, result_ref=self.w.result)
        replace_json(Path(self.f.config["checkpoint_head"]), self.w.next_ref)
        self.ended_after_delivery()
        result = self.tick()
        self.assertEqual(result["state"], "continuation_incomplete")
        self.assertEqual(result["execution_status"], "settled_submission_missing")
        self.assertEqual(len(self.s.m.messages), 1)
        self.assertFalse(self.w.acked)

    def test_crash_before_ack_is_incomplete_and_same_turn_can_recover(self):
        self.w.begin()
        self.w.evidence()
        mutation = workflow.mutation

        def crash(journal, target, name, *args):
            if name == "ack":
                raise RuntimeError("before ack")
            return mutation(journal, target, name, *args)

        with patch.object(workflow, "mutation", side_effect=crash):
            with self.assertRaisesRegex(RuntimeError, "before ack"):
                self.submit()
        self.ended_after_delivery()
        self.assertEqual(self.tick()["execution_status"], "settled_submission_missing")
        self.assertFalse(self.w.acked)
        self.assertTrue(self.submit()["submission_accepted"])
        self.assertEqual(len(self.w.mutations), 2)

    def test_identity_change_rejected_before_settlement_or_ack(self):
        self.w.begin()
        self.w.evidence()
        for field, value in (("owner", "other"), ("generation", 2),
                             ("caller", {**self.f.caller, "caller": {
                                 **self.f.caller["caller"], "processIncarnation": "other"}})):
            original = getattr(self.f, field)
            with self.subTest(field=field):
                setattr(self.f, field, value)
                try:
                    with self.assertRaises(ValueError):
                        self.submit()
                finally:
                    setattr(self.f, field, original)
        with patch.dict(os.environ, ORCA_TERMINAL_HANDLE="other"):
            with self.assertRaises(ValueError):
                self.submit()
        self.f.observer_mock.return_value["thread_id"] = "other-session"
        with self.assertRaisesRegex(ValueError, "provider_session"):
            self.submit()
        self.assertFalse(self.w.acked)
        self.assertEqual(len(self.w.mutations), 1)
        self.assertIsNone(next(iter(read_json(self.f.state / "outbox.json")["actions"].values()))["result"])

    def test_stop_during_ack_blocks_head_publication_without_losing_settlement(self):
        self.w.begin()
        self.w.evidence()
        original = self.w.query
        stop = dict(state="review_required", route="alternatives_review",
                    checkpoint=self.w.old, business_acceptance="not_evaluated")

        def query(cli, runtime, args):
            reply = original(cli, runtime, args)
            if "--ack" in args:
                journal = read_json(self.f.state / "scheduler.json")
                journal["stop"] = stop
                replace_json(self.f.state / "scheduler.json", journal)
            return reply

        with patch.object(self.w, "query", side_effect=query):
            with self.assertRaisesRegex(ValueError, "tui_scheduler_stopped"):
                self.submit()
        self.assertTrue(self.w.acked)
        self.assertEqual(read_json(self.f.config["checkpoint_head"]), self.w.old)
        self.assertEqual(read_json(self.f.state / "scheduler.json")["stop"], stop)
        self.assertFalse(self.w.receipt_path.exists())

    def test_accepted_receipt_cannot_be_silently_repinned(self):
        self.w.begin()
        self.w.evidence()
        self.submit()
        receipt = read_json(self.w.receipt_path)
        receipt["submitted_at"] = now()
        replace_json(self.w.receipt_path, receipt)
        with self.assertRaisesRegex(ValueError, "receipt_changed"):
            self.submit()
        with self.assertRaisesRegex(ValueError, "file_pin_changed"):
            self.tick()
        self.assertEqual(len(self.w.mutations), 2)

    def test_unknown_protocol_and_legacy_submit_are_not_implicitly_enabled(self):
        legacy_config = {k: v for k, v in self.f.config.items() if k != "turn_protocol"}
        ref = self.f.t.ref("legacy-submit-config.json", legacy_config)
        with self.assertRaisesRegex(ValueError, "requires_workflow_v2"):
            workflow.submit(ref, {}, {}, {}, "/not-used")
        self.assertEqual(self.w.mutations, [])

    def test_legacy_recovery_rejects_v2_before_preparation_or_consumption(self):
        parts = ({}, None, self.f.config_ref, self.f.config, self.f.c, [self.f.state])
        with patch.object(recovery, "original", return_value=parts), patch.object(recovery.deploy, "private_directory") as output:
            with self.assertRaisesRegex(ValueError, "recovery_workflow_v2_not_supported"):
                recovery.prepare({}, "/not-used")
            output.assert_not_called()
        permit = self.f.t.ref("unsupported-recovery.json", {"kind": recovery.KIND})
        with self.assertRaisesRegex(ValueError, "recovery_workflow_v2_not_supported"):
            workflow.begin(self.f.config_ref, recovery_ref=permit, call=self.w.query)
        self.assertEqual(self.w.mutations, [])

    def test_submit_cli_requires_explicit_execute_and_complete_pins(self):
        args = ["submit", "--config", self.f.config_ref["path"],
                "--config-sha256", self.f.config_ref["sha256"]]
        for extra, error in (([], "tui_explicit_execute_required"),
                             (["--execute"], "tui_workflow_finish_arguments")):
            output = io.StringIO()
            with self.subTest(extra=extra), contextlib.redirect_stdout(output), patch.object(workflow, "submit") as call:
                self.assertEqual(workflow.main(args + extra), 2)
                self.assertIn(error, output.getvalue())
                call.assert_not_called()

    def test_ended_after_claim_is_unknown_but_original_submit_can_recover(self):
        self.w.begin()
        self.ended_after_delivery()
        result = self.tick()
        self.assertEqual(result["state"], "continuation_incomplete")
        self.assertEqual(result["execution_status"], "unknown")
        self.assertFalse(result["automatic_replay"])
        self.assertFalse(self.w.begin()["execute_action"])
        self.w.evidence()
        self.assertTrue(self.submit()["submission_accepted"])
        self.assertTrue(Path(result["receipt"]["path"]).exists())

    def test_predelivery_turn_is_not_incomplete(self):
        self.assertEqual(self.tick()["state"], "awaiting_continuation")
        self.assertFalse(list(self.f.state.glob("incomplete-turn-*.json")))

    def test_busy_turn_is_not_incomplete(self):
        self.ended_after_delivery()

        def busy(*_):
            raise WaitNotReady(IdleWaitResult("pending", "tui_idle_timeout"))

        self.assertEqual(self.tick(observe_turn=busy)["state"], "awaiting_real_turn_end")
        self.assertFalse(list(self.f.state.glob("incomplete-turn-*.json")))
        self.assertEqual(len(self.s.m.messages), 1)

    def test_interaction_or_changed_turn_is_not_incomplete(self):
        self.ended_after_delivery()

        def interaction(*_):
            raise WaitNotReady(IdleWaitResult("interaction_required", "tui_idle_interaction_required"))

        self.assertEqual(self.tick(observe_turn=interaction)["state"], "interaction_required")
        observations = iter((self.s.ended, None))
        self.assertEqual(self.tick(observe_turn=lambda *_: next(observations))["state"], "reobserving")
        self.assertFalse(list(self.f.state.glob("incomplete-turn-*.json")))


if __name__ == "__main__":
    unittest.main()

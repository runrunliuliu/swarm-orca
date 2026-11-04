"""Offline native receipt fixtures, not live acceptance or business proof."""
import copy
from datetime import timedelta
import os
from pathlib import Path
import unittest
from unittest.mock import patch

from coordinator_io import file_ref, now, read_json, replace_json, timestamp
from coordinator_tui_continue import apply_review_clear
import coordinator_tui_workflow as workflow
import test_coordinator_tui_scheduler as scheduler


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.s = scheduler.SchedulerTests()
        self.s.setUp()
        self.addCleanup(self.s.doCleanups)
        self.s.tick()
        self.init_workflow(self.s)

    def init_workflow(self, s):
        self.s, self.f, self.m = s, s.f, s.m
        self.old = self.f.record_ref
        self.action_id = self.f.record["checkpoint"]["next_action"]["id"]
        self.delivery = dict(runId="run_test", deliveryId="delivery-test", count=2,
                             messages=[copy.deepcopy(self.m.messages[-1]), {"id": "fact-extra"}])
        self.receipts, self.mutations = {}, []
        self.acked = False
        self.fail_after = None
        self.recovery_ref = None
        self.f.observer_mock.return_value["observed_at"] = now()
        env = patch.dict(os.environ, ORCA_TERMINAL_HANDLE="term_test")
        env.start()
        self.addCleanup(env.stop)

    def query(self, cli, runtime, args):
        if args[:2] == ["orchestration", "request-show"] and args[-1] in self.receipts:
            return dict(requestId=args[-1], state="completed", method="orchestration.check",
                        receipt=copy.deepcopy(self.receipts[args[-1]]))
        if args[:2] != ["orchestration", "check"]:
            return self.f.query(cli, runtime, args)
        if "--retry-request" not in args:
            self.assertIn("--peek", args)
            return dict(runId="run_test", messages=[], count=0, hasOutstandingDelivery=not self.acked)
        key = args[args.index("--retry-request") + 1]
        self.assertNotIn(key, self.receipts, "uncertain native mutations must not be replayed")
        self.mutations.append(args)
        if "--ack" in args:
            entry = next(iter(read_json(self.f.state / "outbox.json")["actions"].values()))
            self.assertIsNotNone(entry["result"], "ACK before durable settlement")
            self.assertIn("--peek", args, "ACK must not consume next batch")
            self.acked = True
            for message in self.m.messages:
                message["read"] = 1
            reply = dict(runId="run_test", acknowledged=self.delivery["deliveryId"], messages=[],
                         count=0, hasOutstandingDelivery=False)
            operation = "ack"
        else:
            reply, operation = self.delivery, "consume"
        self.receipts[key] = copy.deepcopy(reply)
        if self.fail_after == operation:
            self.fail_after = None
            raise TimeoutError("simulated native reply loss")
        return copy.deepcopy(reply)

    def begin(self):
        return workflow.begin(self.f.config_ref, recovery_ref=self.recovery_ref, call=self.query)

    def evidence(self):
        proof = self.f.t.ref("bootstrap/workflow-proof.json", {"actual": "fixture execution"})
        self.result = self.f.t.ref("bootstrap/workflow-result.json", dict(action_id=self.action_id,
            checkpoint=self.old, status="executed", evidence=[proof]))
        self.processed = self.f.t.ref("bootstrap/workflow-processed.json", dict(
            delivery_id=self.delivery["deliveryId"], messages=[
                {"id": self.delivery["messages"][0]["id"], "evidence": [self.result]},
                {"id": "fact-extra", "evidence": [proof]}]))
        self.s.new_turn(("met", "actionable"))
        self.next_ref = self.f.record_ref
        replace_json(Path(self.f.config["checkpoint_head"]), self.old)
        self.receipt_path = self.f.t.f.bootstrap / "workflow-completed.json"

    def finish(self):
        return workflow.finish(self.f.config_ref, self.result, self.next_ref, self.processed,
                               str(self.receipt_path), recovery_ref=self.recovery_ref, call=self.query)

    def operator_review_case(self):
        self.s.execute()
        self.f.record["checkpoint"]["next_action"].update(
            id="operator-handoff", owner="outer-operator")
        self.s.new_turn()
        self.old = self.f.record_ref
        self.action_id = "operator-handoff"
        proof = self.f.t.ref("bootstrap/operator-proof-workflow.json", {"operator": "done"})
        self.result = self.f.t.ref("bootstrap/operator-result-workflow.json", dict(
            action_id=self.action_id, checkpoint=self.old, status="executed", evidence=[proof]))
        with patch.dict(os.environ, {"ORCA_TERMINAL_HANDLE": "term-operator",
                                     "ORCA_PANE_KEY": "sender-tab:sender-leaf"}, clear=True):
            settled = self.f.step("operator-settle", result_ref=self.result, call=self.f.query)
        self.assertEqual(settled["state"], "operator_settled")
        stop = {"state": "review_required", "route": "operator_handoff",
                "checkpoint": self.old, "business_acceptance": "not_evaluated"}
        replace_json(self.f.state / "scheduler.json", dict(config=self.f.config_ref,
                                                            stop=stop, waits={}, turns={}))
        with patch.dict(os.environ, self.m.environment, clear=True):
            first = self.s.tick(observe_turn=lambda *_: None)
        self.assertEqual(first["state"], "operator_result_review_enqueued")
        self.delivery = dict(runId="run_test", deliveryId="operator-review-delivery", count=1,
                             messages=[copy.deepcopy(self.m.messages[-1])])

    def operator_review_evidence(self):
        self.f.observer_mock.return_value["observed_at"] = now()
        self.s.new_turn(("met", "actionable"))
        self.next_ref = self.f.record_ref
        replace_json(Path(self.f.config["checkpoint_head"]), self.old)
        self.processed = self.f.t.ref("bootstrap/operator-review-processed.json", dict(
            delivery_id=self.delivery["deliveryId"], messages=[{
                "id": self.delivery["messages"][0]["id"], "evidence": [self.result]}]))
        self.receipt_path = self.f.t.f.bootstrap / "operator-review-completed.json"

    def operator_review_begin(self):
        return workflow.operator_review_begin(self.f.config_ref, call=self.query)

    def operator_review_finish(self):
        return workflow.operator_review_finish(self.f.config_ref, self.result, self.next_ref,
                                               self.processed, str(self.receipt_path), call=self.query)

    def test_full_batch_finish_and_retry_do_not_reexecute_or_reconsume(self):
        self.assertTrue(self.begin()["execute_action"])
        self.assertFalse(self.begin()["execute_action"])
        self.evidence()
        result = self.finish()
        self.assertTrue(result["ok"])
        self.assertFalse(result["runtime_end_hook"])
        self.assertEqual(self.finish(), result)
        self.assertEqual(len(self.mutations), 2)
        self.assertEqual(read_json(self.f.config["checkpoint_head"]), self.next_ref)
        self.assertEqual(len(self.m.messages), 1)

    def test_operator_handoff_result_review_publishes_next_checkpoint_without_replay(self):
        self.operator_review_case()
        begin = self.operator_review_begin()
        self.assertFalse(begin["execute_action"])
        self.assertEqual(begin["state"], "operator_result_review_ready")
        self.assertEqual(begin["result"], self.result)
        self.operator_review_evidence()
        result = self.operator_review_finish()
        self.assertTrue(result["ok"])
        self.assertFalse(result["runtime_end_hook"])
        self.assertEqual(read_json(self.f.config["checkpoint_head"]), self.next_ref)
        self.assertEqual(self.operator_review_finish(), result)
        self.assertTrue(self.acked)
        self.assertEqual(len(self.mutations), 2)
        self.assertEqual(len(self.m.messages), 2)
        outbox = read_json(self.f.state / "outbox.json")
        operator_entry = next(entry for entry in outbox["actions"].values()
                              if entry["checkpoint"] == self.old)
        self.assertEqual(operator_entry["result"], self.result)
        receipt = read_json(self.receipt_path)
        self.assertEqual(receipt["kind"], "coordinator-operator-result-review-workflow")
        self.assertEqual(receipt["next_checkpoint"], self.next_ref)

        self.s.ended["completed_turn"] = dict(turn_id="after-operator-review-finish",
            context_at=(timestamp(now()) + timedelta(seconds=1)).isoformat(),
            completed_at=(timestamp(now()) + timedelta(seconds=2)).isoformat(),
            prefix_bytes=999, prefix_sha256="d" * 64)
        with patch.dict(os.environ, self.m.environment, clear=True):
            self.assertEqual(self.s.tick()["state"], "continuation_enqueued")
        self.assertEqual(len(self.m.messages), 3)

    def test_partial_duplicate_or_unpinned_batch_refused_before_ack(self):
        self.begin()
        self.evidence()
        saved = read_json(self.processed["path"])
        for rows in (saved["messages"][:1], [saved["messages"][0]] * 2,
                     [{**saved["messages"][0], "evidence": []}, saved["messages"][1]]):
            replace_json(Path(self.processed["path"]), {**saved, "messages": rows})
            self.processed = file_ref(self.processed["path"])
            with self.assertRaisesRegex(ValueError, "whole_delivery"):
                self.finish()
        self.assertFalse(self.acked)
        self.assertFalse(self.receipt_path.exists())

    def test_consume_reply_loss_uses_request_lookup_not_new_check(self):
        self.fail_after = "consume"
        with self.assertRaises(TimeoutError):
            self.begin()
        self.assertTrue(self.begin()["execute_action"])
        self.assertEqual(len(self.mutations), 1)

    def test_ack_reply_loss_uses_receipt_and_never_reexecutes(self):
        self.begin()
        self.evidence()
        self.fail_after = "ack"
        with self.assertRaises(TimeoutError):
            self.finish()
        self.assertTrue(self.finish()["ok"])
        self.assertEqual(len(self.mutations), 2)

    def test_unknown_outcome_requires_reconciliation(self):
        self.fail_after = "consume"
        with self.assertRaises(TimeoutError):
            self.begin()
        self.receipts.clear()
        with self.assertRaisesRegex(ValueError, "native_outcome_unknown"):
            self.begin()
        self.assertEqual(len(self.mutations), 1)

    def test_foreign_delivery_is_not_claimed_or_acked(self):
        self.delivery["messages"][0]["id"] = "earlier-independent-batch"
        with self.assertRaisesRegex(ValueError, "other_delivery_first"):
            self.begin()
        self.assertIsNone(next(iter(read_json(self.f.state / "outbox.json")["actions"].values()))["claimed_at"])
        self.assertFalse(self.acked)

    def test_wrong_caller_before_native_consumption(self):
        with patch.dict(os.environ, ORCA_TERMINAL_HANDLE="not-original-coordinator"):
            with self.assertRaises(ValueError):
                self.begin()
        self.assertEqual(self.mutations, [])

    def test_stale_checkpoint_refused_before_ack(self):
        self.begin()
        self.evidence()
        self.next_ref = self.old
        with self.assertRaises(ValueError):
            self.finish()
        self.assertFalse(self.acked)

    def test_ack_interrupted_receipt_is_not_completed_workflow(self):
        self.begin()
        self.evidence()
        self.fail_after = "ack"
        with self.assertRaises(TimeoutError):
            self.finish()
        key = next(reversed(self.receipts))
        self.receipts[key].update(waitInterrupted="outcome_unknown")
        with self.assertRaisesRegex(ValueError, "ack_unconfirmed"):
            self.finish()
        self.assertEqual(len(self.mutations), 2)
        self.assertFalse(self.receipt_path.exists())
        self.assertEqual(read_json(self.f.config["checkpoint_head"]), self.old)

    def test_claim_crash_retry_never_reexecutes_action(self):
        step = workflow.step
        def crash(*args, **kwargs):
            step(*args, **kwargs)
            raise RuntimeError("after claim")
        with patch.object(workflow, "step", side_effect=crash):
            with self.assertRaisesRegex(RuntimeError, "after claim"):
                self.begin()
        self.assertFalse(self.begin()["execute_action"])
        self.assertEqual(len(self.mutations), 1)

    def test_existing_receipt_not_overwritten_and_not_acked(self):
        self.begin()
        self.evidence()
        replace_json(self.receipt_path, {"unrelated": "preserve"})
        before = file_ref(self.receipt_path)
        with self.assertRaisesRegex(ValueError, "receipt_changed"):
            self.finish()
        self.assertFalse(self.acked)
        self.assertEqual(file_ref(self.receipt_path), before)

    def test_progress_guard_runs_before_ack(self):
        self.begin()
        self.evidence()
        progress = {"consecutive_without_acceptance_advance": 3, "limit": 3,
                    "scope": "declared_acceptance_only_not_semantic_verification"}
        with patch.object(workflow, "validate_scheduler_progress", return_value=progress):
            with self.assertRaisesRegex(ValueError, "no_acceptance_progress"):
                self.finish()
            stop = read_json(self.f.state / "scheduler.json")["stop"]
            self.assertEqual(stop["reason"], "tui_scheduler_no_acceptance_progress")
            self.assertEqual(stop["checkpoint"], self.next_ref)
            self.assertEqual(stop["progress"], progress)
            self.assertFalse(self.acked)
            clear_ref, _ = self.f.scheduler_review_clear_ref(stop)
            self.assertEqual(apply_review_clear(self.f.config_ref, clear_ref)["state"],
                             "scheduler_review_clear_applied")
            self.assertTrue(self.finish()["ok"])
        self.assertTrue(self.acked)

    def test_head_publication_crash_retries_only_finish(self):
        self.begin()
        self.evidence()
        write = workflow.replace_json
        def crash(target, data):
            write(target, data)
            if str(target) == self.f.config["checkpoint_head"]:
                raise RuntimeError("after head")
        with patch.object(workflow, "replace_json", side_effect=crash):
            with self.assertRaisesRegex(RuntimeError, "after head"):
                self.finish()
        self.assertTrue(self.finish()["ok"])
        self.assertEqual(len(self.mutations), 2)

    def test_post_ack_retry_completes_prevalidated_head_after_context_advances(self):
        self.begin()
        self.evidence()
        class Busy:
            def __enter__(self):
                return False
            def __exit__(self, *args):
                return False

        with patch("coordinator_io.try_bound_lock", return_value=Busy()):
            result = self.finish()
        self.assertTrue(result["retryable"])
        self.assertTrue(self.acked)
        self.assertEqual(read_json(self.f.config["checkpoint_head"]), self.old)

        # A later retry observes a newer TUI context. The old next checkpoint was
        # already validated before durable settle+ACK, so closeout must not replay
        # the action or ACK and must still publish that pinned head.
        self.f.observer_mock.return_value["observed_at"] = now()
        result = self.finish()
        self.assertTrue(result["ok"])
        self.assertEqual(read_json(self.f.config["checkpoint_head"]), self.next_ref)
        self.assertEqual(len(self.mutations), 2)

    def test_post_settle_pre_ack_retry_still_requires_current_turn_checkpoint(self):
        self.begin()
        self.evidence()
        ack = workflow.mutation

        def crash_on_ack(journal, target, name, args, contract, call):
            if name == "ack":
                raise RuntimeError("before ack")
            return ack(journal, target, name, args, contract, call)

        with patch.object(workflow, "mutation", side_effect=crash_on_ack):
            with self.assertRaisesRegex(RuntimeError, "before ack"):
                self.finish()
        self.f.observer_mock.return_value["observed_at"] = now()
        with self.assertRaisesRegex(ValueError, "tui_checkpoint_not_from_current_turn"):
            self.finish()
        self.assertEqual(read_json(self.f.config["checkpoint_head"]), self.old)


if __name__ == "__main__":
    unittest.main()

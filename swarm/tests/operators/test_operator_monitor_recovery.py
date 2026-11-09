"""Reviewed same-Run recovery with offline runtime fixtures, never live acceptance."""
import copy
import os
from pathlib import Path
from datetime import timedelta
import unittest
from unittest.mock import patch

from coordinator_io import bound_lock, canonical, file_ref, now, publish_new, read_json, replace_json, timestamp
import operator_monitor as monitor
import operator_monitor_deploy as deploy
import operator_monitor_recovery as recovery
import operator_monitor_upgrade as upgrade
import operators.test_operator_monitor_deploy as deployment
import coordinator.test_coordinator_tui_workflow as workflow
from progress_watch import StopObservation, decode_response


class RecoveryTests(workflow.WorkflowTests):
    def setUp(self):
        self.d = deployment.NativeDeploymentTests()
        self.d.setUp()
        self.addCleanup(self.d.doCleanups)
        self.assertEqual(self.d.execute(), 0)
        self.init_workflow(self.d.s)
        self.stop = self.m.state_root / "monitor-stop.json"
        publish_new(self.stop, dict(at=now(), reason="tui_checkpoint_not_from_completed_turn"))
        replace_json(self.m.state_root / "status.json", dict(state="stopped", observed_at=now()))
        status = read_json(self.m.state_root / "deployment-status.json")
        replace_json(self.m.state_root / "deployment-status.json", {**status,
                     "status": file_ref(self.m.state_root / "status.json"), "observed_at": now()})
        self.output = self.m.root / "recovery"
        self.output.mkdir(mode=0o700)
        self.reviewer = dict(terminal="reviewer", incarnation="review-inc", workspace="review-ws")

    def call(self, args, runtime, timeout=20):
        if args[:2] == ["terminal", "show"] and args[-1] in ("preparer", "reviewer"):
            handle = args[-1]
            return dict(terminal=dict(handle=handle, incarnationId="review-inc", worktreeId="review-ws",
                                     connected=True, orphaned=False, agentIdentity="trae"))
        if args[:2] == ["orchestration", "request-show"] and args[-1] in self.receipts:
            return self.query(self.f.c["cli"]["path"], runtime, args)
        return self.m.fake(args, runtime, timeout)

    def prepare(self):
        with patch.dict(os.environ, ORCA_TERMINAL_HANDLE="preparer"):
            self.proposal = recovery.prepare(self.d.ref, str(self.output), call=self.call)
        self.proposal_data = read_json(self.proposal["path"])
        publish_new(self.output / "review.json", dict(schema_version=1, proposal=self.proposal,
            approved=True, reviewer=self.reviewer, evidence=[self.proposal], reason="Offline independent review"))
        self.review = file_ref(self.output / "review.json")

    def approve(self):
        self.prepare()
        self.recovery_ref = recovery.apply(self.proposal, self.review, call=self.call)
        return self.recovery_ref

    def reconciled(self):
        self.approve()
        self.assertTrue(self.begin()["execute_action"])
        self.evidence()
        self.proof = self.finish()["receipt"]
        self.s.ended["completed_turn"]["context_at"] = self.f.observer_mock.return_value["observed_at"]
        self.s.ended["completed_turn"]["completed_at"] = now()

    def complete(self):
        return recovery.complete(self.recovery_ref, self.proof, call=self.call,
                                 observe_turn=lambda *_: copy.deepcopy(self.s.ended))

    def restarted_runtime(self, args, runtime, timeout=20):
        # The native rows (owner, generation, terminals) survive unchanged. Only
        # the response runtime differs, as after a real Server process restart.
        return decode_response(canonical(dict(ok=True, result=self.call(args, runtime, timeout),
            _meta=dict(runtimeId=runtime + "-restarted"))), 0, runtime)

    def test_runtime_restart_blocks_prepare_without_publication_or_state_change(self):
        before = upgrade.inventory([self.m.state_root, self.f.state])
        with patch.dict(os.environ, ORCA_TERMINAL_HANDLE="preparer"):
            with self.assertRaisesRegex(StopObservation, "^runtime_mismatch$"):
                recovery.prepare(self.d.ref, str(self.output), call=self.restarted_runtime)
        self.assertEqual(before, upgrade.inventory([self.m.state_root, self.f.state]))
        self.assertEqual(list(self.output.iterdir()), [])
        self.assertEqual(self.mutations, [])

    def test_runtime_restart_after_review_blocks_apply_without_state_change(self):
        self.prepare()
        before = upgrade.inventory([self.m.state_root, self.f.state, self.output])
        with self.assertRaisesRegex(StopObservation, "^runtime_mismatch$"):
            recovery.apply(self.proposal, self.review, call=self.restarted_runtime)
        self.assertEqual(before, upgrade.inventory([self.m.state_root, self.f.state, self.output]))
        self.assertFalse((self.output / "reviewed.json").exists())
        self.assertEqual(self.mutations, [])

    def test_runtime_restart_after_workflow_blocks_complete_without_replay(self):
        self.reconciled()
        before = upgrade.inventory([self.m.state_root, self.f.state, self.output])
        mutations = copy.deepcopy(self.mutations)
        with self.assertRaisesRegex(StopObservation, "^runtime_mismatch$"):
            recovery.complete(self.recovery_ref, self.proof, call=self.restarted_runtime,
                              observe_turn=lambda *_: copy.deepcopy(self.s.ended))
        self.assertEqual(before, upgrade.inventory([self.m.state_root, self.f.state, self.output]))
        self.assertEqual(self.mutations, mutations)
        self.assertFalse((self.output / "committed.json").exists())
        self.assertFalse((self.output / "deployment.json").exists())

    def test_prepare_and_apply_only_publish_review_no_state_or_send(self):
        before = upgrade.inventory([self.m.state_root, self.f.state])
        ref = self.approve()
        self.assertEqual(recovery.apply(self.proposal, self.review, call=self.call), ref)
        self.assertEqual(before, upgrade.inventory([self.m.state_root, self.f.state]))
        self.assertEqual(len(self.m.messages), 1)
        self.assertEqual(self.mutations, [])
        self.assertFalse((self.output / "deployment.json").exists())
        with self.assertRaisesRegex(ValueError, "persistent_stop"):
            self.d.execute()

    def test_reconcile_commit_then_same_sender_restart_no_resend(self):
        old_stop = file_ref(self.stop)
        old_config = self.f.config_ref.copy()
        self.reconciled()
        ref = self.complete()
        self.assertEqual(self.complete(), ref)
        plan, config = deploy.validate(ref)
        self.assertEqual(plan["config"], self.d.plan["config"])
        self.assertEqual(plan["sender"], self.d.plan["sender"])
        self.assertEqual(self.f.config_ref, old_config)
        self.assertEqual(old_stop, file_ref(self.stop))
        self.assertFalse(monitor.persistently_stopped(config))
        self.d.ref = ref
        proofs = []
        with patch.dict(os.environ, self.m.environment):
            self.assertEqual(self.d.execute(observer=lambda: proofs.append(deploy.verify(ref, call=self.call))), 0)
        self.assertEqual(proofs[0]["state"], "monitor_runtime_observed")
        with patch.dict(os.environ, self.m.environment):
            self.assertEqual(self.d.execute(), 0)
        self.assertEqual(len(self.m.messages), 2)  # One new action, never the old continuation again.
        self.assertEqual(old_stop, file_ref(self.stop))

    def test_recovery_next_failure_latches_without_rewriting_old_stop(self):
        self.reconciled()
        ref = self.complete()
        old_stop = file_ref(self.stop)
        self.d.ref = ref
        def fail(_):
            raise ValueError("another_failure")
        self.assertEqual(self.d.execute(tick=fail), 2)
        _, config = deploy.validate(ref)
        self.assertEqual(read_json(monitor.failure_latch(config))["reason"], "another_failure")
        self.assertEqual(file_ref(self.stop), old_stop)
        with self.assertRaisesRegex(ValueError, "persistent_stop"):
            self.d.execute()

    def test_manual_stop_always_blocks_even_with_committed_plan(self):
        self.reconciled()
        ref = self.complete()
        publish_new(self.m.state_root / "STOP", b"operator stop")
        self.d.ref = ref
        with self.assertRaisesRegex(ValueError, "persistent_stop"):
            self.d.execute()

    def test_continuation_manual_stop_always_blocks_committed_plan(self):
        self.reconciled()
        ref = self.complete()
        publish_new(self.f.state / "STOP", b"operator stop")
        self.d.ref = ref
        with self.assertRaisesRegex(ValueError, "persistent_stop"):
            self.d.execute()

    def test_changed_original_stop_cannot_use_recovery_plan(self):
        self.reconciled()
        ref = self.complete()
        replace_json(self.stop, {"reason": "different_failure"})
        with self.assertRaisesRegex(ValueError, "file_pin_changed"):
            deploy.validate(ref)

    def test_unknown_stop_manual_stop_claimed_or_owner_change_refused(self):
        old = read_json(self.stop)
        replace_json(self.stop, {**old, "reason": "unknown_error"})
        with self.assertRaisesRegex(ValueError, "stop_not_supported"):
            self.prepare()
        replace_json(self.stop, old)
        publish_new(self.f.state / "STOP", b"stop")
        with self.assertRaisesRegex(ValueError, "manual_stop"):
            self.prepare()
        (self.f.state / "STOP").unlink()  # Test-only temporary fixture.
        self.begin()
        with self.assertRaisesRegex(ValueError, "unclaimed"):
            self.prepare()
        self.assertFalse((self.output / "proposal.json").exists())

    def test_reviewer_cannot_be_preparer_coordinator_or_sender(self):
        self.prepare()
        saved = read_json(self.review["path"])
        for handle in ("preparer", "term_test", "term-operator"):
            replace_json(Path(self.review["path"]), {**saved, "reviewer": {**self.reviewer, "terminal": handle}})
            with self.assertRaisesRegex(ValueError, "independent_reviewer"):
                recovery.apply(self.proposal, file_ref(self.review["path"]), call=self.call)
        self.assertFalse((self.output / "reviewed.json").exists())

    def test_state_drift_after_review_denied_before_coordinator_consume(self):
        self.approve()
        publish_new(self.m.state_root / "STOP", b"new stop")
        with self.assertRaisesRegex(ValueError, "state_changed"):
            self.begin()
        self.assertEqual(self.mutations, [])

    def test_unrelated_outbox_change_and_bad_native_receipt_block_complete(self):
        self.reconciled()
        key = next(iter(self.receipts))
        saved = self.receipts[key]
        self.receipts[key] = {**saved, "count": 999}
        with self.assertRaisesRegex(ValueError, "native_receipt_unconfirmed"):
            self.complete()
        self.assertFalse((self.output / "deployment.json").exists())

    def test_complete_requires_actual_completed_turn_and_empty_mailbox(self):
        self.reconciled()
        with self.assertRaisesRegex(ValueError, "session_changed"):
            recovery.complete(self.recovery_ref, self.proof, call=self.call, observe_turn=lambda *_: None)
        self.m.messages[0]["read"] = 0
        with self.assertRaisesRegex(ValueError, "pending_mail"):
            self.complete()
        self.assertFalse((self.output / "deployment.json").exists())

    def test_plan_published_last_crash_can_retry_without_action(self):
        self.reconciled()
        publish = recovery.publish_new
        def crash(target, data):
            publish(target, data)
            if target.name == "committed.json":
                raise RuntimeError("crash")
        with patch.object(recovery, "publish_new", side_effect=crash):
            with self.assertRaisesRegex(RuntimeError, "crash"):
                self.complete()
        self.assertFalse((self.output / "deployment.json").exists())
        deploy.validate(self.complete())
        self.assertEqual(len(self.mutations), 2)

    def test_original_locks_prevent_prepare_and_complete(self):
        with bound_lock(self.f.state, self.f.config_ref, "tui-continuation"):
            with self.assertRaises(BlockingIOError):
                self.prepare()
        self.assertFalse((self.output / "proposal.json").exists())

    def test_expired_or_changed_source_proposal_not_usable(self):
        self.prepare()
        with patch.object(recovery, "now", return_value=(timestamp(now()) + timedelta(hours=1)).isoformat()):
            with self.assertRaisesRegex(ValueError, "proposal_expired"):
                recovery.apply(self.proposal, self.review, call=self.call)
        with patch.object(deploy, "sources", return_value=[]):
            with self.assertRaisesRegex(ValueError, "source_changed"):
                recovery.apply(self.proposal, self.review, call=self.call)
        self.assertFalse((self.output / "reviewed.json").exists())

    def test_changed_head_before_complete_refused(self):
        self.reconciled()
        replace_json(Path(self.f.config["checkpoint_head"]), self.old)
        with self.assertRaisesRegex(ValueError, "head_changed"):
            self.complete()
        self.assertFalse((self.output / "deployment.json").exists())

    def test_recovery_permit_cannot_be_replaced_or_applied_to_other_action(self):
        self.approve()
        self.assertTrue(self.begin()["execute_action"])
        self.recovery_ref = None
        with self.assertRaisesRegex(ValueError, "binding_changed"):
            self.begin()
        self.assertEqual(len(self.mutations), 1)

    def test_owner_drift_and_scheduler_review_stop_block_recovery(self):
        self.m.run["consumer_generation"] += 1
        with self.assertRaisesRegex(ValueError, "run_changed"):
            self.prepare()
        self.m.run["consumer_generation"] -= 1
        journal = read_json(self.f.state / "scheduler.json")
        journal["stop"] = {"state": "review_required", "reason": "tui_scheduler_no_acceptance_progress"}
        replace_json(self.f.state / "scheduler.json", journal)
        with self.assertRaises(ValueError):
            self.prepare()
        self.assertFalse((self.output / "proposal.json").exists())


if __name__ == "__main__":
    unittest.main()

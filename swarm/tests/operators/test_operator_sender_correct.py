"""Offline correction fault injection; no real terminal or sender migration."""

from pathlib import Path
import unittest
from unittest.mock import patch

from coordinator_io import (bound_lock, file_ref, now, publish_new, read_json,
                            replace_json)
import operator_monitor as monitor
import operator_monitor_deploy as deploy
import operator_sender_correct as correct
import coordinator.test_coordinator_tui_scheduler as scheduler


class CorrectionTests(unittest.TestCase):
    def setUp(self):
        self.s = scheduler.SchedulerTests()
        self.s.setUp()
        self.addCleanup(self.s.doCleanups)
        self.m, self.f = self.s.m, self.s.f
        self.output = self.m.root / "deploy"
        self.output.mkdir(mode=0o700)
        self.plan_ref = deploy.prepare(self.f.config_ref, str(self.m.state_root), str(self.output), call=self.m.fake)
        self.plan, self.config = deploy.validate(self.plan_ref)
        with bound_lock(self.m.state_root, self.config.ref, "monitor"), \
                bound_lock(self.f.state, self.f.config_ref, "tui-continuation"):
            pass
        publish_new(self.m.state_root / "deployment-status.json", dict(schema_version=2, plan=self.plan_ref,
            started_at=now(), observed_at=now(), phase="exited", first_tick_at=None, status=None))
        self.destination = self.m.root / "correction"
        self.destination.mkdir(mode=0o700)
        self.sender = dict(terminal="new-sender", incarnation="new-inc", workspace="new-ws")
        self.reviewer = dict(terminal="reviewer", incarnation="review-inc", workspace="review-ws")

    def call(self, args, runtime, timeout=20):
        if args[:2] == ["terminal", "show"] and args[-1] in ("new-sender", "reviewer"):
            s = self.sender if args[-1] == "new-sender" else self.reviewer
            return dict(terminal=dict(handle=s["terminal"], incarnationId=s["incarnation"], worktreeId=s["workspace"],
                connected=True, orphaned=False, agentIdentity=None if s == self.sender else "trae", tabId="tab", leafId="leaf"))
        return self.m.fake(args, runtime, timeout)

    def prepare(self):
        self.proposal = correct.prepare(self.plan_ref, self.sender, str(self.destination), call=self.call)
        self.data = read_json(self.proposal["path"])
        review = dict(schema_version=1, proposal=self.proposal, approved=True, reviewer=self.reviewer,
                      evidence=[self.proposal], reason="Independent test review; not live evidence")
        publish_new(self.destination / "review.json", review)
        self.review = file_ref(self.destination / "review.json")

    def apply(self):
        return correct.apply(self.proposal, self.review, call=self.call)

    def test_correction_preserves_history_and_state_paths_and_is_idempotent(self):
        old = {p: file_ref(p) for root in (self.output, self.f.state, self.m.state_root)
               for p in root.iterdir() if p.is_file() and p.name != "monitor.lock"}
        self.prepare()
        self.assertFalse((self.m.state_root / "binding-correction.json").exists())
        receipt = self.apply()
        self.assertEqual(receipt, self.apply())
        _, new = deploy.validate(self.data["new_plan"])
        self.assertEqual(new.root, self.m.state_root)
        self.assertEqual(read_json(self.data["new_continuation"]["path"])["state_root"], str(self.f.state))
        for p, ref in old.items():
            if p.name.endswith("-binding.json"):
                self.assertTrue(any(s["before"]["sha256"] == ref["sha256"] for s in self.data["snapshots"]))
            else:
                self.assertEqual(file_ref(p), ref)
        with self.assertRaisesRegex(ValueError, "obsolete_config"):
            deploy.validate(self.plan_ref)

    def test_any_execution_or_unknown_file_refuses(self):
        for root, name in ((self.m.state_root, "state.json"), (self.m.state_root, "launch-unknown.json"),
                           (self.m.state_root, "monitor-stop.json"), (self.f.state, "outbox.json"),
                           (self.f.state, "scheduler.json"), (self.f.state, "unexpected")):
            with self.subTest(name=name):
                publish_new(root / name, {})
                with self.assertRaisesRegex(ValueError, "unstarted_state"):
                    correct.prepare(self.plan_ref, self.sender, str(self.destination), call=self.call)
                (root / name).unlink()

    def test_first_tick_and_unknown_status_refuse(self):
        target = self.m.state_root / "deployment-status.json"
        saved = read_json(target)
        for field, value in (("first_tick_at", now()), ("phase", "starting"), ("status", {}), ("extra", True)):
            replace_json(target, {**saved, field: value})
            with self.assertRaisesRegex(ValueError, "prelaunch_failure"):
                correct.prepare(self.plan_ref, self.sender, str(self.destination), call=self.call)
        replace_json(target, saved)

    def test_agent_sender_and_owner_change_refuse_before_publication(self):
        def bad(args, runtime, timeout):
            r = self.call(args, runtime, timeout)
            if args[-1] == "new-sender":
                r["terminal"]["agentIdentity"] = "trae"
            return r
        with self.assertRaisesRegex(ValueError, "operator_terminal_unverifiable"):
            correct.prepare(self.plan_ref, self.sender, str(self.destination), call=bad)
        self.assertEqual(list(self.destination.iterdir()), [])
        self.m.run["consumer_generation"] += 1
        with self.assertRaisesRegex(ValueError, "run_changed"):
            correct.prepare(self.plan_ref, self.sender, str(self.destination), call=self.call)

    def test_locks_block_prepare_and_apply(self):
        with bound_lock(self.m.state_root, self.config.ref, "monitor"):
            with self.assertRaises(BlockingIOError):
                correct.prepare(self.plan_ref, self.sender, str(self.destination), call=self.call)
        self.prepare()
        with bound_lock(self.f.state, self.f.config_ref, "tui-continuation"):
            with self.assertRaises(BlockingIOError):
                self.apply()

    def test_partial_commit_is_fail_closed_and_resumable(self):
        self.prepare()
        original = correct.replace_json
        calls = []
        def crash(target, value):
            original(target, value)
            calls.append(target)
            if len(calls) == 1:
                raise RuntimeError("simulated crash")
        with patch.object(correct, "replace_json", side_effect=crash):
            with self.assertRaisesRegex(RuntimeError, "crash"):
                self.apply()
        for ref in (self.plan_ref, self.data["new_plan"]):
            with self.assertRaises((ValueError, FileNotFoundError)):
                deploy.validate(ref)
        self.apply()
        deploy.validate(self.data["new_plan"])

    def test_crash_after_first_marker_is_resumable(self):
        self.prepare()
        original = correct.publish_new
        def crash(target, value):
            original(target, value)
            if target.name == "binding-correction.json":
                raise RuntimeError("marker crash")
        with patch.object(correct, "publish_new", side_effect=crash):
            with self.assertRaisesRegex(RuntimeError, "marker crash"):
                self.apply()
        self.assertEqual(read_json(self.m.state_root / "monitor-binding.json"), self.config.ref)
        with self.assertRaises(ValueError):
            deploy.validate(self.plan_ref)
        self.apply()
        deploy.validate(self.data["new_plan"])

    def test_apply_independently_rejects_forged_failure_snapshot(self):
        self.prepare()
        snapshot = next(s for s in self.data["snapshots"] if s["target"].endswith("deployment-status.json"))
        value = read_json(snapshot["before"]["path"])
        value["first_tick_at"] = now()
        replace_json(Path(snapshot["before"]["path"]), value)
        snapshot["before"] = file_ref(snapshot["before"]["path"])
        replace_json(Path(self.proposal["path"]), self.data)
        self.proposal = file_ref(self.proposal["path"])
        review = read_json(self.review["path"])
        review["proposal"] = self.proposal
        review["evidence"] = [self.proposal]
        replace_json(Path(self.review["path"]), review)
        self.review = file_ref(self.review["path"])
        with self.assertRaisesRegex(ValueError, "prelaunch_failure"):
            self.apply()
        self.assertFalse((self.m.state_root / "binding-correction.json").exists())

    def test_committed_binding_corruption_is_not_idempotent_success(self):
        self.prepare()
        self.apply()
        replace_json(self.f.state / "tui-continuation-binding.json", self.f.config_ref)
        with self.assertRaisesRegex(ValueError, "binding_changed"):
            self.apply()

    def test_committed_missing_marker_is_not_idempotent_success(self):
        self.prepare()
        self.apply()
        for root in (self.m.state_root, self.f.state):
            marker = root / "binding-correction.json"
            saved = read_json(marker)
            marker.unlink()
            with self.assertRaises(FileNotFoundError):
                self.apply()
            publish_new(marker, saved)

    def test_evidence_drift_during_live_check_refuses_without_markers(self):
        self.prepare()
        evidence = self.destination / "independent-evidence.json"
        publish_new(evidence, {"reviewed": True})
        review = read_json(self.review["path"])
        review["evidence"] = [file_ref(evidence)]
        replace_json(Path(self.review["path"]), review)
        self.review = file_ref(self.review["path"])
        def drift(args, runtime, timeout=20):
            result = self.call(args, runtime, timeout)
            if args[-1] == "reviewer":
                replace_json(evidence, {"reviewed": False})
            return result
        with self.assertRaisesRegex(ValueError, "file_pin_changed"):
            correct.apply(self.proposal, self.review, call=drift)
        self.assertFalse((self.m.state_root / "binding-correction.json").exists())
        self.assertFalse((self.f.state / "binding-correction.json").exists())

    def test_change_after_review_refuses_without_rebinding(self):
        self.prepare()
        publish_new(self.f.state / "outbox.json", {"actions": {}, "order": []})
        with self.assertRaisesRegex(ValueError, "unstarted_state"):
            self.apply()
        self.assertEqual(read_json(self.m.state_root / "monitor-binding.json"), self.config.ref)

    def test_review_and_source_drift_refuse(self):
        self.prepare()
        with patch.object(deploy, "sources", return_value=[]):
            with self.assertRaisesRegex(ValueError, "revision_changed_scope"):
                self.apply()
        review = read_json(self.review["path"])
        review["approved"] = False
        replace_json(Path(self.review["path"]), review)
        self.review = file_ref(self.review["path"])
        with self.assertRaisesRegex(ValueError, "external_review_required"):
            self.apply()


if __name__ == "__main__":
    unittest.main()

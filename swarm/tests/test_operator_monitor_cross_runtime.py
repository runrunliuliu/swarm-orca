"""Client integration only: the Server boundary is an explicit offline fixture."""

import copy
import os
from pathlib import Path
import unittest
from unittest.mock import patch

from coordinator_io import canonical, digest, file_ref, now, parse, publish_new, read_json, replace_json
import coordinator_tui_scheduler as scheduler
import operator_continuity_route as route
import operator_continuity_source as source_observer
import operator_monitor_cross_runtime as cross
import operator_monitor_recovery as recovery
import operator_monitor_deploy as deploy
import operator_monitor as monitor
from operator_sender_correct import original
from operator_continuity_deployment import original as continued_original, stop_path, runtime_chain
import test_operator_monitor_recovery as same


class CrossRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.f = same.RecoveryTests()
        self.f.setUp()
        self.addCleanup(self.f.doCleanups)
        f = self.f
        self.source = f.f.c["runtime"]
        self.target = self.source + "-successor"
        self.transition = f.f.t.ref("transition.json", dict(schema_version=1,
            kind="planned-restart-monitor-transition", old_plan=f.d.ref, source_runtime=self.source,
            target_runtime=self.target, server_id="fixture-server",
            seal=f.f.t.ref("seal.json", {"fixture_only": True}), binding=f.m.binding,
            snapshot=recovery.snapshot(f.d.ref, *original(f.d.ref))))
        self.phases = []

    def server(self, transition, phase, evidence):
        self.assertEqual(transition, route.validate(self.transition))
        self.phases.append(phase)
        return dict(transition_canonical_sha256=digest(canonical(transition)), phase=phase)

    def call(self, args, runtime, timeout=20):
        self.assertEqual(runtime, self.target, "native query used historical runtime")
        return self.f.call(args, self.source, timeout)

    def query(self, cli, runtime, args):
        self.assertEqual(runtime, self.target)
        result = self.f.query(cli, self.source, args)
        if args[:2] == ["orchestration", "strict-caller-check"]:
            return dict(ok=True, result=result, _meta=dict(runtimeId=self.target))
        return result

    def prepare(self):
        with patch.dict(os.environ, ORCA_TERMINAL_HANDLE="preparer"):
            self.proposal = cross.prepare(self.transition, str(self.f.output), call=self.call)
        self.review = self.f.f.t.ref(str(self.f.output / "review.json"), dict(schema_version=1, proposal=self.proposal,
            approved=True, reviewer=self.f.reviewer, evidence=[self.proposal], reason="Offline review"))

    def approve(self):
        self.prepare()
        self.permit = cross.apply(self.proposal, self.review, call=self.call)

    def reconciled(self):
        self.approve()
        self.assertTrue(cross.begin(self.permit, call=self.query)["execute_action"])
        self.assertFalse(cross.begin(self.permit, call=self.query)["execute_action"])
        self.f.evidence()
        self.proof = cross.finish(self.permit, self.f.result, self.f.next_ref, self.f.processed,
                                 str(self.f.receipt_path), call=self.query)["receipt"]
        self.f.s.ended["completed_turn"].update(
            context_at=self.f.f.observer_mock.return_value["observed_at"], completed_at=now())

    def complete(self):
        return cross.complete(self.permit, self.proof, call=self.call,
                              observe_turn=lambda *_: copy.deepcopy(self.f.s.ended))

    def execute(self, plan, observer=None):
        tick = monitor.tick
        schedule = scheduler.schedule
        def tick_schedule(config, snapshot, call):
            return schedule(config, snapshot, call,
                            observe_turn=lambda *_: copy.deepcopy(self.f.s.ended))
        replace = deploy.replace_json
        def write(target, value):
            replace(target, value)
            if observer and target.name == "deployment-status.json" and value["phase"] == "monitoring":
                observer()
        with patch.object(monitor, "native", side_effect=route.routed(self.call)), \
                patch.object(monitor, "tick", side_effect=lambda c: tick(c, call=route.routed(self.call))), \
                patch.object(scheduler, "schedule", side_effect=tick_schedule), \
                patch.object(deploy, "own_sender_environment", return_value=self.f.m.environment), \
                patch.object(deploy, "replace_json", side_effect=write), \
                patch.dict(os.environ, self.f.m.environment):
            return cross.run(plan, once=True)

    def test_native_server_denial_before_any_query_or_write(self):
        before = list(self.f.output.iterdir())
        with patch.object(route, "maintenance_call", side_effect=PermissionError("runtime_access_denied")) as call:
            with self.assertRaisesRegex(PermissionError, "runtime_access_denied"):
                self.prepare()
        self.assertEqual(call.call_count, 1)
        self.assertEqual(call.call_args.args[1], self.target)
        self.assertEqual(before, list(self.f.output.iterdir()))
        self.assertEqual(self.f.mutations, [])
        self.assertEqual(route.runtime(self.source), self.source)

    def test_direct_same_runtime_entry_cannot_use_transition(self):
        with patch.dict(os.environ, ORCA_TERMINAL_HANDLE="preparer"):
            with self.assertRaisesRegex(ValueError, "explicit_entry_required"):
                recovery.prepare(self.f.d.ref, str(self.f.output), transition_ref=self.transition, call=self.call)
        self.assertEqual(list(self.f.output.iterdir()), [])

    def test_complete_loop_then_next_action_with_unchanged_historical_pins(self):
        pins = [self.f.d.ref, self.f.d.plan["config"], self.f.f.config_ref, self.f.f.contract_ref,
                self.f.f.config["dispatch_gate"], self.f.f.t.caller_ref, file_ref(self.f.stop)]
        with patch.object(route, "server_boundary", side_effect=self.server):
            self.reconciled()
            plan = self.complete()
            self.assertEqual(self.complete(), plan)
            self.assertEqual(read_json(plan["path"])["config"], self.f.d.plan["config"])
            with self.assertRaisesRegex(ValueError, "explicit_entry_required"):
                deploy.run(plan, once=True)
            _, config = deploy.validate(plan)
            before = recovery.inventory(original(self.f.d.ref)[-1])
            for entry in (monitor.run, monitor.tick):
                with self.assertRaisesRegex(ValueError, "explicit_entry_required"):
                    entry(config)
            self.assertEqual(before, recovery.inventory(original(self.f.d.ref)[-1]))
            proofs = []
            self.assertEqual(self.execute(plan, lambda: proofs.append(cross.verify(plan, call=self.call))), 0)
            self.assertEqual(proofs[0]["state"], "monitor_runtime_observed")
            self.assertEqual(self.execute(plan), 0)
            self.assertEqual(len(self.f.m.messages), 2)
            sent = [args for args in self.f.m.calls if args[:2] == ["orchestration", "send"]][-1]
            payload = parse(sent[sent.index("--payload") + 1])
            self.assertEqual(payload["recovery_plan"], plan)
            self.assertIn("continue-begin", sent[sent.index("--body") + 1])
            self.assertEqual(len(self.f.mutations), 2)
            self.f.delivery = dict(runId="run_test", deliveryId="second-batch", count=1,
                                   messages=[copy.deepcopy(self.f.m.messages[-1])])
            self.f.acked = False
            self.f.f.observer_mock.return_value["observed_at"] = now()
            self.assertTrue(cross.continue_begin(plan, call=self.query)["execute_action"])
            self.assertFalse(cross.continue_begin(plan, call=self.query)["execute_action"])
            checkpoint = self.f.f.record_ref
            action = self.f.f.record["checkpoint"]["next_action"]["id"]
            proof = self.f.f.t.ref("bootstrap/second-proof.json", {"actual": "second fixture action"})
            result = self.f.f.t.ref("bootstrap/second-result.json", dict(action_id=action,
                checkpoint=checkpoint, status="executed", evidence=[proof]))
            processed = self.f.f.t.ref("bootstrap/second-processed.json", dict(delivery_id="second-batch",
                messages=[dict(id=self.f.m.messages[-1]["id"], evidence=[result])]))
            self.f.s.new_turn(("met", "met"))
            next_ref = self.f.f.record_ref
            replace_json(Path(self.f.f.config["checkpoint_head"]), checkpoint)
            self.assertTrue(cross.continue_finish(plan, result, next_ref, processed,
                str(self.f.f.t.f.bootstrap / "second-workflow.json"), call=self.query)["ok"])
            self.assertTrue(cross.audit(plan, call=self.query)["ok"])
            self.assertEqual(len(self.f.mutations), 4)
            self.assertTrue(self.f.acked)
        self.assertEqual(pins, [file_ref(ref["path"]) for ref in pins])
        self.assertEqual(route.runtime(self.source), self.source)
        self.assertTrue({"prepare", "apply", "begin", "finish", "complete", "run", "verify",
                         "continue-begin", "continue-finish", "turn-end"}.issubset(self.phases))

    def test_real_tui_reader_only_allows_runtime_metadata_change_in_verified_scope(self):
        t = self.f.f.t
        anchor = self.f.f.c["observation"]["startup_anchor"]
        options = dict(startup_anchor=anchor, expected_thread=self.f.f.c["coordinator"]["session"])
        old_anchor = file_ref(anchor["path"])
        t.discovery.update(runtimeId=self.target, startedAt=t.ms - 1000)
        t.write_state()
        with self.assertRaisesRegex(ValueError, "runtime_state_unverifiable"):
            t.observe(**options)
        with patch.object(route, "server_boundary", side_effect=self.server):
            with route.scope(self.transition, "prepare"):
                observed = t.observe(**options)
                self.assertEqual(observed["runtime_id"], self.target)
                self.assertEqual(observed["binding"]["runtime"]["runtimeId"], self.target)
                t.entry["evidenceObservedAt"] = t.ms - 2000
                t.write_state()
                with self.assertRaisesRegex(ValueError, "hook_stale_or_future"):
                    t.observe(**options)
                t.entry["evidenceObservedAt"] = t.ms
                t.entry["launchTokenHash"] = "b" * 64
                t.write_state()
                with self.assertRaisesRegex(ValueError, "hook_strict_caller_mismatch"):
                    t.observe(**options)
        self.assertEqual(file_ref(anchor["path"]), old_anchor)

    def test_two_reviewed_restart_cycles_keep_config_and_pending_identity(self):
        initial = self.f.d.ref
        with patch.object(route, "server_boundary", side_effect=self.server):
            self.reconciled()
            first = self.complete()
            self.assertEqual(self.execute(first), 0)
            parts = continued_original(first)
            stopped = stop_path(parts[0], self.f.m.state_root)
            publish_new(stopped, dict(at=now(), reason="tui_checkpoint_not_from_completed_turn"))
            replace_json(self.f.m.state_root / "status.json", dict(state="stopped", observed_at=now()))
            status_path = self.f.m.state_root / "deployment-status.json"
            status = read_json(status_path)
            replace_json(status_path, {**status, "phase": "exited", "observed_at": now(),
                "status": file_ref(self.f.m.state_root / "status.json")})
            # Caller freshness is covered by source tests; exercise the recovered plan routing here.
            with patch.object(source_observer, "source_caller", return_value={"fixture_operator": True}):
                observed = source_observer.observe_source(first, call=self.call,
                    observe_turn=lambda *_: copy.deepcopy(self.f.s.ended))["observation"]
            self.assertIn("source-prepare", self.phases)
            self.assertEqual(observed["plan"], first)
            self.assertEqual(parse(observed["pending_message"]["payload"])["recovery_plan"], first)
            self.target += "-second"
            self.transition = self.f.f.t.ref("transition-2.json", dict(schema_version=1,
                kind="planned-restart-monitor-transition", old_plan=first,
                source_runtime=runtime_chain(first)[-1], target_runtime=self.target,
                server_id="fixture-server", seal=self.f.f.t.ref("seal-2.json", {"fixture_only": True}),
                binding=self.f.m.binding, snapshot=recovery.snapshot(first, *parts)))
            with patch.dict(os.environ, ORCA_TERMINAL_HANDLE="preparer"):
                with self.assertRaisesRegex(ValueError, "explicit_entry_required"):
                    recovery.prepare(first, str(self.f.output), call=self.call)
            self.f.output = self.f.m.root / "recovery-second"
            self.f.output.mkdir(mode=0o700)
            self.approve()
            self.f.delivery = dict(runId="run_test", deliveryId="cycle-two", count=1,
                messages=[copy.deepcopy(self.f.m.messages[-1])])
            self.f.acked = False
            self.f.f.observer_mock.return_value["observed_at"] = now()
            self.assertTrue(cross.begin(self.permit, call=self.query)["execute_action"])
            self.assertFalse(cross.begin(self.permit, call=self.query)["execute_action"])
            checkpoint = self.f.f.record_ref
            action = self.f.f.record["checkpoint"]["next_action"]["id"]
            proof = self.f.f.t.ref("bootstrap/cycle-two-proof.json", {"actual": "second cycle fixture"})
            result = self.f.f.t.ref("bootstrap/cycle-two-result.json", dict(action_id=action,
                checkpoint=checkpoint, status="executed", evidence=[proof]))
            processed = self.f.f.t.ref("bootstrap/cycle-two-processed.json", dict(delivery_id="cycle-two",
                messages=[dict(id=self.f.m.messages[-1]["id"], evidence=[result])]))
            self.f.s.new_turn(("met", "actionable"), action_id="cycle-two-followup")
            next_ref = self.f.f.record_ref
            replace_json(Path(self.f.f.config["checkpoint_head"]), checkpoint)
            self.proof = cross.finish(self.permit, result, next_ref, processed,
                str(self.f.f.t.f.bootstrap / "cycle-two-workflow.json"), call=self.query)["receipt"]
            self.f.s.ended["completed_turn"].update(
                context_at=self.f.f.observer_mock.return_value["observed_at"], completed_at=now())
            second = self.complete()
            self.assertEqual(self.complete(), second)
            self.assertEqual(runtime_chain(second), [self.source, self.source + "-successor", self.target])
            self.assertEqual(read_json(second["path"])["config"], self.f.d.plan["config"])
            self.assertEqual(len(self.f.mutations), 4)
            self.assertTrue(self.f.acked)
            self.assertEqual(file_ref(initial["path"]), initial)
            self.assertEqual(file_ref(first["path"]), first)
            self.assertTrue(stopped.exists())
            self.assertEqual(self.execute(second), 0)
            self.assertEqual(self.execute(second), 0)
            self.assertEqual(len(self.f.m.messages), 3)
            self.assertEqual(len(self.f.mutations), 4)

    def test_new_manual_stop_blocks_following_action_even_after_complete(self):
        with patch.object(route, "server_boundary", side_effect=self.server):
            self.reconciled()
            plan = self.complete()
            publish_new(self.f.m.state_root / "STOP", b"stop after recovery")
            with self.assertRaisesRegex(ValueError, "persistent_stop"):
                cross.continue_begin(plan, call=self.query)
        self.assertEqual(len(self.f.mutations), 2)

    def test_review_rejected_and_state_drift_do_not_consume(self):
        with patch.object(route, "server_boundary", side_effect=self.server):
            self.prepare()
            value = read_json(self.review["path"])
            rejected = self.f.f.t.ref("rejected.json", {**value, "approved": False})
            with self.assertRaises(ValueError):
                cross.apply(self.proposal, rejected, call=self.call)
            self.assertFalse((self.f.output / "reviewed.json").exists())
            self.permit = cross.apply(self.proposal, self.review, call=self.call)
            publish_new(self.f.m.state_root / "STOP", b"stop")
            with self.assertRaisesRegex(ValueError, "state_changed"):
                cross.begin(self.permit, call=self.query)
        self.assertEqual(self.f.mutations, [])

    def test_publication_crash_retry_does_not_replay(self):
        with patch.object(route, "server_boundary", side_effect=self.server):
            self.reconciled()
            publish = recovery.publish_new
            def crash(target, value):
                publish(target, value)
                if target.name == "committed.json":
                    raise RuntimeError("crash")
            with patch.object(recovery, "publish_new", side_effect=crash):
                with self.assertRaisesRegex(RuntimeError, "crash"):
                    self.complete()
            self.assertFalse((self.f.output / "deployment.json").exists())
            deploy.validate(self.complete())
        self.assertEqual(len(self.f.mutations), 2)

    def test_wrong_server_ack_and_changed_transition_stop(self):
        with patch.object(route, "server_boundary", return_value={"verified": True}):
            with self.assertRaisesRegex(ValueError, "boundary_unconfirmed"):
                self.prepare()
        with patch.object(route, "server_boundary", side_effect=self.server):
            self.approve()
            value = read_json(self.transition["path"])
            replace_json(Path(self.transition["path"]), {**value, "target_runtime": "other"})
            with self.assertRaisesRegex(ValueError, "file_pin_changed"):
                cross.begin(self.permit, call=self.query)
        self.assertEqual(self.f.mutations, [])

    def test_failed_scope_does_not_leak_runtime_or_deployment(self):
        with patch.object(route, "server_boundary", side_effect=self.server):
            with self.assertRaisesRegex(RuntimeError, "interrupted"):
                with route.scope(self.transition, "run", dict(plan=self.f.d.ref)):
                    self.assertEqual(route.runtime(self.source), self.target)
                    self.assertEqual(route.continuation_plan(), self.f.d.ref)
                    raise RuntimeError("interrupted")
        self.assertEqual(route.runtime(self.source), self.source)
        self.assertIsNone(route.continuation_plan())

    def test_server_refusal_after_review_does_not_consume(self):
        with patch.object(route, "server_boundary", side_effect=self.server):
            self.approve()
        before = recovery.inventory(original(self.f.d.ref)[-1])
        with patch.object(route, "server_boundary", side_effect=ValueError("server_fenced")):
            with self.assertRaisesRegex(ValueError, "server_fenced"):
                cross.begin(self.permit, call=self.query)
        self.assertEqual(before, recovery.inventory(original(self.f.d.ref)[-1]))
        self.assertEqual(self.f.mutations, [])
        self.assertEqual(route.runtime(self.source), self.source)


if __name__ == "__main__":
    unittest.main()

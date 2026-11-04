"""Isolated lifecycle/real-validator regression; native replies/turns are fixtures.

No live CLI, Agent, Run, shell sender, service, or domain action is started.
"""

import copy
from contextlib import redirect_stdout
from datetime import timedelta
import io
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

from coordinator_io import (bound_lock, canonical, digest, file_ref, now, parse, pinned, publish_new,
                            read_json, replace_json, timestamp)
from coordinator_tui_prepare import prepare as prepare_continuation
from coordinator_tui_turn_end import turn_end
import operator_monitor as monitor
import operator_monitor_deploy as deploy
import operator_readiness as readiness
import operator_startup as startup
import test_coordinator_tui_scheduler as scheduler
import test_coordinator_tui_workflow as workflows


class StartupTests(unittest.TestCase):
    def setUp(self):
        self.s = scheduler.SchedulerTests()
        self.s.setUp()
        self.addCleanup(self.s.doCleanups)
        self.f, self.m = self.s.f, self.s.m
        self.base = self.f.t.f.bootstrap
        self.base.chmod(0o700)
        self.strict_dir = self.base / "strict-start"
        self.strict_dir.mkdir(mode=0o700)
        self.output = self.base / "startup-plan"
        self.output.mkdir(mode=0o700)
        session = copy.deepcopy(self.f.c)
        session["run"] = None
        self.start = dict(schema_version=1, contract=self.f.t.ref("bootstrap/session.json", session),
                          caller_receipt=session["observation"]["caller_receipt"],
                          readiness_evidence=[session["skill_read_evidence"]], directory=str(self.strict_dir),
                          objective="approved task", max_workers=2,
                          request_id="11111111-2222-4333-8444-555555555555",
                          deadline=(timestamp(now()) + timedelta(minutes=5)).isoformat())
        self.inputs = dict(schema_version=1, strict_start=self.f.t.ref("bootstrap/strict.json", self.start),
                           continuation_publication=str(self.base / "initialized" / "continuation-ref.json"),
                           sender=self.m.sender, poll_seconds=1,
                           bootstrap_deadline=(timestamp(now()) + timedelta(minutes=10)).isoformat())
        for key in ("state_root", "monitor_state_root", "deployment_dir"):
            target = self.base / ("startup-" + key)
            target.mkdir(mode=0o700)
            self.inputs[key] = str(target)
        # Historical v1 fixture: new prepare intentionally refuses v1 inputs.
        publish_new(self.output / "lifecycle.json", dict(self.inputs, sources=deploy.sources(),
                    python=str(Path(sys.executable).resolve())))
        self.ref = file_ref(self.output / "lifecycle.json")
        self.plan = parse(pinned(self.ref))
        self.root = Path(self.plan["state_root"])
        # Every native boundary fails the test on an unrecognized verb.
        native = patch.object(monitor, "native", side_effect=self.m.fake)
        native.start()
        self.addCleanup(native.stop)

    def create_receipt(self):
        contract = parse(pinned(self.start["contract"]))
        gate = self.f.t.ref("bootstrap/session-gate.json", dict(ok=True, phase="session", actor="operator",
            schema_version=2, kind=startup.KIND, binding=startup.identity(contract),
            identity_sha256=digest(canonical(startup.identity(contract))), started_at=now(), completed_at=now(),
            valid_until=(timestamp(now()) + timedelta(seconds=180)).isoformat(),
            contract_sha256=self.start["contract"]["sha256"]))
        run = {**self.m.run, "objective": self.start["objective"], "created_at": now()}
        publish_new(self.strict_dir / "create-intent.json", dict(config=self.inputs["strict_start"], gate=gate,
            request_id=self.start["request_id"]))
        publish_new(self.strict_dir / "create-response.json", dict(coordinatorPolicy="strict-v1", run=run))
        publish_new(self.strict_dir / "created.json", dict(ok=True, kind="strict_start_created", run=run,
            config_sha256=self.inputs["strict_start"]["sha256"], gate=gate, request_id=self.start["request_id"]))

    def initialize(self):
        self.init_inputs = {k: self.f.config[k] for k in ("contract", "dispatch_gate", "acceptance", "deadline", "scheduler")}
        self.init_inputs.update(schema_version=1, startup_lifecycle=self.ref,
            output_dir=str(Path(self.inputs["continuation_publication"]).parent),
            **{k: self.f.record["domain_check"][k] for k in ("source", "receipt")})
        with patch.dict(os.environ, ORCA_TERMINAL_HANDLE="term_test"):
            result = prepare_continuation(self.f.t.ref("bootstrap/init-inputs.json", self.init_inputs), call=self.f.query)
        self.f.config_ref = result["config"]
        self.f.config, _, self.f.state = readiness.load(result["config"])
        self.f.record_ref = result["checkpoint"]
        self.m.data["continuation"] = result["config"]
        self.m.config = self.m.configure()
        return result

    def execute(self, *, on_tick=None, schedule=None, once=True):
        original, replace = monitor.tick, startup.replace_json
        def save(target, value):
            replace(target, value)
            if target == self.root / "state.json" and value["current"].get("monitor") and on_tick:
                on_tick(copy.deepcopy(value))
        with patch.object(monitor, "tick", side_effect=lambda c: original(c, call=self.m.fake)), \
                patch("coordinator_tui_scheduler.schedule", side_effect=schedule or (lambda *_: self.s.tick())), \
                patch.object(startup, "replace_json", side_effect=save), redirect_stdout(io.StringIO()):
            return startup.run(self.ref, once=once, call=self.m.fake)

    def state(self):
        return read_json(self.root / "state.json")

    def audit(self):
        def query(cli, runtime, args):
            if args[:2] == ["orchestration", "check"]:
                return dict(runId="run_test", count=0, messages=[], hasOutstandingDelivery=False)
            if args[:2] == ["terminal", "show"] and args[-1] == self.m.sender["terminal"]:
                return self.m.fake(args, runtime)
            return self.f.query(cli, runtime, args)
        with patch.dict(os.environ, ORCA_TERMINAL_HANDLE="term_test"):
            return turn_end(self.f.config_ref, call=query)

    def test_static_prepare_and_check_have_no_native_calls_or_monitor_state(self):
        self.assertEqual(self.m.calls, [])
        self.assertEqual(list(self.root.iterdir()), [])
        self.assertEqual(list(Path(self.inputs["monitor_state_root"]).iterdir()), [])
        with redirect_stdout(io.StringIO()):
            args = ["--plan", self.ref["path"], "--plan-sha256", self.ref["sha256"]]
            self.assertEqual(startup.main(["check", *args]), 0)
            self.assertEqual(startup.main(["run", *args]), 2)
        self.assertEqual(self.m.calls, [])

    def test_waits_for_fixed_publications_without_creating_or_prompting(self):
        self.assertEqual(self.execute()["state"], "awaiting_run_created")
        self.create_receipt()
        self.assertEqual(self.execute()["state"], "awaiting_continuation")
        self.assertEqual(set(self.state()["milestones"]), {"run_created"})
        self.assertFalse(any(c[:2] in (["orchestration", "run-create"], ["orchestration", "send"],
                                      ["terminal", "send"]) for c in self.m.calls))

    def test_actual_executor_reaches_first_tick_then_exit_degrades_not_milestone(self):
        self.create_receipt()
        self.initialize()
        snapshots = []
        self.assertEqual(self.execute(on_tick=snapshots.append)["state"], "monitor_exited")
        self.assertTrue(snapshots[0]["current"]["monitor_ready"])
        self.assertFalse(snapshots[0]["current"]["autonomy_verified"])
        state = self.state()
        self.assertEqual(set(state["milestones"]), {"run_created", "continuation_ready", "monitor_ready"})
        self.assertFalse(state["current"]["monitor_ready"])
        self.assertFalse(startup.status(self.ref, call=self.m.fake)["monitor_ready"])
        self.assertEqual(len(self.m.messages), 1)
        self.assertEqual(self.execute()["state"], "monitor_exited")
        self.assertEqual(len(self.m.messages), 1)
        self.assertEqual(len(self.state()["attempts"]), 2)

    def test_bootstrap_turn_end_requires_monitor_but_not_completed_turn(self):
        self.create_receipt()
        self.initialize()
        before = self.audit()
        self.assertFalse(before["ok"])
        self.assertEqual(before["state"], "autonomy_not_ready")
        seen = []
        self.execute(schedule=lambda *_: {"state": "awaiting_real_turn_end"}, on_tick=lambda _: seen.append(self.audit()))
        self.assertTrue(seen[0]["ok"])
        self.assertTrue(seen[0]["readiness"]["bootstrap"])
        self.assertFalse(seen[0]["readiness"]["autonomy_verified"])
        self.assertEqual(self.m.messages, [])

    def test_scheduler_review_inside_monitoring_and_interaction_are_not_ready(self):
        self.create_receipt()
        self.initialize()
        for state in ("review_required", "interaction_required", "reobserving", "unknown"):
            seen = []
            self.execute(schedule=lambda *_: {"state": state}, on_tick=seen.append)
            self.assertFalse(seen[0]["current"]["monitor_ready"])
            self.assertEqual(seen[0]["current"]["monitor"]["state"], "monitor_runtime_observed")
        self.assertNotIn("monitor_ready", self.state()["milestones"])

    def test_unknown_launch_is_not_replayed(self):
        self.create_receipt()
        self.initialize()
        with patch.object(deploy, "run", side_effect=TimeoutError("simulated unknown outcome")) as start:
            self.assertEqual(self.execute()["state"], "review_required")
            again = self.execute()
        self.assertEqual(start.call_count, 1)
        self.assertIn("startup_launch_requires_reconciliation", again["missing"])
        self.assertEqual(len(self.state()["attempts"]), 1)

    def test_partial_prepare_reconciles_exact_same_config_and_directories(self):
        self.create_receipt()
        self.initialize()
        publish = deploy.publish_new
        def interrupted(target, value):
            if target.name == "deployment.json":
                raise OSError("interrupted after monitor config")
            publish(target, value)
        with patch.object(deploy, "publish_new", side_effect=interrupted):
            self.assertEqual(self.execute()["state"], "review_required")
        config = file_ref(Path(self.inputs["deployment_dir"]) / "monitor.json")
        self.assertEqual(self.state()["attempts"], [])
        self.assertEqual(self.execute()["state"], "monitor_exited")
        self.assertEqual(config, file_ref(config["path"]))
        self.assertEqual(len(self.m.messages), 1)

    def test_completed_prepare_before_state_write_reconciles_not_reprepares(self):
        self.create_receipt()
        self.initialize()
        prepare = deploy.prepare
        def interrupted(*args, **kwargs):
            prepare(*args, **kwargs)
            raise OSError("crash after final publication")
        with patch.object(deploy, "prepare", side_effect=interrupted):
            self.assertEqual(self.execute()["state"], "review_required")
        plan = file_ref(Path(self.inputs["deployment_dir"]) / "deployment.json")
        self.assertEqual(self.execute()["state"], "monitor_exited")
        self.assertEqual(self.state()["deployment"], plan)

    def test_changed_partial_config_is_never_overwritten(self):
        self.create_receipt()
        self.initialize()
        self.execute()
        state = self.state()
        # Fault fixture: persisted pre-launch intent plus unrecognized partial config.
        state.update(deployment=None, attempts=[], prepare_intent=True)
        replace_json(self.root / "state.json", state)
        target = Path(self.inputs["deployment_dir"]) / "monitor.json"
        data = read_json(target)
        data["poll_seconds"] += 1
        replace_json(target, data)
        before = file_ref(target)
        result = self.execute()
        self.assertIn("monitor_prepare_partial_config_changed", result["missing"])
        self.assertEqual(file_ref(target), before)

    def test_stop_is_preserved_and_no_second_launch(self):
        self.create_receipt()
        self.initialize()
        self.execute()
        stop = Path(self.inputs["monitor_state_root"]) / "STOP"
        publish_new(stop, b"review required")
        before = file_ref(stop)
        with patch.object(deploy, "run") as start:
            self.assertIn("startup_persistent_stop", self.execute()["missing"])
        start.assert_not_called()
        self.assertEqual(file_ref(stop), before)
        self.assertFalse(startup.status(self.ref, call=self.m.fake)["monitor_ready"])

    def test_run_generation_change_stops_before_deploy(self):
        self.create_receipt()
        self.initialize()
        self.m.run["consumer_generation"] += 1
        self.assertIn("startup_run_binding_changed", self.execute()["missing"])
        self.assertFalse((Path(self.inputs["deployment_dir"]) / "monitor.json").exists())

    def test_native_sender_required_no_identity_synthesis(self):
        with patch.dict(os.environ, {"ORCA_TERMINAL_HANDLE": "someone-else"}, clear=True):
            with self.assertRaisesRegex(ValueError, "requires_own_operator_terminal"):
                self.execute()
        self.assertFalse((self.root / "state.json").exists())

    def test_second_lifecycle_cannot_start_while_original_lock_held(self):
        with bound_lock(self.root, self.ref, "operator-startup"):
            with self.assertRaises(BlockingIOError):
                self.execute()
        self.assertFalse((self.root / "state.json").exists())

    def test_custom_checkpoint_rejected_without_deployment(self):
        self.create_receipt()
        self.initialize()
        custom = self.f.t.ref("bootstrap/custom.json", dict(schema_version=1, kind="strict_live11_run_phase_checkpoint"))
        replace_json(Path(self.f.config["checkpoint_head"]), custom)
        self.assertEqual(self.execute()["state"], "review_required")
        self.assertFalse((Path(self.inputs["deployment_dir"]) / "monitor.json").exists())

    def test_persisted_scheduler_review_not_hidden_by_healthy_outer_status(self):
        self.create_receipt()
        self.initialize()
        self.execute(schedule=lambda *_: {"state": "awaiting_real_turn_end"})
        stop = dict(state="review_required", route="alternatives_review", checkpoint=self.f.record_ref,
                    business_acceptance="not_evaluated")
        replace_json(self.f.state / "scheduler.json", dict(config=self.f.config_ref, stop=stop, waits={}, turns={}))
        before = file_ref(self.f.state / "scheduler.json")
        self.assertIn("startup_checkpoint_requires_review", self.execute()["missing"])
        self.assertEqual(file_ref(self.f.state / "scheduler.json"), before)

    def test_formal_blocked_checkpoint_requires_review_without_launch(self):
        self.create_receipt()
        self.s.new_turn(("blocked", "blocked"))
        self.initialize()
        checked = readiness.continuation(self.f.config_ref)
        self.assertTrue(checked["continuation_ready"])
        self.assertFalse(checked["eligible"])
        with patch.object(deploy, "run") as launch:
            self.assertIn("startup_checkpoint_requires_review", self.execute()["missing"])
        launch.assert_not_called()
        self.assertEqual(self.m.messages, [])

    def test_terminal_audits_do_not_require_monitor_restart_or_claim_autonomy(self):
        self.create_receipt()
        self.initialize()
        for statuses in (("blocked", "blocked"), ("met", "met")):
            self.s.new_turn(statuses)
            replace_json(Path(self.f.config["checkpoint_head"]), self.f.record_ref)
            result = self.audit()
            self.assertTrue(result["ok"])
            self.assertIn(result["decision"], ("blocked", "complete"))
            self.assertFalse(result["readiness"]["autonomous_wait_ready"])
            self.assertFalse(result["readiness"]["autonomy_verified"])

    def test_two_opted_in_workflow_cycles_settle_ack_publish_and_deduplicate(self):
        self.create_receipt()
        self.initialize()
        original_config, completed = self.f.config_ref.copy(), []
        for index, statuses in enumerate((("met", "actionable"), ("met", "met"))):
            def consume_and_finish(_):
                w = workflows.WorkflowTests()
                w.init_workflow(self.s)
                workflow_query = w.query
                w.query = lambda cli, runtime, args: (self.m.fake(args, runtime)
                    if args[:2] == ["terminal", "show"] and args[-1] == self.m.sender["terminal"]
                    else workflow_query(cli, runtime, args))
                try:
                    w.delivery["deliveryId"] = "delivery-" + str(index)
                    self.assertTrue(w.begin()["execute_action"])
                    self.assertFalse(w.begin()["execute_action"])
                    proof = self.f.t.ref(f"bootstrap/proof-cycle-{index}.json", {"fixture_action": index})
                    w.result = self.f.t.ref(f"bootstrap/result-cycle-{index}.json", dict(
                        action_id=w.action_id, checkpoint=w.old, status="executed", evidence=[proof]))
                    w.processed = self.f.t.ref(f"bootstrap/processed-cycle-{index}.json", dict(
                        delivery_id=w.delivery["deliveryId"], messages=[
                            {"id": w.delivery["messages"][0]["id"], "evidence": [w.result]},
                            {"id": "fact-extra", "evidence": [proof]}]))
                    self.s.new_turn(statuses)
                    w.next_ref = self.f.record_ref
                    replace_json(Path(self.f.config["checkpoint_head"]), w.old)
                    w.receipt_path = self.base / f"completed-cycle-{index}.json"
                    result = w.finish()
                    self.assertTrue(result["ok"], result)
                    self.assertEqual(w.finish(), result)
                    self.assertTrue(w.acked)
                    self.assertEqual(len(w.mutations), 2)
                    completed.append(read_json(w.receipt_path))
                finally:
                    w.doCleanups()
            self.assertEqual(self.execute(on_tick=consume_and_finish)["state"], "monitor_exited")
        self.assertEqual(self.f.config_ref, original_config)
        self.assertEqual(len(self.m.messages), 2)
        self.assertEqual(len(completed), 2)
        self.assertEqual(completed[-1]["turn_end"]["decision"], "complete")
        self.assertFalse(completed[-1]["turn_end"]["readiness"]["autonomy_verified"])
        self.assertIn("startup_checkpoint_requires_review", self.execute()["missing"])
        self.assertEqual(len(self.m.messages), 2)

    def test_one_executor_observes_later_creation_and_publication(self):
        run_monitor = deploy.run
        publications = iter((self.create_receipt, self.initialize))
        with patch.object(startup.time, "sleep", side_effect=lambda _: next(publications)()) as sleep, \
                patch.object(deploy, "run", side_effect=lambda ref, **kw:
                             run_monitor(ref, once=True, observer=kw["observer"])) as launch:
            self.assertEqual(self.execute(once=False)["state"], "monitor_exited")
        self.assertEqual(sleep.call_count, 2)
        self.assertEqual(launch.call_count, 1)
        self.assertFalse(launch.call_args.kwargs["once"])

    def test_status_is_readonly_before_and_after_deployment(self):
        def files():
            return {str(p): file_ref(p) for p in self.base.rglob("*") if p.is_file()}
        before = files()
        self.assertEqual(startup.status(self.ref, call=self.m.fake)["state"], "bootstrap")
        self.assertEqual(files(), before)
        self.create_receipt()
        self.initialize()
        self.execute()
        before = files()
        self.assertFalse(startup.status(self.ref, call=self.m.fake)["monitor_ready"])
        self.assertEqual(files(), before)

    def test_changed_historical_creation_pin_not_accepted_by_status(self):
        self.create_receipt()
        self.initialize()
        self.execute()
        value = read_json(self.strict_dir / "created.json")
        replace_json(self.strict_dir / "created.json", dict(value, extra="changed"))
        self.assertEqual(startup.status(self.ref, call=self.m.fake)["state"], "review_required")

    def test_changed_deployment_is_not_adopted_by_turn_end(self):
        self.create_receipt()
        self.initialize()
        def inspect(_):
            state = self.state()
            state["deployment"] = {**state["deployment"], "sha256": "0" * 64}
            replace_json(self.root / "state.json", state)
            result = self.audit()
            self.assertFalse(result["ok"])
            self.assertEqual(result["error"], "readiness_lifecycle_deployment_changed")
        self.execute(schedule=lambda *_: {"state": "awaiting_real_turn_end"}, on_tick=inspect)

    def test_checkpoint_and_context_races_during_readiness_are_rejected(self):
        self.create_receipt()
        self.initialize()
        original = readiness.for_continuation
        for change in ("head", "journal", "context"):
            self.f.observer_mock.return_value["observed_at"] = now()
            self.s.new_turn()
            replace_json(Path(self.f.config["checkpoint_head"]), self.f.record_ref)
            def racing(*args, **kwargs):
                result = original(*args, **kwargs)
                if change == "head":
                    self.s.new_turn()
                    replace_json(Path(self.f.config["checkpoint_head"]), self.f.record_ref)
                elif change == "journal":
                    replace_json(self.f.state / "scheduler.json", dict(
                        config=self.f.config_ref, stop=None, waits={}, turns={}))
                else:
                    self.f.observer_mock.return_value["observed_at"] = now()
                return result
            with self.subTest(change=change), patch.object(readiness, "for_continuation", side_effect=racing):
                with self.assertRaisesRegex(ValueError, "tui_turn_end_(state|context)_changed"):
                    self.audit()

    def test_readiness_adapter_caps_timeout_and_expiry_skips_final_fence(self):
        import observation_budget as budget
        from types import SimpleNamespace
        self.create_receipt()
        self.initialize()
        tick = [100.0]
        def expired(ref, *, call):
            def inspect_timeout(cli, runtime, args):
                self.assertEqual(budget.timeout(15), 2)
                tick[0] += 61
                return {}
            with patch.object(self.f, "query", side_effect=inspect_timeout):
                return call(["status"], "runtime_test", 2)
        from coordinator_tui_continue import check_with_runtime
        with patch.object(budget, "time", SimpleNamespace(monotonic=lambda: tick[0])), \
                patch.object(readiness, "for_continuation", side_effect=expired), \
                patch("coordinator_tui_turn_end.check_with_runtime", wraps=check_with_runtime) as fence:
            with self.assertRaises(budget.ObservationTimeout):
                self.audit()
            self.assertEqual(fence.call_count, 1)
        self.assertFalse(budget.active())

    def test_changed_head_during_live_verify_cannot_report_ready(self):
        self.create_receipt()
        self.initialize()
        self.execute()
        def racing(*args, **kwargs):
            self.s.new_turn()
            replace_json(Path(self.f.config["checkpoint_head"]), self.f.record_ref)
            return {"scheduler_readiness": readiness.scheduler_health({"state": "awaiting_real_turn_end"})}
        with patch.object(deploy, "verify", side_effect=racing):
            result = readiness.check(self.f.config_ref, self.state()["deployment"], call=self.m.fake)
        self.assertFalse(result["monitor_ready"])
        self.assertEqual(result["reason"], "readiness_continuation_changed_during_observation")

    def test_expired_bootstrap_never_launches_or_extends_deadline(self):
        self.create_receipt()
        self.initialize()
        expired = (timestamp(self.inputs["bootstrap_deadline"]) + timedelta(seconds=1)).isoformat()
        before = file_ref(self.ref["path"])
        with patch.object(startup, "now", return_value=expired), patch.object(deploy, "run") as launch:
            self.assertIn("startup_publication_deadline_expired", self.execute()["missing"])
        launch.assert_not_called()
        self.assertEqual(file_ref(self.ref["path"]), before)

    def test_invalid_rsi_receipt_hash_never_deploys(self):
        self.create_receipt()
        self.initialize()
        record = parse(pinned(self.f.record_ref))
        receipt = Path(record["domain_check"]["receipt"]["path"])
        replace_json(receipt, dict(read_json(receipt), changed=True))
        self.assertIn("file_pin_changed", self.execute()["missing"])
        self.assertEqual(self.m.messages, [])

    def test_deadline_expiring_during_prepare_stops_before_launch_intent(self):
        self.create_receipt()
        self.initialize()
        prepare, clock = deploy.prepare, [now()]
        def preflight(*args, **kwargs):
            plan = prepare(*args, **kwargs)
            clock[0] = (timestamp(self.inputs["bootstrap_deadline"]) + timedelta(seconds=1)).isoformat()
            return plan
        with patch.object(startup, "now", side_effect=lambda: clock[0]), \
                patch.object(deploy, "prepare", side_effect=preflight), patch.object(deploy, "run") as launch:
            self.assertIn("startup_publication_deadline_expired", self.execute()["missing"])
        launch.assert_not_called()
        self.assertEqual(self.state()["attempts"], [])
        self.assertFalse(list(self.root.glob("launch-intent-*.json")))

    def test_failed_monitor_exit_reports_failure_and_is_not_restarted(self):
        self.create_receipt()
        self.initialize()
        def fail(*_):
            raise ValueError("fixture_scheduler_failure")
        result = self.execute(schedule=fail)
        self.assertFalse(result["ok"])
        self.assertEqual(result["state"], "review_required")
        self.assertEqual(result["returncode"], 2)
        self.assertEqual(self.state()["attempts"][0]["returncode"], 2)
        with patch.object(deploy, "run") as launch:
            self.assertEqual(self.execute()["state"], "review_required")
        launch.assert_not_called()

    def test_disappeared_deployment_reports_loss_not_fresh_bootstrap(self):
        self.create_receipt()
        self.initialize()
        self.execute()
        target = Path(self.state()["deployment"]["path"])
        target.rename(target.with_suffix(".saved"))
        status = startup.status(self.ref, call=self.m.fake)
        self.assertFalse(status["monitor_ready"])
        self.assertEqual(status["state"], "not_ready")
        self.assertEqual(status["reason"], "readiness_evidence_missing")

    def test_lifecycle_sender_and_path_cannot_be_changed_in_continuation(self):
        self.create_receipt()
        self.initialize()
        for change in ({"scheduler": {**self.m.sender, "terminal": "other"}},
                       {"state_root": self.inputs["state_root"]},
                       {"startup_lifecycle": {**self.ref, "sha256": "0" * 64}}):
            ref = self.f.t.ref("bootstrap/wrong-continuation.json", {**self.f.config, **change})
            with self.subTest(change=change), self.assertRaises(ValueError):
                readiness.continuation(ref)

    def test_malformed_persistent_state_is_rejected_without_overwrite(self):
        state = startup.read_state(self.plan, self.ref)
        for change in ({"attempts": [1]}, {"milestones": {"monitor_ready": False}},
                       {"schema_version": True}, {"prepare_intent": "yes"}):
            replace_json(self.root / "state.json", {**state, **change})
            before = file_ref(self.root / "state.json")
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, "startup_state_binding_changed"):
                startup.read_state(self.plan, self.ref)
            self.assertEqual(file_ref(self.root / "state.json"), before)

    def test_source_change_denies_resume_and_never_repins(self):
        with patch.object(deploy, "sources", return_value=[]):
            with self.assertRaisesRegex(ValueError, "startup_source_changed"):
                self.execute()


if __name__ == "__main__":
    unittest.main()

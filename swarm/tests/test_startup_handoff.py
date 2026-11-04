"""Production lifecycle/action/gate/dispatch/prepare chain; native/provider fakes.

No real Agent, Run, Worker, send or service. Domain checker fixtures do not claim
business acceptance. Historical setup is reused only for filesystem/native data.
"""

import copy
from contextlib import redirect_stdout
from datetime import timedelta
import os
import io
import time
from pathlib import Path
import unittest
from unittest.mock import patch

from coordinator_io import file_ref, now, parse, pinned, publish_new, read_json, replace_json, timestamp
import coordinator_first_dispatch as first
import coordinator_tui_continue as continuation
import operator_monitor as monitor
import operator_startup as startup
import startup_handoff as handoff
import startup_execution as execution
import coordinator_tui_scheduler as scheduling
from coordinator_tui_turn_end import turn_end
from terminal_idle_wait import IdleWaitResult
from coordinator_worker_profiles import PROFILES
import test_operator_startup as legacy


class HandoffTests(unittest.TestCase):
    def setUp(self):
        self.old = legacy.StartupTests()
        self.old.setUp()
        self.addCleanup(self.old.doCleanups)
        self.f, self.m = self.old.f, self.old.m
        self.base = self.old.base
        self.inputs = dict(self.old.inputs, schema_version=2, bootstrap_owner=None, workers="required",
                           execution={"mode": "autonomous", "trigger": None},
                           runtime=dict(schema_version=1, deadline=self.f.config["deadline"],
                                        authority=[self.f.c["handoff"]]))
        self.output = self.base / "lifecycle"
        self.output.mkdir(mode=0o700)
        self.dispatches = []
        session = patch("operator_session.observe_identity", return_value={"trust": "fixture"})
        session.start()
        self.addCleanup(session.stop)
        native = patch("coordinator_startup.native", side_effect=self.gate_query)
        native.start()
        self.addCleanup(native.stop)

    def configure(self, mode="autonomous", workers="required", actual_create=False):
        self.inputs["workers"] = workers
        self.inputs["execution"] = {"mode": mode, "trigger": None}
        if mode == "native-event":
            self.inputs["execution"]["trigger"] = {"source": "worker_done", "readiness": str(Path(self.inputs["state_root"]) / "trigger-ready.json")}
        self.ref = startup.prepare(self.f.t.ref("bootstrap/new-inputs.json", self.inputs), str(self.output))
        self.plan, _, _, _ = startup.load(self.ref)
        self.root = Path(self.plan["state_root"])
        self.old.inputs["strict_start"] = self.plan["strict_start"]
        if actual_create:
            self.create_actual()
        else:
            self.old.create_receipt()
        self.created = read_json(self.old.strict_dir / "created.json")["run"]
        self.m.run.update(created_at=self.created["created_at"])
        self.materials = dict(contract=self.f.contract_ref, reason="approved isolated task",
                              authority=[self.f.c["handoff"]], worker=None)
        if workers == "required":
            self.materials["worker"] = dict(schema_version=2, cli=self.f.c["cli"]["path"], run="run_test",
                task="task_test", model="gpt-5.5", timeout_ms=1000, profiles_sha256=file_ref(PROFILES)["sha256"],
                placement=dict(kind="existing", worktree="id:workspace_test"))

    def create_actual(self):
        import coordinator_strict_start as strict
        import coordinator_strict as strict_check
        created = False
        self.creates = []
        def native(cli, runtime, args):
            nonlocal created
            if args[:2] == ["orchestration", "run-current"] and not created:
                return {"run": None}
            if args[:2] == ["orchestration", "run-create"]:
                self.creates.append(args)
                created = True
                self.m.run.update(objective=self.old.start["objective"], created_at=now())
                return dict(run=copy.deepcopy(self.m.run), coordinatorPolicy="strict-v1")
            return self.gate_query(cli, runtime, args)
        def sleep(seconds):
            if not (self.old.strict_dir / "gate-ready.json").exists():
                with patch.dict(os.environ, ORCA_TERMINAL_HANDLE="term_operator"):
                    strict.publish(self.plan["strict_start"], file_ref(self.old.strict_dir / "ready.json"))
            time.sleep(seconds)
        with patch.dict(os.environ, ORCA_TERMINAL_HANDLE="term_test"), \
                patch.object(strict, "native", side_effect=native), \
                patch.object(strict_check, "native", side_effect=native), \
                patch.object(strict, "time", wraps=time) as clock:
            clock.sleep.side_effect = sleep
            result = strict.wait_and_create(self.plan["strict_start"])
        self.assertEqual(result["lifecycle"], self.ref)
        self.assertFalse(result["runtime_ready"])
        self.assertIn("pull_argv", result["handoff"])

    def gate_query(self, cli, runtime, args):
        if args[:2] == ["terminal", "wait"]:
            return IdleWaitResult("pending", "tui_idle_timeout")
        if args == ["status"]:
            return {"runtime": {"appVersion": "1.4.219", "state": "ready"}}
        if args[:2] == ["terminal", "show"] and args[-1] == "term_operator":
            return {"terminal": {"handle": "term_operator", "incarnationId": "inc_operator", "connected": True,
                                 "orphaned": False, "worktreeId": "workspace_operator"}}
        if args[:2] == ["orchestration", "check"]:
            return dict(runId="run_test" if "--run" in args else None, count=0, messages=[], hasOutstandingDelivery=False)
        if args[:2] in (["orchestration", "run-show"], ["orchestration", "run-current"]):
            return dict(run=copy.deepcopy(self.m.run), coordinatorPolicy="strict-v1")
        if args[:2] == ["orchestration", "worker-list"]:
            return dict(scope={"run": "run_test"}, workers=[], page={"total": 0, "hasMore": False})
        return self.f.query(cli, runtime, args)

    def query(self, args, runtime, timeout=20):
        return self.gate_query(self.f.c["cli"]["path"], runtime, args)

    def dispatch(self, cli, runtime, args, *, timeout_seconds):
        self.dispatches.append(args)
        return dict(state="ready", stage="input_accepted", runId="run_test", taskId="task_test", dispatchId="ctx_test",
                    mutation={"requestId": args[args.index("--retry-request") + 1]})

    def action(self, action, value=None):
        actor = handoff.ACTIONS[action]
        with patch.dict(os.environ, ORCA_TERMINAL_HANDLE=self.f.c[actor]["terminal"]):
            pending = handoff.task(self.ref, actor, call=self.query)
            self.assertEqual(pending["action"], action)
            handoff.accept(self.ref, actor, action, call=self.query)
            return handoff.complete(self.ref, actor, action,
                self.f.t.ref("bootstrap/input-" + action + ".json", value) if value is not None else None,
                call=self.query, dispatch_call=self.dispatch)

    def admitted(self):
        self.action("materials", self.materials)
        self.action("review", dict(materials=file_ref(self.root / "materials.json"), decision="approve", notes="independent fixture audit"))
        self.action("dispatch")
        return handoff.admission(self.ref, file_ref(self.root / "admission.json"))

    def initialize(self):
        admitted = self.admitted()
        self.old.s.new_turn()
        data = dict(schema_version=1, contract=admitted["contract"], dispatch_gate=admitted["dispatch_gate"],
                    acceptance=self.f.config["acceptance"], deadline=self.inputs["runtime"]["deadline"], scheduler=self.m.sender,
                    output_dir=str(Path(self.inputs["continuation_publication"]).parent),
                    **{k: self.f.record["domain_check"][k] for k in ("source", "receipt")})
        self.action("continuation", data)
        result = read_json(self.root / "continuation-receipt.json")
        self.config_ref = result["config"]
        self.config, self.contract, self.state = continuation.load(self.config_ref)
        return result

    def test_invalid_continuation_acceptance_fails_before_the_execution_fence(self):
        # A continuation input whose acceptance is the full RSI contract (instead of
        # exactly {"requirements": [...]}) must be refused before the lifecycle action
        # writes its executing marker, otherwise inspect() can only report
        # reconciliation_required for an attempt that never mutated anything.
        self.configure(mode="native-event")
        admitted = self.admitted()
        self.old.s.new_turn()
        data = dict(schema_version=1, contract=admitted["contract"], dispatch_gate=admitted["dispatch_gate"],
                    acceptance=self.f.config["contract"], deadline=self.inputs["runtime"]["deadline"],
                    scheduler=self.m.sender,
                    output_dir=str(Path(self.inputs["continuation_publication"]).parent),
                    **{k: self.f.record["domain_check"][k] for k in ("source", "receipt")})
        with self.assertRaisesRegex(ValueError, "tui_acceptance_invalid"):
            self.action("continuation", data)
        state = Path(self.inputs["state_root"])
        for name in ("continuation-executing.json", "continuation-inputs.json",
                     "continuation-complete.json", "continuation-receipt.json"):
            self.assertFalse((state / name).exists(), name)
        self.assertFalse((Path(self.inputs["continuation_publication"]).parent).exists(),
                         "continuation output directory must not be created")

    def review(self):
        self.action("materials", self.materials)
        self.action("review", dict(materials=file_ref(self.root / "materials.json"), decision="approve", notes="reviewed"))

    def monitor_query(self, args, runtime, timeout=20):
        if args[:2] in (["terminal", "show"], ["terminal", "list"],
                        ["orchestration", "task-list"], ["orchestration", "inbox"],
                        ["orchestration", "send"], ["orchestration", "request-show"]):
            return self.m.fake(args, runtime, timeout)
        return self.query(args, runtime, timeout)

    def audit(self):
        def query(cli, runtime, args):
            if args[:2] == ["terminal", "show"] and args[-1] == self.m.sender["terminal"]:
                return self.m.fake(args, runtime)
            return self.gate_query(cli, runtime, args)
        with patch.dict(os.environ, ORCA_TERMINAL_HANDLE="term_test"):
            return turn_end(self.config_ref, call=query)

    def execute_monitor(self):
        tick, schedule, save = monitor.tick, scheduling.schedule, startup.replace_json
        seen = []
        def persist(target, value):
            save(target, value)
            if target == self.root / "state.json" and value["current"].get("continuation_ready"):
                seen.append((copy.deepcopy(value), self.audit()))
        def no_completed_turn(*args):
            raise scheduling.WaitNotReady(IdleWaitResult("pending", "tui_idle_timeout"))
        with patch.object(monitor, "tick", side_effect=lambda config: tick(config, call=self.monitor_query)), \
                patch.object(scheduling, "schedule", side_effect=lambda *args: schedule(*args, observe_turn=no_completed_turn)), \
                patch.object(startup, "replace_json", side_effect=persist), redirect_stdout(io.StringIO()):
            result = startup.run(self.ref, once=True, call=self.monitor_query)
        return result, seen

    def trigger_candidate(self, source="worker_done", trigger_id="ctx_test"):
        until = (timestamp(now()) + timedelta(seconds=120)).isoformat()
        trigger = self.f.t.ref("bootstrap/trigger.json", dict(kind="native_event_trigger_preflight", ready=True,
            run=self.contract["run"], source=source, trigger_id=trigger_id, checked_at=now(), valid_until=until))
        return self.f.t.ref("bootstrap/trigger-review.json", dict(decision="ready", notes="independently reviewed",
            evidence=[self.f.c["handoff"]], trigger=trigger, valid_until=until))

    def test_new_prepare_refuses_old_schema_and_missing_mode(self):
        with self.assertRaisesRegex(ValueError, "startup_new_inputs_v2_required"):
            startup.prepare(self.f.t.ref("bootstrap/old-inputs.json", self.old.inputs), str(self.output))
        value = dict(self.inputs)
        del value["execution"]
        with self.assertRaisesRegex(ValueError, "startup_inputs_invalid"):
            startup.prepare(self.f.t.ref("bootstrap/missing-inputs.json", value), str(self.output))
        self.assertEqual(list(self.output.iterdir()), [])

    def test_trigger_template_is_read_only_and_not_an_approval(self):
        self.configure(mode="native-event")
        output = io.StringIO()
        with patch.object(startup, "load", wraps=startup.load), \
                patch.object(monitor, "native") as native, redirect_stdout(output):
            code = handoff.main(["trigger-template", "--plan", self.ref["path"],
                "--plan-sha256", self.ref["sha256"], "--actor", "operator"])
        self.assertEqual(code, 0)
        native.assert_not_called()
        result = parse(output.getvalue().encode())
        self.assertIsNone(result["candidate_template"]["decision"])
        self.assertFalse(result["execution_authorized"])
        bad = self.f.t.ref("bootstrap/unreviewed.json", result["candidate_template"])
        with self.assertRaisesRegex(ValueError, "startup_trigger_review_required"):
            execution.trigger_candidate(bad)
        self.assertFalse((self.root / "trigger-ready.json").exists())

    def test_raw_preflight_rejected_before_plan_or_owner_io_with_template(self):
        raw = self.f.t.ref("bootstrap/raw-preflight.json", dict(kind="native_event_trigger_preflight", ready=True))
        output = io.StringIO()
        with patch.object(startup, "load") as load, patch.object(handoff, "authority") as authority, \
                redirect_stdout(output):
            code = handoff.main(["trigger-ready", "--plan", "/unused", "--plan-sha256", "0" * 64,
                "--actor", "operator", "--input", raw["path"], "--input-sha256", raw["sha256"], "--execute"])
        self.assertEqual(code, 2)
        load.assert_not_called()
        authority.assert_not_called()
        result = parse(output.getvalue().encode())
        self.assertEqual(result["reason"], "startup_trigger_review_required")
        self.assertEqual(result["candidate_template"], execution.trigger_template())

    def test_trigger_template_deliberately_requires_operator_before_io(self):
        output = io.StringIO()
        with patch.object(startup, "load") as load, patch.object(monitor, "native") as native, \
                redirect_stdout(output):
            code = handoff.main(["trigger-template", "--plan", "/unused",
                "--plan-sha256", "0" * 64, "--actor", "coordinator"])
        self.assertEqual(code, 2)
        self.assertEqual(parse(output.getvalue().encode())["reason"], "startup_original_role_required")
        load.assert_not_called()
        native.assert_not_called()

    def test_cli_missing_or_irrelevant_arguments_fail_before_native_io(self):
        for mode, extra, reason in [
                ("trigger-ready", [], "startup_input_pin_required"),
                ("refresh-review", [], "startup_input_pin_required"),
                ("accept", [], "startup_action_required"),
                ("complete", ["--action", "materials"], "startup_input_pin_required"),
                ("pull", ["--action", "review"], "startup_unexpected_action"),
                ("complete", ["--action", "dispatch", "--input", "/unused", "--input-sha256", "0" * 64],
                 "startup_unexpected_input")]:
            with self.subTest(mode=mode, extra=extra), patch.object(handoff, "context") as context, \
                    redirect_stdout(io.StringIO()) as output:
                code = handoff.main([mode, "--plan", "/unused", "--plan-sha256", "0" * 64,
                                     "--actor", "operator", "--execute", *extra])
                self.assertEqual(code, 2)
                self.assertEqual(parse(output.getvalue().encode())["reason"], reason)
                context.assert_not_called()

    def test_generated_inspect_command_remains_accepted(self):
        self.configure()
        argv = handoff.commands(self.ref, "materials", "coordinator")["inspect_argv"]
        with patch.object(handoff, "inspect", return_value=dict(ok=True)) as inspect, \
                redirect_stdout(io.StringIO()):
            self.assertEqual(handoff.main(argv[3:]), 0)
        inspect.assert_called_once()

    def test_new_prepare_requires_independently_fixed_runtime_policy(self):
        value = dict(self.inputs)
        del value["runtime"]
        with self.assertRaisesRegex(ValueError, "startup_runtime_policy_required"):
            startup.prepare(self.f.t.ref("bootstrap/missing-runtime.json", value), str(self.output))
        self.assertEqual(list(self.output.iterdir()), [])

    def test_coordinator_cannot_widen_reviewed_runtime_deadline(self):
        self.configure()
        self.initialize()
        for deadline in (None, (timestamp(self.config["deadline"]) + timedelta(hours=1)).isoformat()):
            with self.subTest(deadline=deadline), self.assertRaisesRegex(ValueError, "startup_runtime_deadline_changed"):
                continuation.validate_config(dict(self.config, deadline=deadline))

    def test_expired_bootstrap_does_not_expire_established_runtime(self):
        self.configure(mode="manual", workers="not-applicable")
        self.initialize()
        expired = (timestamp(self.inputs["bootstrap_deadline"]) + timedelta(seconds=1)).isoformat()
        with patch("startup_handoff.now", return_value=expired), patch("operator_startup.now", return_value=expired):
            with patch.dict(os.environ, ORCA_TERMINAL_HANDLE="term_operator"):
                with self.assertRaisesRegex(ValueError, "startup_handoff_deadline_expired"):
                    handoff.context(self.ref, actor="operator", call=self.query)
            result, seen = self.execute_monitor()
        self.assertEqual(result["state"], "monitor_exited")
        self.assertTrue(seen)
        receipt = read_json(Path(self.inputs["monitor_state_root"]) / "deployment-status.json")
        self.assertEqual(receipt["acceptance"]["runtime"], self.inputs["runtime"])
        self.assertEqual(receipt["acceptance"]["run"], self.contract["run"])

    def test_explicit_reviewed_null_deadline_is_preserved(self):
        from startup_runtime import established
        self.inputs["runtime"]["deadline"] = None
        self.configure(mode="manual", workers="not-applicable")
        self.initialize()
        self.assertIsNone(self.config["deadline"])
        after = (timestamp(self.inputs["bootstrap_deadline"]) + timedelta(hours=1)).isoformat()
        with patch("startup_runtime.now", return_value=after), patch("coordinator_tui_continue.now", return_value=after):
            self.assertEqual(established(self.ref, self.config_ref)[0]["runtime"], self.inputs["runtime"])
        with self.assertRaisesRegex(ValueError, "startup_runtime_deadline_changed"):
            continuation.validate_config(dict(self.config, deadline=self.f.config["deadline"]))

    def test_runtime_deadline_closes_admission_despite_historical_first_tick(self):
        from startup_runtime import established
        self.configure(mode="manual", workers="not-applicable")
        self.initialize()
        self.execute_monitor()
        with patch("startup_runtime.now", return_value=self.config["deadline"]):
            with self.assertRaisesRegex(ValueError, "startup_runtime_deadline_expired"):
                established(self.ref, self.config_ref)
        self.assertEqual(self.m.messages, [])

    def test_native_event_trigger_can_be_reviewed_after_startup_closes_without_sends(self):
        self.configure(mode="native-event")
        self.initialize()
        after = (timestamp(self.inputs["bootstrap_deadline"]) + timedelta(seconds=1)).isoformat()
        with patch("startup_handoff.now", return_value=after), patch("operator_startup.now", return_value=after), \
                patch.dict(os.environ, ORCA_TERMINAL_HANDLE="term_operator"):
            execution.attest_trigger(self.ref, self.trigger_candidate(), call=self.query)
            self.assertFalse(execution.can_send(self.config))
            self.assertEqual(execution.event_ready(self.config, self.contract)["decision"], "ready")
        self.assertEqual(self.m.messages, [])

    def test_acceptance_is_before_first_tick_and_tamper_is_not_ready(self):
        import operator_monitor_deploy as deploy
        self.configure(mode="manual", workers="not-applicable")
        self.initialize()
        tick = monitor.tick
        def checked(config, **kwargs):
            receipt = read_json(config.root / "deployment-status.json")
            self.assertEqual(receipt["phase"], "starting")
            self.assertIsNone(receipt["first_tick_at"])
            self.assertEqual(receipt["acceptance"]["continuation"], self.config_ref)
            return tick(config, **kwargs)
        with patch.object(monitor, "tick", side_effect=checked):
            self.execute_monitor()
        deployment = read_json(self.root / "state.json")["deployment"]
        target = Path(self.plan["monitor_state_root"]) / "deployment-status.json"
        receipt = read_json(target)
        receipt["acceptance"]["run"]["generation"] += 1
        replace_json(target, receipt)
        with self.assertRaisesRegex(ValueError, "monitor_runtime_acceptance_changed"):
            deploy.verify(deployment, call=self.monitor_query)

    def test_pending_before_executor_acceptance_records_known_exit_not_false_ready(self):
        from bootstrap_identity import IdentityVerificationPending
        self.configure(mode="manual", workers="not-applicable")
        self.initialize()
        with patch("startup_runtime.acceptance", side_effect=IdentityVerificationPending("bootstrap_identity_reverification_pending")):
            result, seen = self.execute_monitor()
        self.assertEqual(result["state"], "revalidation_pending")
        state = read_json(self.root / "state.json")
        self.assertEqual(state["attempts"][-1]["returncode"], 3)
        self.assertIsNone(state["attempts"][-1]["receipt"])
        self.assertFalse(state["current"]["runtime_ready"])
        self.assertEqual(seen, [])
        self.assertEqual(self.m.messages, [])

    def test_readiness_rechecks_runtime_after_sender_native_observation(self):
        from bootstrap_identity import IdentityVerificationPending
        import operator_monitor_deploy as deploy
        import startup_runtime
        self.configure(mode="manual", workers="not-applicable")
        self.initialize()
        deployment = deploy.prepare(self.config_ref, self.plan["monitor_state_root"],
                                    self.plan["deployment_dir"], call=self.monitor_query)
        checked = []
        tick, fence, acceptance = monitor.tick, monitor.fence, startup_runtime.acceptance
        def observe(event, _):
            if event != "tick":
                return
            def native_then_expire(*args, **kwargs):
                fence(*args, **kwargs)
                checked.append(True)
            def admitted(*args):
                if checked:
                    raise IdentityVerificationPending("bootstrap_identity_reverification_pending")
                return acceptance(*args)
            with patch.object(monitor, "fence", side_effect=native_then_expire), \
                    patch.object(startup_runtime, "acceptance", side_effect=admitted):
                with self.assertRaises(IdentityVerificationPending):
                    deploy.verify(deployment, call=self.monitor_query)
        with patch.object(monitor, "tick", side_effect=lambda config: tick(config, call=self.monitor_query)), \
                redirect_stdout(io.StringIO()):
            self.assertEqual(deploy.run(deployment, once=True, observer=observe), 0)
        self.assertEqual(checked, [True])
        self.assertEqual(self.m.messages, [])

    def test_pending_does_not_retry_unknown_send(self):
        from bootstrap_identity import IdentityVerificationPending
        self.configure(mode="manual", workers="not-applicable")
        self.initialize()
        state = continuation.read_outbox(self.state)
        record = read_json(self.config["checkpoint_head"])
        entry = continuation.prepare_entry(state, record, parse(pinned(record)), self.state)
        entry["attempted"] = True
        def unknown_then_pending(*_):
            replace_json(self.state / "outbox.json", state)
            raise IdentityVerificationPending("bootstrap_identity_reverification_pending")
        with patch("startup_runtime.acceptance", side_effect=unknown_then_pending) as accept:
            result, _ = self.execute_monitor()
        self.assertEqual(result["returncode"], 2)
        self.assertEqual(accept.call_count, 1)
        self.assertTrue(execution.unknown_sends(self.config))
        self.assertEqual(self.m.messages, [])

    def test_stop_during_sender_native_fence_prevents_acceptance(self):
        self.configure(mode="manual", workers="not-applicable")
        self.initialize()
        fence = monitor.fence
        def stop_after_native(*args, **kwargs):
            fence(*args, **kwargs)
            publish_new(self.root / "STOP", b"stop during sender check")
        with patch.object(monitor, "fence", side_effect=stop_after_native):
            result, seen = self.execute_monitor()
        self.assertEqual(result["returncode"], 2)
        target = Path(self.plan["monitor_state_root"])
        self.assertEqual(list(target.glob("launch-*.json")), [])
        self.assertFalse((target / "deployment-status.json").exists())
        self.assertEqual(self.m.messages, [])
        self.assertEqual(seen, [])

    def test_pending_observes_lifecycle_stop_without_another_tick(self):
        from bootstrap_identity import IdentityVerificationPending
        self.configure(mode="manual", workers="not-applicable")
        self.initialize()
        def pending(*_):
            publish_new(self.root / "STOP", b"original lifecycle stop")
            raise IdentityVerificationPending("bootstrap_identity_reverification_pending")
        with patch("startup_runtime.acceptance", side_effect=pending) as accept:
            result, _ = self.execute_monitor()
        self.assertEqual(result["returncode"], 2)
        self.assertEqual(accept.call_count, 1)
        self.assertEqual((self.root / "STOP").read_bytes(), b"original lifecycle stop")
        self.assertEqual(self.m.messages, [])

    def test_monitor_runtime_binding_cannot_change_sender_generation_or_mode(self):
        import operator_monitor_deploy as deploy
        self.configure(mode="manual", workers="not-applicable")
        self.initialize()
        ref = deploy.prepare(self.config_ref, self.plan["monitor_state_root"], self.plan["deployment_dir"], call=self.monitor_query)
        _, configured = deploy.validate(ref)
        for key, value in (("sender", dict(self.plan["sender"], terminal="different")),
                           ("binding", dict(configured.data["binding"], generation=999)),
                           ("execution", dict(mode="autonomous", trigger=None)),
                           ("state_root", str(self.base))):
            with self.subTest(key=key), self.assertRaises(ValueError):
                execution.can_send(dict(configured.data, **{key: value}))

    def test_created_materials_gate_role_routing_and_separate_acceptance(self):
        self.configure()
        result = handoff.inspect(self.ref, call=self.query)
        self.assertEqual((result["next_owner"], result["action"]), ("coordinator", "materials"))
        with patch.dict(os.environ, ORCA_TERMINAL_HANDLE="term_test"):
            published = handoff.task(self.ref, "coordinator", call=self.query)
            self.assertFalse(published["responsibility_accepted"])
            with self.assertRaises(FileNotFoundError):
                handoff.complete(self.ref, "coordinator", "materials", call=self.query)
        self.action("materials", self.materials)
        result = handoff.inspect(self.ref, call=self.query)
        self.assertEqual((result["next_owner"], result["action"]), ("operator", "review"))
        self.assertFalse(result["runtime_ready"])
        self.assertEqual(self.dispatches, [])

    def test_real_gate_dispatch_and_prepare_producers_are_connected(self):
        self.configure()
        self.initialize()
        self.assertEqual(len(self.dispatches), 1)
        self.assertEqual(self.config["execution"]["mode"], "autonomous")
        self.assertTrue(startup.publication(self.ref, startup.created(self.ref, call=self.query)))
        self.assertEqual(handoff.inspect(self.ref, call=self.query)["next_owner"], "sender")
        self.assertFalse(startup.status(self.ref, call=self.query)["monitor_ready"])

    def test_no_worker_uses_real_run_readiness_gates_not_fake_dispatch(self):
        self.configure(workers="not-applicable", mode="manual")
        self.initialize()
        self.assertIsNone(self.config["dispatch_gate"])
        self.assertEqual(execution.startup_gate(self.config)["phase"], "run-readiness")
        self.assertEqual(self.dispatches, [])
        self.assertFalse((self.root / "first-dispatch").exists())

    def test_gate_without_native_acceptance_cannot_admit(self):
        self.configure()
        self.admitted()
        receipt = read_json(self.root / "first-dispatch" / "dispatch-response.json")
        receipt["state"] = "unknown"
        replace_json(self.root / "first-dispatch" / "dispatch-response.json", receipt)
        with self.assertRaises(ValueError):
            handoff.admission(self.ref, file_ref(self.root / "admission.json"))

    def test_unknown_dispatch_never_replays(self):
        self.configure()
        self.action("materials", self.materials)
        self.action("review", dict(materials=file_ref(self.root / "materials.json"), decision="approve", notes="reviewed"))
        with patch.object(self, "dispatch", side_effect=TimeoutError("native outcome unknown")):
            with self.assertRaisesRegex(ValueError, "requires_reconciliation"):
                self.action("dispatch")
        state = handoff.inspect(self.ref, call=self.query)
        self.assertEqual(state["state"], "reconciliation_required")
        self.assertIn("request_id", state)
        with self.assertRaisesRegex(ValueError, "startup_action_not_available"):
            self.action("dispatch")
        with patch.dict(os.environ, ORCA_TERMINAL_HANDLE="term_operator"):
            with self.assertRaisesRegex(ValueError, "startup_refresh_after_dispatch_forbidden"):
                handoff.refresh_review(self.ref, None, call=self.query)

    def test_manual_and_event_send_gates_cover_queued_entries(self):
        self.configure(mode="native-event")
        self.initialize()
        self.assertFalse(execution.can_send(self.config))
        state = continuation.read_outbox(self.state)
        record = read_json(parse(pinned(self.config_ref))["checkpoint_head"])
        entry = continuation.prepare_entry(state, record, parse(pinned(record)), self.state)
        with self.assertRaisesRegex(ValueError, "startup_mode_forbids_send"):
            continuation.deliver_entry(self.config_ref, self.config, self.contract, self.state, state,
                entry, parse(pinned(record)), self.f.query, lambda: None)
        self.assertFalse(entry["attempted"])
        self.assertEqual(self.f.sends, [])
        # The policy remains observation-only after any acceptance deadline.
        with patch.object(execution, "now", return_value=(timestamp(now()) + timedelta(days=1)).isoformat()):
            self.assertFalse(execution.can_send(self.config))
        entry["attempted"] = True
        replace_json(self.state / "outbox.json", state)
        self.assertTrue(execution.unknown_sends(self.config))

    def test_mode_missing_lifecycle_rejected_before_initialization(self):
        config = dict(self.f.config, execution={"mode": "autonomous", "trigger": None})
        with self.assertRaisesRegex(ValueError, "startup_lifecycle_required"):
            continuation.validate_config(config)

    def test_expired_gate_routes_original_operator_and_preserves_old_chain(self):
        self.configure()
        self.review()
        old_gate = file_ref(self.root / "operator-gate.json")
        expires = parse(pinned(old_gate))["valid_until"]
        with patch.object(handoff, "now", return_value=expires):
            pending = handoff.inspect(self.ref, call=self.query)
            self.assertEqual((pending["state"], pending["next_owner"]), ("operator_gate_expired", "operator"))
            self.assertEqual(pending["identity"], self.f.c["operator"])
            with self.assertRaisesRegex(ValueError, "startup_action_not_available"):
                self.action("dispatch")
        review = file_ref(self.root / "review.json")
        with patch.dict(os.environ, ORCA_TERMINAL_HANDLE="term_operator"):
            result = handoff.refresh_review(self.ref, self.f.t.ref("bootstrap/refresh.json",
                dict(previous=review, decision="approve", notes="fresh independent audit")), call=self.query)
        self.assertEqual(old_gate, file_ref(old_gate["path"]))
        self.assertEqual(review, file_ref(review["path"]))
        self.action("dispatch")
        admitted = handoff.admission(self.ref, file_ref(self.root / "admission.json"))
        self.assertEqual(admitted["review"], result["review"])
        self.assertEqual(len(self.dispatches), 1)
        self.assertTrue((self.root / "first-dispatch-1" / "dispatched.json").exists())

    def test_native_idle_is_blocked_handoff_not_legal_turn_end(self):
        self.configure()
        def query(args, runtime, timeout=20):
            if args[:2] == ["terminal", "wait"]:
                return IdleWaitResult("ready")
            return self.query(args, runtime, timeout)
        result = startup.status(self.ref, call=query)
        self.assertEqual(result["state"], "handoff_incomplete_role_idle")
        self.assertEqual(result["next_owner"], "coordinator")
        self.assertFalse(result["runtime_ready"])
        self.assertFalse(result["responsibility_accepted"])

    def test_insufficient_gate_window_is_routed_before_any_dispatch_intent(self):
        self.configure()
        self.review()
        expiry = timestamp(read_json(self.root / "operator-gate.json")["valid_until"])
        with patch.object(handoff, "now", return_value=(expiry - timedelta(seconds=1)).isoformat()):
            pending = handoff.inspect(self.ref, call=self.query)
            self.assertEqual(pending["state"], "operator_gate_window_insufficient")
            self.assertEqual(pending["next_owner"], "operator")
        self.assertEqual(handoff.dispatch_intents(self.root), [])
        self.assertEqual(self.dispatches, [])

    def test_original_creation_intent_without_receipt_never_retries_create(self):
        self.configure()
        # Deterministic interrupted native boundary: preserve intent, hide only
        # this fixture's completed publication, as a real interrupted creator would.
        (self.old.strict_dir / "created.json").rename(self.old.strict_dir / "interrupted-created.json")
        result = startup.status(self.ref, call=self.query)
        self.assertIn("startup_creation_requires_reconciliation", result["missing"])
        self.assertFalse(result["runtime_ready"])

    def test_new_contract_cannot_strip_lifecycle_and_mode(self):
        self.configure()
        self.initialize()
        config = {k: v for k, v in self.config.items() if k not in ("execution", "startup_lifecycle", "startup_evidence")}
        with self.assertRaisesRegex(ValueError, "startup_lifecycle_required"):
            continuation.validate_config(config)

    def test_stop_between_dispatch_intent_and_native_mutation(self):
        self.configure()
        self.review()
        publish = first.publish_new
        def stop_after_intent(target, value):
            publish(target, value)
            if target.name == "dispatch-intent.json":
                publish_new(self.root / "STOP", b"stop")
        with patch.object(first, "publish_new", side_effect=stop_after_intent):
            with self.assertRaisesRegex(ValueError, "requires_reconciliation"):
                self.action("dispatch")
        self.assertEqual(self.dispatches, [])
        self.assertTrue((self.root / "first-dispatch" / "dispatch-intent.json").exists())

    def test_autonomous_first_tick_allows_first_yield_then_exit_degrades(self):
        self.configure(actual_create=True)
        self.initialize()
        result, seen = self.execute_monitor()
        self.assertEqual(result["state"], "monitor_exited", result)
        self.assertFalse(result["runtime_ready"])
        self.assertEqual(len(seen), 1)
        state, audit = seen[0]
        self.assertTrue(state["current"]["runtime_ready"], state["current"])
        self.assertIn("runtime_ready", state["milestones"])
        self.assertTrue(audit["ok"], audit)
        self.assertTrue(audit["readiness"]["bootstrap"])
        self.assertFalse(audit["readiness"]["acceptance_complete"])
        self.assertEqual(self.m.messages, [])
        self.assertEqual(len(self.creates), 1)
        self.assertFalse(startup.status(self.ref, call=self.monitor_query)["runtime_ready"])

    def test_manual_real_monitor_and_turn_end_are_non_autonomous(self):
        self.configure(mode="manual", workers="not-applicable")
        self.initialize()
        result, seen = self.execute_monitor()
        self.assertEqual(result["state"], "monitor_exited")
        self.assertEqual(len(seen), 1)
        self.assertTrue(seen[0][0]["current"]["runtime_ready"])
        audit = seen[0][1]
        self.assertTrue(audit["ok"], audit)
        self.assertEqual(audit["outcome"], "manual_non_autonomous_handoff")
        self.assertFalse(audit["readiness"]["autonomous_wait_ready"])
        self.assertEqual(self.m.messages, [])

    def test_event_real_monitor_requires_scoped_preflight_and_never_sends(self):
        self.configure(mode="native-event")
        self.initialize()
        _, seen = self.execute_monitor()
        self.assertTrue(seen, read_json(self.root / "state.json")["current"])
        self.assertFalse(seen[0][0]["current"]["runtime_ready"])
        bad = self.trigger_candidate(trigger_id="wrong-dispatch")
        with patch.dict(os.environ, ORCA_TERMINAL_HANDLE="term_operator"):
            with self.assertRaisesRegex(ValueError, "startup_trigger_scope_changed"):
                execution.attest_trigger(self.ref, bad, call=self.query)
            execution.attest_trigger(self.ref, self.trigger_candidate(), call=self.query)
        _, seen = self.execute_monitor()
        self.assertTrue(seen[0][0]["current"]["runtime_ready"], seen)
        audit = seen[0][1]
        self.assertTrue(audit["ok"], audit)
        self.assertEqual(audit["outcome"], "designated_native_event_only")
        self.assertFalse(audit["readiness"]["autonomous_wait_ready"])
        self.assertEqual(self.m.messages, [])
        expiry = read_json(self.plan["execution"]["trigger"]["readiness"])["valid_until"]
        with patch.object(execution, "now", return_value=expiry):
            with self.assertRaisesRegex(ValueError, "startup_trigger_readiness_expired"):
                execution.event_ready(self.config, self.contract)
            self.assertFalse(execution.can_send(self.config))

    def test_no_worker_cannot_claim_worker_done_trigger_ready(self):
        self.configure(mode="native-event", workers="not-applicable")
        self.initialize()
        with patch.dict(os.environ, ORCA_TERMINAL_HANDLE="term_operator"):
            with self.assertRaisesRegex(ValueError, "startup_worker_trigger_requires_worker"):
                execution.attest_trigger(self.ref, self.trigger_candidate(), call=self.query)

    def test_queued_send_and_stop_at_last_boundary_produce_no_native_send(self):
        self.configure()
        self.initialize()
        state = continuation.read_outbox(self.state)
        record = read_json(self.config["checkpoint_head"])
        entry = continuation.prepare_entry(state, record, parse(pinned(record)), self.state)
        save = continuation.replace_json
        def stop_after_attempt(target, value):
            save(target, value)
            if target == self.state / "outbox.json" and entry["attempted"]:
                publish_new(self.root / "STOP", b"stop")
        with patch.object(continuation, "replace_json", side_effect=stop_after_attempt):
            with self.assertRaisesRegex(ValueError, "startup_persistent_stop"):
                continuation.deliver_entry(self.config_ref, self.config, self.contract, self.state, state,
                    entry, parse(pinned(record)), self.f.query, lambda: None)
        self.assertEqual(self.f.sends, [])
        self.assertTrue(execution.unknown_sends(self.config))


if __name__ == "__main__":
    unittest.main()

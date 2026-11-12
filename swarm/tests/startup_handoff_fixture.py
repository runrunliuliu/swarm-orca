"""Shared lifecycle/action/gate/dispatch fixture for the handoff regression modules.

Split out of `tests/core/test_startup_handoff.py` without changing a fixture or an assertion:
each of the four handoff modules drives the same production chain, and running them as separate
modules is what keeps the slowest module from becoming the floor of the parallel offline gate.
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

from coordinator_io import file_ref, now, read_json, timestamp
import coordinator_tui_continue as continuation
import operator_monitor as monitor
import operator_startup as startup
import startup_handoff as handoff
import coordinator_tui_scheduler as scheduling
from coordinator_tui_turn_end import turn_end
from terminal_idle_wait import IdleWaitResult
from coordinator_worker_profiles import PROFILES
from publication_wait_fixture import polling_watch
import operators.test_operator_startup as legacy


class HandoffCase(unittest.TestCase):
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
                patch.object(strict, "time", wraps=time) as clock, \
                patch("publication_wait.watch", polling_watch(sleep)):
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


    def trigger_candidate(self, source="worker_done", trigger_id="ctx_test", with_window=False):
        until = (timestamp(now()) + timedelta(seconds=300 if with_window else 120)).isoformat()
        trigger = self.f.t.ref("bootstrap/trigger.json", dict(kind="native_event_trigger_preflight", ready=True,
            run=self.contract["run"], source=source, trigger_id=trigger_id, checked_at=now(), valid_until=until))
        candidate = dict(decision="ready", notes="independently reviewed",
            evidence=[self.f.c["handoff"]], trigger=trigger, valid_until=until)
        if with_window:
            candidate["release_window"] = dict(deadline=until, publish_budget_seconds=30, reserve_seconds=120)
        return self.f.t.ref("bootstrap/trigger-review.json", candidate)


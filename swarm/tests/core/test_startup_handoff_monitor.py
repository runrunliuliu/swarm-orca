"""Monitor tick, send fence, pending and turn-end chain; native fakes only.

No real Agent, Run, Worker, send or service.
"""

from contextlib import redirect_stdout
import io
from pathlib import Path
from unittest.mock import patch

from coordinator_io import publish_new, read_json, replace_json
import operator_monitor as monitor
import operator_startup as startup
import startup_execution as execution
from terminal_idle_wait import IdleWaitResult

from startup_handoff_fixture import HandoffCase


class MonitorTests(HandoffCase):
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


if __name__ == "__main__":
    unittest.main()

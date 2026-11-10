"""Native-event trigger, send gate, pending and stop-fence chain; native fakes.

No real Agent, Run, Worker, send or service.
"""

from contextlib import redirect_stdout
from datetime import timedelta
import os
import io
from pathlib import Path
from unittest.mock import patch

from coordinator_io import now, parse, pinned, publish_new, read_json, replace_json, timestamp
import coordinator_tui_continue as continuation
import operator_monitor as monitor
import operator_startup as startup
import startup_handoff as handoff
import startup_execution as execution

from startup_handoff_fixture import HandoffCase


class TriggerTests(HandoffCase):
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


    def test_event_window_receipt_roundtrip_and_expiry_after_slow_evidence(self):
        self.configure(mode="native-event")
        self.initialize()
        with patch.dict(os.environ, ORCA_TERMINAL_HANDLE="term_operator"):
            execution.attest_trigger(self.ref, self.trigger_candidate(with_window=True), call=self.query)
        receipt = execution.event_ready(self.config, self.contract)
        self.assertEqual(receipt["schema_version"], 2)
        self.assertEqual(receipt["release_window"]["reserve_seconds"], 120)
        original = execution.unknown_sends
        for remaining, reason in ((120, "startup_trigger_window_insufficient"),
                                  (0, "startup_trigger_readiness_expired")):
            clock = [now()]
            def slow_last_read(*args):
                result = original(*args)
                clock[0] = (timestamp(receipt["valid_until"]) - timedelta(seconds=remaining)).isoformat()
                return result
            with self.subTest(remaining=remaining), \
                    patch.object(execution, "now", side_effect=lambda: clock[0]), \
                    patch.object(execution, "unknown_sends", side_effect=slow_last_read):
                with self.assertRaisesRegex(ValueError, reason):
                    execution.event_ready(self.config, self.contract)


    def test_trigger_cli_preserves_only_exact_safe_rpc_rejections(self):
        for code in ("startup_release_window_invalid", "startup_trigger_window_insufficient",
                     "startup_trigger_readiness_expired", "bootstrap_owner_busy_not_executed",
                     "secret path or payload"):
            reason = "bootstrap_rpc_rejected:" + code
            output = io.StringIO()
            with patch.object(execution, "attest_trigger", side_effect=ValueError(reason)), redirect_stdout(output):
                result = handoff.main(["trigger-ready", "--actor", "operator", "--execute",
                    "--plan", "/fixture/plan", "--plan-sha256", "a" * 64,
                    "--input", "/fixture/candidate", "--input-sha256", "b" * 64])
            self.assertEqual(result, 2)
            value = parse(output.getvalue().encode())
            self.assertEqual(value["reason"], reason if code != "secret path or payload" else "readiness_observation_failed")
            self.assertFalse(value["retry_allowed"])


    def test_no_worker_cannot_claim_worker_done_trigger_ready(self):
        self.configure(mode="native-event", workers="not-applicable")
        self.initialize()
        with patch.dict(os.environ, ORCA_TERMINAL_HANDLE="term_operator"):
            with self.assertRaisesRegex(ValueError, "startup_worker_trigger_requires_worker"):
                execution.attest_trigger(self.ref, self.trigger_candidate(), call=self.query)


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


if __name__ == "__main__":
    unittest.main()

"""Production handoff gate, dispatch intent and admission chain; native/provider fakes.

No real Agent, Run, Worker, send or service.
"""

from datetime import timedelta
import os
from pathlib import Path
from unittest.mock import patch

from coordinator_io import file_ref, parse, pinned, publish_new, read_json, replace_json, timestamp
import coordinator_first_dispatch as first
import operator_startup as startup
import startup_handoff as handoff
import startup_execution as execution

from startup_handoff_fixture import HandoffCase


class HandoffTests(HandoffCase):
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


    def test_runtime_deadline_closes_admission_despite_historical_first_tick(self):
        from startup_runtime import established
        self.configure(mode="manual", workers="not-applicable")
        self.initialize()
        self.execute_monitor()
        with patch("startup_runtime.now", return_value=self.config["deadline"]):
            with self.assertRaisesRegex(ValueError, "startup_runtime_deadline_expired"):
                established(self.ref, self.config_ref)
        self.assertEqual(self.m.messages, [])


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


if __name__ == "__main__":
    unittest.main()

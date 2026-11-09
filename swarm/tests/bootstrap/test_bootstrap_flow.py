"""Phase-2 same-chain vertical tests: real original builder, fake role adapters."""

from dataclasses import replace
from datetime import timedelta
from pathlib import Path
import threading
import unittest
from unittest.mock import patch

from bootstrap_admission import control_paths
from bootstrap_control_fixture import AuthorityFixture
from bootstrap_driver import OfflineBootstrapDriver
from bootstrap_events import check_state
from bootstrap_flow_fixture import OfflineAdapters
from bootstrap_protocol import BACKEND, ControlBinding, EVENTS, RequestAdmission, layout
from coordinator_io import file_ref, parse, pinned, publish_new, timestamp
from coordinator_strict_request import build_request
import coordinator.test_coordinator_strict_request as request_tests


class BootstrapFlowTests(unittest.TestCase):
    def setUp(self):
        self.base = request_tests.StrictRequestTests()
        self.base.setUp()
        self.addCleanup(self.base.doCleanups)
        self.root = self.base.root
        self.paths = layout(self.root)
        for directory in ("control", "coordinator", "operator", "events"):
            (self.root / directory).mkdir(mode=0o700)
        for name in ("owner", "driver"):
            (self.root / "control" / (name + ".lock")).touch(mode=0o600)
        publish_new(Path(self.paths["skill_read_evidence"]), {"skill_read": "S0 fixture"})
        fields = parse(pinned(self.base.source["contract_fields"]))
        fixed = {k: fields[k] for k in ("cli", "runtime_config", "role_skill", "handoff")}
        fixed["skill_read_evidence"] = file_ref(self.paths["skill_read_evidence"])
        self.b = dict(schema_version=1, kind="strict_bootstrap_binding", attempt_id="attempt-flow",
            runtime=self.base.source["runtime"], workspace=self.base.source["workspace"],
            coordinator=dict(terminal="term_test", incarnation="inc_test", process_incarnation="pty:inc_test",
                             pane_key="tab:leaf", agent="trae"), operator=fields["operator"], paths=self.paths,
            created_at=(timestamp(self.base.tui.caller["checkedAt"]) - timedelta(seconds=1)).isoformat(),
            deadline=(self.base.clock + timedelta(minutes=20)).isoformat(), context_max_age_seconds=1800,
            fixed_inputs=fixed,
            authorization_refs=parse(pinned(self.base.source["task_source"]))["authorization_refs"],
            file_tool_evidence_paths=[str(self.root / "coordinator" / "file-tool-probe.json")],
            control=dict(backend=BACKEND, control_id="flow-control", generation="flow-generation"),
            execution_authorized=False)
        publish_new(self.root / "attempt-binding.json", self.b)
        self.control = ControlBinding(file_ref(self.root / "attempt-binding.json"), "flow-control", "flow-generation")
        slots = {p: "operator" for name, p in self.paths.items() if name != "skill_read_evidence"}
        for name in ("caller_receipt", "caller-ready", "final_readiness", "request"):
            slots[self.paths[name]] = "coordinator"
        slots.update({p: "coordinator" for p in self.b["file_tool_evidence_paths"]})
        for name, p in control_paths(self.root).items():
            slots[p] = "operator" if name in {"observe-intent", "fields-intent", "contract-intent", "readiness-intent"} else "coordinator"
        self.authority = AuthorityFixture(self.root / "control", self.control, slots)
        self.addCleanup(self.authority.close)
        self.adapters = OfflineAdapters(self.base, self.control, self.authority)
        self.authority.admission_check = lambda: self.adapters.recheck(self.control)
        self.authority.arm(self.control, lambda: None)
        for module in ("bootstrap_admission", "bootstrap_driver"):
            clock = patch(module + ".now", side_effect=lambda: self.base.clock.isoformat())
            clock.start()
            self.addCleanup(clock.stop)
        self.driver = OfflineBootstrapDriver(self.control, self.authority, self.adapters)
        self.adapters.driver = self.driver
        self.addCleanup(self.driver.close)
        self.base.tui.calls.clear()

    def run_flow(self):
        with patch("subprocess.Popen", side_effect=AssertionError("offline only")):
            return self.driver.run(self.base.source)

    def ready(self):
        self.driver.publish_caller()
        self.driver.wait_for(EVENTS[2])
        self.driver.final_readiness()
        self.driver.wait_for(EVENTS[3])

    def test_real_builder_full_dynamic_chain_and_same_control_downstream(self):
        import coordinator_strict_request
        for name in ("caller_receipt", "session_observation", "contract_fields", "final_readiness", "request"):
            self.assertFalse(Path(self.paths[name]).exists(), name)
        with patch.object(coordinator_strict_request, "build_request", wraps=build_request) as builder:
            request = self.run_flow()
        builder.assert_called_once()
        self.assertIs(builder.call_args.kwargs["authority"], self.authority)
        value = parse(pinned(request))
        self.assertEqual(value["schema_version"], 5)
        self.assertNotIn("bootstrap_admission", value)
        s4 = parse(pinned(self.driver.slot(EVENTS[3])))
        self.assertEqual(value["readiness_evidence"], s4["readiness_evidence"])
        self.assertEqual([set(r) for r in value["readiness_evidence"]], [{"path", "sha256"}] * 4)
        for name in ("caller_receipt", "session_observation", "contract_fields"):
            self.assertEqual(value[name], self.driver.slot(name))
        association = parse(pinned(self.driver.slot("request-admission")))
        self.assertEqual(association["request"], request)
        self.assertEqual(association["readiness_marker"], self.driver.slot(EVENTS[3]))
        self.assertEqual(self.adapters.trace, ["caller", "observe", "submit_fields", "produce_fields",
            "submit_contract", "produce_contract", "final_evidence_after_wait_return", "submit_readiness", "produce_readiness"])
        self.assertEqual(self.base.tui.calls, [])
        seen = []
        self.driver.downstream(request, lambda control, intent: seen.append((control, intent)))
        self.assertIs(seen[0][0], self.control)
        self.assertTrue(self.authority.armed)
        result = check_state(str(self.root), attempt_binding_sha256=self.control.attempt_binding["sha256"],
                             expect_attempt="attempt-flow", clock=self.base.clock)
        self.assertTrue(result["evidence_chain_complete"])
        self.assertFalse(result["ready"])
        self.assertEqual(result["state"], "durability_unverified")

    def test_first_wait_returns_before_coordinator_evidence_or_second_review(self):
        self.driver.publish_caller()
        self.driver.wait_for(EVENTS[2])
        self.assertIsNone(self.driver.slot("final_readiness"))
        self.assertEqual(self.adapters.calls["submit_readiness"], 0)
        self.assertEqual(self.adapters.calls["final_evidence"], 0)
        with self.assertRaisesRegex(TimeoutError, "wait_pending"):
            self.driver.wait_for(EVENTS[3], timeout=0.02, interval=0.01)
        self.driver.final_readiness()
        self.driver.wait_for(EVENTS[3])
        self.assertEqual(self.adapters.calls["final_evidence"], 1)

    def test_duplicate_notifications_and_reentry_preserve_outputs_and_clock(self):
        request = self.run_flow()
        before = {p: (p.read_bytes(), p.stat().st_mtime_ns) for p in self.root.rglob("*") if p.is_file()}
        for _ in range(10):
            self.driver.notify()
        self.base.clock += timedelta(seconds=1)
        self.assertEqual(self.driver.run(self.base.source), request)
        after = {p: (p.read_bytes(), p.stat().st_mtime_ns) for p in self.root.rglob("*") if p.is_file()}
        self.assertEqual(before, after)
        for name in ("caller", "observe", "submit_fields", "submit_contract", "submit_readiness", "final_evidence"):
            self.assertEqual(self.adapters.calls[name], 1, name)

    def test_unknown_delivery_is_queried_not_resubmitted_then_lost_event_recovers(self):
        self.adapters.delay.add("fields")
        self.driver.publish_caller()
        self.driver.drain()
        for status in ("submitted", "input_accepted", "turn_started", "unknown"):
            self.adapters.pending["fields"] = status
            self.driver.notify()
            self.driver.drain()
        self.assertEqual(self.adapters.calls["submit_fields"], 1)
        self.assertIsNone(self.driver.slot(EVENTS[2]))
        self.adapters.drop_notifications = True
        self.adapters.complete("fields")
        # Erase even the local producer notification: a fixed-path tick suffices.
        with self.driver.condition:
            self.driver.requested = False
        self.driver.wait_for(EVENTS[2])
        self.assertEqual(self.adapters.calls["submit_fields"], 1)
        self.assertEqual(self.adapters.calls["produce_fields"], 1)

    def test_busy_defers_and_unsupported_idle_fails_without_submit(self):
        self.adapters.session = "busy"
        self.driver.publish_caller()
        self.driver.drain()
        self.assertIsNone(self.driver.slot("fields-intent"))
        self.assertEqual(self.adapters.calls["submit_fields"], 0)
        self.adapters.session, self.adapters.safe_point = "idle", False
        with self.assertRaisesRegex(ValueError, "blocked_operator_resume_unsupported"):
            self.driver.drain()
        self.adapters.safe_point = True
        self.driver.wait_for(EVENTS[2])
        self.assertEqual(self.adapters.calls["submit_fields"], 1)

    def test_review_reject_is_not_overwritten_or_promoted(self):
        self.adapters.decisions["contract"] = "reject"
        self.driver.publish_caller()
        with self.assertRaisesRegex(ValueError, "operator_rejected"):
            self.driver.wait_for(EVENTS[2])
        rejected = self.driver.slot("contract_review")
        self.adapters.decisions["contract"] = "approve"
        with self.assertRaisesRegex(ValueError, "operator_rejected"):
            self.driver.drain()
        self.assertEqual(self.driver.slot("contract_review"), rejected)
        self.assertIsNone(self.driver.slot(EVENTS[2]))
        self.assertEqual(self.adapters.calls["submit_contract"], 1)

    def test_declaration_without_adapter_provenance_cannot_advance(self):
        self.adapters.provenance_valid = False
        self.driver.publish_caller()
        with self.assertRaisesRegex(ValueError, "provenance_unverified"):
            self.driver.drain()
        self.assertIsNone(self.driver.slot(EVENTS[2]))

    def test_dirty_trigger_during_drain_is_not_lost_or_recursive(self):
        original = self.driver.advance
        calls = []
        def step():
            calls.append(1)
            if len(calls) == 1:
                self.driver.notify()
                self.driver.drain()  # coalesces instead of recursing
            return original()
        with patch.object(self.driver, "advance", side_effect=step):
            self.driver.drain()
        self.assertEqual(len(calls), 2)
        self.assertFalse(self.driver.running)

    def test_second_driver_is_excluded_and_late_subscriber_reconciles_existing_chain(self):
        self.driver.publish_caller()
        with self.assertRaises(BlockingIOError):
            OfflineBootstrapDriver(self.control, self.authority, self.adapters)
        self.driver.close()
        self.driver = OfflineBootstrapDriver(self.control, self.authority, self.adapters)
        self.adapters.driver = self.driver
        self.addCleanup(self.driver.close)
        self.driver.wait_for(EVENTS[2])
        self.assertEqual(self.adapters.calls["caller"], 1)

    def test_missing_admission_half_never_falls_back_to_legacy_publish(self):
        for kwargs in ({"authority": self.authority}, {"bootstrap_admission": RequestAdmission(self.control, {})}):
            with self.assertRaisesRegex(ValueError, "admission_pair_required"):
                build_request(self.base.ref, **kwargs)
        self.assertIsNone(self.driver.slot("request"))

    def test_stop_after_s4_before_builder(self):
        self.ready()
        self.driver.stop()
        with self.assertRaisesRegex(ValueError, "stopped"):
            self.driver.build(self.base.source)
        self.assertIsNone(self.driver.slot("request"))

    def test_request_first_then_stop_keeps_fact_but_rejects_downstream(self):
        request = self.run_flow()
        raw = pinned(request)
        self.driver.stop()
        callback = unittest.mock.Mock()
        with self.assertRaisesRegex(ValueError, "stopped"):
            self.driver.downstream(request, callback)
        callback.assert_not_called()
        self.assertEqual(pinned(request), raw)
        self.assertEqual(self.authority.query(self.control, request).status, "confirmed")

    def test_stop_between_association_and_request_cannot_publish_request(self):
        self.ready()
        original = self.authority.commit_new
        def commit(control, **kwargs):
            result = original(control, **kwargs)
            if kwargs["target"] == self.driver.paths["request-admission"]:
                self.authority.stop(control)
            return result
        with patch.object(self.authority, "commit_new", side_effect=commit):
            with self.assertRaisesRegex(ValueError, "stopped"):
                self.driver.build(self.base.source)
        self.assertIsNotNone(self.driver.slot("request-admission"))
        self.assertIsNone(self.driver.slot("request"))

    def test_stop_during_original_live_check_prevents_final_commit_and_lock_is_free(self):
        self.ready()
        def live(*args):
            self.adapters.outside_admission()
            self.authority.stop(self.control)
        with patch("coordinator_strict_start.live", side_effect=live) as probe:
            with self.assertRaisesRegex(ValueError, "stopped"):
                self.driver.build(self.base.source, require_live=True)
        probe.assert_called_once()
        self.assertIsNone(self.driver.slot("request"))

    def test_full_chain_rechecked_inside_original_builder_publication(self):
        self.ready()
        original = self.authority.commit_new
        def commit(control, **kwargs):
            if kwargs["target"] == self.paths["request"]:
                Path(self.paths[EVENTS[0]]).write_bytes(b"changed")
            return original(control, **kwargs)
        with patch.object(self.authority, "commit_new", side_effect=commit):
            with self.assertRaises(ValueError):
                self.driver.build(self.base.source)
        self.assertFalse(Path(self.paths["request"]).exists())

    def test_identity_changed_after_live_check_is_rechecked_at_final_admission(self):
        self.ready()
        def live(*args):
            self.adapters.identity_valid = False
        with patch("coordinator_strict_start.live", side_effect=live):
            with self.assertRaisesRegex(ValueError, "identity_changed"):
                self.driver.build(self.base.source, require_live=True)
        self.assertIsNone(self.driver.slot("request"))

    def test_changed_source_is_not_silently_accepted_after_request_commit(self):
        request = self.run_flow()
        with self.assertRaisesRegex(ValueError, "request_input_mismatch"):
            self.driver.build(dict(self.base.source, max_workers=2))
        self.assertEqual(self.driver.slot("request"), request)

    def test_unconfirmed_s4_never_enters_request_builder(self):
        self.ready()
        s4 = self.driver.slot(EVENTS[3])
        self.authority.confirmed.discard((s4["path"], s4["sha256"]))
        with patch("coordinator_strict_request.build_request", side_effect=AssertionError("no builder")):
            with self.assertRaisesRegex(ValueError, "confirmation_unavailable"):
                self.driver.build(self.base.source)
        self.assertIsNone(self.driver.slot("request"))

    def test_unknown_admission_without_request_blocks_rebuild(self):
        self.ready()
        original = self.authority.commit_new
        def commit(control, **kwargs):
            result = original(control, **kwargs)
            if kwargs["target"] == self.driver.paths["request-admission"]:
                raise ConnectionError("fixture_reply_lost")
            return result
        with patch.object(self.authority, "commit_new", side_effect=commit):
            with self.assertRaises(ConnectionError):
                self.driver.build(self.base.source)
        self.assertIsNone(self.driver.slot("request"))
        with patch("coordinator_strict_request.build_request", side_effect=AssertionError("no rebuild")):
            with self.assertRaisesRegex(ValueError, "confirmation_unavailable"):
                self.driver.build(self.base.source)

    def test_notification_between_scan_and_sleep_wakes_wait(self):
        self.adapters.delay.add("fields")
        self.driver.publish_caller()
        self.driver.drain()
        at_sleep, complete = threading.Event(), threading.Event()
        original_wait = self.driver.condition.wait
        failures = []
        def waiter(timeout):
            at_sleep.set()
            return original_wait(timeout)
        def produce():
            try:
                if not at_sleep.wait(2):
                    raise TimeoutError("test_wait_not_reached")
                self.adapters.complete("fields")
            except BaseException as exc:
                failures.append(exc)
            finally:
                complete.set()
        thread = threading.Thread(target=produce, daemon=True)
        thread.start()
        try:
            with patch.object(self.driver.condition, "wait", side_effect=waiter):
                self.driver.wait_for(EVENTS[2], timeout=3, interval=1)
        finally:
            thread.join(3)
        self.assertFalse(thread.is_alive())
        self.assertTrue(complete.is_set())
        self.assertEqual(failures, [])
        self.assertEqual(self.adapters.calls["submit_fields"], 1)

    def test_visible_but_unconfirmed_request_is_never_rebuilt(self):
        self.ready()
        original = self.authority.commit_new
        def commit(control, **kwargs):
            result = original(control, **kwargs)
            if kwargs["target"] == self.paths["request"]:
                self.authority.confirmed.discard((result.target["path"], result.target["sha256"]))
            return result
        with patch.object(self.authority, "commit_new", side_effect=commit):
            with self.assertRaisesRegex(ValueError, "confirmation_unavailable"):
                self.driver.build(self.base.source)
        target = Path(self.paths["request"])
        original_bytes, original_time = target.read_bytes(), target.stat().st_mtime_ns
        with patch("coordinator_strict_request.build_request", side_effect=AssertionError("no rebuild")):
            with self.assertRaisesRegex(ValueError, "confirmation_unavailable"):
                self.driver.build(self.base.source)
        self.assertEqual((target.read_bytes(), target.stat().st_mtime_ns), (original_bytes, original_time))

    def test_identity_change_or_old_control_blocks_publication(self):
        self.ready()
        self.adapters.identity_valid = False
        with self.assertRaisesRegex(ValueError, "identity_changed"):
            self.driver.build(self.base.source)
        self.assertIsNone(self.driver.slot("request"))
        wrong = replace(self.control, generation="old")
        with self.assertRaisesRegex(ValueError, "generation_mismatch"):
            self.authority.commit_new(wrong, actor="coordinator", target=self.paths["request"], raw=b"{}",
                                      prerequisites=[], recheck=lambda: None)


if __name__ == "__main__":
    unittest.main()

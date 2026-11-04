"""Phase 3: faults on the Phase-2 chain and ORIGINAL request builder.

These are bounded, test-owned filesystem/thread faults, never native Agents.
No alternative builder, recovery generation or production transport is invented.
"""

from contextlib import contextmanager
from dataclasses import replace
from datetime import timedelta
from pathlib import Path
import threading
import time
import unittest
from unittest.mock import Mock, patch

from bootstrap_admission import inspect_chain
from bootstrap_control_fixture import AuthorityFixture
from bootstrap_driver import OfflineBootstrapDriver
from bootstrap_events import check_state
from bootstrap_protocol import EVENTS
import coordinator_io as evidence
import coordinator_strict_request
import test_bootstrap_flow as flow_tests


@contextmanager
def flow():
    fixture = flow_tests.BootstrapFlowTests()
    try:
        fixture.setUp()
        yield fixture
    finally:
        fixture.doCleanups()


def snapshot(f):
    return {str(p): (p.read_bytes(), p.stat().st_mtime_ns)
            for p in f.root.rglob("*") if p.is_file()}


def diagnostic(f):
    return check_state(str(f.root), attempt_binding_sha256=f.control.attempt_binding["sha256"],
                       expect_attempt=f.b["attempt_id"], clock=f.base.clock)


class BootstrapFailureTests(unittest.TestCase):
    def assert_once(self, f):
        for name in ("caller", "observe", "final_evidence", "submit_fields", "produce_fields",
                     "submit_contract", "produce_contract", "submit_readiness", "produce_readiness"):
            self.assertEqual(f.adapters.calls[name], 1, name)

    def test_lost_commit_replies_reconcile_original_roles_without_reproduction(self):
        names = ["caller_receipt", *EVENTS, "session_observation", "contract_fields", "contract_review",
                 "probe", "final_readiness", "readiness_review", "request-input", "request"]
        for name in names:
            with self.subTest(slot=name), flow() as f:
                target = f.b["file_tool_evidence_paths"][0] if name == "probe" else f.driver.paths[name]
                original = f.authority.commit_new
                commits = []
                def commit(control, **kwargs):
                    result = original(control, **kwargs)
                    commits.append(kwargs["target"])
                    if kwargs["target"] == target:
                        raise ConnectionError("fixture_commit_reply_lost")
                    return result
                with patch.object(coordinator_strict_request, "build_request",
                                  wraps=coordinator_strict_request.build_request) as builder:
                    with patch.object(f.authority, "commit_new", side_effect=commit):
                        with self.assertRaisesRegex(ConnectionError, "reply_lost"):
                            f.run_flow()
                    before = snapshot(f)
                    request = f.run_flow()
                    builder.assert_called_once()
                for path, value in before.items():
                    self.assertEqual(snapshot(f)[path], value)
                self.assertEqual(commits.count(target), 1)
                self.assertEqual(f.authority.query(f.control, request).status, "confirmed")
                self.assert_once(f)

    def test_directory_barrier_gaps_require_explicit_same_owner_reconciliation(self):
        # Each target is reached through the original production/wait/builder chain.
        # The association-only gap has a separate no-rebuild test below.
        names = ["caller_receipt", *EVENTS, "session_observation", "contract_fields", "contract_review",
                 "probe", "final_readiness", "readiness_review", "request"]
        for name in names:
            with self.subTest(slot=name), flow() as f:
                target = Path(f.b["file_tool_evidence_paths"][0] if name == "probe" else f.driver.paths[name])
                original = evidence.publish_new
                attempts = []
                def publish(path, raw):
                    attempts.append(str(path))
                    if Path(path) == target:
                        with patch.object(evidence, "fsync_dir", side_effect=OSError("fixture_barrier_failed")):
                            return original(path, raw)
                    return original(path, raw)
                with patch.object(coordinator_strict_request, "build_request",
                                  wraps=coordinator_strict_request.build_request) as builder:
                    with patch.object(evidence, "publish_new", side_effect=publish):
                        with self.assertRaisesRegex(OSError, "barrier_failed"):
                            f.run_flow()
                    ref = evidence.file_ref(target)
                    self.assertEqual(f.authority.query(f.control, ref).status, "durability_unverified")
                    before = snapshot(f)
                    with self.assertRaisesRegex(ValueError, "not_armed"):
                        f.run_flow()
                    self.assertEqual(snapshot(f), before)
                    # Explicit TEST HARNESS attestation: synchronous original writer
                    # has returned; no native operation exists; all original pins
                    # and identity remain fixed. This is NOT a production recovery API.
                    def recovery_check():
                        self.assertTrue(f.adapters.identity_valid)
                        self.assertEqual(snapshot(f), before)
                        inspect_chain(f.control)
                    f.authority.reconcile(f.control, target=ref, recheck=recovery_check)
                    self.assertFalse(f.authority.armed)
                    self.assertEqual(snapshot(f), before)
                    f.authority.arm(f.control, recovery_check)
                    f.base.clock += timedelta(seconds=1)
                    request = f.run_flow()
                    builder.assert_called_once()
                self.assertEqual(attempts.count(str(target)), 1)
                for path, value in before.items():
                    self.assertEqual(snapshot(f)[path], value)
                self.assertEqual(f.authority.query(f.control, request).status, "confirmed")
                self.assert_once(f)

    def test_association_barrier_recovery_does_not_rebuild_missing_request(self):
        with flow() as f:
            f.ready()
            original = evidence.publish_new
            def publish(path, raw):
                if str(path) == f.driver.paths["request-admission"]:
                    with patch.object(evidence, "fsync_dir", side_effect=OSError("fixture_barrier_failed")):
                        return original(path, raw)
                return original(path, raw)
            with patch.object(evidence, "publish_new", side_effect=publish):
                with self.assertRaises(OSError):
                    f.driver.build(f.base.source)
            ref = evidence.file_ref(f.driver.paths["request-admission"])
            f.authority.reconcile(f.control, target=ref, recheck=lambda: inspect_chain(f.control))
            f.authority.arm(f.control, lambda: inspect_chain(f.control))
            before = snapshot(f)
            with patch.object(coordinator_strict_request, "build_request") as builder:
                with self.assertRaisesRegex(ValueError, "confirmation_unavailable"):
                    f.driver.build(f.base.source)
                builder.assert_not_called()
            self.assertEqual(snapshot(f), before)
            self.assertFalse(Path(f.paths["request"]).exists())

    def test_lost_observation_response_queries_original_intent(self):
        with flow() as f:
            original = f.adapters.observe
            def observe(*args):
                original(*args)
                raise ConnectionError("fixture_observation_reply_lost")
            with patch.object(f.adapters, "observe", side_effect=observe):
                with self.assertRaises(ConnectionError):
                    f.run_flow()
            f.run_flow()
            self.assertEqual(f.adapters.calls["query_observation"], 1)
            self.assert_once(f)

    def test_original_coordinator_queries_final_evidence_after_reply_loss(self):
        with flow() as f:
            original = f.adapters.final_evidence
            def produce(*args):
                original(*args)
                raise ConnectionError("fixture_final_evidence_reply_lost")
            with patch.object(f.adapters, "final_evidence", side_effect=produce):
                with self.assertRaises(ConnectionError):
                    f.run_flow()
            f.run_flow()
            self.assertEqual(f.adapters.calls["query_final_evidence"], 1)
            self.assert_once(f)

    def test_intent_before_transport_acceptance_unknown_is_never_resubmitted(self):
        with flow() as f:
            with patch.object(f.adapters, "submit", side_effect=ConnectionError("fixture_transport_unknown")) as submit:
                with self.assertRaises(ConnectionError):
                    f.run_flow()
                submit.assert_called_once()
            before = snapshot(f)
            for _ in range(3):
                f.driver.drain()
            self.assertEqual(f.adapters.calls["submit_fields"], 0)
            self.assertGreater(f.adapters.calls["query_fields"], 0)
            self.assertEqual(snapshot(f), before)
            self.assertEqual(diagnostic(f)["state"], "pending_contract_fields_ready")

    def test_unknown_delivery_for_both_reviews_uses_same_id_without_new_turn(self):
        for stage in ("contract", "readiness"):
            with self.subTest(stage=stage), flow() as f:
                f.adapters.delay.add(stage)
                f.driver.publish_caller()
                if stage == "readiness":
                    f.driver.wait_for(EVENTS[2])
                    f.driver.final_readiness()
                f.driver.drain()
                request = f.adapters.submissions[stage]
                for status in ("unknown", "submitted", "input_accepted", "turn_started"):
                    f.adapters.pending[stage] = status
                    f.driver.drain()
                f.adapters.drop_notifications = True
                f.adapters.complete(stage)
                f.run_flow()
                self.assertEqual(f.adapters.submissions[stage], request)
                self.assert_once(f)

    def test_readiness_rejection_never_reaches_builder_or_changes_review(self):
        with flow() as f:
            f.adapters.decisions["readiness"] = "reject"
            with patch.object(coordinator_strict_request, "build_request") as builder:
                with self.assertRaisesRegex(ValueError, "operator_rejected"):
                    f.run_flow()
                before = snapshot(f)
                f.adapters.decisions["readiness"] = "approve"
                with self.assertRaisesRegex(ValueError, "operator_rejected"):
                    f.driver.drain()
                builder.assert_not_called()
            self.assertEqual(snapshot(f), before)
            self.assertEqual(f.adapters.calls["produce_readiness"], 1)
            self.assertFalse(Path(f.paths[EVENTS[3]]).exists())

    def test_deadline_expires_during_unknown_delivery_without_renewal(self):
        with flow() as f:
            f.adapters.delay.add("contract")
            f.driver.publish_caller()
            f.driver.drain()
            before = snapshot(f)
            f.base.clock = evidence.timestamp(f.b["deadline"])
            with self.assertRaisesRegex(ValueError, "attempt_deadline_expired"):
                f.driver.wait_for(EVENTS[2], timeout=0.01)
            self.assertEqual(diagnostic(f)["state"], "blocked_deadline_exceeded")
            self.assertEqual(snapshot(f), before)
            self.assertEqual(f.adapters.calls["submit_contract"], 1)

    def test_notification_storm_yields_and_wait_stays_bounded(self):
        with flow() as f:
            def storm():
                f.driver.notify()
                return False
            with patch.object(f.driver, "advance", side_effect=storm) as advance:
                f.driver.drain()
                self.assertEqual(advance.call_count, 16)
                self.assertTrue(f.driver.requested)
                started = time.monotonic()
                with self.assertRaisesRegex(TimeoutError, "wait_pending"):
                    f.driver.wait_for(EVENTS[2], timeout=0.02, interval=0.01)
                self.assertLess(time.monotonic() - started, 1)
            self.assertFalse(f.driver.running)
            self.assertFalse(Path(f.paths[EVENTS[0]]).exists())

    def test_exit_window_notification_is_serviced_by_next_fixed_path_tick(self):
        with flow() as f:
            f.adapters.delay.add("fields")
            f.driver.publish_caller()
            f.driver.drain()
            self.assertFalse(f.driver.running)
            f.adapters.complete("fields")
            self.assertTrue(f.driver.requested)
            f.run_flow()
            self.assert_once(f)

    def test_concurrent_drains_coalesce_and_close_cannot_release_running_owner(self):
        with flow() as f:
            entered, release = threading.Event(), threading.Event()
            failures = []
            original = f.driver.advance
            def advance():
                entered.set()
                if not release.wait(3):
                    raise TimeoutError("fixture_release_timeout")
                return original()
            def drain():
                try:
                    f.driver.drain()
                except BaseException as exc:
                    failures.append(exc)
            with patch.object(f.driver, "advance", side_effect=advance):
                worker = threading.Thread(target=drain, daemon=True)
                worker.start()
                try:
                    self.assertTrue(entered.wait(2))
                    for _ in range(4):
                        f.driver.drain()
                    with self.assertRaisesRegex(ValueError, "still_running"):
                        f.driver.close()
                    with self.assertRaises(BlockingIOError):
                        OfflineBootstrapDriver(f.control, f.authority, f.adapters)
                finally:
                    release.set()
                    worker.join(3)
            self.assertFalse(worker.is_alive())
            self.assertEqual(failures, [])
            f.run_flow()
            self.assert_once(f)

    def test_closed_driver_ignores_late_callbacks_and_cannot_resume(self):
        with flow() as f:
            callback = f.adapters.notify
            f.driver.close()
            before, sequence = snapshot(f), f.driver.sequence
            callback()
            self.assertEqual(f.driver.sequence, sequence)
            with self.assertRaisesRegex(ValueError, "driver_stopped"):
                f.driver.drain()
            self.assertEqual(snapshot(f), before)

    def test_old_owner_is_fenced_and_new_generation_cannot_implicitly_take_over(self):
        with flow() as f:
            request = f.run_flow()
            before = snapshot(f)
            f.authority.close()
            self.assertEqual(f.authority.query(f.control, request).status, "durability_unverified")
            for action in (lambda: f.authority.arm(f.control, lambda: None),
                           lambda: f.driver.build(f.base.source),
                           lambda: f.driver.downstream(request, Mock())):
                with self.assertRaisesRegex(ValueError, "owner_closed"):
                    action()
            successor_control = replace(f.control, generation="explicit-test-successor")
            successor = AuthorityFixture(f.root / "control", successor_control, f.authority.slots)
            try:
                self.assertFalse(successor.armed)
                self.assertEqual(successor.query(successor_control, request).status, "durability_unverified")
                with self.assertRaisesRegex(ValueError, "generation_mismatch"):
                    successor.arm(f.control, lambda: None)
                # Generation registration/attestation has no production adapter.
                # Lock availability alone must not grant a new driver takeover.
                with self.assertRaisesRegex(ValueError, "bootstrap_control_mismatch"):
                    OfflineBootstrapDriver(successor_control, successor, f.adapters)
            finally:
                successor.close()
            self.assertEqual(snapshot(f), before)

    def test_lock_replacement_blocks_admission_and_confirmation_before_publication(self):
        for name in ("owner", "driver"):
            with self.subTest(lock=name), flow() as f:
                f.ready()
                lock = f.root / "control" / (name + ".lock")
                saved = lock.with_suffix(".saved")
                lock.rename(saved)
                lock.touch(mode=0o600)
                try:
                    with self.assertRaisesRegex(ValueError, "existing_lock_changed"):
                        f.driver.build(f.base.source)
                    if name == "owner":
                        ref = evidence.file_ref(f.paths[EVENTS[3]])
                        self.assertEqual(f.authority.query(f.control, ref).status, "durability_unverified")
                    self.assertFalse(Path(f.paths["request"]).exists())
                finally:
                    # Restore the fixture's ORIGINAL inode, not a production lock.
                    saved.replace(lock)

    def test_failed_reconcile_or_arm_closes_previously_armed_authority(self):
        for action in ("reconcile", "arm"):
            with self.subTest(action=action), flow() as f:
                f.driver.publish_caller()
                def reject():
                    raise ValueError("fixture_recovery_unverified")
                with self.assertRaisesRegex(ValueError, "recovery_unverified"):
                    if action == "arm":
                        f.authority.arm(f.control, reject)
                    else:
                        f.authority.reconcile(f.control, target=f.driver.slot(EVENTS[0]), recheck=reject)
                self.assertFalse(f.authority.armed)
                before = snapshot(f)
                with self.assertRaisesRegex(ValueError, "not_armed"):
                    f.driver.drain()
                self.assertEqual(snapshot(f), before)

    def test_s5_callback_failure_or_reply_loss_never_replays_downstream(self):
        with flow() as f:
            request = f.run_flow()
            callback = Mock(side_effect=ConnectionError("fixture_downstream_unknown"))
            with self.assertRaises(ConnectionError):
                f.driver.downstream(request, callback)
            before = snapshot(f)
            with self.assertRaisesRegex(ValueError, "downstream_query_required"):
                f.driver.downstream(request, callback)
            callback.assert_called_once()
            self.assertEqual(snapshot(f), before)

    def test_s5_control_loss_before_intent_never_calls_downstream(self):
        with flow() as f:
            request = f.run_flow()
            callback = Mock()
            with patch.object(f.authority, "query", side_effect=ConnectionError("fixture_authority_unavailable")):
                with self.assertRaises(ConnectionError):
                    f.driver.downstream(request, callback)
            callback.assert_not_called()
            self.assertIsNone(f.driver.slot("downstream-intent"))

    def test_stop_after_s5_intent_keeps_inflight_action_but_rejects_new_action(self):
        with flow() as f:
            request = f.run_flow()
            seen = []
            def callback(control, intent):
                f.adapters.outside_admission()
                with self.assertRaisesRegex(ValueError, "still_running"):
                    f.driver.close()
                f.driver.stop()
                seen.append(intent)
                return "fixture_inflight_completed"
            self.assertEqual(f.driver.downstream(request, callback), "fixture_inflight_completed")
            with self.assertRaisesRegex(ValueError, "stopped"):
                f.driver.downstream(request, callback)
            self.assertEqual(len(seen), 1)
            self.assertEqual(f.authority.query(f.control, request).status, "confirmed")

    def test_request_commit_stop_race_orders_at_actual_publication_barrier(self):
        with flow() as f:
            f.ready()
            at_barrier, release, stop_called = threading.Event(), threading.Event(), threading.Event()
            results, errors = {}, []
            original = evidence.publish_new
            def publish(path, raw):
                if str(path) != f.paths["request"]:
                    return original(path, raw)
                original_sync = evidence.fsync_dir
                def sync(directory):
                    at_barrier.set()
                    if not release.wait(5):
                        raise TimeoutError("fixture_barrier_timeout")
                    original_sync(directory)
                with patch.object(evidence, "fsync_dir", side_effect=sync):
                    return original(path, raw)
            def build():
                try:
                    results["request"] = f.driver.build(f.base.source)
                except BaseException as exc:
                    errors.append(exc)
            def stop():
                try:
                    stop_called.set()
                    f.authority.stop(f.control)
                    results["stop"] = "durable"
                except BaseException as exc:
                    errors.append(exc)
            with patch.object(evidence, "publish_new", side_effect=publish):
                writer = threading.Thread(target=build, daemon=True)
                stopper = threading.Thread(target=stop, daemon=True)
                writer.start()
                try:
                    self.assertTrue(at_barrier.wait(4))
                    # build() is outside drain(), but still owns the lifecycle
                    # through original builder publication and reply delivery.
                    self.assertFalse(f.driver.running)
                    with self.assertRaisesRegex(ValueError, "still_running"):
                        f.driver.close()
                    with self.assertRaises(BlockingIOError):
                        OfflineBootstrapDriver(f.control, f.authority, f.adapters)
                    ref = evidence.file_ref(f.paths["request"])
                    self.assertEqual(f.authority.query(f.control, ref).status, "durability_unverified")
                    stopper.start()
                    self.assertTrue(stop_called.wait(2))
                    self.assertNotIn("stop", results)
                finally:
                    release.set()
                    writer.join(5)
                    if stopper.ident is not None:
                        stopper.join(5)
            self.assertFalse(writer.is_alive() or stopper.is_alive())
            self.assertEqual(errors, [])
            self.assertEqual(results["stop"], "durable")
            self.assertEqual(f.authority.query(f.control, results["request"]).status, "confirmed")
            callback = Mock()
            with self.assertRaisesRegex(ValueError, "stopped"):
                f.driver.downstream(results["request"], callback)
            callback.assert_not_called()

    def test_late_operator_result_after_stop_is_not_admitted(self):
        with flow() as f:
            f.adapters.delay.add("contract")
            f.driver.publish_caller()
            f.driver.drain()
            f.driver.stop()
            before = snapshot(f)
            with self.assertRaisesRegex(ValueError, "stopped"):
                f.adapters.complete("contract")
            self.assertEqual(snapshot(f), before)
            self.assertIsNone(f.driver.slot("contract_review"))
            self.assertEqual(f.adapters.calls["submit_contract"], 1)

    def test_failed_stop_ack_keeps_driver_and_authority_closed(self):
        with flow() as f:
            request = f.run_flow()
            with patch.object(evidence, "fsync_dir", side_effect=OSError("fixture_stop_ack_unknown")):
                with self.assertRaises(OSError):
                    f.driver.stop()
            self.assertTrue(f.driver.stopping)
            self.assertFalse(f.authority.armed)
            before = snapshot(f)
            callback = Mock()
            with self.assertRaisesRegex(ValueError, "stopped"):
                f.driver.downstream(request, callback)
            with self.assertRaisesRegex(ValueError, "stopped"):
                f.authority.arm(f.control, lambda: None)
            self.assertEqual(snapshot(f), before)
            callback.assert_not_called()

    def test_before_link_request_failure_does_not_reenter_builder(self):
        with flow() as f:
            f.ready()
            original = evidence.publish_new
            def publish(path, raw):
                if str(path) == f.paths["request"]:
                    raise OSError("fixture_before_link")
                return original(path, raw)
            with patch.object(evidence, "publish_new", side_effect=publish):
                with self.assertRaisesRegex(OSError, "before_link"):
                    f.driver.build(f.base.source)
            self.assertFalse(f.authority.armed)
            association = evidence.parse(evidence.pinned(f.driver.slot("request-admission")))
            self.assertEqual(f.authority.query(f.control, association["request"]).status, "not_committed")
            # Even explicit test-only rearm cannot turn an intent into permission
            # to regenerate request bytes, refresh time or invoke the builder.
            f.authority.arm(f.control, lambda: inspect_chain(f.control))
            with patch.object(coordinator_strict_request, "build_request") as builder:
                with self.assertRaisesRegex(ValueError, "confirmation_unavailable"):
                    f.driver.build(f.base.source)
                builder.assert_not_called()

    def test_expired_attempt_cannot_rearm_through_recovery_check(self):
        with flow() as f:
            request = f.run_flow()
            before = snapshot(f)
            f.base.clock = evidence.timestamp(f.b["deadline"])
            with self.assertRaisesRegex(ValueError, "attempt_deadline_expired"):
                f.authority.reconcile(f.control, target=request, recheck=lambda: inspect_chain(f.control))
            self.assertFalse(f.authority.armed)
            with self.assertRaisesRegex(ValueError, "attempt_deadline_expired"):
                f.authority.arm(f.control, lambda: inspect_chain(f.control))
            self.assertFalse(f.authority.armed)
            self.assertEqual(snapshot(f), before)


if __name__ == "__main__":
    unittest.main()

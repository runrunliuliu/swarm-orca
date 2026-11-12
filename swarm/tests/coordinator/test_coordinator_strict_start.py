"""Offline handshake integration: real gates/log reader + mocked native service only."""
import copy
from datetime import datetime, timedelta, timezone
import io
import json
import os
from pathlib import Path
import time
import subprocess
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

from coordinator_io import file_ref, parse, pinned, publish_new, timestamp
from coordinator_launch import main
from coordinator_strict_start import plan, publish, wait_and_create
import coordinator.test_coordinator_strict as strict_tests


class GatePublicationBusyTests(unittest.TestCase):
    """A busy read after an admitted gate must not poison the one-shot gate slot."""

    def test_a_busy_checkpoint_does_not_write_a_failure_bundle(self):
        """attempt26: the gate verified, then a busy read wrote ok=false into gate-ready.json."""
        from unittest.mock import patch
        from observation_budget import ObservationBusy

        calls = []

        def busy_twice(*_args, **_kwargs):
            calls.append(1)
            if len(calls) < 3:
                raise ObservationBusy()

        with patch("coordinator_strict_start.checkpoint", side_effect=busy_twice):
            from coordinator_strict_start import checkpoint_until
            checkpoint_until(time.monotonic() + 5)
        self.assertEqual(len(calls), 3)

    def test_the_publication_path_uses_the_bounded_retry(self):
        """The gate-publication block must not call the bare checkpoint()."""
        import inspect
        import coordinator_strict_start as module

        source = inspect.getsource(module)
        block = source.split("publish_new(gate_path, receipt)", 1)[1].split("require(timestamp(ready", 1)[0]
        self.assertIn("checkpoint_until(", block)
        self.assertNotIn("\n            checkpoint()", block)


class WaiterLivenessTests(unittest.TestCase):
    """The one live waiter must survive a busy owner but never a closed window."""

    def test_a_busy_checkpoint_is_retried_until_the_owner_answers(self):
        from unittest.mock import patch
        from observation_budget import ObservationBusy
        from coordinator_strict_start import checkpoint_until

        calls = []

        def busy_twice():
            calls.append(1)
            if len(calls) < 3:
                raise ObservationBusy()

        with patch("coordinator_strict_start.checkpoint", side_effect=busy_twice):
            checkpoint_until(time.monotonic() + 5)
        self.assertEqual(len(calls), 3)

    def test_an_expired_window_still_raises_instead_of_spinning(self):
        from unittest.mock import patch
        from observation_budget import ObservationBusy
        from coordinator_strict_start import checkpoint_until

        with patch("coordinator_strict_start.checkpoint", side_effect=ObservationBusy()):
            with self.assertRaises(ObservationBusy):
                checkpoint_until(time.monotonic() - 1)


class StrictStartTests(unittest.TestCase):
    def setUp(self):
        fixture = strict_tests.StrictCoordinatorTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        self.strict = fixture
        self.gate = fixture.fixture
        self.root = fixture.trae.root
        self.directory = fixture.trae.bootstrap / "attempt-1"
        self.directory.mkdir()
        initial = fixture.proof_query(None, None, ["orchestration", "strict-caller-check"])
        self.config = {
            "schema_version": 1, "contract": self.gate.ref("contract.json", self.gate.contract),
            "caller_receipt": self.gate.ref("caller.json", {"ok": True, "result": initial,
                "_meta": {"runtimeId": "runtime_test"}}),
            "readiness_evidence": [self.gate.contract["skill_read_evidence"]],
            "directory": str(self.directory), "objective": "approved objective ' $(not executed)",
            "max_workers": 2, "request_id": "11111111-2222-4333-8444-555555555555",
            "deadline": (datetime.now(timezone.utc) + timedelta(seconds=120)).isoformat()}
        self.ref = self.gate.ref("start.json", self.config)
        self.calls, self.run, self.failure, self.post_check = [], None, None, None
        self.on_wait = self.operator_publish
        for target in ("coordinator_strict_start.native", "coordinator_strict.native"):
            mock = patch(target, side_effect=self.query)
            mock.start()
            self.addCleanup(mock.stop)
        self.clock = (datetime.now(timezone.utc) + timedelta(seconds=1)).replace(microsecond=250000)
        self.create_delay = self.response_delay = 0
        for target in ("coordinator_strict_start.now", "coordinator_strict.now", "coordinator_startup.now"):
            clock = patch(target, side_effect=lambda: self.clock.isoformat())
            clock.start()
            self.addCleanup(clock.stop)
        sleeper = patch("coordinator_strict_start.time.sleep", side_effect=self.sleep)
        sleeper.start()
        self.addCleanup(sleeper.stop)
        os.environ["ORCA_TERMINAL_HANDLE"] = "term_test"

    def sleep(self, seconds):
        self.clock += timedelta(seconds=seconds)
        if not (self.directory / "gate-ready.json").exists():
            self.on_wait()

    def query(self, cli, runtime, args):
        self.calls.append(args)
        if args == ["orchestration", "run-current"]:
            return {"run": copy.deepcopy(self.run)}
        if args[:2] == ["orchestration", "run-create"]:
            self.assertIn("--strict-coordinator", args)
            self.assertNotIn("--from", args)
            self.assertEqual(args[args.index("--retry-request") + 1], self.config["request_id"])
            self.clock += timedelta(seconds=self.create_delay)
            self.create_time = self.clock
            self.run = {"id": "run_created", "objective": self.config["objective"],
                        "coordinator_handle": "term_test", "consumer_generation": 1,
                        "created_at": self.clock.isoformat(timespec="seconds").replace("+00:00", "Z")}
            self.clock += timedelta(seconds=self.response_delay)
            if self.failure == "timeout":
                raise subprocess.TimeoutExpired("private", 15)
            if self.failure == "late":
                self.run["created_at"] = self.config["deadline"]
            return {"coordinatorPolicy": "strict-v1", "run": copy.deepcopy(self.run)}
        if args[:2] == ["orchestration", "run-show"]:
            result = copy.deepcopy(self.run)
            if self.failure == "owner":
                result["coordinator_handle"] = "other"
            return {"run": result}
        return self.strict.proof_query(cli, runtime, args)

    def operator_publish(self):
        ready_ref = file_ref(self.directory / "ready.json")
        with patch.dict(os.environ, {"ORCA_TERMINAL_HANDLE": "term_operator"}):
            publish(self.ref, ready_ref)
        if self.post_check:
            self.post_check()

    def creates(self):
        return [q for q in self.calls if q[:2] == ["orchestration", "run-create"]]

    def test_full_handshake_wait_publish_check_create_readback_without_model_turn(self):
        result = wait_and_create(self.ref)
        self.assertTrue(result["ok"])
        self.assertFalse(result["native_gate_atomic"])
        self.assertTrue(result["first_dispatch_gates_required"])
        self.assertEqual(len(self.creates()), 1)
        self.assertTrue((self.directory / "create-response.json").is_file())
        self.assertTrue((self.directory / "created.json").is_file())
        self.assertFalse(any("worker-start" in q or "run-use" in q for q in self.calls))

    def test_second_precision_creation_waits_past_fractional_gate_and_passes_dispatch(self):
        result = wait_and_create(self.ref)
        receipt = parse(pinned(result["gate"]))
        self.assertNotEqual(timestamp(receipt["completed_at"]).microsecond, 0)
        created = timestamp(result["run"]["created_at"])
        self.assertGreater(created, timestamp(receipt["completed_at"]))
        self.assertLess((created - timestamp(receipt["completed_at"])).total_seconds(), 1)
        self.assertEqual(created.microsecond, 0)
        self.gate.run = result["run"]
        self.gate.workers["scope"]["run"] = result["run"]["id"]
        self.gate.contract["run"] = {"id": result["run"]["id"], "generation": 1}
        with patch.dict(os.environ, {"ORCA_TERMINAL_HANDLE": "term_operator"}):
            dispatch = self.gate.gate(phase="first-dispatch", previous=result["gate"])
        self.assertTrue(dispatch["ok"])

    def test_same_second_expired_commit_is_not_accepted_or_retried(self):
        def delay_to_expired_commit():
            receipt = parse(pinned(file_ref(self.directory / "operator-gate.json")))
            cutoff = timestamp(receipt["valid_until"])
            self.clock = cutoff - timedelta(seconds=2)
            self.create_delay = 2.25
        self.post_check = delay_to_expired_commit
        with self.assertRaisesRegex(ValueError, "requires_reconciliation"):
            wait_and_create(self.ref)
        receipt = parse(pinned(file_ref(self.directory / "operator-gate.json")))
        self.assertLess(timestamp(self.run["created_at"]), timestamp(receipt["valid_until"]))
        self.assertGreater(self.create_time, timestamp(receipt["valid_until"]))
        self.assertEqual(len(self.creates()), 1)
        self.assertTrue((self.directory / "create-response.json").exists())
        self.assertFalse((self.directory / "created.json").exists())

    def test_timely_timestamp_with_response_after_ttl_requires_reconciliation(self):
        self.response_delay = 61
        with self.assertRaisesRegex(ValueError, "requires_reconciliation"):
            wait_and_create(self.ref)
        receipt = parse(pinned(file_ref(self.directory / "operator-gate.json")))
        self.assertLess(self.create_time, timestamp(receipt["valid_until"]))
        self.assertEqual(len(self.creates()), 1)
        self.assertFalse((self.directory / "created.json").exists())

    def test_timely_timestamp_with_response_after_config_deadline_is_not_success(self):
        self.config["deadline"] = (self.clock + timedelta(seconds=10)).isoformat()
        self.ref = self.gate.ref("short-start.json", self.config)
        self.response_delay = 11
        with self.assertRaisesRegex(ValueError, "requires_reconciliation"):
            wait_and_create(self.ref)
        self.assertEqual(len(self.creates()), 1)
        self.assertFalse((self.directory / "created.json").exists())

    def test_gate_pin_change_during_second_alignment_never_creates(self):
        def tamper(seconds):
            self.clock += timedelta(seconds=seconds)
            if not (self.directory / "gate-ready.json").exists():
                self.on_wait()
            else:
                (self.directory / "operator-gate.json").write_text("changed")
        with patch("coordinator_strict_start.time.sleep", side_effect=tamper):
            with self.assertRaisesRegex(ValueError, "file_pin_changed"):
                wait_and_create(self.ref)
        self.assertEqual(self.creates(), [])

    def test_last_partial_second_is_rejected_before_create(self):
        def near_expiry():
            receipt = parse(pinned(file_ref(self.directory / "operator-gate.json")))
            self.clock = timestamp(receipt["valid_until"]) - timedelta(seconds=0.1)
        self.post_check = near_expiry
        with self.assertRaisesRegex(ValueError, "receipt_stale"):
            wait_and_create(self.ref)
        self.assertEqual(self.creates(), [])

    def test_no_full_second_in_gate_stops_without_create(self):
        def short_gate():
            self.rewrite_published_gate(valid_until=(self.clock + timedelta(seconds=0.4)).isoformat())
        self.post_check = short_gate
        with self.assertRaisesRegex(ValueError, "no_safe_creation_window"):
            wait_and_create(self.ref)
        self.assertEqual(self.creates(), [])

    def test_deadline_expiring_while_waiting_for_safe_second_never_creates(self):
        def expire(_):
            if not (self.directory / "gate-ready.json").exists():
                self.on_wait()
            else:
                self.clock = timestamp(self.config["deadline"])
        with patch("coordinator_strict_start.time.sleep", side_effect=expire):
            with self.assertRaisesRegex(ValueError, "receipt_stale"):
                wait_and_create(self.ref)
        self.assertEqual(self.creates(), [])

    def test_plan_has_absolute_invocation_and_no_effects(self):
        result = plan(self.ref)
        self.assertTrue(Path(result["wait_argv"][2]).is_absolute())
        self.assertIn("--execute", result["wait_argv"])
        publish = result["operator_publish_argv"]
        self.assertEqual(publish[publish.index("--ready") + 1], str(self.directory / "ready.json"))
        self.assertEqual(result["operator_publish_ready_path"], str(self.directory / "ready.json"))
        self.assertEqual(result["operator_publish_expected_bundle"]["path"],
                         str(self.directory / "gate-ready.json"))
        self.assertEqual(result["operator_publish_contract"], self.config["contract"])
        self.assertEqual(result["operator_publish_identity"], self.gate.contract["operator"])
        self.assertFalse(result["operator_context_checked"])
        self.assertIn("--check-operator-context", result["operator_check_argv"])
        self.assertNotIn("--execute", result["operator_check_argv"])
        for instruction in ("No ordinary-shell fallback", "Do not set or borrow ORCA_TERMINAL_HANDLE",
                            "before the Coordinator starts its waiter", "Do not start a new attempt"):
            self.assertTrue(any(instruction in text for text in result["requirements"]))
        self.assertEqual([item["wait_for"] for item in result["phase_waits"]],
                         ["ready.json", "gate-ready.json"])
        self.assertTrue(any("tui-idle" in item["note"] for item in result["phase_waits"]))
        self.assertTrue(any("operator_publish_argv" in requirement
                            for requirement in result["requirements"]))
        self.assertEqual(self.calls, [])
        self.assertEqual(list(self.directory.iterdir()), [])

    def test_operator_context_check_is_read_only_and_rejects_missing_or_wrong_caller(self):
        argv = plan(self.ref)["operator_check_argv"][3:]
        for caller, error in ((None, "operator_mailbox_native_context_required"),
                              ("term_other", "operator_native_context_mismatch"),
                              ("term_operator", None)):
            out = io.StringIO()
            with self.subTest(caller=caller), patch.dict(os.environ, {}, clear=True), redirect_stdout(out):
                if caller is not None:
                    os.environ["ORCA_TERMINAL_HANDLE"] = caller
                code = main(argv)
            result = json.loads(out.getvalue())
            self.assertEqual(code, 2 if error else 0)
            if error:
                self.assertEqual(result["error"], error)
            else:
                self.assertTrue(result["operator_context_checked"])
                self.assertFalse(result["execution_authorized"])
            self.assertEqual(list(self.directory.iterdir()), [])
            self.assertEqual(self.calls, [])
            self.assertEqual(self.gate.queries, [])

    def test_context_check_cannot_execute_or_bypass_an_existing_attempt(self):
        for mode, flags, error in (
                ("strict-start-plan", ["--execute"], "strict_start_plan_is_read_only"),
                ("strict-start-wait", [], "strict_start_context_check_is_plan_only"),
                ("strict-start-publish", ["--execute"], "strict_start_context_check_is_plan_only")):
            out = io.StringIO()
            with self.subTest(mode=mode), redirect_stdout(out):
                code = main([mode, "--config", self.ref["path"], "--config-sha256", self.ref["sha256"],
                             "--check-operator-context", *flags])
            self.assertEqual(code, 2)
            self.assertEqual(json.loads(out.getvalue())["error"], error)
            self.assertEqual(list(self.directory.iterdir()), [])
        marker = self.directory / "publication-intent.json"
        publish_new(marker, {"unknown_prior_attempt": True})
        original = marker.read_bytes()
        with patch.dict(os.environ, ORCA_TERMINAL_HANDLE="term_operator"), \
                self.assertRaisesRegex(ValueError, "strict_start_attempt_already_started"):
            plan(self.ref, check_operator_context=True)
        self.assertEqual(marker.read_bytes(), original)
        self.assertEqual(self.calls, [])
        self.assertEqual(self.gate.queries, [])

    def test_publish_checks_context_before_readiness_or_publication_intent(self):
        # A successful earlier context check is not a lease for the later publisher.
        with patch.dict(os.environ, ORCA_TERMINAL_HANDLE="term_operator"):
            self.assertTrue(plan(self.ref, check_operator_context=True)["operator_context_checked"])
        for caller, error in ((None, "operator_mailbox_native_context_required"),
                              ("term_other", "operator_native_context_mismatch")):
            out = io.StringIO()
            with self.subTest(caller=caller), patch.dict(os.environ, {}, clear=True), redirect_stdout(out):
                if caller is not None:
                    os.environ["ORCA_TERMINAL_HANDLE"] = caller
                code = main(["strict-start-publish", "--config", self.ref["path"],
                             "--config-sha256", self.ref["sha256"], "--execute"])
            self.assertEqual(code, 2)
            self.assertEqual(json.loads(out.getvalue())["error"], error)
            self.assertEqual(list(self.directory.iterdir()), [])
            self.assertEqual(self.calls, [])
            self.assertEqual(self.gate.queries, [])

    def test_invalid_start_window_stops_plan_wait_and_publish_before_effects(self):
        for remaining, code in ((-1, "strict_start_deadline_expired"),
                                (0, "strict_start_deadline_expired"),
                                (900.001, "strict_start_wait_must_be_bounded_to_900_seconds")):
            self.config["deadline"] = (self.clock + timedelta(seconds=remaining)).isoformat()
            ref = self.gate.ref("deadline-start.json", self.config)
            for operation in (plan, wait_and_create, lambda r: publish(r, {})):
                with self.subTest(remaining=remaining, operation=operation):
                    with self.assertRaisesRegex(ValueError, "^" + code + "$"):
                        operation(ref)
                    self.assertEqual(list(self.directory.iterdir()), [])
                    self.assertEqual(self.calls, [])
                    self.assertEqual(self.gate.queries, [])

    def test_plan_accepts_exact_900_and_positive_fractional_window(self):
        for remaining in (900, 0.001):
            self.config["deadline"] = (self.clock + timedelta(seconds=remaining)).isoformat()
            ref = self.gate.ref("deadline-start.json", self.config)
            self.assertTrue(plan(ref)["ok"])
        self.assertEqual(self.calls, [])
        self.assertEqual(list(self.directory.iterdir()), [])

    def test_consumed_attempt_takes_precedence_over_expired_deadline_without_effects(self):
        for name, code in (("create-intent.json", "create_requires_reconciliation"),
                           ("create-response.json", "create_requires_reconciliation"),
                           ("created.json", "create_requires_reconciliation"),
                           ("ready.json", "attempt_already_started"),
                           ("publication-intent.json", "attempt_already_started"),
                           ("operator-gate.json", "attempt_already_started"),
                           ("gate-ready.json", "attempt_already_started")):
            attempt = self.directory / name.removesuffix(".json")
            attempt.mkdir()
            publish_new(attempt / name, {"unverified_prior_outcome": True})
            config = dict(self.config, directory=str(attempt), deadline=self.clock.isoformat())
            ref = self.gate.ref(name + "-config.json", config)
            before = {f.name: f.read_bytes() for f in attempt.iterdir()}
            for operation in (plan, wait_and_create):
                with self.subTest(name=name, operation=operation):
                    with self.assertRaisesRegex(ValueError, code):
                        operation(ref)
                    self.assertEqual(before, {f.name: f.read_bytes() for f in attempt.iterdir()})
                    self.assertEqual(self.calls, [])
                    self.assertEqual(self.gate.queries, [])

    def test_dangling_attempt_marker_is_not_treated_as_absent(self):
        marker = self.directory / "create-intent.json"
        marker.symlink_to(self.directory / "missing-target")
        for operation in (plan, wait_and_create):
            with self.assertRaisesRegex(ValueError, "create_requires_reconciliation"):
                operation(self.ref)
        self.assertTrue(marker.is_symlink())
        self.assertEqual(self.calls, [])

    def test_attempt_marker_access_denial_stops_without_effects(self):
        original_lstat = Path.lstat

        def deny(target):
            if target == self.directory / "create-intent.json":
                raise PermissionError("denied")
            return original_lstat(target)

        with patch.object(Path, "lstat", deny):
            for operation in (plan, wait_and_create):
                with self.assertRaises(PermissionError):
                    operation(self.ref)
        self.assertEqual(list(self.directory.iterdir()), [])
        self.assertEqual(self.calls, [])

    def test_clean_attempt_still_checks_native_existing_run_before_readiness(self):
        self.run = {"id": "run_existing"}
        with self.assertRaisesRegex(ValueError, "strict_start_existing_run_requires_reconciliation"):
            wait_and_create(self.ref)
        self.assertEqual(self.creates(), [])
        self.assertEqual(list(self.directory.iterdir()), [])

    def test_explicit_execute_required_and_safe_error(self):
        for mode in ("strict-start-wait", "strict-start-publish"):
            out = io.StringIO()
            with redirect_stdout(out):
                code = main([mode, "--config", self.ref["path"], "--config-sha256", self.ref["sha256"]])
            self.assertEqual(code, 2)
            self.assertEqual(json.loads(out.getvalue())["error"], "strict_start_explicit_execute_required")
        self.assertEqual(self.calls, [])

    def test_operator_cannot_publish_before_waiter_readiness(self):
        with patch.dict(os.environ, ORCA_TERMINAL_HANDLE="term_operator"), self.assertRaises(OSError):
            publish(self.ref, {"path": str(self.directory / "ready.json"), "sha256": "0" * 64})
        self.assertFalse((self.directory / "gate-ready.json").exists())
        self.assertEqual(self.creates(), [])

    def test_diagnostics_cannot_wake_waiter(self):
        (self.directory / "old-session-gate.json").write_text('{"ok":false}')
        result = wait_and_create(self.ref)
        self.assertTrue(result["ok"])

    def test_no_overwrite_no_second_create_or_reuse_of_ready(self):
        wait_and_create(self.ref)
        original = (self.directory / "gate-ready.json").read_bytes()
        with self.assertRaisesRegex(ValueError, "create_requires_reconciliation"):
            wait_and_create(self.ref)
        with patch.dict(os.environ, {"ORCA_TERMINAL_HANDLE": "term_operator"}), self.assertRaises(FileExistsError):
            publish(self.ref, file_ref(self.directory / "ready.json"))
        self.assertEqual((self.directory / "gate-ready.json").read_bytes(), original)
        self.assertEqual(len(self.creates()), 1)

    def test_atomic_publisher_never_replaces_existing_bytes(self):
        target = self.directory / "publication.json"
        publish_new(target, {"ok": False})
        with self.assertRaises(FileExistsError):
            publish_new(target, {"ok": True})
        self.assertEqual(json.loads(target.read_text()), {"ok": False})

    def test_wrong_attempt_or_failed_publication_stops_without_create(self):
        self.on_wait = lambda: publish_new(self.directory / "gate-ready.json", {"ok": False})
        with self.assertRaisesRegex(ValueError, "publication_mismatch"):
            wait_and_create(self.ref)
        self.assertEqual(self.creates(), [])

    def test_gate_pin_change_rejected(self):
        self.post_check = lambda: (self.directory / "operator-gate.json").write_text("changed")
        with self.assertRaisesRegex(ValueError, "file_pin_changed"):
            wait_and_create(self.ref)
        self.assertEqual(self.creates(), [])

    def rewrite_published_gate(self, **changes):
        # Deliberately simulate bad producer input; production never overwrites.
        gate_path = self.directory / "operator-gate.json"
        receipt = json.loads(gate_path.read_text())
        receipt.update(changes)
        gate_path.write_text(json.dumps(receipt))
        bundle_path = self.directory / "gate-ready.json"
        bundle = json.loads(bundle_path.read_text())
        bundle["gate"] = file_ref(gate_path)
        bundle_path.write_text(json.dumps(bundle))

    def test_gate_predating_readiness_rejected_even_with_matching_hash(self):
        self.post_check = lambda: self.rewrite_published_gate(started_at="2000-01-01T00:00:00+00:00")
        with self.assertRaisesRegex(ValueError, "predates_readiness"):
            wait_and_create(self.ref)
        self.assertEqual(self.creates(), [])

    def test_gate_expired_after_publication_never_creates(self):
        self.post_check = lambda: self.rewrite_published_gate(valid_until="2000-01-01T00:00:00+00:00")
        with self.assertRaisesRegex(ValueError, "receipt_stale"):
            wait_and_create(self.ref)
        self.assertEqual(self.creates(), [])

    def test_wrong_publisher_after_readiness_leaves_no_publication(self):
        self.on_wait = lambda: publish(self.ref, file_ref(self.directory / "ready.json"))
        with self.assertRaisesRegex(ValueError, "operator_native_context_mismatch"):
            wait_and_create(self.ref)
        self.assertEqual([p.name for p in self.directory.iterdir()], ["ready.json"])
        self.assertEqual(self.creates(), [])

    def test_operator_failure_publishes_terminal_failure_not_success(self):
        self.gate.operator["incarnationId"] = "changed"

        def failed_gate():
            with self.assertRaisesRegex(ValueError, "publication_failed"):
                self.operator_publish()
        self.on_wait = failed_gate
        with self.assertRaisesRegex(ValueError, "publication_mismatch"):
            wait_and_create(self.ref)
        publication = json.loads((self.directory / "gate-ready.json").read_text())
        self.assertFalse(publication["ok"])
        self.assertEqual(publication["error"], "operator_identity_changed")
        original = (self.directory / "gate-ready.json").read_bytes()
        with self.assertRaises(FileExistsError):
            self.operator_publish()
        self.assertEqual((self.directory / "gate-ready.json").read_bytes(), original)
        self.assertEqual(self.creates(), [])

    def test_create_intent_collision_never_sends_mutation(self):
        publish_new(self.directory / "create-intent.json", {"unknown_prior_attempt": True})
        with self.assertRaisesRegex(ValueError, "create_requires_reconciliation"):
            wait_and_create(self.ref)
        self.assertEqual(self.calls, [])
        self.assertFalse((self.directory / "ready.json").exists())
        self.assertEqual(self.creates(), [])

    def test_racing_create_intent_still_never_overwrites_or_sends_mutation(self):
        self.post_check = lambda: publish_new(self.directory / "create-intent.json",
                                             {"unknown_prior_attempt": True})
        with self.assertRaises(FileExistsError):
            wait_and_create(self.ref)
        self.assertEqual(json.loads((self.directory / "create-intent.json").read_text()),
                         {"unknown_prior_attempt": True})
        self.assertEqual(self.creates(), [])

    def test_publication_denial_or_collision_stops_without_another_write(self):
        for error in (PermissionError, FileExistsError):
            for denied_name in ("operator-gate.json", "gate-ready.json"):
                with self.subTest(error=error.__name__, path=denied_name):
                    attempt = self.directory / (error.__name__ + "-" + denied_name)
                    attempt.mkdir()
                    config = dict(self.config, directory=str(attempt))
                    ref = self.gate.ref(attempt.name + "-config.json", config)
                    writes = []

                    def deny(target, value):
                        writes.append(target.name)
                        if target.name == denied_name:
                            raise error("publication unavailable")
                        return publish_new(target, value)

                    def operator():
                        with patch.dict(os.environ, {"ORCA_TERMINAL_HANDLE": "term_operator"}):
                            publish(ref, file_ref(attempt / "ready.json"))

                    self.on_wait = operator
                    with patch("coordinator_strict_start.publish_new", side_effect=deny):
                        with self.assertRaises(error):
                            wait_and_create(ref)
                    expected = ["ready.json", "publication-intent.json", "operator-gate.json"]
                    if denied_name == "gate-ready.json":
                        expected.append("gate-ready.json")
                    self.assertEqual(writes, expected)
                    self.assertFalse((attempt / "gate-ready.json").exists())
                    self.assertEqual(self.creates(), [])

    def test_valid_ready_hash_is_required_for_operator_publication(self):
        def bad_pin():
            with patch.dict(os.environ, {"ORCA_TERMINAL_HANDLE": "term_operator"}):
                publish(self.ref, {"path": str(self.directory / "ready.json"), "sha256": "0" * 64})
        self.on_wait = bad_pin
        with self.assertRaisesRegex(ValueError, "file_pin_changed"):
            wait_and_create(self.ref)
        self.assertFalse((self.directory / "gate-ready.json").exists())
        self.assertEqual(self.creates(), [])

    def test_changed_input_during_wait_stops(self):
        self.post_check = lambda: Path(self.config["readiness_evidence"][0]["path"]).write_text("changed")
        with self.assertRaisesRegex(ValueError, "file_pin_changed"):
            wait_and_create(self.ref)
        self.assertEqual(self.creates(), [])

    def test_unknown_create_stops_with_request_id_and_never_retries(self):
        self.failure = "timeout"
        with self.assertRaisesRegex(ValueError, "requires_reconciliation"):
            wait_and_create(self.ref)
        self.assertEqual(len(self.creates()), 1)
        self.assertIsNotNone(self.run)  # Server committed before losing response.
        intent = json.loads((self.directory / "create-intent.json").read_text())
        self.assertEqual(intent["request_id"], self.config["request_id"])
        self.assertFalse((self.directory / "created.json").exists())

    def test_unknown_create_cannot_replay_after_deadline_or_native_run_release(self):
        self.failure = "timeout"
        with self.assertRaisesRegex(ValueError, "create_requires_reconciliation"):
            wait_and_create(self.ref)
        original = {f.name: f.read_bytes() for f in self.directory.iterdir()}
        calls = copy.deepcopy(self.calls)
        self.clock = timestamp(self.config["deadline"]) + timedelta(seconds=1)
        self.run = None  # Even later native cleanup would not authorize replay.
        for operation in (plan, wait_and_create):
            with self.assertRaisesRegex(ValueError, "create_requires_reconciliation"):
                operation(self.ref)
        self.assertEqual(original, {f.name: f.read_bytes() for f in self.directory.iterdir()})
        self.assertEqual(self.calls, calls)
        self.assertEqual(len(self.creates()), 1)

    def test_wrong_owner_readback_is_not_success_or_automatic_cleanup(self):
        self.failure = "owner"
        with self.assertRaisesRegex(ValueError, "requires_reconciliation"):
            wait_and_create(self.ref)
        self.assertEqual(len(self.creates()), 1)
        self.assertTrue((self.directory / "create-response.json").exists())
        self.assertFalse((self.directory / "created.json").exists())

    def test_late_creation_is_preserved_for_reconciliation_not_accepted(self):
        self.failure = "late"
        with self.assertRaisesRegex(ValueError, "requires_reconciliation"):
            wait_and_create(self.ref)
        self.assertEqual(len(self.creates()), 1)

    def test_wait_is_bounded_and_cannot_run_in_operator_shell(self):
        os.environ["ORCA_TERMINAL_HANDLE"] = "term_operator"
        with self.assertRaisesRegex(ValueError, "native_context"):
            wait_and_create(self.ref)
        self.assertEqual(self.creates(), [])

    def test_wait_expiry_without_publication_never_creates(self):
        with patch("coordinator_strict_start.time.monotonic", side_effect=[100, 1000]):
            with self.assertRaisesRegex(ValueError, "wait_expired"):
                wait_and_create(self.ref)
        self.assertEqual(self.creates(), [])

    def test_observation_is_not_skill_read_evidence(self):
        fake = self.gate.ref("not-skill.json", {"thread_id": "s", "effective": {}, "log_path": "p"})
        self.gate.contract["skill_read_evidence"] = fake
        self.config["contract"] = self.gate.ref("contract-new.json", self.gate.contract)
        self.config["readiness_evidence"] = [fake]
        ref = self.gate.ref("bad-start.json", self.config)
        with self.assertRaisesRegex(ValueError, "skill_evidence_is_observation"):
            plan(ref)


if __name__ == "__main__":
    unittest.main()

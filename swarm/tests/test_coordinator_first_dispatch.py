"""Real gate/planner and file fences; native dispatch is a recording fake only."""

import contextlib
import copy
from datetime import timedelta
import io
import json
import os
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

import coordinator_first_dispatch as first
from coordinator_io import file_ref, now, pinned, timestamp
from coordinator_launch import main
from coordinator_worker_plan import build_plan
from coordinator_worker_profiles import PROFILES
import test_coordinator_startup as startup
import test_trae_tui as tui
from trae_coordinator import TUI_ADAPTER


class FirstDispatchTests(unittest.TestCase):
    def setUp(self):
        self.s = startup.StartupGateTests()
        self.s.setUp()
        self.addCleanup(self.s.doCleanups)
        self.s.use_v2(receipt_ttl=180)
        self.s.prepare_dispatch()
        self.operator = self.s.ref("operator-first.json", self.s.gate(
            phase="first-dispatch", previous=self.s.prior))
        self.contract_ref = self.s.contract_ref
        self.state = self.s.fixture.bootstrap / "first-dispatch"
        self.state.mkdir(mode=0o700)
        self.request = dict(schema_version=2, cli=self.s.contract["cli"]["path"],
            run="run_test", task="task_test", model="gpt-5.5", timeout_ms=1000,
            profiles_sha256=file_ref(PROFILES)["sha256"],
            placement=dict(kind="existing", worktree="id:workspace_test"),
            first_dispatch=dict(contract=self.contract_ref, operator_gate=self.operator,
                                state_root=str(self.state)))
        self.calls = []
        self.timeout = False
        self.late = False
        self.clock = None
        self.env = patch.dict(os.environ, ORCA_TERMINAL_HANDLE="term_test")
        self.env.start()
        self.addCleanup(self.env.stop)

    def ref(self):
        return self.s.ref("worker-request.json", self.request)

    def slot(self):
        return {"runtime": self.s.contract["runtime"], "run": "run_test", "generation": 1}

    def package(self, *, prefix="first-dispatch", slot=None, package_extra=None, worker=None):
        if worker is None:
            worker = copy.deepcopy(self.request)
            del worker["first_dispatch"]
        worker_ref = self.s.ref(prefix + "-worker.json", worker)
        package = {
            "schema_version": 1,
            "kind": first.PACKAGE_KIND,
            "contract": self.contract_ref,
            "worker": worker_ref,
            "state_root": str(self.state),
            "slot": self.slot() if slot is None else slot,
        }
        package.update(package_extra or {})
        return self.s.ref(prefix + "-package.json", package), worker_ref

    def prepared(self, *, prefix="first-dispatch", **options):
        package_ref, worker_ref = self.package(prefix=prefix, **options)
        ready_ref = self.s.ref(prefix + "-ready.json", first.prepare_package(package_ref))
        return package_ref, ready_ref, worker_ref

    def call(self, cli, runtime, args, *, timeout_seconds):
        self.calls.append((cli, runtime, args, timeout_seconds))
        self.assertTrue((self.state / "dispatch-intent.json").is_file())
        if self.timeout:
            raise subprocess.TimeoutExpired("fake-start", 1)
        if self.late:
            self.clock.side_effect = None
            self.clock.return_value = (timestamp(now()) + timedelta(seconds=500)).isoformat()
        return dict(state="ready", stage="input_accepted", runId="run_test",
                    taskId="task_test", dispatchId="ctx_test",
                    mutation={"requestId": args[args.index("--retry-request") + 1]})

    def execute(self):
        return first.dispatch(self.ref(), call=self.call)

    def query(self, cli, runtime, args, *, timeout_seconds=15):
        self.assertEqual(args[:3], ["worktree", "show", "--worktree"])
        isolation = self.request["write_isolation"]
        return {"worktree": {"id": self.request["placement"]["worktree"][3:],
                             "path": isolation["workspace_root"]}}

    def test_real_gate_then_one_dispatch_without_model_gap(self):
        before = pinned(self.operator)
        result = self.execute()
        self.assertTrue(result["ok"])
        self.assertFalse(result["native_gate_atomic"])
        self.assertEqual(pinned(self.operator), before)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.calls[0][2][:2], ["orchestration", "worker-start"])
        self.assertEqual(self.calls[0][3], 16)
        args = self.calls[0][2]
        self.assertEqual(args[args.index("--effort") + 1], "high")
        self.assertEqual(args[args.index("--backend-variant") + 1], "max")
        self.assertEqual(result["resolved_profile"]["config"], file_ref(PROFILES))
        self.assertEqual(json.loads((self.state / "dispatch-intent.json").read_text())["resolved_profile"],
                         result["resolved_profile"])
        gate = json.loads(pinned(result["gate"]))
        self.assertEqual(gate["previous_sha256"], self.operator["sha256"])
        self.assertLess(timestamp(result["received_at"]), timestamp(gate["valid_until"]))
        # Legacy receipts keep their shape and gain only additive evidence.
        self.assertEqual(result["request"], self.ref())
        self.assertNotIn("package", result)
        self.assertEqual(result["outcome"], "accepted")
        self.assertIsNone(result["timeline"]["prepare_seconds"])

    def test_prepare_package_is_deterministic_and_has_no_side_effects(self):
        before = sorted(self.state.iterdir())
        package_ref, ready_ref, worker_ref = self.prepared()
        expected = json.loads(pinned(ready_ref))
        self.assertEqual(first.prepare_package(package_ref), expected)
        self.assertEqual(first.prepare_package(package_ref), expected)
        self.assertEqual(expected["package"], package_ref)
        self.assertEqual(expected["worker"], worker_ref)
        self.assertEqual(expected["slot"], {
            "runtime": self.s.contract["runtime"], "run": "run_test", "generation": 1})
        self.assertFalse(expected["effectsApplied"])
        self.assertEqual(sorted(self.state.iterdir()), before)
        self.assertEqual(self.calls, [])

    def test_prepared_package_dispatches_with_fresh_gate_without_replanning(self):
        package_ref, ready_ref, worker_ref = self.prepared()
        result = first.dispatch_package(package_ref, ready_ref, self.operator, call=self.call)
        self.assertTrue(result["ok"])
        self.assertEqual(result["outcome"], "accepted")
        self.assertEqual(result["package"], package_ref)
        self.assertEqual(result["ready"], ready_ref)
        self.assertEqual(result["worker"], worker_ref)
        self.assertEqual(len(self.calls), 1)
        intent = json.loads((self.state / "dispatch-intent.json").read_text())
        self.assertEqual(intent["package"], package_ref)
        self.assertEqual(intent["ready"], ready_ref)
        self.assertEqual(intent["slot"], {
            "runtime": self.s.contract["runtime"], "run": "run_test", "generation": 1})
        self.assertEqual(result["operator_gate"], self.operator)
        self.assertEqual(intent["operator_gate"], self.operator)
        accepted = first.verify_accepted(file_ref(self.state / "dispatched.json"),
                                         contract_ref=self.contract_ref)
        self.assertEqual(accepted["package"], package_ref)
        self.assertEqual(accepted["outcome"], "accepted")
        timeline = accepted["timeline"]
        self.assertEqual(timeline["gate_completed_at"],
                         json.loads(pinned(accepted["gate"]))["completed_at"])
        self.assertEqual(timeline["requested_at"], accepted["requested_at"])
        self.assertEqual(timeline["received_at"], accepted["received_at"])
        self.assertEqual(timeline["valid_until"], accepted["valid_until"])
        self.assertGreater(timeline["window_seconds_after_check"], 16)
        self.assertGreaterEqual(timeline["native_seconds"], 0)
        # Preparing is clock-free, so its duration stays unknown, never zero.
        self.assertIsNone(timeline["prepare_seconds"])
        self.assertEqual(timeline["unknown"], ["prepare_seconds"])

    def test_prepared_ready_tamper_is_rejected_with_matching_pin(self):
        package_ref, ready_ref, _ = self.prepared()
        for key, value in (("timeout_seconds", 900.0),
                           ("slot", dict(self.slot(), generation=2)),
                           ("state_root", str(self.s.fixture.bootstrap))):
            with self.subTest(key=key):
                ready = json.loads(pinned(ready_ref))
                ready[key] = value
                # The forged READY carries its own correct pin: only a full
                # recalculation from the package can reject it.
                forged = self.s.ref("forged-ready.json", ready)
                with patch("coordinator_first_dispatch.run_gate") as gate:
                    with self.assertRaisesRegex(ValueError, "ready_binding_changed"):
                        first.dispatch_package(package_ref, forged, self.operator, call=self.call)
                    gate.assert_not_called()
                self.assertFalse((self.state / "dispatch-intent.json").exists())
        self.assertEqual(self.calls, [])

    def test_prepared_package_slot_mismatch_is_rejected(self):
        for key, value in (("run", "run_other"), ("generation", 2), ("runtime", "runtime_other")):
            with self.subTest(key=key):
                package_ref, _ = self.package(slot=dict(self.slot(), **{key: value}))
                with patch("coordinator_first_dispatch.run_gate") as gate:
                    with self.assertRaisesRegex(ValueError, "slot_binding_mismatch"):
                        first.prepare_package(package_ref)
                    gate.assert_not_called()
        self.assertFalse((self.state / "dispatch-intent.json").exists())
        self.assertEqual(self.calls, [])

    def test_prepared_package_rejects_embedded_gate_and_unknown_fields(self):
        package_ref, _ = self.package(prefix="embedded", worker=copy.deepcopy(self.request))
        with self.assertRaisesRegex(ValueError, "prepared_worker_must_not_embed_gate"):
            first.prepare_package(package_ref)
        package_ref, _ = self.package(prefix="extra", package_extra={"operator_gate": self.operator})
        with self.assertRaisesRegex(ValueError, "invalid_first_dispatch_package"):
            first.prepare_package(package_ref)
        worker = copy.deepcopy(self.request)
        del worker["first_dispatch"]
        worker["run"] = "run_other"
        package_ref, _ = self.package(prefix="rebound", worker=worker)
        with self.assertRaisesRegex(ValueError, "request_binding_mismatch"):
            first.prepare_package(package_ref)
        self.assertFalse((self.state / "dispatch-intent.json").exists())
        self.assertEqual(self.calls, [])

    def test_prepared_cli_requires_all_pins_and_rejects_mixed_chains(self):
        package_ref, ready_ref, _ = self.prepared()
        legacy = self.ref()
        def run(args):
            with contextlib.redirect_stdout(io.StringIO()) as output:
                return main(args), json.loads(output.getvalue())
        prepared = ["--package", package_ref["path"], "--package-sha256", package_ref["sha256"],
                    "--ready", ready_ref["path"], "--ready-sha256", ready_ref["sha256"],
                    "--operator-gate", self.operator["path"],
                    "--operator-gate-sha256", self.operator["sha256"]]
        code, payload = run(["first-dispatch", "--request", legacy["path"],
                             "--request-sha256", legacy["sha256"],
                             "--ready", ready_ref["path"], "--execute"])
        self.assertEqual((code, payload["error"]),
                         (2, "invalid_legacy_first_dispatch_arguments"))
        self.assertEqual(payload["outcome"], "not_attempted")
        for args, error in (
                (["--package", package_ref["path"], "--package-sha256", package_ref["sha256"]],
                 "prepared_first_dispatch_arguments_required"),
                ([*prepared, "--request-sha256", legacy["sha256"]],
                 "prepared_first_dispatch_arguments_required"),
                ([*prepared, "--operator-gate-sha256", ""],
                 "prepared_first_dispatch_arguments_required")):
            with self.subTest(error=error, args=args[:2]):
                self.assertEqual(run(["first-dispatch", *args, "--execute"]),
                                 (2, dict(payload, error=error)))
        with patch("coordinator_first_dispatch.dispatch_package",
                   return_value={"ok": True}) as dispatched:
            self.assertEqual(run(["first-dispatch", *prepared, "--execute"]),
                             (0, {"ok": True}))
        dispatched.assert_called_once_with(
            {"path": package_ref["path"], "sha256": package_ref["sha256"]},
            {"path": ready_ref["path"], "sha256": ready_ref["sha256"]},
            {"path": self.operator["path"], "sha256": self.operator["sha256"]})
        self.assertFalse((self.state / "dispatch-intent.json").exists())
        self.assertEqual(self.calls, [])

    def test_same_state_root_second_package_requires_reconciliation(self):
        package_ref, ready_ref, _ = self.prepared()
        self.assertTrue(first.dispatch_package(package_ref, ready_ref,
                                               self.operator, call=self.call)["ok"])
        worker = copy.deepcopy(self.request)
        del worker["first_dispatch"]
        worker["task"] = "task_second"
        second, second_ready, _ = self.prepared(prefix="second", worker=worker)
        for package, ready in ((package_ref, ready_ref), (second, second_ready)):
            with self.subTest(package=package["path"]):
                with self.assertRaisesRegex(ValueError, "requires_reconciliation"):
                    first.dispatch_package(package, ready, self.operator, call=self.call)
        self.assertEqual(len(self.calls), 1)
        intent = json.loads((self.state / "dispatch-intent.json").read_text())
        self.assertEqual(intent["package"], package_ref)

    def test_prepared_inputs_changed_during_gate_stops_before_intent(self):
        replacement = self.s.fixture.bootstrap / "replacement-profiles.json"
        replacement.write_bytes(PROFILES.read_bytes())
        package_ref, ready_ref, _ = self.prepared()
        original = first.run_gate
        def changing_gate(*args, **kwargs):
            receipt = original(*args, **kwargs)
            os.environ["SWARM_WORKER_PROFILES"] = str(replacement)
            return receipt
        with patch("coordinator_first_dispatch.run_gate", side_effect=changing_gate):
            with self.assertRaisesRegex(ValueError, "first_dispatch_inputs_changed"):
                first.dispatch_package(package_ref, ready_ref, self.operator, call=self.call)
        self.assertFalse((self.state / "dispatch-intent.json").exists())
        self.assertEqual(self.calls, [])

    def test_prepared_acceptance_rejects_rebound_operator_gate(self):
        package_ref, ready_ref, _ = self.prepared()
        first.dispatch_package(package_ref, ready_ref, self.operator, call=self.call)
        intent_path = self.state / "dispatch-intent.json"
        intent = json.loads(intent_path.read_text())
        rebound = self.s.ref("other-operator.json", json.loads(pinned(self.operator)))
        # Same bytes at another path: content hashing alone cannot tell the
        # rebound receipt apart, so intent and receipt must agree on the pin.
        self.assertNotEqual(rebound, intent["operator_gate"])
        intent["operator_gate"] = rebound
        intent_path.write_text(json.dumps(intent))
        with self.assertRaisesRegex(ValueError, "acceptance_binding_changed"):
            first.verify_accepted(file_ref(self.state / "dispatched.json"),
                                  contract_ref=self.contract_ref)

    def test_acceptance_rejects_drifted_timeline(self):
        package_ref, ready_ref, _ = self.prepared()
        first.dispatch_package(package_ref, ready_ref, self.operator, call=self.call)
        target = self.state / "dispatched.json"
        receipt = json.loads(target.read_text())
        receipt["timeline"]["prepare_seconds"] = 0.0
        target.write_text(json.dumps(receipt))
        with self.assertRaisesRegex(ValueError, "acceptance_timeline_changed"):
            first.verify_accepted(file_ref(target), contract_ref=self.contract_ref)

    def test_intent_publish_failure_after_link_blocks_redispatch(self):
        package_ref, ready_ref, _ = self.prepared()
        original = first.publish_new
        def failing(target, value):
            original(target, value)
            if target.name == "dispatch-intent.json":
                raise OSError("simulated directory fsync failure")
        with patch("coordinator_first_dispatch.publish_new", side_effect=failing):
            with self.assertRaisesRegex(ValueError, "requires_reconciliation") as stopped:
                first.dispatch_package(package_ref, ready_ref, self.operator, call=self.call)
        self.assertEqual(stopped.exception.details["outcome"], "outcome_unknown")
        self.assertEqual(stopped.exception.details["cause"],
                         "first_dispatch_intent_outcome_unknown")
        self.assertTrue((self.state / "dispatch-intent.json").exists())
        self.assertEqual(self.calls, [])
        with self.assertRaisesRegex(ValueError, "requires_reconciliation"):
            first.dispatch_package(package_ref, ready_ref, self.operator, call=self.call)
        self.assertEqual(self.calls, [])

    def test_prepared_package_rejects_changed_worker_and_ready(self):
        package_ref, ready_ref, worker_ref = self.prepared()
        Path(worker_ref["path"]).write_text("{}")
        with self.assertRaisesRegex(ValueError, "file_pin_changed"):
            first.dispatch_package(package_ref, ready_ref, self.operator, call=self.call)
        self.assertFalse((self.state / "dispatch-intent.json").exists())
        self.assertEqual(self.calls, [])

    def test_prepare_cli_outputs_reviewable_ready_without_execution(self):
        package_ref, _, _ = self.prepared()
        with contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(main(["first-dispatch-prepare", "--package", package_ref["path"],
                                   "--package-sha256", package_ref["sha256"]]), 0)
        result = json.loads(output.getvalue())
        self.assertEqual(result, first.prepare_package(package_ref))
        self.assertFalse((self.state / "dispatch-intent.json").exists())
        self.assertEqual(self.calls, [])

    def test_expired_operator_stops_without_intent_or_worker_and_refresh_reuses_run(self):
        gate = json.loads(pinned(self.operator))
        gate["started_at"] = gate["completed_at"] = (timestamp(now()) - timedelta(seconds=800)).isoformat()
        gate["valid_until"] = (timestamp(now()) - timedelta(seconds=570)).isoformat()
        old = self.s.ref("expired-operator.json", gate)
        self.request["first_dispatch"]["operator_gate"] = old
        preserved = pinned(old)
        with self.assertRaisesRegex(ValueError, "operator_dispatch_gate_stale_or_changed"):
            self.execute()
        self.assertFalse((self.state / "dispatch-intent.json").exists())
        self.assertEqual(self.calls, [])
        with patch.dict(os.environ, ORCA_TERMINAL_HANDLE="term_operator"):
            fresh = self.s.gate(phase="first-dispatch", previous=self.s.prior)
        self.assertEqual(self.s.contract_ref["sha256"], self.contract_ref["sha256"])
        self.request["first_dispatch"]["operator_gate"] = self.s.ref("refreshed-operator.json", fresh)
        self.assertTrue(self.execute()["ok"])
        self.assertEqual(pinned(old), preserved)
        self.assertEqual(self.s.contract["run"], {"id": "run_test", "generation": 1})

    def test_coordinator_cannot_refresh_operator_gate_itself(self):
        with self.assertRaisesRegex(ValueError, "operator_native_context_mismatch"):
            self.s.gate(phase="first-dispatch", previous=self.s.prior)
        self.assertEqual(self.calls, [])

    def test_model_only_gpt54_dispatch_pins_xhigh_standard_before_native_call(self):
        self.request["model"] = "gpt-5.4"
        result = self.execute()
        self.assertTrue(result["ok"])
        self.assertEqual(len(self.calls), 1)
        argv = self.calls[0][2]
        for flag, value in (("agent", "trae"), ("model", "gpt-5.4"),
                            ("effort", "xhigh"), ("backend-variant", "standard")):
            self.assertEqual(argv[argv.index("--" + flag) + 1], value)
        intent = json.loads((self.state / "dispatch-intent.json").read_text())
        self.assertEqual(intent["resolved_profile"], result["resolved_profile"])
        self.assertEqual(result["resolved_profile"]["backend_variant"], "standard")
        self.assertEqual(result["resolved_profile"]["config"], file_ref(PROFILES))

    def test_external_profile_is_preserved_in_dispatch_and_acceptance(self):
        profile = self.s.fixture.bootstrap / "private-profiles.json"
        profile.write_bytes(PROFILES.read_bytes() + b"\n")
        self.request["profiles_sha256"] = file_ref(profile)["sha256"]
        with patch.dict(os.environ, SWARM_WORKER_PROFILES=str(profile)):
            result = self.execute()
            accepted = first.verify_accepted(file_ref(self.state / "dispatched.json"),
                                             contract_ref=self.contract_ref)
        self.assertTrue(accepted["ok"])
        self.assertEqual(result["resolved_profile"]["config"], file_ref(profile))
        self.assertEqual(len(self.calls), 1)

    def test_external_policy_path_change_during_gate_stops_before_intent(self):
        profile = self.s.fixture.bootstrap / "private-profiles.json"
        replacement = self.s.fixture.bootstrap / "replacement-profiles.json"
        profile.write_bytes(PROFILES.read_bytes())
        replacement.write_bytes(PROFILES.read_bytes())
        original_gate = first.run_gate

        def changing_gate(*args, **kwargs):
            receipt = original_gate(*args, **kwargs)
            os.environ["SWARM_WORKER_PROFILES"] = str(replacement)
            return receipt

        with patch.dict(os.environ, SWARM_WORKER_PROFILES=str(profile)), \
                patch.object(first, "run_gate", side_effect=changing_gate):
            with self.assertRaisesRegex(ValueError, "first_dispatch_inputs_changed"):
                self.execute()
        self.assertFalse((self.state / "dispatch-intent.json").exists())
        self.assertEqual(self.calls, [])

    def test_write_isolation_resolves_exact_workspace_twice_before_intent(self):
        review = self.s.fixture.bootstrap / "worker-review"
        source = self.s.fixture.bootstrap / "source"
        review.mkdir()
        source.mkdir()
        self.request["writable_roots"] = [str(review)]
        self.request["write_isolation"] = {
            "workspace_root": str(review), "read_only_roots": [str(source)]}
        with patch.object(self, "query", wraps=self.query) as query:
            result = first.dispatch(self.ref(), call=self.call, query=query)
        self.assertTrue(result["ok"])
        self.assertEqual(query.call_count, 2)
        intent = json.loads((self.state / "dispatch-intent.json").read_text())
        self.assertEqual(intent["write_isolation_workspace"],
                         {"id": "workspace_test", "path": str(review)})

    def test_write_isolation_binding_mismatch_stops_before_gate_or_intent(self):
        review = self.s.fixture.bootstrap / "worker-review"
        source = self.s.fixture.bootstrap / "source"
        other = self.s.fixture.bootstrap / "other"
        for directory in (review, source, other):
            directory.mkdir()
        self.request["writable_roots"] = [str(review)]
        self.request["write_isolation"] = {
            "workspace_root": str(review), "read_only_roots": [str(source)]}
        def wrong(*args, **kwargs):
            return {"worktree": {"id": "workspace_test", "path": str(other)}}
        with patch("coordinator_first_dispatch.run_gate") as gate:
            with self.assertRaisesRegex(ValueError, "workspace_binding_mismatch"):
                first.dispatch(self.ref(), call=self.call, query=wrong)
            gate.assert_not_called()
        self.assertFalse((self.state / "dispatch-intent.json").exists())
        self.assertEqual(self.calls, [])

    def test_write_isolation_change_after_gate_stops_before_intent_or_dispatch(self):
        review = self.s.fixture.bootstrap / "worker-review"
        source = self.s.fixture.bootstrap / "source"
        other = self.s.fixture.bootstrap / "other"
        for directory in (review, source, other):
            directory.mkdir()
        self.request["writable_roots"] = [str(review)]
        self.request["write_isolation"] = {
            "workspace_root": str(review), "read_only_roots": [str(source)]}
        observations = [
            {"worktree": {"id": "workspace_test", "path": str(review)}},
            {"worktree": {"id": "workspace_test", "path": str(other)}},
        ]
        with patch("coordinator_first_dispatch.run_gate", wraps=first.run_gate) as gate:
            with self.assertRaisesRegex(ValueError, "workspace_binding_mismatch"):
                first.dispatch(self.ref(), call=self.call,
                               query=lambda *args, **kwargs: observations.pop(0))
            gate.assert_called_once()
        self.assertEqual(observations, [])
        self.assertFalse((self.state / "dispatch-intent.json").exists())
        self.assertEqual(self.calls, [])

    def test_write_isolation_unresolvable_observation_uses_fixed_error(self):
        review = self.s.fixture.bootstrap / "worker-review"
        source = self.s.fixture.bootstrap / "source"
        review.mkdir()
        source.mkdir()
        self.request["writable_roots"] = [str(review)]
        self.request["write_isolation"] = {
            "workspace_root": str(review), "read_only_roots": [str(source)]}
        missing = self.s.fixture.bootstrap / "missing"
        with patch("coordinator_first_dispatch.run_gate") as gate:
            with self.assertRaisesRegex(ValueError, "workspace_binding_mismatch"):
                first.dispatch(self.ref(), call=self.call, query=lambda *args, **kwargs: {
                    "worktree": {"id": "workspace_test", "path": str(missing)}})
            gate.assert_not_called()
        self.assertFalse((self.state / "dispatch-intent.json").exists())
        self.assertEqual(self.calls, [])

    def test_short_window_stops_before_intent(self):
        gate = json.loads(pinned(self.operator))
        gate["valid_until"] = (timestamp(now()) + timedelta(seconds=5)).isoformat()
        self.request["first_dispatch"]["operator_gate"] = self.s.ref("short-gate.json", gate)
        with self.assertRaisesRegex(ValueError, "window_insufficient_refresh_operator_gate"):
            self.execute()
        self.assertFalse((self.state / "dispatch-intent.json").exists())
        self.assertEqual(self.calls, [])

    def test_short_window_is_non_hit_not_natural_ttl_expiry(self):
        result = first.classify_first_dispatch_acceptance(
            error="first_dispatch_window_insufficient_refresh_operator_gate")
        self.assertEqual(result["attempt_outcome"], "insufficient_window")
        self.assertEqual(result["first_dispatch_ttl_acceptance"], "NON_HIT")
        self.assertFalse(result["ttl_hit"])
        self.assertFalse(result["requires_timing_evidence"])

    def test_dispatch_success_is_not_ttl_hit(self):
        result = self.execute()
        self.assertEqual(result["first_dispatch_acceptance"]["attempt_outcome"], "dispatch_succeeded")
        self.assertEqual(result["first_dispatch_acceptance"]["first_dispatch_ttl_acceptance"],
                         "NOT_A_TTL_HIT")
        self.assertFalse(result["first_dispatch_acceptance"]["ttl_hit"])

    def test_owner_generation_inventory_or_session_change_prevents_start(self):
        for key, value in (("coordinator_handle", "term_other"), ("consumer_generation", 2)):
            previous = self.s.run[key]
            self.s.run[key] = value
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "run_ownership_changed"):
                self.execute()
            self.s.run[key] = previous
        self.s.workers["workers"] = [{"id": "released-worker"}]
        with self.assertRaisesRegex(ValueError, "inventory_not_empty"):
            self.execute()
        self.s.workers["workers"] = []
        self.s.operator["incarnationId"] = "changed"
        with self.assertRaisesRegex(ValueError, "operator_identity_changed"):
            self.execute()
        self.assertEqual(self.calls, [])

    def test_wrong_context_or_request_binding_prevents_start(self):
        with patch.dict(os.environ, ORCA_TERMINAL_HANDLE="term_other"):
            with self.assertRaisesRegex(ValueError, "coordinator_native_context_required"):
                self.execute()
        self.request["run"] = "run_other"
        with self.assertRaisesRegex(ValueError, "request_binding_mismatch"):
            self.execute()
        self.assertEqual(self.calls, [])

    def test_context_expiration_during_gate_never_dispatches(self):
        self.s.age_context(901)
        with self.assertRaises(ValueError):
            self.execute()
        self.assertEqual(self.calls, [])

    def test_expiry_during_intent_write_stops_at_last_boundary(self):
        with patch("coordinator_first_dispatch.now", side_effect=now) as clock:
            original = first.publish_new
            def delayed(target, value):
                original(target, value)
                if target.name == "dispatch-intent.json":
                    clock.side_effect = None
                    clock.return_value = (timestamp(now()) + timedelta(seconds=500)).isoformat()
            with patch("coordinator_first_dispatch.publish_new", side_effect=delayed):
                with self.assertRaisesRegex(ValueError, "requires_reconciliation") as stopped:
                    self.execute()
        self.assertIn("expired_before_start", stopped.exception.details["cause"])
        self.assertEqual(stopped.exception.details["outcome"], "outcome_unknown")
        self.assertTrue((self.state / "dispatch-intent.json").exists())
        self.assertEqual(self.calls, [])

    def test_unknown_result_blocks_retry_even_if_request_or_gate_changes(self):
        self.timeout = True
        with self.assertRaisesRegex(ValueError, "requires_reconciliation"):
            self.execute()
        self.timeout = False
        self.request["task"] = "task_second"
        self.request["first_dispatch"]["operator_gate"] = self.s.ref("copy-gate.json", json.loads(pinned(self.operator)))
        with self.assertRaisesRegex(ValueError, "requires_reconciliation"):
            self.execute()
        self.assertEqual(len(self.calls), 1)
        self.assertFalse((self.state / "dispatched.json").exists())

    def test_success_cannot_be_replayed(self):
        self.execute()
        with self.assertRaisesRegex(ValueError, "requires_reconciliation"):
            self.execute()
        self.assertEqual(len(self.calls), 1)

    def test_late_response_is_preserved_but_not_success(self):
        self.late = True
        with patch("coordinator_first_dispatch.now", side_effect=now) as self.clock:
            with self.assertRaisesRegex(ValueError, "requires_reconciliation"):
                self.execute()
        self.assertTrue((self.state / "dispatch-response.json").exists())
        self.assertFalse((self.state / "dispatched.json").exists())

    def test_changed_pins_prevent_start(self):
        ref = self.ref()
        Path(self.operator["path"]).write_text("{}")
        with self.assertRaisesRegex(ValueError, "file_pin_changed"):
            first.dispatch(ref, call=self.call)
        self.assertEqual(self.calls, [])

    def test_request_changed_after_gate_prevents_start(self):
        ref = self.ref()
        original = first.run_gate
        def change(*args, **kwargs):
            result = original(*args, **kwargs)
            Path(ref["path"]).write_text("{}")
            return result
        with patch("coordinator_first_dispatch.run_gate", side_effect=change):
            with self.assertRaisesRegex(ValueError, "file_pin_changed"):
                first.dispatch(ref, call=self.call)
        self.assertEqual(self.calls, [])

    def test_profiles_changed_during_gate_prevent_intent_and_start(self):
        profile_path = self.s.fixture.bootstrap / "worker-model-profiles.json"
        profile_path.write_bytes(PROFILES.read_bytes())
        original = first.run_gate
        def change(*args, **kwargs):
            result = original(*args, **kwargs)
            profile_path.write_text("{}")
            return result
        with patch("coordinator_worker_profiles.PROFILES", profile_path):
            with patch("coordinator_first_dispatch.run_gate", side_effect=change):
                with self.assertRaisesRegex(ValueError, "file_pin_changed"):
                    self.execute()
        self.assertFalse((self.state / "dispatch-intent.json").exists())
        self.assertEqual(self.calls, [])

    def test_blocked_profile_is_explicit_cli_error_before_gate_or_intent(self):
        self.request["model"] = "example-blocked-model"
        ref = self.ref()
        with patch("coordinator_first_dispatch.run_gate") as gate:
            with contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(main(["first-dispatch", "--request", ref["path"],
                                       "--request-sha256", ref["sha256"], "--execute"]), 2)
            self.assertIn("standard_backend_launch_unverified", json.loads(output.getvalue())["error"])
            gate.assert_not_called()
        self.assertFalse((self.state / "dispatch-intent.json").exists())
        self.assertEqual(self.calls, [])

    def test_plan_routes_first_start_but_later_waves_stay_native(self):
        ref = self.ref()
        plan = build_plan(self.request, request_ref=ref)
        self.assertIn("first-dispatch", plan["argv"])
        self.assertNotIn("worker-start", plan["argv"])
        self.assertIn(ref["sha256"], plan["argv"])
        del self.request["first_dispatch"]
        self.assertEqual(build_plan(self.request)["argv"][1:3], ["orchestration", "worker-start"])

    def test_pi_request_keeps_the_first_dispatch_gate_and_fixed_profile(self):
        self.request["model"] = "example-pi-model"
        ref = self.ref()
        plan = build_plan(self.request, request_ref=ref)
        self.assertIn("first-dispatch", plan["argv"])
        self.assertEqual(plan["resolved_profile"]["agent"], "pi")
        self.assertNotIn("--effort", plan["argv"])
        self.assertNotIn("--backend-variant", plan["argv"])
        del self.request["first_dispatch"]
        native = build_plan(self.request)["argv"]
        self.assertEqual(native[native.index("--agent") + 1], "pi")
        self.assertEqual(native[native.index("--model") + 1], "example-pi-model")
        self.assertNotIn("--effort", native)
        self.assertNotIn("--backend-variant", native)

    def test_cli_requires_execute_and_reports_stale_gate(self):
        ref = self.ref()
        args = ["first-dispatch", "--request", ref["path"], "--request-sha256", ref["sha256"]]
        with contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(main(args), 2)
        self.assertEqual(json.loads(output.getvalue())["error"], "first_dispatch_explicit_execute_required")
        with patch("coordinator_first_dispatch.dispatch", side_effect=first.GateError("operator_dispatch_gate_stale_or_changed")):
            with contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(main([*args, "--execute"]), 2)
        self.assertEqual(json.loads(output.getvalue())["error"], "operator_dispatch_gate_stale_or_changed")
        self.assertEqual(json.loads(output.getvalue())["next_step"], "operator_recheck_same_run_preserve_old_receipts")
        self.assertEqual(json.loads(output.getvalue())["first_dispatch_acceptance"]["attempt_outcome"],
                         "expired")
        self.assertEqual(self.calls, [])

    def test_cli_reports_insufficient_window_non_hit(self):
        ref = self.ref()
        args = ["first-dispatch", "--request", ref["path"], "--request-sha256", ref["sha256"], "--execute"]
        with patch("coordinator_first_dispatch.dispatch",
                   side_effect=first.GateError("first_dispatch_window_insufficient_refresh_operator_gate")):
            with contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(main(args), 2)
        payload = json.loads(output.getvalue())
        self.assertEqual(payload["first_dispatch_acceptance"]["attempt_outcome"], "insufficient_window")
        self.assertEqual(payload["first_dispatch_acceptance"]["first_dispatch_ttl_acceptance"], "NON_HIT")
        self.assertFalse(payload["first_dispatch_acceptance"]["ttl_hit"])

    def test_tui_observer_and_live_caller_are_used_by_execution_entry(self):
        t = tui.TuiTests()
        t.setUp()
        self.addCleanup(t.doCleanups)
        c = self.s.contract
        c["adapter"] = TUI_ADAPTER
        c["runtime_config"] = file_ref(t.f.runtime)
        c["workspace"]["path"] = str(t.f.cwd)
        c["role_skill"] = self.s.ref("SKILL.md", "role", t.f.cwd)
        c["observation"] = dict(profile=str(t.profile), caller_receipt=t.caller_ref,
            log_root=str(t.f.root), roots=[str(t.f.bootstrap)], startup_anchor=t.ref("anchor.json", t.observe()))
        c["run"] = None
        self.state = t.f.bootstrap / "dispatch"
        self.state.mkdir(mode=0o700)
        def query(cli, runtime, args):
            if args == ["orchestration", "strict-caller-check"]:
                return copy.deepcopy(t.caller)
            if args[:2] == ["orchestration", "run-current"]:
                return {"run": copy.deepcopy(self.s.run)}
            if args == ["orchestration", "check", "--terminal", "term_operator", "--peek"]:
                self.assertEqual(os.environ["ORCA_TERMINAL_HANDLE"], "term_operator")
                return {"count": 0, "messages": []}
            return self.s.query(cli, runtime, args)
        # This test targets the execution route/live Coordinator caller. Operator
        # root-session capture has separate real-reader fixtures.
        with patch("trae_tui.native", side_effect=t.query), \
                patch("coordinator_startup.native", side_effect=query), \
                patch("operator_session.observe_identity", return_value={"trust": "fixture"}):
            with patch.dict(os.environ, ORCA_TERMINAL_HANDLE="term_operator"):
                self.s.prepare_dispatch()
                op = self.s.gate(phase="first-dispatch", previous=self.s.prior)
            self.request["first_dispatch"] = dict(contract=self.s.contract_ref,
                operator_gate=self.s.ref("tui-operator.json", op), state_root=str(self.state))
            t.caller["caller"]["authorityFingerprint"] = "b" * 64
            with self.assertRaisesRegex(ValueError, "tui_live_caller_changed"):
                self.execute()
            t.caller = json.loads(pinned(t.caller_ref))
            self.assertTrue(self.execute()["ok"])
        self.assertEqual(len(self.calls), 1)

    def test_failed_native_receipt_is_not_success_and_cannot_retry(self):
        def failed(cli, runtime, args, **kwargs):
            receipt = self.call(cli, runtime, args, **kwargs)
            receipt["state"] = "failed"
            return receipt
        with self.assertRaisesRegex(ValueError, "requires_reconciliation"):
            first.dispatch(self.ref(), call=failed)
        self.assertTrue((self.state / "dispatch-response.json").exists())
        self.assertFalse((self.state / "dispatched.json").exists())
        with self.assertRaisesRegex(ValueError, "requires_reconciliation"):
            self.execute()
        self.assertEqual(len(self.calls), 1)

    def test_native_wrapper_honors_explicit_timeout_without_changing_default(self):
        native = first.dispatch.__kwdefaults__["call"]
        with patch("trae_coordinator.subprocess.run") as run:
            run.return_value.stdout = json.dumps({"ok": True, "_meta": {"runtimeId": "runtime_test"}, "result": {}})
            native("/fake", "runtime_test", ["status"])
            self.assertEqual(run.call_args.kwargs["timeout"], 15)
            native("/fake", "runtime_test", ["orchestration", "worker-start"], timeout_seconds=75)
            self.assertEqual(run.call_args.kwargs["timeout"], 75)

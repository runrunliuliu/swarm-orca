"""Offline startup-input regressions; real observer files, no live Agent/Run."""

import copy
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
import io
import json
import os
from pathlib import Path
import stat
import sys
import unittest
from unittest.mock import patch

from coordinator_io import file_ref, parse, pinned, publish_new, timestamp
from coordinator_launch import main
from coordinator_strict_delivery import delivery_plan, wait_for_config
from coordinator_strict import StrictCheckError
from coordinator_strict_request import build_request
from coordinator_strict_start import wait_and_create
import coordinator.test_coordinator_strict_delivery as delivery_tests
import trae.test_trae_tui as tui_tests
from coordinator_task_source import STRICT_REQUEST_INPUT_SCHEMA_VERSION, STRICT_REQUEST_SCHEMA_VERSION


class StrictRequestTests(unittest.TestCase):
    def setUp(self):
        self.tui = tui_tests.TuiTests()
        self.tui.setUp()
        self.addCleanup(self.tui.doCleanups)
        self.root = self.tui.f.bootstrap
        self.root.chmod(0o700)
        self.directory = self.root / "strict-start"
        self.target = self.root / "strict-config-request.json"
        self.observation = self.tui.observe()
        self.clock = datetime.now(timezone.utc)
        self.source = {
            "schema_version": STRICT_REQUEST_INPUT_SCHEMA_VERSION, "cli": file_ref(Path(sys.executable).resolve()),
            "runtime": "runtime_test",
            "workspace": {"id": "workspace_test", "path": str(self.tui.f.cwd)},
            "caller_receipt": self.tui.caller_ref,
            "session_observation": self.tui.ref("observation.json", self.observation),
            "readiness_evidence": [self.tui.ref("readiness.json", {"read": "final"})],
            "directory": str(self.directory), "recovery_note": None,
            "max_workers": 1, "task_deadline": (self.clock + timedelta(hours=1)).isoformat(),
            "request_id": "11111111-2222-4333-8444-555555555555"}
        skill = self.tui.f.cwd / "SKILL.md"
        skill.write_text("role instructions")
        self.source["contract_fields"] = self.tui.ref("fields.json", {
            **{k: self.source[k] for k in ("cli", "runtime", "workspace")},
            "adapter": "trae-tui-runtime-v1",
            "coordinator": {"terminal": "term_test", "incarnation": "inc_test", "session": tui_tests.legacy.SID},
            "operator": {"terminal": "term_operator", "incarnation": "inc_operator",
                         "provider": "trae", "session": "operator-session"},
            "runtime_config": file_ref(self.tui.f.runtime), "role_skill": file_ref(skill),
            "handoff": file_ref(self.tui.f.prompt), "skill_read_evidence": self.source["readiness_evidence"][0],
            "observation": {"profile": str(self.tui.profile), "caller_receipt": self.tui.caller_ref,
                "log_root": str(self.tui.f.root), "roots": [str(self.root)],
                "startup_anchor": self.source["session_observation"]}})
        self.source["task_source"] = self.tui.ref("business-task.json", {
            "schema_version": 1, "kind": "strict_business_task", "workspace": self.source["workspace"],
            "objective": "approved bounded test",
            "authorization_refs": [self.tui.ref("authorization.txt", "original user task")]})
        self.ref = self.tui.ref("request-input.json", self.source)
        for name in ("coordinator_strict_request.now", "coordinator_strict_delivery.now"):
            clock = patch(name, side_effect=lambda: self.clock.isoformat())
            clock.start()
            self.addCleanup(clock.stop)
        self.tui.calls.clear()

    def build(self):
        self.ref = self.tui.ref("request-input.json", self.source)
        return build_request(self.ref)

    def reject_without_request(self, error):
        with self.assertRaisesRegex(ValueError, error):
            self.build()
        self.assertFalse(self.target.exists())
        self.assertEqual(self.tui.calls, [])

    def test_derives_provider_session_and_incarnation_before_exclusive_publish(self):
        original = copy.deepcopy(self.source)
        result = self.build()
        request = parse(pinned(result["request"]))
        self.assertEqual(self.source, original)
        self.assertEqual(request["schema_version"], 5)
        self.assertEqual(request["schema_version"], STRICT_REQUEST_SCHEMA_VERSION)
        self.assertEqual(request["coordinator"], {
            "terminal": "term_test", "incarnation": "inc_test", "session": tui_tests.legacy.SID})
        self.assertNotEqual(request["coordinator"]["session"], self.tui.caller["caller"]["paneKey"])
        self.assertNotEqual(request["coordinator"]["incarnation"],
                            self.tui.caller["caller"]["processIncarnation"])
        self.assertEqual(timestamp(request["deadline"]), self.clock + timedelta(seconds=900))
        self.assertEqual(request["startup_window"]["handshake_timeout_seconds"], 900)
        self.assertFalse(result["execution_authorized"])
        self.assertFalse(result["identity_verified"])
        self.assertTrue(result["review_required"])
        self.assertEqual(stat.S_IMODE(self.target.stat().st_mode), 0o600)
        self.assertTrue(delivery_plan(result["request"])["ok"])
        self.assertFalse(self.directory.exists())
        self.assertEqual(self.tui.calls, [])

    def test_explicit_handshake_seconds_and_task_deadline_cap(self):
        self.source["handshake_timeout_seconds"] = 600
        self.source["task_deadline"] = (self.clock + timedelta(seconds=450)).isoformat()
        request = parse(pinned(self.build()["request"]))
        self.assertEqual(timestamp(request["deadline"]), self.clock + timedelta(seconds=450))
        self.assertEqual(request["startup_window"]["handshake_timeout_seconds"], 600)

    def test_null_task_deadline_keeps_bounded_handshake(self):
        self.source["task_deadline"] = None
        result = self.build()
        request = parse(pinned(result["request"]))
        self.assertIsNone(request["startup_window"]["task_deadline"])
        self.assertEqual(timestamp(request["deadline"]), self.clock + timedelta(seconds=900))
        self.assertTrue(delivery_plan(result["request"])["ok"])
        self.clock += timedelta(seconds=900)
        with self.assertRaisesRegex(ValueError, "strict_start_deadline_expired"):
            delivery_plan(result["request"])
        self.assertEqual(self.tui.calls, [])

    def test_null_task_deadline_keeps_explicit_shorter_handshake(self):
        self.source.update(task_deadline=None, handshake_timeout_seconds=600)
        request = parse(pinned(self.build()["request"]))
        self.assertEqual(timestamp(request["deadline"]), self.clock + timedelta(seconds=600))

    def test_missing_or_malformed_task_deadline_is_not_unlimited(self):
        for deadline in ("", "later", "2026-10-28T04:10:00", False, 0, [], {}):
            with self.subTest(deadline=deadline):
                self.source["task_deadline"] = deadline
                self.reject_without_request("strict_config_task_deadline_invalid")
        del self.source["task_deadline"]
        self.reject_without_request("strict_config_request_input_invalid")

    def test_refreshed_tui_observation_derives_same_identity(self):
        observation = self.tui.observe(startup_anchor=self.source["session_observation"],
                                       expected_thread=tui_tests.legacy.SID)
        self.assertEqual(observation["kind"], "trae_tui_session_observation")
        self.source["session_observation"] = self.tui.ref("fresh-observation.json", observation)
        self.tui.calls.clear()
        request = parse(pinned(self.build()["request"]))
        self.assertEqual(request["coordinator"]["session"], tui_tests.legacy.SID)
        self.assertTrue(delivery_plan(file_ref(self.target))["ok"])
        self.assertEqual(self.tui.calls, [])

    def test_worker_units_and_handwritten_derived_fields_are_not_accepted(self):
        for field, value in (("timeout_ms", 90000), ("coordinator", {}),
                             ("deadline", self.source["task_deadline"]), ("gate_ttl", 180)):
            with self.subTest(field=field):
                self.source[field] = value
                self.reject_without_request("strict_config_request_input_invalid")
                del self.source[field]
        for seconds in (90000, True, 0, -1, 1.5, "900"):
            with self.subTest(seconds=seconds):
                self.source["handshake_timeout_seconds"] = seconds
                self.reject_without_request("strict_config_handshake_timeout_seconds_invalid")

    def test_expired_task_stops_without_request(self):
        self.source["task_deadline"] = self.clock.isoformat()
        self.reject_without_request("strict_start_deadline_expired")

    def test_mismatched_observer_bindings_fail_before_request(self):
        variants = [
            ("schema_version", True),
            ("runtime_id", "different"),
            ("effective.cwd", str(self.root)),
            ("thread_id", "tab:leaf"),
            ("session_id", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"),
            ("binding.session_id", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"),
            ("binding.runtime.runtimeId", "other"),
            ("binding.terminal.handle", "term_other"),
            ("binding.terminal.tabId", "other"),
            ("binding.terminal.worktreeId", "other"),
            ("binding.terminal.executionHostId", "remote"),
            ("binding.terminal.incarnationId", "other"),
            ("binding.terminal.ptyId", "other"),
            ("caller_receipt.sha256", "0" * 64),
            ("adapter", "unknown"),
            ("kind", "summary"),
        ]
        for field, value in variants:
            observation = copy.deepcopy(self.observation)
            target = observation
            keys = field.split(".")
            for key in keys[:-1]:
                target = target[key]
            target[keys[-1]] = value
            self.source["session_observation"] = self.tui.ref("observation.json", observation)
            with self.subTest(field=field):
                self.reject_without_request("strict_config_")

    def test_request_plan_rechecks_binding_not_just_uuid_shape(self):
        result = self.build()
        original = parse(pinned(result["request"]))
        for field, value in (("session", "tab:leaf"),
                             ("session", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"),
                             ("incarnation", "pty:inc_test")):
            request = copy.deepcopy(original)
            request["coordinator"][field] = value
            self.target.write_text(json.dumps(request))
            with self.subTest(field=field, value=value), self.assertRaisesRegex(ValueError, "strict_config_"):
                delivery_plan(file_ref(self.target))
        self.assertEqual(self.tui.calls, [])

    def test_observation_pin_change_is_rejected_at_plan(self):
        result = self.build()
        Path(self.source["session_observation"]["path"]).write_text("changed observation")
        with self.assertRaisesRegex(ValueError, "file_pin_changed"):
            delivery_plan(result["request"])

    def test_deadline_cannot_be_recomputed_or_extended_by_plan(self):
        result = self.build()
        original = parse(pinned(result["request"]))
        self.clock += timedelta(seconds=100)
        self.assertEqual(delivery_plan(result["request"])["deadline"], original["deadline"])
        changed = dict(original, deadline=(timestamp(original["deadline"]) + timedelta(seconds=1)).isoformat())
        self.target.write_text(json.dumps(changed))
        with self.assertRaisesRegex(ValueError, "strict_config_window_mismatch"):
            delivery_plan(file_ref(self.target))

    def test_original_pin_drift_or_permission_denial_prevents_any_publish(self):
        original = pinned(self.ref)
        Path(self.ref["path"]).write_text("changed")
        with self.assertRaisesRegex(ValueError, "file_pin_changed"):
            build_request(self.ref)
        Path(self.ref["path"]).write_bytes(original)
        with patch("coordinator_strict_request.pinned", side_effect=PermissionError("denied")):
            with self.assertRaises(PermissionError):
                build_request(self.ref)
        self.assertFalse(self.target.exists())

    def test_readiness_drift_during_preparation_is_not_repinned(self):
        from coordinator_strict_request import validate_binding

        def change(value, initial):
            validate_binding(value, initial)
            Path(self.source["readiness_evidence"][0]["path"]).write_text("producer changed")

        with patch("coordinator_strict_request.validate_binding", side_effect=change):
            self.reject_without_request("file_pin_changed")

    def test_business_task_drift_before_request_publication_is_not_repinned(self):
        from coordinator_strict_delivery import validate_request

        def change(value, target):
            result = validate_request(value, target)
            Path(self.source["task_source"]["path"]).write_text("producer changed task")
            return result

        with patch("coordinator_strict_delivery.validate_request", side_effect=change):
            self.reject_without_request("file_pin_changed")

    def test_repeated_request_does_not_refresh_deadline_or_overwrite(self):
        result = self.build()
        original = pinned(result["request"])
        for elapsed in (60, 900):
            self.clock += timedelta(seconds=elapsed)
            with self.assertRaisesRegex(ValueError, "strict_config_request_attempt_exists"):
                self.build()
            self.assertEqual(pinned(result["request"]), original)

    def test_prior_prepare_or_dangling_publication_stops_new_request(self):
        self.directory.mkdir(mode=0o700)
        marker = self.directory / "prepare-intent.json"
        marker.write_text("unknown prior prepare")
        self.reject_without_request("strict_prepare_target_exists")
        marker.unlink()
        self.directory.rmdir()
        (self.root / "strict-config-ready.json").symlink_to(self.root / "missing")
        self.reject_without_request("strict_config_request_attempt_exists")

    def test_publish_race_preserves_other_claimant(self):
        other = b"other immutable request\n"

        def compete(target, value):
            publish_new(target, other)
            publish_new(target, value)

        with patch("coordinator_strict_request.publish_new", side_effect=compete):
            with self.assertRaises(FileExistsError):
                self.build()
        self.assertEqual(self.target.read_bytes(), other)

    def test_cli_requires_execute_and_routes_to_builder(self):
        argv = ["strict-config-request", "--input", self.ref["path"], "--input-sha256", self.ref["sha256"]]
        for flags, code in (([], 2), (["--check", "--execute"], 2), (["--check"], 0), (["--execute"], 0)):
            out = io.StringIO()
            with patch("coordinator_strict_start.live") as live, redirect_stdout(out):
                self.assertEqual(main([*argv, *flags]), code)
            result = json.loads(out.getvalue())
            if code:
                self.assertEqual(result["error"], "strict_config_request_explicit_mode_required")
                self.assertFalse(self.target.exists())
                live.assert_not_called()
            elif flags == ["--check"]:
                self.assertEqual(result["kind"], "strict_config_request_checked")
                self.assertEqual(result["request_path"], str(self.target))
                self.assertFalse(result["deadline_fixed"])
                self.assertFalse(self.target.exists())
                live.assert_not_called()
            else:
                live.assert_called_once()
                self.assertTrue(delivery_plan(result["request"])["ok"])
        self.assertEqual(self.tui.calls, [])

    def test_execute_rejects_outer_publish_before_writing_request(self):
        argv = ["strict-config-request", "--input", self.ref["path"],
                "--input-sha256", self.ref["sha256"], "--execute"]
        out = io.StringIO()
        with patch("coordinator_strict_start.live",
                   side_effect=StrictCheckError("strict_coordinator_native_context_required")) as live, \
                redirect_stdout(out):
            self.assertEqual(main(argv), 2)
        self.assertEqual(json.loads(out.getvalue())["error"],
                         "strict_coordinator_native_context_required")
        live.assert_called_once()
        self.assertFalse(self.target.exists())

    def test_legacy_request_early_guard_rejects_original_pane_key_bug(self):
        request = parse(pinned(self.build()["request"]))
        request["schema_version"] = 1
        del request["session_observation"], request["startup_window"]
        del request["task_source"], request["recovery_note"]
        del request["contract_fields"]
        self.directory.mkdir(mode=0o700)
        for key, value, error in (
                ("session", self.tui.caller["caller"]["paneKey"], "strict_config_provider_session_required"),
                ("incarnation", self.tui.caller["caller"]["processIncarnation"], "strict_config_incarnation_mismatch")):
            changed = copy.deepcopy(request)
            changed["coordinator"][key] = value
            self.target.write_text(json.dumps(changed))
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, error):
                delivery_plan(file_ref(self.target))
        self.assertEqual(self.tui.calls, [])

    def test_business_objective_cannot_be_replaced_by_recovery_step(self):
        self.source["recovery_note"] = "repair expired handshake; no Run in this substep"
        request = parse(pinned(self.build()["request"]))
        self.assertEqual(request["objective"], "approved bounded test")
        request["objective"] = self.source["recovery_note"]
        self.target.write_text(json.dumps(request))
        with self.assertRaisesRegex(ValueError, "strict_config_task_objective_mismatch"):
            delivery_plan(file_ref(self.target))

    def test_free_objective_and_old_builder_input_are_rejected(self):
        self.source["objective"] = "repair only"
        self.reject_without_request("strict_config_request_input_invalid")
        del self.source["objective"]
        for version in (1, 2, 3):
            self.source["schema_version"] = version
            self.reject_without_request("strict_config_request_input_invalid")

    def test_task_source_scope_pin_and_authorization_drift_stop(self):
        task = parse(pinned(self.source["task_source"]))
        self.source["task_source"] = self.tui.ref("wrong-task.json", dict(task, workspace={}))
        self.reject_without_request("strict_config_task_source_scope_mismatch")
        self.source["task_source"] = self.tui.ref("business-task.json", task)
        Path(task["authorization_refs"][0]["path"]).write_text("changed")
        self.reject_without_request("file_pin_changed")

    def test_unknown_task_source_fields_are_rejected_before_request(self):
        task = parse(pinned(self.source["task_source"]))
        self.source["task_source"] = self.tui.ref("business-task.json", dict(task, scope_notes="extra"))
        self.reject_without_request("strict_config_task_source_invalid")

    def test_task_pin_is_rechecked_by_plan_and_old_requests_are_not_upgraded(self):
        result = self.build()
        request = parse(pinned(result["request"]))
        Path(self.source["task_source"]["path"]).write_text("changed")
        with self.assertRaisesRegex(ValueError, "file_pin_changed"):
            delivery_plan(result["request"])
        for version in (1, 2):
            old = dict(request, schema_version=version)
            del old["contract_fields"]
            del old["task_source"], old["recovery_note"]
            if version == 1:
                del old["session_observation"], old["startup_window"]
            self.target.write_text(json.dumps(old))
            ref = file_ref(self.target)
            self.directory.mkdir(mode=0o700, exist_ok=True)
            self.assertTrue(delivery_plan(ref)["ok"])
            self.assertEqual(file_ref(self.target), ref)

    def test_malformed_observation_cli_stops_without_echoing_private_input(self):
        observation = dict(self.observation, binding="private malformed input")
        self.source["session_observation"] = self.tui.ref("malformed.json", observation)
        ref = self.tui.ref("request-input.json", self.source)
        out = io.StringIO()
        with redirect_stdout(out):
            code = main(["strict-config-request", "--input", ref["path"],
                         "--input-sha256", ref["sha256"], "--execute"])
        self.assertEqual(code, 2)
        self.assertEqual(json.loads(out.getvalue()), {
            "ok": False, "decision": "stop", "error": "strict_config_request_failed"})
        self.assertFalse(self.target.exists())
        self.assertEqual(self.tui.calls, [])


class StrictRequestIntegrationTests(unittest.TestCase):
    def setUp(self):
        f = delivery_tests.StrictDeliveryTests()
        f.setUp()
        self.addCleanup(f.doCleanups)
        self.f = f
        f.bootstrap.chmod(0o700)
        f.directory.rmdir()  # Empty synthetic legacy fixture, not an existing attempt.
        # Replace only this synthetic v1 fixture request with a new builder input.
        Path(f.ref["path"]).unlink()
        stream = f.gate.fixture
        observation = tui_tests.stream_observe(
            cli=sys.executable, runtime="runtime_test", terminal="term_test",
            incarnation="inc_test", workspace="workspace_test", cwd=stream.cwd,
            cursor=2, log_root=stream.root, roots=[str(stream.bootstrap)], run=None)
        source = {key: value for key, value in f.expected.items()
                  if key not in ("mode", "coordinator", "deadline")}
        source.update(session_observation=f.gate.ref("observation.json", observation),
                      task_deadline=(f.start.clock + timedelta(hours=1)).isoformat(),
                      schema_version=4, recovery_note="prepare handshake",
                      contract_fields=f.prep.fields)
        source["task_source"] = f.gate.ref("business-task.json", {
            "schema_version": 1, "kind": "strict_business_task", "workspace": source["workspace"],
            "objective": source.pop("objective"),
            "authorization_refs": [f.gate.ref("authorization.txt", "original user task")]})
        ref = f.gate.ref("request-input.json", source)
        for name in ("coordinator_strict_request.now", "coordinator_request_prepare.now"):
            clock = patch(name, side_effect=lambda: f.start.clock.isoformat())
            clock.start()
            self.addCleanup(clock.stop)
        result = build_request(ref)
        f.ref = result["request"]
        f.expected = parse(pinned(f.ref))
        # A 90-second Worker timeout must not expire configuration preparation.
        f.start.clock += timedelta(seconds=100)
        f.prep.input["deadline"] = f.expected["deadline"]
        f.prep.ref = f.gate.ref("prepare.json", f.prep.input)
        f.gate.queries.clear()  # Exclude the setup's read-only session observation.
        f.prepare = self.prepare
        f.publish = self.publish

    def prepare(self):
        from coordinator_request_prepare import prepare_request
        with patch.dict(os.environ, {"ORCA_TERMINAL_HANDLE": "term_operator"}):
            self.f.result = prepare_request(self.f.ref)
        return self.f.result

    def publish(self):
        from coordinator_request_prepare import review_request
        from coordinator_strict_delivery import deliver
        f = self.f
        with patch.dict(os.environ, {"ORCA_TERMINAL_HANDLE": "term_operator"}):
            review = review_request(f.ref, decision="approve", notes="Independent fixture review")
            return deliver(f.ref, f.result["config"], f.result["preparation"], review["review"])

    def test_stream_request_prepare_delivery_then_original_gated_create(self):
        f = self.f
        f.prepare()
        f.publish()
        delivered = wait_for_config(f.ref)
        self.assertEqual(f.start.creates(), [])
        f.start.ref = delivered["config"]
        self.assertTrue(wait_and_create(delivered["config"])["ok"])
        self.assertEqual(len(f.start.creates()), 1)

    def test_recovery_objective_in_prepared_config_cannot_be_delivered(self):
        f = self.f
        f.prepare()
        config = parse(pinned(f.result["config"]))
        config["objective"] = "repair handshake only"
        f.result["config"] = f.gate.ref("start.json", config, f.directory)
        with self.assertRaisesRegex(ValueError, "strict_config_prepared_request_mismatch"):
            f.publish()
        self.assertFalse(Path(f.locations["publication_path"]).exists())
        f.assert_no_start()

    def test_task_drift_after_preparation_validation_prevents_publication(self):
        from coordinator_strict_delivery import check_actor_context
        f = self.f
        f.prepare()

        def change(contract, actor):
            check_actor_context(contract, actor)
            Path(f.expected["task_source"]["path"]).write_text("changed business task")

        with patch("coordinator_strict_delivery.check_actor_context", side_effect=change), \
                self.assertRaisesRegex(ValueError, "file_pin_changed"):
            f.publish()
        self.assertFalse(Path(f.locations["publication_path"]).exists())
        f.assert_no_start()

    def test_authorization_drift_at_final_live_check_stops_waiter(self):
        from coordinator_strict_delivery import live
        f = self.f
        f.prepare()
        f.publish()
        task = parse(pinned(f.expected["task_source"]))
        calls = 0

        def change(*args):
            nonlocal calls
            result = live(*args)
            calls += 1
            if calls == 2:
                Path(task["authorization_refs"][0]["path"]).write_text("changed authorization")
            return result

        with patch("coordinator_strict_delivery.live", side_effect=change), \
                self.assertRaisesRegex(ValueError, "file_pin_changed"):
            wait_for_config(f.ref)
        self.assertEqual(calls, 2)
        f.assert_no_start()


if __name__ == "__main__":
    unittest.main()

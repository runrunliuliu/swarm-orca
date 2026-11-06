"""Operator adapters exercise existing strict planner/hook reader using offline fixtures."""

from contextlib import redirect_stdout
import errno
import io
import json
from pathlib import Path
import shlex
import sys
import unittest
from unittest.mock import patch

from coordinator_input import input_bytes
from coordinator_io import file_ref, now, parse, pinned
from coordinator_launch import build_plan
from operator_prepare import main
from operator_session import observe, observe_operator, verify_operator_identity
import test_trae_tui as tui_tests


class OperatorSessionTests(unittest.TestCase):
    def setUp(self):
        self.tui = tui_tests.TuiTests()
        self.tui.setUp()
        self.addCleanup(self.tui.doCleanups)
        self.f = self.tui.f
        self.directory = self.f.root / "observations"
        self.directory.mkdir(mode=0o700)
        self.output = self.directory / "anchor.json"
        self.source = dict(schema_version=1, cli=sys.executable, runtime="runtime_test",
            terminal="term_test", incarnation="inc_test", workspace="workspace_test",
            cwd=str(self.f.cwd), profile=str(self.tui.profile), caller_receipt=self.tui.caller_ref,
            log_root=str(self.f.root), roots=[str(self.f.bootstrap)], runtime_config=file_ref(self.f.runtime),
            context_max_age_seconds=1800, expected_thread=None, startup_anchor=None, output=str(self.output))
        self.material_counter = 0
        self.save()

    def save(self):
        self.ref = self.tui.ref("operator-observe.json", self.source)

    def operator_input(self, *, expected=None, output=None, provider="trae"):
        data = dict(schema_version=1, cli=sys.executable, runtime="runtime_test",
            operator={"provider": provider, "terminal": "term_test", "incarnation": "inc_test",
                      "session": tui_tests.legacy.SID},
            workspace="workspace_test", profile=str(self.tui.profile), log_root=str(self.f.root),
            context_max_age_seconds=1800,
            expected_effective={"effort": "high"} if expected is None else expected,
            output=str(output or (self.directory / "operator-identity.json")))
        return self.tui.ref("operator-identity-input.json", data)

    def native_materials(self, plan_ref):
        self.material_counter += 1
        prefix = f"native-materials-{self.material_counter}-"
        marker = self.tui.ref(prefix + "marker.json", {"fixture": "prelaunch"})
        handoff = self.tui.ref(prefix + "handoff.md", "reviewed handoff")
        launch = self.tui.ref(prefix + "launch.json", {"fixture": "launch-plan"})
        return self.tui.ref(prefix + "final-checklist.json", {
            "schema_version": 1, "kind": "operator_prelaunch_materials",
            "status": "ready_for_external_review", "assembly_id": "operator-session-test",
            "input": marker, "input_snapshot": marker,
            "business_task": {"workspace": {"id": "workspace_test", "path": str(self.f.cwd)},
                "task_source": marker, "objective": "fixture", "recovery_note": None,
                "task_source_snapshot": marker},
            "dependencies": {"authority_refs": [], "task_authority_refs": [],
                "acceptance_refs": [], "scope_refs": [], "baseline_refs": [],
                "reference_refs": [], "launch_config_refs": []},
            "artifacts": {"handoff": handoff, "launch_plan": launch,
                          "bound_launch_plan": plan_ref},
            "source_snapshots": [{"source": marker, "snapshot": marker}],
            "created_at": now(), "final_checklist_includes_self": False,
            "agent_started": False, "run_created": False, "gate_issued": False,
            "execution_authorized": False})

    def operator_identity_result(self):
        return {"source": {"cli": sys.executable, "runtime": "runtime_test",
                            "workspace": "workspace_test"},
                "session": {"runtime": "runtime_test", "provider": "trae",
                            "terminal": "term_test", "incarnation": "inc_test",
                            "workspace": "workspace_test", "session": tui_tests.legacy.SID,
                            "observed_at": now()},
                "effective": {"effort": "xhigh"}, "trust": "fixture"}

    def observe(self):
        with patch("trae_tui.native", side_effect=self.tui.query):
            return observe(self.ref)

    def cli(self, *flags):
        out = io.StringIO()
        with redirect_stdout(out):
            code = main(["observe-session", "--input", self.ref["path"],
                         "--input-sha256", self.ref["sha256"], *flags])
        return code, json.loads(out.getvalue())

    def route_cli(self, command, ref, *flags):
        out = io.StringIO()
        with redirect_stdout(out):
            code = main([command, "--input", ref["path"], "--input-sha256", ref["sha256"], *flags])
        return code, json.loads(out.getvalue())

    def test_exact_shared_mapping_and_compact_whitelisted_output(self):
        with patch("trae_tui.native", side_effect=self.tui.query):
            code, result = self.cli("--execute")
        self.assertEqual(code, 0)
        self.assertTrue(result["requires_live_caller_check"])
        self.assertFalse(result["execution_authorized"])
        self.assertIn("not-live-process-attested", result["trust"])
        self.assertEqual(result["effective"]["model"], "GPT-5.5")
        self.assertEqual(result["session"]["thread_id"], tui_tests.legacy.SID)
        self.assertNotIn("binding", result)
        self.assertNotIn("launch_token_hash", json.dumps(result))
        self.assertNotIn("must-never-appear", json.dumps(result))
        raw = parse(pinned(result["observation"]))
        self.assertEqual(raw["kind"], "trae_tui_startup_anchor")
        self.assertEqual(raw["binding"]["terminal"]["tabId"], "tab")
        self.assertNotIn("must-never-appear", json.dumps(raw))
        self.assertEqual(self.output.stat().st_mode & 0o777, 0o600)
        self.assertTrue(all(args[0] == "status" or args[:2] in (
            ["terminal", "show"], ["worktree", "show"]) for args in self.tui.calls))

    def test_observe_entrypoints_are_explicit_and_legacy_alias_keeps_coordinator_semantics(self):
        expected = {"ok": True, "kind": "routed", "execution_authorized": False}
        for command in ("observe-session", "observe-coordinator"):
            with self.subTest(command=command), \
                    patch("operator_session.observe", return_value=expected) as coordinator, \
                    patch("operator_session.observe_operator") as operator:
                code, result = self.route_cli(command, self.ref, "--execute")
            self.assertEqual(code, 0)
            self.assertEqual(result, expected)
            coordinator.assert_called_once_with(self.ref)
            operator.assert_not_called()

        op_ref = self.operator_input(output=self.directory / "operator-route.json")
        with patch("operator_session.observe", side_effect=AssertionError("coordinator observer used")) as coordinator, \
                patch("operator_session.observe_operator", return_value=expected) as operator:
            code, result = self.route_cli("observe-operator", op_ref, "--execute")
        self.assertEqual(code, 0)
        self.assertEqual(result, expected)
        operator.assert_called_once_with(op_ref)
        coordinator.assert_not_called()

    def test_operator_high_is_verified_without_relaxing_coordinator_xhigh(self):
        self.f.context["payload"]["effort"] = "high"
        self.f.write_log()
        with patch("trae_tui.native", side_effect=self.tui.query), \
                self.assertRaisesRegex(ValueError, "settings mismatch"):
            observe(self.ref)

        op_ref = self.operator_input()
        with patch("trae_tui.native", side_effect=self.tui.query), \
                patch("trae_tui.observe", side_effect=AssertionError("coordinator observer used")):
            result = observe_operator(op_ref)
        self.assertEqual(result["kind"], "operator_identity_observed")
        self.assertEqual(result["effective"], {"effort": "high"})
        self.assertEqual(result["session"]["session"], tui_tests.legacy.SID)
        self.assertFalse(result["execution_authorized"])
        raw = parse(pinned(result["observation"]))
        self.assertEqual(raw["identity"]["session_id"], tui_tests.legacy.SID)
        self.assertFalse(any(args[:2] == ["terminal", "read"] for args in self.tui.calls))

    def test_operator_identity_verifier_is_read_only_and_reused_by_observer(self):
        op_ref = self.operator_input(expected={"effort": "xhigh"},
                                     output=self.directory / "operator-readonly.json")
        with patch("trae_tui.native", side_effect=self.tui.query):
            result = verify_operator_identity(op_ref)
        self.assertFalse((self.directory / "operator-readonly.json").exists())
        self.assertEqual(result["session"]["session"], tui_tests.legacy.SID)
        self.assertEqual(result["effective"], {"effort": "xhigh"})

    def test_pi_operator_identity_reuses_runtime_state_without_trae_launch_commitment(self):
        self.tui.term["agentIdentity"] = "pi"
        self.tui.entry.update(source="pi", payload={"agentType": "pi"})
        self.tui.write_state()
        op_ref = self.operator_input(provider="pi", expected={"cwd": str(self.f.cwd)},
                                     output=self.directory / "pi-operator.json")
        with patch("trae_tui.native", side_effect=self.tui.query):
            result = observe_operator(op_ref)
        self.assertEqual(result["session"]["provider"], "pi")
        self.assertEqual(result["session"]["session"], tui_tests.legacy.SID)
        self.assertEqual(result["effective"], {"cwd": str(self.f.cwd)})
        raw = parse(pinned(result["observation"]))
        self.assertNotIn("launch_token_hash", raw["identity"])

    def test_operator_identity_read_only_verifier_accepts_existing_observation_pin(self):
        output = self.directory / "operator-existing-observation.json"
        op_ref = self.operator_input(expected={"effort": "xhigh"}, output=output)
        with patch("trae_tui.native", side_effect=self.tui.query):
            observed = observe_operator(op_ref)
        self.assertEqual(file_ref(output), observed["observation"])

        with patch("trae_tui.native", side_effect=self.tui.query):
            result = verify_operator_identity(op_ref)
        self.assertEqual(result["session"]["session"], tui_tests.legacy.SID)
        self.assertEqual(result["effective"], {"effort": "xhigh"})

        with patch("trae_tui.native") as query, \
                self.assertRaisesRegex(ValueError, "operator_session_output_exists"):
            observe_operator(op_ref)
        query.assert_not_called()

    def test_operator_effective_settings_use_reviewed_trae_semantics(self):
        self.f.context["payload"].update(effort="high", approvals_reviewer="guardian_subagent")
        self.f.context["payload"]["sandbox_policy"]["exclude_tmpdir_env_var"] = False
        self.f.write_log()
        op_ref = self.operator_input(expected={
            "effort": "high",
            "approval_policy": "on-request",
            "approvals_reviewer": "auto_review",
            "sandbox_policy": {"type": "workspace-write", "network_access": True},
        })
        with patch("trae_tui.native", side_effect=self.tui.query):
            result = observe_operator(op_ref)
        self.assertEqual(result["effective"]["approvals_reviewer"], "guardian_subagent")
        self.assertEqual(result["effective"]["sandbox_policy"]["type"], "workspace-write")
        self.assertTrue(result["effective"]["sandbox_policy"]["network_access"])

        self.f.context["payload"]["approvals_reviewer"] = "user"
        self.f.write_log()
        op_ref = self.operator_input(expected={"approvals_reviewer": "auto_review"},
                                     output=self.directory / "operator-bad-reviewer.json")
        with patch("trae_tui.native", side_effect=self.tui.query), \
                self.assertRaisesRegex(ValueError, "operator_session_effective_settings_mismatch"):
            observe_operator(op_ref)
        self.assertFalse((self.directory / "operator-bad-reviewer.json").exists())

    def test_operator_observation_requires_reviewed_effective_settings(self):
        op_ref = self.operator_input(expected=None)
        data = parse(pinned(op_ref))
        data["expected_effective"] = None
        op_ref = self.tui.ref("operator-missing-effective.json", data)
        with patch("trae_tui.native", side_effect=self.tui.query), \
                self.assertRaisesRegex(ValueError, "operator_session_expected_effective_required"):
            observe_operator(op_ref)
        self.assertFalse((self.directory / "operator-identity.json").exists())

    def test_no_execute_means_no_native_queries_or_evidence_writes(self):
        with patch("trae_tui.native") as query:
            code, result = self.cli()
        self.assertEqual(code, 2)
        self.assertEqual(result["error"], "operator_session_explicit_execute_required")
        query.assert_not_called()
        self.assertFalse(self.output.exists())

    def test_duplicate_output_is_not_reused_and_is_rejected_before_queries(self):
        first = self.observe()
        with patch("trae_tui.native") as query, self.assertRaisesRegex(ValueError, "output_exists"):
            observe(self.ref)
        query.assert_not_called()
        self.assertEqual(file_ref(self.output), first["observation"])

    def test_saved_full_observation_can_be_consumed_as_existing_startup_anchor(self):
        first = self.observe()
        self.source.update(startup_anchor=first["observation"], expected_thread=first["session"]["thread_id"],
                           output=str(self.directory / "second.json"))
        self.save()
        second = self.observe()
        original = parse(pinned(first["observation"]))
        current = parse(pinned(second["observation"]))
        self.assertEqual(current["kind"], "trae_tui_session_observation")
        self.assertEqual(current["binding"], original["binding"])
        self.assertEqual(current["observed_at"], original["observed_at"])  # reading does not renew TTL

    def test_config_pin_drift_before_and_during_observation_stops(self):
        def race(cli, runtime, args):
            result = self.tui.query(cli, runtime, args)
            self.f.runtime.write_text(self.f.runtime.read_text() + "\n")
            return result

        with patch("trae_tui.native", side_effect=race), self.assertRaisesRegex(ValueError, "file_pin_changed"):
            observe(self.ref)
        self.assertFalse(self.output.exists())
        with patch("trae_tui.native") as query, self.assertRaisesRegex(ValueError, "file_pin_changed"):
            observe(self.ref)
        query.assert_not_called()

    def test_input_pin_drift_after_observation_stops_before_publication(self):
        def race(cli, runtime, args):
            Path(self.ref["path"]).write_text("{}")
            return self.tui.query(cli, runtime, args)

        with patch("trae_tui.native", side_effect=race), self.assertRaisesRegex(ValueError, "file_pin_changed"):
            observe(self.ref)
        self.assertFalse(self.output.exists())

    def test_native_denial_stops_without_fallback_and_preserves_errno(self):
        with patch("trae_tui.native", side_effect=PermissionError(errno.EACCES, "private context")) as query:
            code, result = self.cli("--execute")
        self.assertEqual(code, 2)
        self.assertEqual(query.call_count, 1)
        self.assertEqual(result["decision"], "stop")
        self.assertEqual(result["os_error"], "EACCES")
        self.assertNotIn("private context", json.dumps(result))
        self.assertFalse(self.output.exists())

    def test_stale_hook_keeps_original_timing_no_refresh(self):
        self.tui.entry["evidenceObservedAt"] -= 9999999
        self.tui.write_state()
        with patch("trae_tui.native", side_effect=self.tui.query):
            code, result = self.cli("--execute")
        self.assertEqual(code, 2)
        self.assertEqual(result["error"], "tui_hook_stale_or_future")
        self.assertFalse(self.output.exists())

    def test_wrong_caller_mapping_or_effective_settings_cannot_be_downgraded(self):
        self.tui.term["ptyId"] = "other-pty"
        with self.assertRaisesRegex(ValueError, "strict_caller_mismatch"):
            self.observe()
        self.tui.term["ptyId"] = "pty"
        self.f.context["payload"]["effort"] = "low"
        self.f.write_log()
        with self.assertRaisesRegex(ValueError, "settings mismatch"):
            self.observe()
        self.assertFalse(self.output.exists())

    def test_schema_and_ttl_are_not_inferred_from_unreviewed_fields(self):
        for change in ({"schema_version": True}, {"completed_turn": True},
                       {"context_max_age_seconds": 3601}, {"context_max_age_seconds": True}):
            ref = self.tui.ref("bad-input.json", {**self.source, **change})
            with patch("trae_tui.native") as query, self.assertRaises(ValueError):
                observe(ref)
            query.assert_not_called()
            self.assertFalse(self.output.exists())

    def test_native_plan_delegates_full_strict_validation_and_preserves_argv(self):
        self.f.prompt.write_text("--leading 'quoted' \"space word\" $(no-command) `literal`\n汉字")
        plan = build_plan(**self.f.args, strict_coordinator=True)
        ref = self.tui.ref("plan.json", plan)
        materials = self.native_materials(ref)
        operator_input = self.operator_input(expected={"effort": "xhigh"},
                                             output=self.directory / "operator-native-plan.json")
        out = io.StringIO()
        with patch("coordinator_strict.native", side_effect=self.tui.query), \
                patch("operator_session.verify_operator_identity",
                      return_value=self.operator_identity_result()), redirect_stdout(out):
            code = main(["native-plan", "--plan", ref["path"], "--plan-sha256", ref["sha256"],
                         "--cli", sys.executable, "--runtime", "runtime_test", "--workspace", "workspace_test",
                         "--materials", materials["path"], "--materials-sha256", materials["sha256"],
                         "--operator-input", operator_input["path"],
                         "--operator-input-sha256", operator_input["sha256"]])
        self.assertEqual(code, 0)
        result = json.loads(out.getvalue())
        self.assertFalse(result["execution_authorized"])
        self.assertNotIn("--agent-args", result["argv"])
        assignment = next(arg for arg in result["argv"] if arg.startswith("--agent-args="))
        self.assertEqual(assignment, "--agent-args=" + plan["native_launch"]["agent_args"])
        short_prompt = shlex.split(assignment.split("=", 1)[1])[-1]
        self.assertNotEqual(short_prompt.encode(), input_bytes(plan))
        self.assertIn("Strict Coordinator bootstrap", short_prompt)
        self.assertIn(plan["input_contract"]["stdin_sha256"], short_prompt)
        self.assertIn("coordinator_tui_continue.py", short_prompt)
        self.assertIn("strict-config-request", short_prompt)
        self.assertEqual([args[0:2] for args in self.tui.calls], [["status"], ["worktree", "show"]])

    def test_native_plan_tamper_rejected_before_native_queries(self):
        plan = build_plan(**self.f.args, strict_coordinator=True)
        plan["native_launch"]["agent_args"] += " --yolo"
        ref = self.tui.ref("tampered.json", plan)
        bogus_hash = "0" * 64
        with patch("coordinator_strict.native") as query, redirect_stdout(io.StringIO()):
            code = main(["native-plan", "--plan", ref["path"], "--plan-sha256", ref["sha256"],
                         "--cli", sys.executable, "--runtime", "runtime_test", "--workspace", "workspace_test",
                         "--materials", str(self.directory / "unused-materials.json"),
                         "--materials-sha256", bogus_hash,
                         "--operator-input", str(self.directory / "unused-operator.json"),
                         "--operator-input-sha256", bogus_hash])
        self.assertEqual(code, 2)
        query.assert_not_called()


if __name__ == "__main__":
    unittest.main()

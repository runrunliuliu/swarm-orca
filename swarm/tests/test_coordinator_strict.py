from datetime import datetime, timedelta, timezone
from contextlib import redirect_stderr
import io
import copy
import os
import shlex
import unittest
from unittest.mock import patch

from coordinator_launch import build_plan, main
from coordinator_input import input_bytes
from coordinator_io import digest, now
from coordinator_strict import (CAPABILITY, MAX_AGENT_ARGS_BYTES, MAX_PINNED_INPUT_BYTES,
                                caller_result, check_session, native_plan)
from trae_exec_capture import run as capture
import test_coordinator_startup as startup_tests


class StrictCoordinatorTests(unittest.TestCase):
    def setUp(self):
        probe = patch("coordinator_strict.verify_trae_executable", return_value={"cli_version": "0.210.1"})
        self.executable_probe = probe.start()
        self.addCleanup(probe.stop)
        self.fixture = startup_tests.StartupGateTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.trae = self.fixture.fixture
        self.fixture.use_v2()
        self.material_counter = 0

    def plan(self):
        return build_plan(**self.trae.args, strict_coordinator=True)

    def test_plan_uses_pinned_argv_prompt_without_executable_capture(self):
        self.trae.prompt.write_text("approved 'quotes' $(not-a-command)\n汉字\n")
        plan = self.plan()
        self.assertIsNone(plan["argv"])
        self.assertIsNone(plan["command"])
        self.assertTrue(plan["native_launch"]["strict_eligible"])
        self.assertFalse(plan["native_launch"]["stdin_required"])
        args = shlex.split(plan["native_launch"]["agent_args"])
        self.assertEqual(args[0], "exec")
        self.assertNotEqual(args[-1].encode(), input_bytes(plan))
        self.assertEqual(plan["native_launch"]["prompt_sha256"],
                         plan["input_contract"]["stdin_sha256"])
        self.assertEqual(plan["native_launch"]["prompt_delivery"],
                         "pinned-files-short-prompt-v1")
        self.assertLessEqual(len(plan["native_launch"]["agent_args"].encode()),
                             MAX_AGENT_ARGS_BYTES)
        self.assertNotIn("end this bootstrap turn", args[-1])
        self.assertIn("Strict Coordinator bootstrap", args[-1])
        self.assertIn("Prompt file: " + str(self.trae.prompt.resolve()), args[-1])
        self.assertIn(plan["input_contract"]["stdin_sha256"], args[-1])
        self.assertIn(plan["input_contract"]["brief_sha256"], args[-1])
        self.assertIn(plan["input_contract"]["fragment_sha256"], args[-1])
        self.assertIn("strict-caller-check", args[-1])
        self.assertEqual(plan["native_launch"]["verified_executable"], self.trae.args["trae"])
        self.assertEqual(plan["startup_delivery"]["mode"], "continuous-native-file-v1")
        self.assertEqual(plan["startup_delivery"]["publication_path"],
                         str(self.trae.bootstrap / "strict-config-ready.json"))
        self.assertIn(plan["startup_delivery"]["request_path"], args[-1])
        self.assertIn("strict-config-request", args[-1])
        self.assertIn("strict-config-plan", args[-1])
        self.assertIn("Use input schema v4", args[-1])
        self.assertIn("it generates request schema v5", args[-1])
        self.assertNotIn("Use input schema v3", args[-1])
        self.assertIn("worker-plan --request", args[-1])
        self.assertIn("Do not end the exec turn for terminal follow-up", args[-1])

    def test_native_prompt_reads_protocol_before_saving_caller_outside_strict_start(self):
        plan = self.plan()
        prompt = shlex.split(plan["native_launch"]["agent_args"])[-1]
        read_first = (
            "First, read the prompt file and strict startup protocol in full; "
            "verify the supplied pins before caller-check or any filesystem writes.")
        reserved = (
            "Protocol-owned directory (not an evidence directory): "
            + str(self.trae.bootstrap / "strict-start")
            + ". Leave it absent for Operator's strict-start-prepare; "
            "do not create it or write caller/status/raw evidence there.")
        caller = (
            "For an unregistered historical attempt, run orchestration strict-caller-check in this live Coordinator context "
            "and preserve the raw receipt at: " + str(self.trae.bootstrap / "initial-caller.json"))
        for instruction in (read_first, reserved, caller):
            self.assertIn(instruction, prompt)
        self.assertLess(prompt.index(read_first), prompt.index(caller))
        self.assertLess(prompt.index(reserved), prompt.index(caller))
        self.assertNotIn("First action: run", prompt)
        self.assertIn("For an explicitly registered strict-bootstrap attempt", prompt)
        self.assertIn("Do not bypass that path with direct strict-config-request", prompt)
        self.assertIn("retain the same owner pin on every S5 command", prompt)
        self.assertIn("owner.json only registers the owner", prompt)
        self.assertIn("pending/awaiting_arm", prompt)
        self.assertIn("Read-only poll expiry is pending with unverified current liveness", prompt)
        self.assertIn("heartbeat never confirms a commit or extends the attempt deadline", prompt)
        self.assertEqual(plan["native_launch"]["short_prompt_sha256"], digest(prompt.encode("utf-8")))

    def test_single_turn_flag_conflicts_with_continuous_strict_launch(self):
        out = io.StringIO()
        with redirect_stderr(out), self.assertRaises(SystemExit) as exc:
            main(["--trae", self.trae.args["trae"], "--cwd", str(self.trae.cwd),
                  "--strict-coordinator", "--single-turn"])
        self.assertEqual(exc.exception.code, 2)
        self.assertIn("conflicts with the continuous strict Coordinator", out.getvalue())

    def test_no_capture_effects_for_strict_plans(self):
        ref = self.fixture.ref("strict.json", self.plan())
        with patch("trae_exec_capture.subprocess.Popen") as spawn:
            with self.assertRaisesRegex(ValueError, "strict_requires_native_launch_not_capture"):
                capture(ref["path"], io.BytesIO())
            spawn.assert_not_called()
        self.assertFalse(self.trae.root.joinpath("strict.process-intent.json").exists())

    def test_no_strict_resume_or_replacement(self):
        for change in ({"resume_session": startup_tests.trae_tests.SID},
                       {"replacement_run": "run_real"}):
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, "strict_requires_fresh"):
                build_plan(**dict(self.trae.args, bootstrap_dir=None, archive_dir=self.trae.archive,
                                  strict_coordinator=True, **change))

    def test_prompt_size_and_nul_rejected_without_truncation(self):
        self.trae.prompt.write_text("x" * 66000)
        plan = self.plan()
        self.assertGreater(len(input_bytes(plan)), MAX_AGENT_ARGS_BYTES)
        self.assertLessEqual(len(plan["native_launch"]["agent_args"].encode()),
                             MAX_AGENT_ARGS_BYTES)
        for text in ("'" * 20000, "x" * 20000, "汉" * 6000, "'" * 4000):
            self.trae.prompt.write_text(text)
            self.assertLessEqual(len(self.plan()["native_launch"]["agent_args"].encode()),
                                 MAX_AGENT_ARGS_BYTES)
        for text in ("\0", "x" * MAX_PINNED_INPUT_BYTES):
            self.trae.prompt.write_text(text)
            with self.assertRaisesRegex(ValueError, "strict_native_prompt_too_large_or_invalid"):
                self.plan()

    def test_realistic_long_handoff_keeps_native_args_bounded(self):
        self.trae.prompt.write_text("汉字'" + "x" * 100000)
        plan = self.plan()
        self.assertGreater(len(input_bytes(plan)), MAX_AGENT_ARGS_BYTES)
        self.assertLessEqual(len(plan["native_launch"]["agent_args"].encode()),
                             MAX_AGENT_ARGS_BYTES)
        ref = self.fixture.ref("limit-plan.json", plan)
        with patch("coordinator_strict.native", side_effect=self.launch_query):
            self.assertEqual(self.prepared(ref)["mode"], "strict_native_launch_plan")
        with patch("coordinator_strict.MAX_AGENT_ARGS_BYTES",
                   len(plan["native_launch"]["agent_args"].encode()) - 1), \
                patch("coordinator_strict.native") as query:
            with self.assertRaisesRegex(ValueError, "strict_native_prompt_too_large_or_invalid"):
                self.plan()
            query.assert_not_called()

    def test_rechecked_plan_stops_during_native_preparation_before_queries(self):
        plan = self.plan()
        ref = self.fixture.ref("old-limit-plan.json", plan)
        with patch("coordinator_strict.native") as query:
            with patch("coordinator_strict.MAX_AGENT_ARGS_BYTES",
                       len(plan["native_launch"]["agent_args"].encode()) - 1), \
                    self.assertRaisesRegex(ValueError, "strict_native_prompt_too_large_or_invalid"):
                self.prepared(ref)
            query.assert_not_called()

    def launch_query(self, cli, runtime, args):
        if args == ["status"]:
            return {"runtime": {"state": "ready", "capabilities": [CAPABILITY]}}
        if args == ["worktree", "show", "--worktree", "id:workspace_test"]:
            return {"worktree": {"id": "workspace_test", "path": str(self.trae.cwd)}}
        self.fail("unexpected native call: " + str(args))

    def materials(self, plan_ref, *, workspace=None):
        self.material_counter += 1
        prefix = f"materials-{self.material_counter}-"
        marker = self.fixture.ref(prefix + "marker.json", {"fixture": "prelaunch"})
        handoff = self.fixture.ref(prefix + "handoff.md", "reviewed handoff")
        launch = self.fixture.ref(prefix + "launch.json", {"fixture": "launch-plan"})
        checklist = {
            "schema_version": 1, "kind": "operator_prelaunch_materials",
            "status": "ready_for_external_review", "assembly_id": "strict-test",
            "input": marker, "input_snapshot": marker,
            "business_task": {"workspace": workspace or {
                "id": "workspace_test", "path": str(self.trae.cwd)},
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
            "execution_authorized": False}
        return self.fixture.ref(prefix + "final-checklist.json", checklist)

    def operator_input(self):
        return self.fixture.ref("operator-input.json", {"fixture": "operator-input"})

    def operator_result(self, *, workspace="workspace_test", session_workspace="workspace_test"):
        return {"source": {"cli": self.fixture.contract["cli"]["path"],
                            "runtime": "runtime_test", "workspace": workspace},
                "session": {"runtime": "runtime_test", "provider": "trae",
                            "terminal": "term_operator", "incarnation": "inc_operator",
                            "workspace": session_workspace,
                            "session": "operator-session", "observed_at": now()},
                "effective": {"effort": "high"}, "trust": "fixture"}

    def prepared(self, ref, *, materials=None, operator_input=None, operator_result=None):
        with patch("operator_session.verify_operator_identity",
                   return_value=operator_result or self.operator_result()):
            return native_plan(ref, cli=self.fixture.contract["cli"]["path"],
                               runtime="runtime_test", workspace="workspace_test",
                               materials=materials or self.materials(ref),
                               operator_input=operator_input or self.operator_input())

    def test_native_preparation_is_read_only_and_explicitly_scoped(self):
        ref = self.fixture.ref("strict.json", self.plan())
        with patch("coordinator_strict.native", side_effect=self.launch_query) as query:
            result = self.prepared(ref)
        self.assertEqual(query.call_count, 2)
        self.assertEqual(result["argv"][1:7], ["terminal", "create", "--worktree",
                                              "id:workspace_test", "--agent", "trae"])
        self.assertNotIn("--command", result["argv"])
        self.assertEqual(result["argv"][7:9],
                         ["--agent-args", self.plan()["native_launch"]["agent_args"]])
        self.assertEqual(result["operator_session"]["workspace"], "workspace_test")
        self.assertFalse(result["execution_authorized"])

    def test_native_preparation_requires_prelaunch_materials_before_queries(self):
        ref = self.fixture.ref("strict.json", self.plan())
        with patch("coordinator_strict.native") as query:
            with self.assertRaisesRegex(ValueError, "strict_native_prelaunch_materials_required"):
                native_plan(ref, cli=self.fixture.contract["cli"]["path"],
                            runtime="runtime_test", workspace="workspace_test")
            query.assert_not_called()

    def test_material_plan_or_workspace_mismatch_stops_before_native_queries(self):
        ref = self.fixture.ref("strict.json", self.plan())
        other = self.fixture.ref("other-plan.json", self.plan())
        cases = [
            self.materials(other),
            self.materials(ref, workspace={"id": "workspace_test", "path": str(self.trae.root)}),
        ]
        for materials in cases:
            with self.subTest(materials=materials["path"]), \
                    patch("coordinator_strict.native") as query, \
                    self.assertRaisesRegex(ValueError, "strict_native_materials_"):
                self.prepared(ref, materials=materials)
            query.assert_not_called()

    def test_operator_identity_scope_mismatch_stops_before_native_queries(self):
        ref = self.fixture.ref("strict.json", self.plan())
        for result in (self.operator_result(workspace="other"),
                       self.operator_result(session_workspace="other")):
            with self.subTest(result=result), patch("coordinator_strict.native") as query, \
                    self.assertRaisesRegex(ValueError, "strict_native_operator_scope_mismatch"):
                self.prepared(ref, operator_result=result)
            query.assert_not_called()

    def test_old_host_stops_before_launch_or_workspace_query(self):
        ref = self.fixture.ref("strict.json", self.plan())
        with patch("coordinator_strict.native", return_value={"runtime": {"state": "ready"}}) as query:
            with self.assertRaisesRegex(ValueError, "strict_native_runtime_unsupported"):
                self.prepared(ref)
        self.assertEqual(query.call_count, 1)
        self.executable_probe.assert_not_called()

    def test_version_drift_stops_before_returning_launch_argv(self):
        ref = self.fixture.ref("strict.json", self.plan())
        self.executable_probe.side_effect = ValueError("trae_executable_version_mismatch")
        with patch("coordinator_strict.native", side_effect=self.launch_query), \
                self.assertRaisesRegex(ValueError, "trae_executable_version_mismatch"):
            self.prepared(ref)

    def test_changed_args_or_prompt_rejected_before_native_calls(self):
        for changed in ("args", "prompt", "delivery"):
            plan = self.plan()
            if changed == "args":
                plan["native_launch"]["agent_args"] += " --yolo"
            if changed == "delivery":
                plan["startup_delivery"]["publication_path"] += ".other"
            ref = self.fixture.ref("strict.json", plan)
            if changed == "prompt":
                self.trae.prompt.write_text("new unreviewed brief")
            with patch("coordinator_strict.native") as query:
                with self.assertRaises(ValueError):
                    self.prepared(ref)
                query.assert_not_called()

    def session_refs(self):
        initial = self.proof_query(None, None, ["orchestration", "strict-caller-check"])
        self.caller_ref = self.fixture.ref("initial-caller.json", initial)
        receipt = self.fixture.gate()
        self.contract_ref = self.fixture.contract_ref
        self.receipt = receipt
        self.receipt_ref = self.fixture.ref("operator-gate.json", receipt)
        os.environ["ORCA_TERMINAL_HANDLE"] = "term_test"

    def check(self, receipt=None):
        return check_session(self.contract_ref, receipt or self.receipt_ref, self.caller_ref)

    def proof_query(self, cli, runtime, args):
        if args == ["orchestration", "strict-caller-check"]:
            return {"coordinatorPolicy": "strict-v1", "effectsApplied": False,
                    "checkedAt": datetime.now(timezone.utc).isoformat(),
                    "caller": {"terminalHandle": "term_test", "authorityFingerprint": "a" * 64,
                    "paneKey": "tab:leaf", "processIncarnation": "pty:inc_test",
                    "hostScope": {"kind": "local", "hostId": "local"}}}
        if args == ["terminal", "show", "--terminal", "term_test"]:
            return {"terminal": {"incarnationId": "inc_test", "worktreeId": "workspace_test",
                                 "connected": True, "orphaned": False}}
        self.fail("unexpected mutation/query: " + str(args))

    def test_live_coordinator_consumes_fresh_pinned_operator_gate_without_creating_run(self):
        self.session_refs()
        with patch("coordinator_strict.native", side_effect=self.proof_query) as query:
            result = self.check()
        self.assertTrue(result["ok"])
        self.assertFalse(result["effectsApplied"])
        self.assertEqual(query.call_count, 3)

    def test_real_cli_envelope_preserves_raw_receipt_pin(self):
        self.session_refs()
        from coordinator_io import parse, pinned
        initial = parse(pinned(self.caller_ref))
        self.caller_ref = self.fixture.ref("full-caller.json", {
            "id": "request-id", "ok": True, "result": initial,
            "_meta": {"runtimeId": "runtime_test"}})
        with patch("coordinator_strict.native", side_effect=self.proof_query):
            result = self.check()
        self.assertEqual(result["caller_sha256"], self.caller_ref["sha256"])

    def test_caller_envelope_wrong_runtime_failure_and_malformed_result_rejected(self):
        initial = self.proof_query(None, None, ["orchestration", "strict-caller-check"])
        full = {"ok": True, "result": initial, "_meta": {"runtimeId": "runtime_test"}}
        for change in ({"ok": False}, {"ok": 1}, {"_meta": {"runtimeId": "other"}},
                       {"result": None}, {"error": "private"}, {"_meta": None}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                caller_result({**copy.deepcopy(full), **change}, "runtime_test")
        for change in ({"caller": None}, {"effectsApplied": True}, {"checkedAt": None}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                caller_result({**initial, **change}, "runtime_test")

    def test_stale_receipt_or_operator_context_rejected_before_probe(self):
        self.session_refs()
        old = (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()
        for changes in ({"valid_until": old}, {"actor": "coordinator"}, {"identity_sha256": "bad"}):
            ref = self.fixture.ref("invalid-gate.json", dict(self.receipt, **changes))
            with patch("coordinator_strict.native") as query, self.assertRaises(ValueError):
                self.check(ref)
            query.assert_not_called()
        os.environ["ORCA_TERMINAL_HANDLE"] = "term_operator"
        with patch("coordinator_strict.native") as query, self.assertRaises(ValueError):
            self.check()
        query.assert_not_called()

    def test_live_identity_race_and_native_refusal_do_not_fall_back_to_shell(self):
        self.session_refs()
        for failure in ("retired", "changed"):
            calls = []
            def query(cli, runtime, args):
                calls.append(args)
                if failure == "retired":
                    raise ValueError("native proof refused")
                result = self.proof_query(cli, runtime, args)
                if len(calls) == 3:
                    result["caller"]["processIncarnation"] = "new-process"
                return result
            with patch("coordinator_strict.native", side_effect=query), self.assertRaises(ValueError):
                self.check()
            self.assertTrue(all("run-create" not in args for args in calls))

    def test_same_terminal_and_process_cannot_replace_launch_token_between_gates(self):
        self.session_refs()
        def query(cli, runtime, args):
            result = self.proof_query(cli, runtime, args)
            result["caller"]["authorityFingerprint"] = "b" * 64
            return result
        with patch("coordinator_strict.native", side_effect=query), self.assertRaisesRegex(
                ValueError, "strict_launch_authority_changed"):
            self.check()

    def test_gate_expiring_during_live_check_stops(self):
        self.session_refs()
        expired = (datetime.now(timezone.utc) + timedelta(minutes=5)).isoformat()
        with patch("coordinator_strict.native", side_effect=self.proof_query), \
                patch("coordinator_strict.now", side_effect=[self.receipt["completed_at"], expired]), \
                self.assertRaisesRegex(ValueError, "strict_operator_session_receipt_stale"):
            self.check()

    def test_legacy_bootstrap_stays_unchanged(self):
        plan = build_plan(**self.trae.args)
        self.assertFalse(plan["native_launch"]["strict_eligible"])
        self.assertEqual(plan["argv"][-1], "-")
        self.assertEqual(plan["phase"], "bootstrap")


if __name__ == "__main__":
    unittest.main()

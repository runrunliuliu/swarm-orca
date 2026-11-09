"""Offline native/log fixtures only; no Agent or model requests."""

import copy
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import shlex
import sys
import unittest
from unittest.mock import patch

from coordinator_input import input_bytes
from coordinator_io import canonical, digest, file_ref, now
from coordinator_launch import build_plan
from coordinator_startup import identity, validate
from coordinator_strict import native_plan
from trae_coordinator import ContextFreshnessError, TUI_ADAPTER, TUI_EXECUTION, observe as stream_observe, verify_log
from trae_tui import observe
import test_trae_coordinator as legacy
import test_coordinator_startup as startup


class TuiTests(unittest.TestCase):
    cli_version = "0.211.1"

    def setUp(self):
        probe = patch("coordinator_strict.verify_trae_executable", return_value={"cli_version": self.cli_version})
        self.executable_probe = probe.start()
        self.addCleanup(probe.stop)
        self.f = legacy.TraeCoordinatorTests()
        self.f.setUp()
        self.addCleanup(self.f.doCleanups)
        self.f.use_auto_review()
        self.f.runtime.write_text(json.dumps(dict(schema_version=1, scope="swarm_coordinator_only",
            provider="trae", cli_version=self.cli_version, execution=TUI_EXECUTION)))
        self.f.meta["payload"].update(source="cli", originator="traex-tui", cli_version=self.cli_version)
        self.f.write_log()
        self.profile = self.f.root / "profile"
        (self.profile / "agent-hooks").mkdir(parents=True)
        self.ms = datetime.now(timezone.utc).timestamp() * 1000
        self.discovery = dict(runtimeId="runtime_test", pid=42, startedAt=self.ms - 10000,
                              authToken="must-never-appear")
        self.term = dict(handle="term_test", worktreeId="workspace_test", tabId="tab", leafId="leaf",
                         ptyId="pty", incarnationId="inc_test", executionHostId="local", agentIdentity="trae",
                         connected=True, orphaned=False)
        self.entry = dict(worktreeId="workspace_test", tabId="tab", source="trae",
            payload={"agentType": "trae"}, launchTokenHash="a" * 64, receivedAt=self.ms,
            evidenceObservedAt=self.ms, providerSession={"key": "session_id", "id": legacy.SID,
                                                       "transcriptPath": str(self.f.log)})
        authority = dict(terminalHandle="term_test", paneKey="tab:leaf", processIncarnation="pty:inc_test",
                         hostScope={"kind": "local", "hostId": "host"}, launchTokenHash="a" * 64)
        self.caller = dict(coordinatorPolicy="strict-v1", effectsApplied=False, checkedAt=now(),
            caller={**{k: v for k, v in authority.items() if k != "launchTokenHash"},
                    "authorityFingerprint": digest(canonical(authority))})
        self.caller_ref = self.ref("caller.json", self.caller)
        self.write_state()
        self.calls = []

    def ref(self, name, value):
        p = self.f.root / name
        p.write_text(json.dumps(value))
        return file_ref(p)

    def write_state(self):
        for p, v in ((self.profile / "orca-runtime.json", self.discovery),
                     (self.profile / "agent-hooks" / "last-status.json", {"version": 2, "entries": {"tab:leaf": self.entry}})):
            p.write_text(json.dumps(v))
            p.chmod(0o600)

    def query(self, cli, runtime, args):
        self.calls.append(args)
        if args == ["status"]:
            return dict(runtime={"appVersion": "1.4.219", "state": "ready", "capabilities": ["orchestration.strict-caller-check.v1"]},
                        target={"kind": "local"}, app={"running": True, "pid": 42})
        if args[:2] == ["terminal", "show"]:
            return {"terminal": copy.deepcopy(self.term)}
        if args[:2] == ["worktree", "show"]:
            return {"worktree": {"id": "workspace_test", "path": str(self.f.cwd)}}
        self.fail(args)

    def observe(self, **extra):
        args = dict(cli=sys.executable, runtime="runtime_test", terminal="term_test",
            incarnation="inc_test", workspace="workspace_test", cwd=str(self.f.cwd),
            profile=str(self.profile), caller_receipt=self.caller_ref, log_root=str(self.f.root),
            roots=[str(self.f.bootstrap)], trae_runtime_config=self.f.runtime)
        args.update(extra)
        with patch("trae_tui.native", side_effect=self.query):
            return observe(**args)

    def native_materials(self, plan_ref):
        marker = self.ref("native-materials-marker.json", {"fixture": "prelaunch"})
        handoff = self.ref("native-materials-handoff.md", "reviewed handoff")
        launch = self.ref("native-materials-launch.json", {"fixture": "launch-plan"})
        return self.ref("native-materials-final-checklist.json", {
            "schema_version": 1, "kind": "operator_prelaunch_materials",
            "status": "ready_for_external_review", "assembly_id": "tui-test",
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
                            "terminal": "term_operator", "incarnation": "inc_operator",
                            "workspace": "workspace_test", "session": "operator-session",
                            "observed_at": now()},
                "effective": {"effort": "high"}, "trust": "fixture"}

    def test_tui_native_plan_no_exec_flags_and_prompt_exact(self):
        plan = build_plan(**self.f.args, strict_coordinator=True)
        self.assertEqual(plan["adapter"], TUI_ADAPTER)
        self.assertEqual(plan["launch_transport"], "tui")
        self.assertEqual(plan["phase"], "strict-tui-bootstrap")
        args = shlex.split(plan["native_launch"]["agent_args"])
        for flag in ("--no-daemon", "--no-alt-screen", "--strict-config"):
            self.assertIn(flag, args)
        for flag in ("exec", "--json", "--color", "resume", "-"):
            self.assertNotIn(flag, args[:-1])
        # Why: the folder-trust gate would stop an unattended TUI on a workspace Trae has not
        # seen; the override answers it for this process only, without writing user config.
        trust = "projects={" + json.dumps(plan["cwd"]) + '={trust_level="trusted"}}'
        self.assertIn(trust, args)
        self.assertEqual(args[args.index(trust) - 1], "-c")
        self.assertEqual([arg for arg in args if arg.startswith("projects=")], [trust])
        self.assertNotEqual(args[-1].encode(), input_bytes(plan))
        self.assertEqual(plan["native_launch"]["prompt_sha256"],
                         plan["input_contract"]["stdin_sha256"])
        self.assertIn("Prompt file: " + str(self.f.prompt.resolve()), args[-1])
        self.assertIn(plan["input_contract"]["stdin_sha256"], args[-1])
        self.assertIn("strict-config-request", args[-1])
        self.assertIn("strict-config-plan", args[-1])
        self.assertIn("coordinator_tui_continue.py", args[-1])
        self.assertNotIn("Do not end the exec", args[-1])
        ref = self.ref("plan.json", plan)
        materials = self.native_materials(ref)
        operator_input = self.ref("operator-input.json", {"fixture": "operator-input"})
        with patch("coordinator_strict.native", side_effect=self.query), \
                patch("operator_session.verify_operator_identity",
                      return_value=self.operator_identity_result()):
            launch = native_plan(ref, cli=sys.executable, runtime="runtime_test",
                                 workspace="workspace_test", materials=materials,
                                 operator_input=operator_input)
        self.assertEqual(launch["argv"][1:3], ["terminal", "create"])
        self.assertNotIn("--agent-args", launch["argv"])
        assignments = [v for v in launch["argv"] if v.startswith("--agent-args=")]
        self.assertEqual(assignments, ["--agent-args=" + plan["native_launch"]["agent_args"]])
        self.assertEqual(shlex.split(assignments[0].split("=", 1)[1]), args)
        self.assertFalse(launch["execution_authorized"])
        self.executable_probe.assert_called_once_with(self.f.args["trae"], self.cli_version)

    def test_requires_strict_and_explicit_version_no_resume(self):
        with self.assertRaisesRegex(ValueError, "requires --strict"):
            build_plan(**self.f.args)
        with self.assertRaisesRegex(ValueError, "fresh native"):
            build_plan(**dict(self.f.args, bootstrap_dir=None, archive_dir=self.f.archive,
                              resume_session=legacy.SID, strict_coordinator=True))
        config = json.loads(self.f.runtime.read_text())
        config["cli_version"] = "0.210.1"
        self.f.runtime.write_text(json.dumps(config))
        with self.assertRaisesRegex(ValueError, "0.211.1"):
            build_plan(**self.f.args, strict_coordinator=True)

    def test_no_stream_fallback(self):
        with patch("trae_coordinator.native") as query, self.assertRaisesRegex(ValueError, "explicit trae_tui"):
            stream_observe(cli=sys.executable, runtime="r", terminal="t", incarnation="i", workspace="w",
                           cwd=self.f.cwd, cursor=0, log_root=self.f.root, roots=[], trae_runtime_config=self.f.runtime)
        query.assert_not_called()

    def test_exact_mapping_no_secret_or_liveness_claim(self):
        result = self.observe()
        self.assertEqual(result["thread_id"], legacy.SID)
        self.assertTrue(result["requires_live_caller_check"])
        self.assertIn("not-live-process-attested", result["trust"])
        self.assertNotIn("must-never-appear", json.dumps(result))
        self.assertFalse(any(a[:2] == ["terminal", "read"] for a in self.calls))

    def test_context_expiring_during_final_snapshot_stops(self):
        import trae_tui
        original = trae_tui.runtime_binding.observe
        later = datetime.now(timezone.utc)
        samples = 0
        def sample(*args):
            nonlocal later, samples
            result = original(*args)
            samples += 1
            if samples == 2:
                later += timedelta(seconds=901)
            return result
        clock = unittest.mock.MagicMock(wraps=datetime)
        clock.now.side_effect = lambda *args: later
        anchor = self.ref("anchor.json", self.observe())
        # Native/log read initially passes. Only final wall-clock check sees expiry.
        with patch("trae_tui.datetime", clock), patch("trae_tui.runtime_binding.observe", side_effect=sample), \
                self.assertRaises(ContextFreshnessError):
            self.observe(startup_anchor=anchor, expected_thread=legacy.SID)

    def test_stale_hook_has_specific_sanitized_code(self):
        self.entry["evidenceObservedAt"] -= 9999999
        self.write_state()
        with self.assertRaisesRegex(ValueError, "tui_hook_stale_or_future"):
            self.observe()

    def test_same_process_multiple_turns_and_anchor(self):
        anchor = self.observe()
        ref = self.ref("anchor.json", anchor)
        for _ in range(3):
            self.f.context["timestamp"] = now()
            with self.f.log.open("a") as target:
                target.write(json.dumps(self.f.context) + "\n")
            result = self.observe(startup_anchor=ref, expected_thread=legacy.SID)
            self.assertEqual(result["binding"], anchor["binding"])
            self.assertGreater(result["prefix_bytes"], anchor["prefix_bytes"])

    def test_startup_anchor_runtime_rebind_requires_explicit_same_identity_token(self):
        anchor = self.observe()
        ref = self.ref("anchor.json", anchor)
        self.discovery["runtimeId"] = "runtime_restarted"
        self.discovery["startedAt"] = datetime.now(timezone.utc).timestamp() * 1000 - 10000
        self.write_state()
        with self.assertRaisesRegex(ValueError, "tui_anchor_identity_changed"):
            self.observe(runtime="runtime_restarted", startup_anchor=ref,
                         caller_receipt_runtime="runtime_test", expected_thread=legacy.SID)
        result = self.observe(runtime="runtime_restarted", startup_anchor=ref,
            caller_receipt_runtime="runtime_test", expected_thread=legacy.SID,
            accepted_runtime_rebind={"schema_version": 1,
                "kind": "verified_same_coordinator_runtime_epoch_rebind",
                "source_runtime": "runtime_test", "target_runtime": "runtime_restarted",
                "terminal": "term_test", "incarnation": "inc_test", "workspace": "workspace_test"})
        self.assertEqual(result["runtime_id"], "runtime_restarted")
        self.assertEqual(result["binding"]["runtime"]["runtimeId"], "runtime_restarted")

    def test_startup_anchor_runtime_rebind_token_is_bound_to_terminal_identity(self):
        anchor = self.observe()
        ref = self.ref("anchor.json", anchor)
        self.discovery["runtimeId"] = "runtime_restarted"
        self.write_state()
        for key, value in (("terminal", "other"), ("incarnation", "other"),
                           ("workspace", "other"), ("target_runtime", "other")):
            token = {"schema_version": 1, "kind": "verified_same_coordinator_runtime_epoch_rebind",
                     "source_runtime": "runtime_test", "target_runtime": "runtime_restarted",
                     "terminal": "term_test", "incarnation": "inc_test", "workspace": "workspace_test"}
            token[key] = value
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "tui_anchor_identity_changed"):
                self.observe(runtime="runtime_restarted", startup_anchor=ref,
                             caller_receipt_runtime="runtime_test", expected_thread=legacy.SID,
                             accepted_runtime_rebind=token)

    def test_shell_connected_is_not_agent(self):
        self.term.pop("agentIdentity")
        with self.assertRaisesRegex(ValueError, "runtime_state_unverifiable"):
            self.observe()

    def test_hook_cannot_regress_behind_startup_anchor(self):
        ref = self.ref("anchor.json", self.observe())
        self.entry["receivedAt"] -= 1
        self.entry["evidenceObservedAt"] -= 1
        self.write_state()
        with self.assertRaisesRegex(ValueError, "hook_regressed"):
            self.observe(startup_anchor=ref, expected_thread=legacy.SID)

    def test_wrong_hook_launch_token_session_runtime_or_replay_stops(self):
        for change in ({"launchTokenHash": "b" * 64}, {"restoredUnconfirmed": True}, {"isReplay": True},
                       {"source": "codex"}, {"evidenceObservedAt": self.ms - 9999999},
                       {"providerSession": {"key": "session_id", "id": "other", "transcriptPath": str(self.f.log)}}):
            original = copy.deepcopy(self.entry)
            self.entry.update(change)
            self.write_state()
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.observe()
            self.entry = original
        self.discovery["runtimeId"] = "other"
        self.write_state()
        with self.assertRaises(ValueError):
            self.observe()

    def test_anchor_cannot_follow_new_identity_or_history(self):
        ref = self.ref("anchor.json", self.observe())
        self.term["ptyId"] = "other"
        with self.assertRaises(ValueError):
            self.observe(startup_anchor=ref, expected_thread=legacy.SID)
        self.term["ptyId"] = "pty"
        self.f.log.write_text(self.f.log.read_text().replace("GPT-5.5", "gpt-5.5"))
        with self.assertRaisesRegex(ValueError, "history_changed"):
            self.observe(startup_anchor=ref, expected_thread=legacy.SID)

    def test_wrong_origin_settings_or_version_rejected(self):
        for key, value in (("originator", "codex_exec"), ("source", "exec"), ("cli_version", "0.210.1"),
                           ("parent_thread_id", legacy.SID), ("agent_id", "child")):
            original = copy.deepcopy(self.f.meta)
            self.f.meta["payload"][key] = value
            self.f.write_log()
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.observe()
            self.f.meta = original

    def test_tui_startup_contract_and_observer_route(self):
        fixture = startup.StartupGateTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        fixture.use_v2()
        c = fixture.contract
        c["adapter"] = TUI_ADAPTER
        c["runtime_config"] = file_ref(self.f.runtime)
        c["observation"] = dict(profile=str(self.profile), caller_receipt=self.caller_ref,
            log_root=str(self.f.root), roots=[str(self.f.bootstrap)], startup_anchor=self.ref("anchor.json", self.observe()))
        validate(c)
        self.assertIn("tui_binding", identity(c))
        with patch("trae_tui.observe", return_value={"thread_id": legacy.SID, "observed_at": now()}) as observer, \
                patch("operator_session.observe_identity", return_value={"trust": "fixture"}), \
                patch("coordinator_startup.check_operator_mailbox"):
            self.assertTrue(fixture.gate()["ok"])
        self.assertNotIn("cursor", observer.call_args.kwargs)
        self.assertEqual(observer.call_args.kwargs["profile"], str(self.profile))
        c["schema_version"] = 1
        c.pop("freshness")
        with self.assertRaises(ValueError):
            validate(c)

    def test_tui_first_dispatch_requires_same_live_caller(self):
        fixture = startup.StartupGateTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        fixture.use_v2()
        c = fixture.contract
        c["adapter"] = TUI_ADAPTER
        c["runtime_config"] = file_ref(self.f.runtime)
        c["observation"] = dict(profile=str(self.profile), caller_receipt=self.caller_ref,
            log_root=str(self.f.root), roots=[str(self.f.bootstrap)],
            startup_anchor=self.ref("anchor.json", self.observe()))
        with patch("trae_tui.observe", return_value={"thread_id": legacy.SID, "observed_at": now()}), \
                patch("operator_session.observe_identity", return_value={"trust": "fixture"}), \
                patch("coordinator_startup.check_operator_mailbox"):
            fixture.prepare_dispatch()
            previous = fixture.ref("dispatch.json", fixture.gate(phase="first-dispatch", previous=fixture.prior))
            def query(cli, runtime, args):
                if args == ["orchestration", "strict-caller-check"]:
                    return copy.deepcopy(self.caller)
                if args[:2] == ["orchestration", "run-current"]:
                    return {"run": copy.deepcopy(fixture.run)}
                return fixture.query(cli, runtime, args)
            with patch.dict(os.environ, ORCA_TERMINAL_HANDLE="term_test"), \
                    patch("coordinator_startup.native", side_effect=query):
                self.assertTrue(fixture.gate(phase="first-dispatch", actor="coordinator", previous=previous)["ok"])
                self.caller["caller"]["authorityFingerprint"] = "b" * 64
                with self.assertRaisesRegex(ValueError, "tui_live_caller_changed"):
                    fixture.gate(phase="first-dispatch", actor="coordinator", previous=previous)


class Tui02121Tests(TuiTests):
    """Same caller, freshness, anchor and settings fences for the observed new TUI."""
    cli_version = "0.212.1"


class Tui02131Tests(TuiTests):
    """Same strict TUI fences for the current host Trae CLI."""
    cli_version = "0.213.1"


if __name__ == "__main__":
    unittest.main()

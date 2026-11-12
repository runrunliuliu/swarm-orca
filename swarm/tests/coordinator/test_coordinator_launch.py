import json
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from coordinator_launch import BASE, build_plan, main


class CoordinatorLaunchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.cwd = self.root / "work space's $(not-a-command)"
        self.archive = self.root / "BN space's archive"
        self.cwd.mkdir()
        self.archive.mkdir()
        self.alias = self.root / "alias"
        self.alias.symlink_to(self.archive, target_is_directory=True)
        # Codex-specific tests must not depend on the user's current Agent preference.
        self.model_config = self.root / "codex-model.json"
        self.model_config.write_text(json.dumps({
            "schema_version": 1, "scope": "swarm_coordinator_only",
            "selection": {"mode": "explicit", "agent": "codex", "model": "gpt-test",
                          "effort": "xhigh", "max_mode": None},
        }))
        self.args = dict(codex=sys.executable, cwd=self.cwd, archive_dir=self.alias,
                         model_config=self.model_config)

    def runtime(self, **updates):
        config = json.loads((BASE / "coordinator-runtime.json").read_text())
        config["execution"].update(updates)
        path = self.root / "runtime.json"
        path.write_text(json.dumps(config))
        return path

    def test_full_access_is_coordinator_only_and_preserves_model(self):
        plan = build_plan(**self.args)
        self.assertEqual(plan["execution"], {
            "sandbox_mode": "danger-full-access", "approval_policy": "never", "no_daemon": True,
        })
        self.assertEqual(plan["selection"], json.loads(self.model_config.read_text())["selection"])
        argv = plan["argv"]
        self.assertEqual(argv[argv.index("--sandbox") + 1], "danger-full-access")
        self.assertEqual(argv[argv.index("--ask-for-approval") + 1], "never")
        self.assertIn("--no-daemon", argv)
        self.assertNotIn("--approve-for-me", argv)
        self.assertNotIn("--add-dir", argv)
        self.assertEqual(plan["task_write_roots"], [str(self.archive)])
        self.assertIn("Phase: run. After required startup/recovery gates", plan["prompt_fragment"])
        self.assertIn("one-shot", plan["prompt_fragment"])
        self.assertIn("worker-plan --request", plan["prompt_fragment"])
        self.assertNotIn("MUST NOT dispatch", plan["prompt_fragment"])

    def test_alias_and_canonical_inputs_produce_same_command_and_prompt(self):
        alias_plan = build_plan(**self.args)
        real_plan = build_plan(**dict(self.args, archive_dir=self.archive))
        self.assertEqual(alias_plan["command"], real_plan["command"])
        self.assertEqual(alias_plan["prompt_fragment"], real_plan["prompt_fragment"])
        self.assertNotIn(str(self.alias), alias_plan["prompt_fragment"])
        self.assertEqual(alias_plan["artifact_dirs"]["evidence"], str(self.archive / "evidence"))
        self.assertEqual(list(self.archive.iterdir()), [])  # Planning creates no probes or directories.

    def test_workspace_write_uses_same_canonical_roots_without_duplicates(self):
        ledger = self.root / "separate-ledger"
        ledger.mkdir()
        plan = build_plan(**self.args, write_dirs=[self.archive, ledger],
                          runtime_config=self.runtime(sandbox_mode="workspace-write"))
        roots = [plan["argv"][i + 1] for i, arg in enumerate(plan["argv"]) if arg == "--add-dir"]
        self.assertEqual(roots, [str(self.archive), str(ledger)])
        self.assertEqual(roots, plan["task_write_roots"])
        self.assertEqual(plan["artifact_dirs"]["archive"], roots[0])

    def test_subdirectory_symlink_escape_and_prefix_sibling_are_rejected(self):
        sibling = self.root / (self.archive.name + "-other-run")
        sibling.mkdir()
        (self.archive / "evidence").symlink_to(sibling, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "escapes archive root"):
            build_plan(**self.args)

    def test_internal_symlink_is_normalized(self):
        (self.archive / "actual-evidence").mkdir()
        (self.archive / "evidence").symlink_to(self.archive / "actual-evidence", target_is_directory=True)
        plan = build_plan(**self.args)
        self.assertEqual(plan["artifact_dirs"]["evidence"], str(self.archive / "actual-evidence"))

    def test_missing_relative_root_and_non_directory_are_rejected(self):
        file = self.root / "file"
        file.touch()
        for path in (self.root / "missing", "relative", "/", file):
            with self.subTest(path=path), self.assertRaises((OSError, ValueError)):
                build_plan(**dict(self.args, archive_dir=path))

    def test_shell_command_round_trip_and_cwd_normalization(self):
        cwd_alias = self.root / "cwd-link"
        cwd_alias.symlink_to(self.cwd, target_is_directory=True)
        plan = build_plan(**dict(self.args, cwd=cwd_alias), write_dirs=[self.archive])
        self.assertEqual(shlex.split(plan["command"]), ["exec", *plan["argv"]])
        self.assertEqual(plan["cwd"], str(self.cwd))

    def test_invalid_execution_config_never_silently_falls_back(self):
        for update in ({"sandbox_mode": "typo"}, {"approval_policy": "automatic"},
                       {"no_daemon": "false"}, {"unknown": True}):
            with self.subTest(update=update), self.assertRaises(ValueError):
                build_plan(**self.args, runtime_config=self.runtime(**update))

    def test_non_codex_or_independent_max_selection_is_rejected(self):
        config = json.loads(self.model_config.read_text())
        path = self.root / "model.json"
        for update in ({"agent": "trae"}, {"max_mode": True}, {"mode": "inherit"}):
            candidate = dict(config, selection=dict(config["selection"], **update))
            path.write_text(json.dumps(candidate))
            with self.subTest(update=update), self.assertRaises(ValueError):
                build_plan(**dict(self.args, model_config=path))
        del config["selection"]["max_mode"]
        path.write_text(json.dumps(config))
        with self.assertRaisesRegex(ValueError, "selection fields"):
            build_plan(**dict(self.args, model_config=path))

    def test_trae_selection_is_rejected_without_codex_fallback(self):
        config = json.loads(self.model_config.read_text())
        config["selection"].update(agent="trae", model="gpt-5.5", effort="xhigh", max_mode=True)
        self.model_config.write_text(json.dumps(config))
        with self.assertRaisesRegex(ValueError, "Trae selection requires --trae"):
            build_plan(**self.args)

    def test_cli_prints_plan_without_executing_selected_binary(self):
        # /bin/false would fail immediately if the planner tried to execute it.
        result = subprocess.run([
            sys.executable, str(BASE / "coordinator_launch.py"), "--codex", "/bin/false",
            "--cwd", str(self.cwd), "--archive-dir", str(self.alias),
            "--model-config", str(self.model_config),
        ], capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(result.stdout)["argv"][0], "/bin/false")
        self.assertEqual(list(self.archive.iterdir()), [])

    def test_native_preflight_subcommand_routes_without_changing_legacy_parser(self):
        with mock.patch("native_preflight.cli_main", return_value=7) as preflight:
            self.assertEqual(main(["native-preflight", "--contract", "/tmp/contract"]), 7)
        preflight.assert_called_once_with(["--contract", "/tmp/contract"])

    def test_wait_stage_and_handoff_accept_are_sibling_verbs(self):
        # Both answer "wait" or "accept", so neither may be folded into `strict-bootstrap`
        # (the owner-RPC client with its --owner/--execute contract).
        wait_argv = ["--bootstrap", "/tmp/attempt", "--expect-attempt", "attempt-test",
                     "--attempt-binding-sha256", "0" * 64, "--stage", "2", "--json"]
        with mock.patch("bootstrap_stage_wait.cli_main", return_value=7) as wait_stage:
            self.assertEqual(main(["strict-bootstrap-wait-stage", *wait_argv]), 7)
        wait_stage.assert_called_once_with(wait_argv)
        accept_argv = ["--bootstrap", "/tmp/attempt", "--expect-attempt", "attempt-test",
                       "--attempt-binding-sha256", "0" * 64, "--wait", "--json"]
        with mock.patch("bootstrap_handoff.cli_main", return_value=5) as accept:
            self.assertEqual(main(["strict-bootstrap-handoff-accept", *accept_argv]), 5)
        accept.assert_called_once_with(accept_argv)

    def test_existing_strict_bootstrap_verbs_keep_their_argv_face(self):
        # Byte-identical pass-through: the new verbs must not reshape these two.
        plan = ["plan", "--owner", "/tmp/owner.json", "--owner-sha256", "0" * 64]
        with mock.patch("bootstrap_tool.cli_main", return_value=0) as tool:
            self.assertEqual(main(["strict-bootstrap", *plan]), 0)
        tool.assert_called_once_with(plan)
        state = ["--bootstrap", "/tmp/attempt", "--expect-attempt", "attempt-test",
                 "--attempt-binding-sha256", "0" * 64, "--check"]
        with mock.patch("bootstrap_events.cli_main", return_value=2) as events:
            self.assertEqual(main(["strict-bootstrap-state", *state]), 2)
        events.assert_called_once_with(state)


if __name__ == "__main__":
    unittest.main()

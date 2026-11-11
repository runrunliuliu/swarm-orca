"""Pi Coordinator launch recipe: what a Pi strict plan may and may not claim.

The repository accepts `pi-tui-runtime-v1` in every gate, so the plan builder has to be
able to produce that plan; before this module the only recipe was Trae's. These cases pin
the provider boundary: a Pi plan says `agent: pi`, verifies Pi's own settings, and refuses
any selection the pinned policy does not prove.
"""

import json
import pathlib
import shlex
import tempfile
import unittest
from unittest.mock import patch

import coordinator_strict
import pi_coordinator
import pi_policy
import tui_adapter


class PiPlanTests(unittest.TestCase):
    def setUp(self):
        self.root = pathlib.Path(tempfile.mkdtemp(prefix="pi-plan-"))
        self.addCleanup(lambda: __import__("shutil").rmtree(self.root, ignore_errors=True))
        self.executable = self.root / "pi"
        self.executable.write_text("#!/bin/sh\necho 1.5.0\n")
        self.executable.chmod(0o755)
        self.policy_path = self.root / "policy.json"
        self.policy_path.write_text(json.dumps({
            "schema_version": 1, "scope": "swarm_coordinator_only", "provider": "pi",
            "model": {"provider": "platform", "id": "ep-20261022142731-wnrq6"},
            "thinking_level": "medium"}))
        self.brief = self.root / "brief.md"
        self.brief.write_text("# brief\n")
        self.archive = self.root / "bootstrap"
        self.archive.mkdir()
        self.selection = pi_coordinator.selection_for(pi_policy.read(str(self.policy_path)))

    def build(self, **overrides):
        kwargs = dict(pi=str(self.executable), cwd=str(self.root),
                      bootstrap_dir=str(self.archive), write_dirs=[str(self.root)],
                      selection=self.selection, runtime_config=str(self.policy_path),
                      prompt_file=str(self.brief), cli_version="1.5.0")
        kwargs.update(overrides)
        return pi_coordinator.build_pi_plan(**kwargs)

    def test_recipe_is_the_pi_tui_adapter(self):
        plan = self.build()
        self.assertEqual(plan["adapter"], tui_adapter.PI_ADAPTER)
        self.assertEqual(plan["execution"], {"launch_mode": "tui"})
        self.assertEqual(plan["phase"], "bootstrap")
        self.assertIsNone(plan["resume_session"])
        self.assertEqual(plan["argv"], [str(self.executable), "--provider", "platform",
                                       "--model", "ep-20261022142731-wnrq6:medium"])

    def helper_root(self):
        root = self.root / "helpers"
        root.mkdir()
        for name in ("coordinator_launch.py", "coordinator-strict-start.md",
                     "coordinator-worker-plan.md", "coordinator_tui_continue.py"):
            (root / name).write_text("# pinned helper\n")
        return root

    def test_a_pinned_helper_root_survives_the_native_plan_rebuild(self):
        # Why: native_plan rebuilds the reviewed plan and requires byte equality. A
        # rebuild without the pinned root always differs, so every pinned-helper plan
        # used to be refused as strict_native_plan_changed.
        import coordinator_strict
        from coordinator_input import bind_prompt

        root = self.helper_root()
        plan = coordinator_strict.strict_plan(self.build(), helper_root=str(root))
        self.assertEqual(plan["helper_root"], str(root))
        same = coordinator_strict.strict_plan(self.build(), helper_root=plan.get("helper_root"))
        self.assertEqual(plan, same)
        self.assertNotEqual(plan, coordinator_strict.strict_plan(self.build()))
        self.assertEqual(bind_prompt(plan, self.brief)["input_contract"],
                         bind_prompt(same, self.brief)["input_contract"])

    def test_native_plan_forwards_the_pinned_helper_root(self):
        import coordinator_strict
        from coordinator_io import canonical, file_ref
        from coordinator_input import bind_prompt
        from unittest.mock import patch

        root = self.helper_root()
        plan = bind_prompt(coordinator_strict.strict_plan(self.build(), helper_root=str(root)), self.brief)

        def write(name, value):
            target = self.root / name
            target.write_bytes((canonical(value) if isinstance(value, dict) else str(value).encode()) + b"\n")
            return file_ref(target)

        ref = write("strict.json", plan)
        materials = write("materials.json", {"fixture": True})
        operator_input = write("operator.json", {"fixture": True})
        query = lambda cli, runtime, argv: (
            {"runtime": {"state": "ready", "capabilities": [coordinator_strict.CAPABILITY]}}
            if argv == ["status"] else {"worktree": {"id": "workspace_test", "path": str(self.root)}})
        with patch("coordinator_strict.native", side_effect=query), \
                patch("coordinator_strict.verify_native_inputs",
                      return_value={"operator": {"session": "operator-session"}}), \
                patch("pi_coordinator.verify_pi_executable", return_value={"cli_version": "1.5.0"}):
            result = coordinator_strict.native_plan(
                ref, cli=str(self.executable), runtime="runtime_test", workspace="workspace_test",
                materials=materials, operator_input=operator_input)
        self.assertEqual(result["mode"], "strict_native_launch_plan")
        self.assertFalse(result["execution_authorized"])

    def test_selection_must_equal_the_pinned_policy(self):
        for change in ({"model": "other"}, {"thinking_level": "low"},
                       {"provider": "elsewhere"}, {"agent": "trae"}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.build(selection=dict(self.selection, **change))

    def test_selection_cannot_add_or_drop_keys(self):
        widened = dict(self.selection, effort="high")
        with self.assertRaises(ValueError):
            self.build(selection=widened)
        narrowed = {key: value for key, value in self.selection.items() if key != "provider"}
        with self.assertRaises(ValueError):
            self.build(selection=narrowed)

    def test_symlinked_or_relative_executable_is_refused(self):
        link = self.root / "pi-link"
        link.symlink_to(self.executable)
        with self.assertRaises(ValueError):
            self.build(pi=str(link))
        with self.assertRaises(ValueError):
            self.build(pi="pi")

    def test_strict_plan_says_pi_and_verifies_pi_settings(self):
        strict = coordinator_strict.strict_plan(self.build(), registered_bootstrap=False)
        self.assertEqual(strict["native_launch"]["agent"], "pi")
        self.assertEqual(strict["phase"], "strict-tui-bootstrap")
        fragment = strict["prompt_fragment"]
        self.assertIn("Pi model provider, model selector and thinking level", fragment)
        self.assertNotIn("Max, sandbox", fragment)
        argv_tail = shlex.split(strict["native_launch"]["agent_args"])
        self.assertEqual(argv_tail[:4], ["--provider", "platform", "--model",
                                         "ep-20261022142731-wnrq6:medium"])
        prompt = argv_tail[-1]
        self.assertEqual(strict["native_launch"]["short_prompt_sha256"],
                         coordinator_strict.digest(prompt.encode("utf-8")))

    def test_trae_recipes_still_say_trae(self):
        for adapter in (None, tui_adapter.TRAE_ADAPTER, tui_adapter.EXEC_ADAPTER):
            with self.subTest(adapter=adapter):
                self.assertEqual(coordinator_strict.provider_of({"adapter": adapter}), "trae")
                self.assertEqual(coordinator_strict.provider_verification_text("trae"),
                                 " Verify actual Trae model, effort, Max, sandbox and approvals against ")

    def test_unknown_adapter_is_refused_not_guessed(self):
        with self.assertRaises(ValueError):
            coordinator_strict.provider_of({"adapter": "codex-ark-tui-runtime-v9"})

    def test_executable_version_mismatch_is_refused(self):
        with self.assertRaises(ValueError):
            pi_coordinator.verify_pi_executable(str(self.executable), "9.9.9")

    def test_executable_version_matches_pinned_value(self):
        with patch.object(pi_coordinator, "prefix_digest", wraps=pi_coordinator.prefix_digest):
            observed = pi_coordinator.verify_pi_executable(str(self.executable), "1.5.0")
        self.assertEqual(observed["cli_version"], "1.5.0")
        self.assertEqual(observed["trust"], "operator-local-prelaunch-not-process-attested")


if __name__ == "__main__":
    unittest.main()

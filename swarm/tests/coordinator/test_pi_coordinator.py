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
        self.assertEqual(plan["argv"], [str(self.executable)])

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
        prompt = shlex.split(strict["native_launch"]["agent_args"])[-1]
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

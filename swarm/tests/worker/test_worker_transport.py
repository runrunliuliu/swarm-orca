"""Declared launch transport per reviewed agent; no native call and no Agent is started."""

import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from coordinator_io import file_ref
from coordinator_worker_plan import build_plan
from coordinator_worker_profiles import (AGENT_TRANSPORT, AGENTS, PROFILES, TRANSPORTS,
                                        resolve, transport)
import offline_env
import trae_exec_capture


class TransportTableTests(unittest.TestCase):
    def test_every_reviewed_agent_declares_a_known_transport(self):
        # A reviewed agent cannot be added to the whitelist without deciding its transport;
        # otherwise this table would silently abstain for it.
        self.assertEqual(set(AGENT_TRANSPORT), set(AGENTS))
        self.assertLessEqual(set(AGENT_TRANSPORT.values()),
                             {"both"} | {wanted + "-only" for wanted in TRANSPORTS})

    def test_tui_only_agents_refuse_exec(self):
        for agent in ("pi", "codex-ark"):
            with self.subTest(agent=agent):
                self.assertEqual(transport(agent), "tui-only")
                with self.assertRaisesRegex(
                        ValueError,
                        "agent_transport_unsupported:" + agent + ":exec:tui-only"):
                    transport(agent, "exec")

    def test_trae_keeps_both_reviewed_shapes(self):
        # Exec is not a fallback here: it is the separately reviewed capture contract.
        self.assertEqual(transport("trae"), "both")
        self.assertEqual(transport("trae", "exec"), "both")

    def test_unreviewed_agent_abstains_instead_of_matching_any_transport(self):
        self.assertIsNone(transport("claude"))
        self.assertIsNone(transport("claude", "exec"))

    def test_unknown_transport_shape_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "unknown_launch_transport:batch"):
            transport("trae", "batch")


class TransportInPlansTests(unittest.TestCase):
    def setUp(self):
        # These assertions describe the bundled fixture, so a private Operator override in the
        # caller's environment must not change which file the plan pins.
        self.addCleanup(offline_env.cleared().stop)

    def request(self, model="gpt-5.5"):
        return {"schema_version": 2, "cli": "/verified/orca-server-cli",
                "run": "run_test", "task": "task_test", "model": model,
                "profiles_sha256": file_ref(PROFILES)["sha256"],
                "placement": {"kind": "existing", "worktree": "id:repo::/workspace"}}

    def test_resolved_profile_records_the_declared_transport(self):
        for model, expected in (("gpt-5.5", "both"), ("example-pi-model", "tui-only"),
                                ("codex-ark/example-ark-model", "tui-only")):
            with self.subTest(model=model):
                _, profile = resolve(model, file_ref(PROFILES)["sha256"])
                self.assertEqual(profile["launch_transport"], expected)

    def test_worker_plan_declares_tui_and_the_agent_shape(self):
        for model, expected in (("gpt-5.5", "both"),
                                ("codex-ark/example-ark-model", "tui-only")):
            with self.subTest(model=model):
                plan = build_plan(self.request(model))
                # worker-start launches a runtime-managed TUI agent; there is no exec shape here.
                self.assertEqual(plan["launch_transport"], "tui")
                self.assertEqual(plan["resolved_profile"]["launch_transport"], expected)
                self.assertFalse(plan["effectsApplied"])

    def test_agent_without_a_tui_shape_fails_before_a_plan_exists(self):
        # The fail-closed path: if a future reviewed agent only ships an exec launch, this plan
        # path must refuse it rather than emit a TUI launch that the vendor cannot honor.
        with patch.dict(AGENT_TRANSPORT, {"trae": "exec-only"}):
            with self.assertRaisesRegex(
                    ValueError, "agent_transport_unsupported:trae:tui:exec-only"):
                build_plan(self.request())

    def test_capture_refuses_a_plan_that_did_not_declare_exec(self):
        # A TUI plan carries argv for the native launch, not for the capture adapter.
        with tempfile.TemporaryDirectory() as temp:
            plan_path = Path(temp, "plan.json")
            plan_path.write_text(json.dumps({"adapter": "trae-exec-stream-v1",
                                             "launch_transport": "tui"}))
            with self.assertRaisesRegex(ValueError, "only an exec plan"):
                trae_exec_capture.run(plan_path, Path(temp, "capture"))


if __name__ == "__main__":
    unittest.main()

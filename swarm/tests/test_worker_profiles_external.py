"""Explicit deployment policy selection, without native calls or Agents."""

import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from coordinator_io import file_ref
from coordinator_worker_plan import build_plan
from coordinator_worker_profiles import PROFILES, resolve


class ExternalWorkerProfilesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.policy = self.root / "private profiles.json"
        self.config = {"schema_version": 1, "scope": "swarm_worker_only", "profiles": {
            "deployment-model": {"agent": "trae", "effort": "xhigh",
                                 "backend_variant": "max", "blocked_reason": None}}}
        self.policy.write_text(json.dumps(self.config))
        self.env = patch.dict(os.environ, {"SWARM_WORKER_PROFILES": str(self.policy)})
        self.env.start()
        self.addCleanup(self.env.stop)

    def request(self):
        return {"schema_version": 2, "cli": "/verified/orca-server-cli",
                "run": "run_test", "task": "task_test", "model": "deployment-model",
                "profiles_sha256": file_ref(self.policy)["sha256"],
                "placement": {"kind": "existing", "worktree": "id:workspace"}}

    def test_plan_uses_reviewed_external_policy_and_records_exact_pin(self):
        with patch("subprocess.Popen") as spawn:
            plan = build_plan(self.request())
        spawn.assert_not_called()
        self.assertFalse(plan["effectsApplied"])
        self.assertEqual(plan["resolved_profile"]["config"], file_ref(self.policy))
        self.assertIn("deployment-model", plan["argv"])
        self.assertIn("xhigh", plan["argv"])

    def test_absent_override_uses_bundled_file(self):
        del os.environ["SWARM_WORKER_PROFILES"]
        _, profile = resolve("gpt-5.5", file_ref(PROFILES)["sha256"])
        self.assertEqual(profile["config"], file_ref(PROFILES))

    def test_invalid_explicit_paths_never_fall_back(self):
        link = self.root / "link.json"
        link.symlink_to(self.policy)
        for source, code in (("", "empty_worker_profiles_path"),
                             ("relative.json", "absolute_path_required"),
                             (str(self.root / "missing.json"), "worker_profiles_unreadable"),
                             (str(link), "canonical_nonsymlink_path_required"),
                             (str(self.root), "wrong_path_type")):
            with self.subTest(source=source), patch.dict(os.environ, {
                    "SWARM_WORKER_PROFILES": source}):
                with self.assertRaisesRegex(ValueError, code):
                    resolve("gpt-5.5", file_ref(PROFILES)["sha256"])

    def test_changed_hash_unknown_model_and_blocked_profile_fail_closed(self):
        request = self.request()
        self.policy.write_text(json.dumps(self.config) + "\n")
        with self.assertRaisesRegex(ValueError, "file_pin_changed"):
            build_plan(request)
        with self.assertRaisesRegex(ValueError, "worker_model_not_in_fixed_profiles"):
            resolve("gpt-5.5", file_ref(self.policy)["sha256"])
        self.config["profiles"]["deployment-model"]["blocked_reason"] = "pending review"
        self.policy.write_text(json.dumps(self.config))
        with self.assertRaisesRegex(ValueError, "worker_profile_blocked"):
            build_plan(self.request())

    def test_request_cannot_select_policy_or_override_settings(self):
        for key in ("profiles_path", "profiles_config", "env", "effort", "backend_variant"):
            request = self.request()
            request[key] = str(PROFILES)
            with self.subTest(key=key), self.assertRaises(ValueError):
                build_plan(request)


if __name__ == "__main__":
    unittest.main()

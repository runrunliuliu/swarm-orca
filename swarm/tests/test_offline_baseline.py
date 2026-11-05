"""The offline baseline must not depend on the caller's private Operator policy.

`tests/run_offline.sh` clears `SWARM_WORKER_PROFILES` before running the suite. These
assertions say why that is required: an ambient override either names a different
reviewed file (so a pin computed elsewhere must be refused as a *source* mismatch)
or names a file that cannot be read (so the run must fail closed with a code rather
than with a bare `OSError` or a misleading `file_pin_changed`).
"""

import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from coordinator_io import file_ref
from coordinator_worker_plan import build_plan
from coordinator_worker_profiles import PROFILES
from test_coordinator_worker_plan import WorkerPlanTests


class OfflineBaselineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.policy = self.root / "private profiles.json"
        self.policy.write_text(json.dumps({
            "schema_version": 1, "scope": "swarm_worker_only", "profiles": {
                "gpt-5.5": {"agent": "trae", "effort": "high",
                            "backend_variant": "max", "blocked_reason": None}}}))
        self.override = patch.dict(os.environ,
                                   {"SWARM_WORKER_PROFILES": str(self.policy)})

    def request(self, pin):
        return dict(schema_version=2, cli="/verified/orca-server-cli", run="run_test",
                    task="task_test", model="gpt-5.5", profiles_sha256=pin,
                    placement={"kind": "existing", "worktree": "id:workspace"})

    def test_suite_is_env_hermetic(self):
        # A private override is active, so this must be a *valid* plan only because
        # the shared plan-argv fixture pins the file the process actually reads.
        with self.override:
            plan = build_plan(self.request(file_ref(self.policy)["sha256"]))
            self.assertEqual(plan["resolved_profile"]["config"],
                             {"path": str(self.policy),
                              "sha256": file_ref(self.policy)["sha256"]})
            # The shipped plan-argv tests must reach the same file under the same env.
            case = WorkerPlanTests("test_existing_workspace_never_emits_creation_flags")
            case.setUp()
            try:
                bundled = build_plan(case.request())
            finally:
                case.doCleanups()
        self.assertEqual(bundled["resolved_profile"]["config"],
                         {"path": str(PROFILES),
                          "sha256": file_ref(PROFILES)["sha256"]})

    def test_cross_source_pin_is_refused_by_name_not_by_hash(self):
        with self.override, self.assertRaisesRegex(ValueError,
                                                   "worker_profiles_pin_source_mismatch"):
            build_plan(self.request(file_ref(PROFILES)["sha256"]))

    def test_unreadable_override_fails_closed_with_an_explicit_code(self):
        missing = str(self.root / "gone.json")
        with patch.dict(os.environ, {"SWARM_WORKER_PROFILES": missing}):
            with self.assertRaisesRegex(ValueError, "worker_profiles_unreadable"):
                build_plan(self.request(file_ref(PROFILES)["sha256"]))

    def test_failed_plan_exposes_no_policy_bytes_or_path(self):
        with self.override:
            for pin in (file_ref(PROFILES)["sha256"], "0" * 64):
                with self.subTest(pin=pin), self.assertRaises(ValueError) as caught:
                    build_plan(self.request(pin))
                message = str(caught.exception)
                self.assertNotIn(str(self.policy), message)
                self.assertNotIn("gpt-5.5", message)
                self.assertNotIn("trae", message)


if __name__ == "__main__":
    unittest.main()

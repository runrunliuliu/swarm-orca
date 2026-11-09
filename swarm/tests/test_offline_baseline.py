"""The offline baseline must not depend on the caller's private Operator policy.

`tests/run_offline.sh` clears `SWARM_WORKER_PROFILES` before running the suite. These
assertions say why that is required: an ambient override either names a different
reviewed file (so a pin computed elsewhere must be refused as a *source* mismatch)
or names a file that cannot be read (so the run must fail closed with a code rather
than with a bare `OSError` or a misleading `file_pin_changed`).

The runner's own modes are pinned here too: `--fast` is iteration feedback over every
module except the documented wall-time dominators, and only `--full` may be reported as
PASS. Both listings are read without running either suite. The expected module set comes
from unittest's own discovery rather than from the glob the script globs, so a nested
importable test package — which discovery would run and `--fast`'s explicit list would
silently miss — fails these assertions instead of passing them.
"""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from coordinator_io import file_ref
from coordinator_worker_plan import build_plan
from coordinator_worker_profiles import PROFILES


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
            # Imported here, not at module scope: unittest collects any TestCase visible
            # in a discovered module, so a top-level import would run those 19 cases twice.
            from test_coordinator_worker_plan import WorkerPlanTests
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


class OfflineRunnerModeTests(unittest.TestCase):
    """Mode selection is a coverage claim, so it is asserted rather than assumed."""

    SLOW = ("test_bootstrap_production", "test_bootstrap_workflow",
            "test_startup_handoff", "test_bootstrap_failures")
    root = Path(__file__).resolve().parents[1]
    script = root / "tests" / "run_offline.sh"

    def discovered(self):
        # unittest's own answer, not the script's glob: that is what `--full` runs, so it is
        # the only honest baseline for "--fast is exactly this minus the slow modules".
        loader = unittest.TestLoader()
        suite = loader.discover(str(self.root / "tests"), top_level_dir=str(self.root / "tests"))
        found = set()

        def walk(items):
            for item in items:
                if isinstance(item, unittest.TestSuite):
                    walk(item)
                else:
                    found.add(type(item).__module__)

        walk(suite)
        return found

    def listing(self, *args, env=None):
        proc = subprocess.run(["sh", str(self.script), *args, "--list"], cwd=self.root,
                              capture_output=True, text=True, timeout=120, env=env)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return proc.stdout.split()

    def test_full_listing_covers_every_discovered_module(self):
        self.assertEqual(sorted(self.listing("--full")), sorted(self.discovered()))

    def test_fast_listing_is_the_full_suite_minus_the_documented_slow_modules(self):
        discovered = self.discovered()
        listed = self.listing("--fast")
        # A renamed or deleted slow module must fail here instead of shrinking --fast
        # silently, and the remainder must be exactly the discovered suite minus that set.
        self.assertTrue(set(self.SLOW) <= discovered)
        self.assertEqual(len(listed), len(set(listed)))
        self.assertEqual(sorted(listed), sorted(discovered - set(self.SLOW)))

    def test_fast_refuses_a_discovery_pattern_instead_of_ignoring_it(self):
        # --fast selects whole modules; honouring neither the pattern nor an error would
        # report coverage the run never had.
        proc = subprocess.run(["sh", str(self.script), "--fast", "-p", "test_bootstrap_*",
                               "--list"], cwd=self.root, capture_output=True, text=True,
                              timeout=120)
        self.assertEqual(proc.returncode, 2, proc.stdout)
        self.assertIn("cannot be combined", proc.stderr)

    def test_selection_does_not_read_private_policy_inputs(self):
        # The script clears both variables itself; a bogus value must change nothing.
        env = dict(os.environ, SWARM_WORKER_PROFILES="/nonexistent/profiles.json",
                   RSI_CHECKER_TEST_ROOT="/nonexistent/rsi-checkout")
        self.assertEqual(sorted(self.listing("--fast", env=env)),
                         sorted(self.discovered() - set(self.SLOW)))


if __name__ == "__main__":
    unittest.main()

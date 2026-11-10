"""The offline baseline must not depend on the caller's private Operator policy.

`tests/run_offline.sh` clears `SWARM_WORKER_PROFILES` before running the suite. These
assertions say why that is required: an ambient override either names a different
reviewed file (so a pin computed elsewhere must be refused as a *source* mismatch)
or names a file that cannot be read (so the run must fail closed with a code rather
than with a bare `OSError` or a misleading `file_pin_changed`).

The runner's own modes are pinned here too: `--fast` is iteration feedback over every
module except the documented wall-time dominators, and only a run that executed every module
may be reported as PASS. Both listings are read without running either suite. The expected
module set comes
from unittest's own discovery rather than from the `tests/<area>/` glob the script walks,
so a package that glob cannot see — for example a new nesting level, which discovery would
still import — fails these assertions instead of passing them.
"""

import json
import os
from pathlib import Path
import subprocess
import sys
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
            # in a discovered module, so a top-level import would run those 19 cases twice
            # here as well as under their own package.
            from coordinator.test_coordinator_worker_plan import WorkerPlanTests
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

    # The handoff chain is four modules rather than one so a parallel run is bounded by a
    # quarter of the old floor; the set is one SLOW group in both this tuple and the script.
    SLOW = ("bootstrap.test_bootstrap_production", "bootstrap.test_bootstrap_workflow",
            "core.test_startup_handoff", "core.test_startup_handoff_prepare",
            "core.test_startup_handoff_trigger", "core.test_startup_handoff_monitor",
            "bootstrap.test_bootstrap_failures")
    root = Path(__file__).resolve().parents[2]
    script = root / "tests" / "run_offline.sh"

    def discovered(self):
        # unittest's own answer, not the script's glob: that is what a default run executes,
        # so it is the only honest baseline for "--fast is exactly this minus the slow modules".
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
        self.assertEqual(sorted(self.listing()), sorted(self.discovered()))

    def test_full_flag_is_refused_because_it_is_the_default(self):
        # Why: `--full` was removed. Left unparsed it would be forwarded to unittest and fail
        # there with "unrecognized arguments", which reads like a broken suite, not a
        # removed flag; the runner has to say so itself.
        proc = subprocess.run(["sh", str(self.script), "--full", "--list"], cwd=self.root,
                              capture_output=True, text=True, timeout=120)
        self.assertEqual(proc.returncode, 2)
        self.assertIn("--full was removed", proc.stderr)

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


class ParallelGateTests(unittest.TestCase):
    """`--jobs` may not change selection, and must not hide or shrink a failure."""

    root = Path(__file__).resolve().parents[2]
    script = root / "tests" / "run_offline.sh"
    helper = root / "tests" / "run_modules.py"

    def listing(self, *args):
        proc = subprocess.run(["sh", str(self.script), *args, "--list"], cwd=self.root,
                              capture_output=True, text=True, timeout=120)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return proc.stdout.split()

    def helper_run(self, modules, jobs="2"):
        return subprocess.run([sys.executable, "-B", str(self.helper), "--jobs", jobs, "--"],
                              cwd=self.root, input="".join(f"{m}\n" for m in modules),
                              capture_output=True, text=True, timeout=300)

    def test_jobs_does_not_change_the_selected_modules(self):
        # Why: concurrency must not become a second, drifting notion of "the suite".
        self.assertEqual(sorted(self.listing("--jobs", "4")), sorted(self.listing()))

    def test_jobs_must_be_a_positive_integer(self):
        proc = subprocess.run(["sh", str(self.script), "--jobs", "0", "--list"], cwd=self.root,
                              capture_output=True, text=True, timeout=120)
        self.assertEqual(proc.returncode, 2)
        self.assertIn("positive integer", proc.stderr)

    def test_jobs_refuses_a_discovery_option_instead_of_passing_it_on(self):
        # Why: -p/-s are discovery options; handing one to a named module makes every worker
        # fail for a reason that has nothing to do with the code under test.
        proc = subprocess.run(["sh", str(self.script), "--jobs", "2", "-p", "test_*"],
                              cwd=self.root, capture_output=True, text=True, timeout=120)
        self.assertEqual(proc.returncode, 2)
        self.assertIn("cannot be combined", proc.stderr)

    def test_default_parallelism_still_runs_a_discovery_pattern(self):
        # Why: the documented iteration form is `-p pattern` with no --jobs. Defaulting to
        # parallel must not turn that into the refusal above, so it falls back to the
        # sequential discovery path instead of failing or running the whole suite.
        proc = subprocess.run(["sh", str(self.script), "-p", "test_capacity_io.py"],
                              cwd=self.root, capture_output=True, text=True, timeout=300)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertNotIn("cannot be combined", proc.stderr)
        self.assertRegex(proc.stderr + proc.stdout, r"Ran [1-9]\d* test")

    def test_helper_runs_every_module_it_is_given(self):
        proc = self.helper_run(["core.test_log_io", "core.test_capacity_io"])
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("modules: 2/2", proc.stdout)
        self.assertIn("OK", proc.stdout)

    def test_helper_fails_when_a_module_cannot_be_loaded(self):
        # Why: a parallel gate that reported success after silently dropping a worker would be
        # worse than a slow one; the missing module has to fail the run and name itself.
        proc = self.helper_run(["core.test_log_io", "core.test_missing_module"])
        self.assertEqual(proc.returncode, 1)
        self.assertIn("core.test_missing_module", proc.stdout)
        self.assertIn("FAILED", proc.stdout)

    def test_helper_refuses_an_empty_selection(self):
        proc = subprocess.run([sys.executable, "-B", str(self.helper), "--jobs", "2", "--"],
                              cwd=self.root, input="", capture_output=True, text=True, timeout=60)
        self.assertEqual(proc.returncode, 2)


if __name__ == "__main__":
    unittest.main()

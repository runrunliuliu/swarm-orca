"""The offline baseline must not depend on the caller's private Operator policy.

`tests/run_offline.sh` clears `SWARM_WORKER_PROFILES` before running the suite. These
assertions say why that is required: an ambient override either names a different
reviewed file (so a pin computed elsewhere must be refused as a *source* mismatch)
or names a file that cannot be read (so the run must fail closed with a code rather
than with a bare `OSError` or a misleading `file_pin_changed`).

The runner's own modes are pinned here too: `--fast` is iteration feedback over every
module except the documented wall-time dominators, and no run is required for a change —
only a run that executed every module may be reported as PASS. Both listings are read without
running either suite. The expected module set comes
from unittest's own discovery rather than from the `tests/<area>/` glob the script walks,
so a package that glob cannot see — for example a new nesting level, which discovery would
still import — fails these assertions instead of passing them.
"""

import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
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

    # The wall-time dominators after the strict handshake was removed (measured on this host):
    # the coordinator driver/prepare pair, the installer, and the monitor/lifecycle modules. The
    # set is one SLOW group in both this tuple and the script.
    SLOW = ("coordinator.test_coordinator_driver", "coordinator.test_coordinator_prepare",
            "publish.test_install_entry", "core.test_monitor_stop_signals",
            "coordinator.test_coordinator_background", "operators.test_operator_monitor_recovery",
            "coordinator.test_coordinator_operator")
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

    def test_a_job_count_above_the_selection_is_refused_because_it_cannot_help(self):
        # Why: more workers than modules only starts workers that never receive work. Being
        # asked for a property the run cannot have has to be refused, not flattened silently.
        jobs = str(len(self.listing()) + 1)
        proc = subprocess.run(["sh", str(self.script), "--jobs", jobs, "-q"], cwd=self.root,
                              capture_output=True, text=True, timeout=120)
        self.assertEqual(proc.returncode, 2, proc.stdout)
        self.assertIn("exceeds", proc.stderr)
        self.assertIn("--jobs 1", proc.stderr)

    def test_default_is_four_workers_and_a_discovery_pattern_still_bypasses_it(self):
        # Why: the default is a documented constant; observing it end-to-end means running 99
        # modules, so assert the declaration and prove the risky half behaviourally below.
        # `-p`/`-s` select tests rather than modules, so they must stay sequential (no helper
        # aggregate line) unless --jobs was asked for together with them, which is refused.
        self.assertIn("\njobs=4\n", self.script.read_text())
        for args in (["-p", "test_capacity_io.py"],
                     ["--jobs", "1", "-p", "test_capacity_io.py"]):
            with self.subTest(args=args):
                proc = subprocess.run(["sh", str(self.script), *args], cwd=self.root,
                                      capture_output=True, text=True, timeout=300)
                self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
                self.assertNotIn("jobs:", proc.stdout)
                self.assertRegex(proc.stdout + proc.stderr, r"Ran [1-9]\d* test")

    def test_a_discovery_pattern_still_runs_through_the_runner(self):
        # Why: the documented iteration form is `-p pattern` with no --jobs. It has to select
        # tests (sequential discovery), not modules, so it must not turn into the refusal above
        # or run the whole suite.
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


class BlastRadiusTests(unittest.TestCase):
    """The diff-to-modules mapping fails closed, and its policy cannot silently narrow.

    Why these read the mapping instead of running it: `run_blast.sh` shells out to the same
    module, so a bug here would be reported as a green targeted run. The four assertions below
    are the reviewed invariant: every test module is reachable from a source, every source has a
    radius or a recorded reason it has none, every selected name exists, and the SHARED_MAP
    policy still covers what the tree imports.
    """

    def setUp(self):
        import blast_radius
        self.blast = blast_radius
        self.radius = blast_radius.Radius()

    def test_every_test_module_is_explained_by_a_source(self):
        unexplained = []
        for module in sorted(self.radius.available):
            if self.blast.Path(self.radius.tests[module]).stem[len("test_"):] in self.radius.sources:
                continue
            imported_sources = self.radius.test_imports.get(module, set()) & set(self.radius.sources)
            if imported_sources:
                continue
            unexplained.append(module)
        self.assertEqual(unexplained, [], "test modules reach no source and import none")

    def test_every_source_module_has_a_radius_or_is_recorded_untested(self):
        empty = [name for name in sorted(self.radius.sources)
                 if not self.radius.tests_for_source(name) and name not in self.blast.UNTESTED]
        self.assertEqual(empty, [], "source modules whose radius is empty must be in UNTESTED")

    def test_every_selected_module_is_a_listed_module(self):
        for name in sorted(self.radius.sources):
            reasons = self.radius.tests_for_source(name)
            self.assertTrue(set(reasons) <= self.radius.available,
                            f"{name} selects modules outside --list")

    def test_shared_map_covers_what_the_tree_imports(self):
        # Why both directions: narrowing the policy is the "green while under-testing" hole, and a
        # tree that grows importers without a policy update is the other half of the same hole.
        for shared, patterns in self.blast.SHARED_MAP.items():
            importers = {module for module, imports in self.radius.test_imports.items()
                         if shared in imports}
            self.assertTrue(importers, f"no test imports {shared}; the policy key is stale")
            missing = [module for module in importers
                       if not self.blast.policy_matches(module, patterns)]
            self.assertEqual(missing, [], f"{shared} policy does not cover {missing}")
        self.assertEqual(self.blast.SHARED_MAP["coordinator_io"], ("*",))
        self.assertEqual(self.blast.SHARED_MAP["blocking_io"],
                         ("core.*", "bootstrap.*", "operators.*"))

    def test_a_changed_test_helper_selects_the_modules_that_import_it(self):
        # Why: a shared fixture is neither a source nor a test module, so a change to one used to
        # select nothing and hard-fail the command - whose only escape was a hand-widened run,
        # the judgement this tool exists to replace.
        reasons = self.radius.tests_for_helper(self.root / "tests" / "publication_wait_fixture.py")
        self.assertIn("core.test_wait_for_file", reasons)
        self.assertEqual(set(reasons.values()), {"helper"})
        self.assertTrue(set(reasons) <= self.radius.available)

    def test_an_empty_diff_is_a_failure_not_a_pass(self):
        completed = subprocess.run(
            [sys.executable, "-B", str(self.root / "tests" / "blast_radius.py"),
             "--range", "HEAD..HEAD"], cwd=self.root, capture_output=True, text=True, timeout=120)
        self.assertEqual(completed.returncode, 2, completed.stdout + completed.stderr)
        self.assertIn("nothing changed", completed.stderr)

    def test_a_source_with_no_radius_fails_closed(self):
        with patch.object(self.blast, "select",
                          return_value=({}, [], [], ["swarm/invented.py"])), \
                redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            self.assertEqual(self.blast.main(["--range", "HEAD~1", "--json"]), 2)

    root = Path(__file__).resolve().parents[2]


class BlastRunnerTests(unittest.TestCase):
    """`tests/run_blast.sh` end to end: no diff is a refusal, a named diff runs modules."""

    root = Path(__file__).resolve().parents[2]
    script = root / "tests" / "run_blast.sh"

    def test_requires_a_range(self):
        completed = subprocess.run(["sh", str(self.script)], cwd=self.root,
                                   capture_output=True, text=True, timeout=60)
        self.assertEqual(completed.returncode, 2, completed.stdout)
        self.assertIn("--range is required", completed.stderr)

    def test_an_unknown_option_is_refused(self):
        completed = subprocess.run(["sh", str(self.script), "--nope"], cwd=self.root,
                                   capture_output=True, text=True, timeout=60)
        self.assertEqual(completed.returncode, 2, completed.stdout)
        self.assertIn("unknown option", completed.stderr)

    def test_dry_run_prints_the_selection_and_runs_nothing(self):
        # Why a fixed revision: `HEAD~1..HEAD` made this test depend on whatever the last commit
        # touched. A docs-only commit selects nothing, which is exit 2 by design (an empty
        # selection must not read as a pass), so the test would flip on merge order rather than on
        # behaviour. 9c13f66a touches a source module and always will.
        completed = subprocess.run(["sh", str(self.script), "--range",
                                    "9c13f66a~1..9c13f66a", "--dry-run"], cwd=self.root,
                                   capture_output=True, text=True, timeout=180)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIn("selection:", completed.stderr + completed.stdout)
        self.assertIn("dry run", completed.stdout)
        self.assertNotIn("modules:", completed.stdout)


class TargetedSelectionTests(unittest.TestCase):
    """`--modules` runs exactly what it names, and never claims more than that.

    Why the negative cases matter more than the positive one: a bare positional module name
    used to be forwarded to unittest, which then ran the whole suite *and* loaded the named
    module inside every worker (`tests` + 101 x 3 assertions, all green). A silent widening
    that reports `OK` is worse than a refusal, so each refusal is pinned here.
    """

    root = Path(__file__).resolve().parents[2]
    script = root / "tests" / "run_offline.sh"
    helper = root / "tests" / "run_modules.py"

    def run_runner(self, *args, timeout=300):
        return subprocess.run(["sh", str(self.script), *args], cwd=self.root,
                              capture_output=True, text=True, timeout=timeout)

    def test_modules_runs_only_the_named_module(self):
        proc = self.run_runner("--modules", "core.test_log_io")
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("selection: 1/", proc.stdout)
        self.assertIn("(explicit)", proc.stdout)
        self.assertIn("modules: 1/1", proc.stdout)
        self.assertIn("TARGETED OK", proc.stdout)

    def test_a_targeted_run_never_says_pass_or_ok_alone(self):
        # Why: `offline PASS` and a bare `OK` are the full-suite words. A targeted run has to be
        # impossible to quote as one, so it may not contain "PASS" at all.
        proc = self.run_runner("--modules", "core.test_log_io")
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        combined = proc.stdout + proc.stderr
        self.assertNotIn("PASS", combined)
        self.assertNotRegex(combined, r"(?m)^OK$")

    def test_an_unknown_module_exits_two_and_names_itself(self):
        proc = self.run_runner("--modules", "core.no_such_module")
        self.assertEqual(proc.returncode, 2, proc.stdout)
        self.assertIn("unknown module: core.no_such_module", proc.stderr)
        self.assertIn("valid names", proc.stderr)
        self.assertNotIn("modules:", proc.stdout)

    def test_a_bare_dotted_positional_is_refused_before_any_module_starts(self):
        # Why: this is the shape that silently ran the whole suite and reported OK.
        proc = self.run_runner("core.test_log_io")
        self.assertEqual(proc.returncode, 2, proc.stdout)
        self.assertIn("use --modules", proc.stderr)
        self.assertNotIn("modules:", proc.stdout)
        self.assertNotIn("tests:", proc.stdout)

    def test_a_bare_test_file_positional_is_refused_too(self):
        proc = self.run_runner("test_log_io.py")
        self.assertEqual(proc.returncode, 2, proc.stdout)
        self.assertIn("use --modules", proc.stderr)

    def test_an_unknown_runner_option_is_refused_instead_of_forwarded(self):
        proc = self.run_runner("--nope")
        self.assertEqual(proc.returncode, 2, proc.stdout)
        self.assertIn("unknown runner option: --nope", proc.stderr)

    def test_one_named_module_gets_one_worker(self):
        # Why: the default is 4, but asking for four workers to run one module is the case the
        # `--jobs exceeds` refusal exists for; the explicit form must take min(4, k) instead.
        proc = self.run_runner("--modules", "core.test_log_io")
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("jobs: 1", proc.stdout)

    def test_an_explicit_job_count_above_the_selection_is_still_refused(self):
        # Why: min(4, k) is a default, not a licence to flatten what the caller spelled out.
        proc = self.run_runner("--modules", "core.test_log_io", "--jobs", "4")
        self.assertEqual(proc.returncode, 2, proc.stdout)
        self.assertIn("exceeds", proc.stderr)

    def test_the_helper_accepts_an_option_value_after_the_separator(self):
        # Why: `-k pattern` is a documented unittest option, and its value is not a module name.
        # Rejecting it would turn a filtered run into an exit 2 after the shell layer allowed it.
        completed = subprocess.run(
            [sys.executable, "-B", str(self.helper), "--jobs", "2", "--", "-k", "test_log"],
            cwd=self.root, input="core.test_log_io\n", capture_output=True, text=True, timeout=120)
        self.assertNotIn("belong on stdin", completed.stderr)

    def test_the_helper_refuses_a_module_name_after_the_separator(self):
        # Why: the second gate. Fixing only the shell runner leaves
        # `run_modules.py --jobs 4 -- core.test_log_io` fanning the module out to every worker.
        proc = subprocess.run([sys.executable, "-B", str(self.helper), "--jobs", "2", "--",
                               "core.test_log_io"], cwd=self.root, input="core.test_log_io\n",
                              capture_output=True, text=True, timeout=60)
        self.assertEqual(proc.returncode, 2, proc.stdout)
        self.assertIn("belong on stdin", proc.stderr)


if __name__ == "__main__":
    unittest.main()

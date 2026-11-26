"""Bounded-search helper: argv shape, scope refusal and the reported timing; no real search."""

import contextlib
import io
import shlex
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import fast_search
import search_guard as guard

TESTS = Path(__file__).resolve().parents[1]
SWARM = TESTS.parent


def cli(*argv, cwd):
    return subprocess.run([sys.executable, "-B", str(SWARM / "fast_search.py"), *argv],
                          capture_output=True, text=True, cwd=cwd)


class ArgvTests(unittest.TestCase):
    def test_git_mode_reads_the_index_inside_one_checkout(self):
        argv = fast_search.build_argv("pat", "/ws/repo", ["*.ts"], "git", 6, "/ws/repo")
        self.assertEqual(argv[:7], ["git", "-C", "/ws/repo", "grep", "-n", "-I", "--no-color"])
        self.assertEqual(argv[7], "pat")
        self.assertEqual(argv[8], "--")
        self.assertIn("*.ts", argv)

    def test_git_mode_keeps_the_subdirectory_it_was_given(self):
        argv = fast_search.build_argv("pat", "/ws/repo/src", [], "git", 6, "/ws/repo")
        self.assertEqual(argv[-1], "src")

    def test_rg_mode_excludes_the_two_trees_that_ruin_a_walk(self):
        argv = fast_search.build_argv("pat", "/ws/repo", [], "rg", 6, "/ws/repo")
        self.assertEqual(argv[:4], ["rg", "-n", "--max-depth", "6"])
        self.assertIn("!node_modules", argv)
        self.assertIn("!.git", argv)
        self.assertEqual(argv[-2:], ["pat", "/ws/repo"])

    def test_the_scope_rule_is_the_guard_s_rule(self):
        with tempfile.TemporaryDirectory() as scratch:
            shared = Path(scratch).resolve()
            (shared / "repo").mkdir()
            verdict = fast_search.scope_refusal(str(shared), str(shared / "repo"), str(shared / "repo"))
            self.assertEqual(verdict["decision"], guard.DENY)
            self.assertIsNone(fast_search.scope_refusal(str(shared / "repo"), str(shared / "repo"),
                                                        str(shared / "repo")))


class CommandLineTests(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.workspace = Path(scratch.name).resolve()
        self.repo = self.workspace / "my-checkout"
        (self.repo / "swarm").mkdir(parents=True)
        (self.repo / ".git").write_text("gitdir: /elsewhere\n", encoding="utf-8")

    def test_dry_run_prints_argv_and_runs_nothing(self):
        done = cli("PATTERN_NOT_PRESENT", "--dry-run", cwd=self.repo)
        self.assertEqual(done.returncode, 0, done.stderr)
        argv = shlex.split(done.stdout.strip())
        self.assertEqual(argv[0], "git")
        self.assertIn("PATTERN_NOT_PRESENT", argv)

    def test_a_target_above_the_worktree_is_refused_before_any_search(self):
        done = cli("pat", "--path", str(self.workspace), "--dry-run", cwd=self.repo)
        self.assertEqual(done.returncode, fast_search.EXIT_PRECONDITION)
        self.assertIn("refused:", done.stderr)
        self.assertIn("git grep", done.stderr)
        self.assertEqual(done.stdout, "")

    def test_dry_run_never_needs_the_search_binary(self):
        with mock.patch.object(fast_search.shutil, "which", return_value=None):
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(fast_search.main(["pat", "--dry-run"]), 0)


if __name__ == "__main__":
    unittest.main()

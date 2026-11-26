"""The search-scope decision table; no Orca process, no search is ever executed."""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import search_guard as guard

TESTS = Path(__file__).resolve().parents[1]
SWARM = TESTS.parent


class ScopeDecisionTests(unittest.TestCase):
    """One rule: a recursive search may only walk inside the caller's own worktree."""

    def setUp(self):
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.workspace = Path(scratch.name).resolve()
        self.root = self.workspace / "my-checkout"
        (self.root / "swarm" / "docs").mkdir(parents=True)
        (self.root / ".git").write_text("gitdir: /elsewhere\n", encoding="utf-8")
        self.other = self.workspace / "another-checkout"
        (self.other / "src").mkdir(parents=True)
        (self.other / ".git").write_text("gitdir: /elsewhere\n", encoding="utf-8")
        self.home = self.workspace / "home"
        self.home.mkdir()

    def verdict(self, command, cwd=None, root=None):
        return guard.evaluate(command, str(cwd or self.root), str(root or self.root))

    def decide(self, command, cwd=None, root=None):
        return self.verdict(command, cwd, root)["decision"]

    def test_ordinary_commands_are_not_judged(self):
        for command in ("ls -la", "git status --porcelain", "python3 -m unittest",
                        "git grep -rn TODO -- '*.ts'", "rg --version", "cat notes.md | head -3"):
            with self.subTest(command=command):
                self.assertEqual(self.decide(command), guard.ALLOW)

    def test_unreadable_command_fails_open(self):
        # A guard that guesses is a guard that blocks ordinary work.
        with patch.object(guard, "_evaluate", side_effect=RuntimeError("boom")):
            verdict = guard.evaluate("rg pat .", str(self.root), str(self.root))
        self.assertEqual(verdict["decision"], guard.ALLOW)
        self.assertIn("boom", verdict["error"])

    def test_single_worktree_exemptions_stay_allowed(self):
        cases = {
            "git grep -rn pat -- '*.ts'": guard.ALLOW,
            "rg -n --max-depth 3 -g '!node_modules' -g '!.git' pat .": guard.ALLOW,
            "rg -l pat": guard.ALLOW,
            "grep -rn pat .": guard.ALLOW,
            "grep -rl pat swarm/docs": guard.ALLOW,
            "grep -n pat single-file.md": guard.ALLOW,
            f"rg -n pat {self.root / 'swarm'}": guard.ALLOW,
            "find . -name '*.py' -maxdepth 3": guard.ALLOW,
            "fd -e py pat src": guard.ALLOW,
        }
        for command, expected in cases.items():
            with self.subTest(command=command):
                self.assertEqual(self.decide(command), expected)

    def test_cross_worktree_searches_are_refused(self):
        cases = (
            f"grep -rl pat {self.workspace}",
            f"rg -l --max-depth 8 -g '!node_modules' pat {self.workspace}",
            f"rg -l pat {self.other}",
            f"grep -rl pat {self.home}",
            "rg -l pat ..",
            "grep -rl pat ../another-checkout",
            "find .. -name '*.json'",
            "fd pat /tmp",
            "rg -l pat $HOME",
            "grep -rl pat ~",
            "grep -rl pat $SOME_UNSET_VARIABLE",
        )
        for command in cases:
            with self.subTest(command=command):
                self.assertEqual(self.decide(command), guard.DENY)

    def test_refusal_names_a_worktree_relative_rewrite(self):
        verdict = self.verdict(f"grep -rl pat {self.workspace}")
        self.assertEqual(verdict["target"], str(self.workspace))
        self.assertEqual(verdict["worktree"], str(self.root))
        self.assertIn("git grep", verdict["suggestions"][0])
        self.assertIn("--max-depth", verdict["suggestions"][1])
        self.assertIn("orca orchestration worker-show", verdict["suggestions"][2])
        self.assertIn(str(self.root), verdict["suggestions"][1])

    def test_wrappers_and_nested_shells_are_unwrapped(self):
        cases = (
            f"sudo -u root rg -l pat {self.workspace}",
            f"xargs -0 rg -l pat {self.workspace}",
            f"bash -c 'grep -rl pat {self.workspace}'",
            f"bash -lc \"rg -l pat {self.other}\"",
            f"rg -l pat $(echo {self.workspace})",
        )
        for command in cases:
            with self.subTest(command=command):
                self.assertEqual(self.decide(command), guard.DENY)

    def test_a_cd_out_of_the_worktree_moves_the_boundary(self):
        outside = tempfile.TemporaryDirectory()
        self.addCleanup(outside.cleanup)
        self.assertEqual(self.decide(f"cd {outside.name} && rg -l pat ."), guard.DENY)
        self.assertEqual(self.decide(f"cd .. && rg -l pat"), guard.DENY)
        inside = self.root / "swarm"
        self.assertEqual(self.decide(f"cd {inside} && rg -l pat ."), guard.ALLOW)

    def test_a_workspace_root_above_checkouts_is_not_searchable(self):
        # The incident shape: cwd is the directory that holds twenty checkouts, not a checkout.
        self.assertEqual(self.decide("rg -l pat .", cwd=self.workspace, root=self.workspace),
                         guard.DENY)
        self.assertEqual(self.decide("grep -rl pat", cwd=self.workspace, root=self.workspace),
                         guard.DENY)
        # One named checkout under it is still a single-tree search.
        self.assertEqual(self.decide("rg -l pat my-checkout", cwd=self.workspace,
                                     root=self.workspace), guard.ALLOW)

    def test_plain_directory_without_checkouts_is_not_the_workspace_shape(self):
        lonely = Path(tempfile.mkdtemp(dir=self.workspace))
        self.assertEqual(self.decide("rg -l pat .", cwd=lonely, root=lonely), guard.ALLOW)

    def test_real_repository_boundary(self):
        if not shutil.which("git"):
            self.skipTest("git is not on PATH")
        repo = self.workspace / "real-repo"
        (repo / "swarm").mkdir(parents=True)
        subprocess.run(["git", "init", "-q", str(repo)], check=True,
                       env={**os.environ, "GIT_CONFIG_GLOBAL": os.devnull,
                            "GIT_CONFIG_SYSTEM": os.devnull})
        verdict = guard.evaluate("rg -l pat .", str(repo / "swarm"))
        self.assertEqual(verdict["decision"], guard.ALLOW)
        self.assertEqual(verdict["worktree"], str(repo))
        verdict = guard.evaluate("rg -l pat ../..", str(repo / "swarm"))
        self.assertEqual(verdict["decision"], guard.DENY)


class CommandLineTests(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.workspace = Path(scratch.name).resolve()
        self.root = self.workspace / "my-checkout"
        self.root.mkdir()
        (self.root / ".git").write_text("gitdir: /elsewhere\n", encoding="utf-8")

    def run_cli(self, *argv, stdin=""):
        return subprocess.run([sys.executable, "-B", str(SWARM / "search_guard.py"), *argv],
                              input=stdin, capture_output=True, text=True)

    def test_json_is_one_line_and_exits_zero_either_way(self):
        allowed = self.run_cli("--cwd", str(self.root), "--command", "rg -n pat .")
        refused = self.run_cli("--cwd", str(self.root), "--command",
                               f"grep -rl pat {self.workspace}")
        for done in (allowed, refused):
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertEqual(len(done.stdout.strip().splitlines()), 1)
        self.assertEqual(json.loads(allowed.stdout)["decision"], guard.ALLOW)
        self.assertEqual(json.loads(refused.stdout)["decision"], guard.DENY)

    def test_command_text_can_arrive_on_stdin(self):
        done = self.run_cli("--cwd", str(self.root), stdin=f"rg -l pat {self.workspace}")
        self.assertEqual(json.loads(done.stdout)["decision"], guard.DENY)

    def test_explain_is_human_readable(self):
        done = self.run_cli("--cwd", str(self.root), "--explain", "--command",
                            f"rg -l pat {self.workspace}")
        self.assertIn("refused:", done.stdout)
        self.assertIn("git grep", done.stdout)
        self.assertNotIn("{", done.stdout)

    def test_missing_command_text_and_bad_cwd_are_usage_errors(self):
        self.assertEqual(self.run_cli("--cwd", str(self.root)).returncode, guard.EXIT_USAGE)
        gone = self.workspace / "not-here"
        self.assertEqual(self.run_cli("--cwd", str(gone), "--command", "ls").returncode,
                         guard.EXIT_PRECONDITION)

"""The release notes are generated, so the only thing that matters is that they are true.

A stale note is worse than none: it is the file an operator reads to decide whether a rebuild is
needed, and a missing PR row reads as "this never landed". These assertions therefore build a real
throwaway repository and re-derive every claim from it instead of trusting the generator's output —
including the two things the note is not allowed to assert (a deployment, an artifact impact it
cannot know).
"""

from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "generate_release_notes.py"
NOTES = ROOT / "docs" / "release-notes"


def run(args: list[str], cwd: Path, env: dict[str, str] | None = None) -> subprocess.CompletedProcess:
    merged = {**os.environ, "GIT_CONFIG_NOSYSTEM": "1", "GIT_AUTHOR_DATE": "2026-11-20T10:00:00Z",
              "GIT_COMMITTER_DATE": "2026-11-20T10:00:00Z"}
    if env:
        merged.update(env)
    return subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=120, env=merged)


class ReleaseNoteTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)
        self.git("init", "-q", "-b", "main")
        self.git("config", "user.email", "test@example.com")
        self.git("config", "user.name", "test")
        self.write("README.md", "base\n")
        self.commit("base")
        self.base = self.git("rev-parse", "HEAD").stdout.strip()

    # -- repository helpers ------------------------------------------------------------------

    def git(self, *args: str) -> subprocess.CompletedProcess:
        completed = run(["git", *args], self.repo)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return completed

    def write(self, relative: str, text: str) -> None:
        path = self.repo / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    def commit(self, subject: str) -> None:
        self.git("add", "-A")
        self.git("commit", "-q", "-m", subject)

    def pr_merge(self, number: int, branch: str, files: dict[str, str], subjects: list[str]) -> None:
        """One PR: a branch with `files`, merged with the subject GitHub writes."""
        main_branch = self.git("rev-parse", "--abbrev-ref", "HEAD").stdout.strip()
        self.git("checkout", "-q", "-b", branch)
        for name, text in files.items():
            self.write(name, text)
            self.git("add", "-A")
            self.git("commit", "-q", "-m", subjects.pop(0))
        self.git("checkout", "-q", main_branch)
        self.git("merge", "-q", "--no-ff", branch, "-m", f"Merge pull request #{number} from o/{branch}")

    def non_pr_merge(self, branch: str) -> None:
        main_branch = self.git("rev-parse", "--abbrev-ref", "HEAD").stdout.strip()
        self.git("checkout", "-q", "-b", branch)
        self.write(f"swarm/{branch}.md", "noise\n")
        self.commit(f"docs: {branch}")
        self.git("checkout", "-q", main_branch)
        self.git("merge", "-q", "--no-ff", branch, "-m", f"Merge branch '{branch}'")

    def note(self, spec: str) -> str:
        completed = run([sys.executable, "-B", str(SCRIPT), "--repo", str(self.repo),
                         "--range", spec], self.repo)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return completed.stdout

    @staticmethod
    def overview_rows(text: str) -> dict[int, list[str]]:
        """`#<n>` -> cells of that row under `## 一览`, so a claim is asserted where it is made.

        Why not `assertIn` on the whole file: the legend below the table also spells the verdict
        words, so a whole-file match would pass on prose while the row said something else.
        """
        rows: dict[int, list[str]] = {}
        in_table = False
        for line in text.splitlines():
            if line.startswith("## 一览"):
                in_table = True
                continue
            if in_table and line.startswith("## "):
                break
            if in_table and line.startswith("| #"):
                cells = [part.strip() for part in line.strip("|").split("|")]
                rows[int(cells[0].lstrip("#"))] = cells
        return rows

    @staticmethod
    def statuses(text: str) -> list[str]:
        return [line.split("：", 1)[1].strip("`") for line in text.splitlines()
                if line.startswith("- 状态：")]

    # -- the note states what git says -------------------------------------------------------

    def test_a_renderer_only_pr_is_not_a_server_bundle_change(self):
        self.pr_merge(7, "feat-ui", {"orca/src/renderer/src/app.tsx": "ui\n"},
                      ["feat(ui): render the new panel"])
        text = self.note(f"{self.base}..HEAD")
        self.assertEqual(self.overview_rows(text)[7],
                         ["#7", "feat(ui): render the new panel", "renderer", "不进"])
        self.assertEqual(self.statuses(text), ["merged"])
        # A renderer path is inside `orca/` but outside the server bundle; the note must not turn
        # that into "a rebuild is needed".
        self.assertNotIn("| orca、renderer | 需构建比对 |", text)

    def test_a_non_renderer_orca_change_never_claims_the_artifact_is_unaffected(self):
        self.pr_merge(8, "feat-main", {"orca/src/main/index.ts": "main\n"},
                      ["feat(main): wire the observer"])
        text = self.note(f"{self.base}..HEAD")
        self.assertEqual(self.overview_rows(text)[8],
                         ["#8", "feat(main): wire the observer", "orca", "需构建比对"])

    def test_the_headline_is_the_pr_first_commit_not_its_review_follow_up(self):
        self.pr_merge(9, "feat-x", {"swarm/a.md": "a\n", "swarm/b.md": "b\n"},
                      ["feat(x): the actual feature", "fix(x): close a review finding"])
        text = self.note(f"{self.base}..HEAD")
        self.assertEqual(self.overview_rows(text)[9],
                         ["#9", "feat(x): the actual feature", "swarm", "不进"])
        self.assertIn("fix(x): close a review finding", text)

    def test_a_non_pr_merge_is_counted_rather_than_dropped(self):
        self.pr_merge(10, "feat-y", {"orca/src/renderer/src/y.tsx": "y\n"}, ["feat(y): y"])
        self.non_pr_merge("noise")
        text = self.note(f"{self.base}..HEAD")
        self.assertIn("2 条主线合并中，1 条是 PR，1 条非 PR 合并未生成条目", text)

    def test_the_note_never_claims_a_deployment(self):
        self.pr_merge(11, "feat-z", {"orca/src/renderer/src/z.tsx": "z\n"}, ["feat(z): z"])
        text = self.note(f"{self.base}..HEAD")
        # Every entry is `merged` and nothing else: `deployed <buildId>` belongs to the private
        # deployment record, so a note that invented one would be unverifiable.
        self.assertEqual(self.statuses(text), ["merged"])
        self.assertNotIn("deployed `", text)
        self.assertIn("不推断", text)

    # -- the file and the history cannot disagree -------------------------------------------

    def test_check_accepts_a_freshly_written_note_and_rejects_an_edited_one(self):
        self.pr_merge(12, "feat-w", {"orca/src/renderer/src/w.tsx": "w\n"}, ["feat(w): w"])
        out = self.tmp.name + "/note.md"
        completed = run([sys.executable, "-B", str(SCRIPT), "--repo", str(self.repo),
                         "--range", f"{self.base}..HEAD", "--write", "--out", out], self.repo)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(run([sys.executable, "-B", str(SCRIPT), "--repo", str(self.repo),
                              "--check", "--out", out], self.repo).returncode, 0)

        path = Path(out)
        path.write_text(path.read_text(encoding="utf-8") + "\nhand edit\n", encoding="utf-8")
        completed = run([sys.executable, "-B", str(SCRIPT), "--repo", str(self.repo),
                         "--check", "--out", out], self.repo)
        self.assertEqual(completed.returncode, 2)
        self.assertIn("stale", completed.stderr)

    def test_a_bad_range_is_a_usage_error_not_an_empty_note(self):
        completed = run([sys.executable, "-B", str(SCRIPT), "--repo", str(self.repo),
                         "--range", "HEAD"], self.repo)
        self.assertEqual(completed.returncode, 2)
        self.assertIn("<from>..<to>", completed.stderr)

    def test_the_same_range_renders_the_same_bytes(self):
        self.pr_merge(13, "feat-v", {"orca/src/renderer/src/v.tsx": "v\n"}, ["feat(v): v"])
        spec = f"{self.base}..HEAD"
        self.assertEqual(self.note(spec), self.note(spec))

    # -- the committed notes describe this repository ----------------------------------------

    def test_the_committed_notes_match_this_repository(self):
        committed = [path for path in sorted(NOTES.glob("*.md")) if path.name != "README.md"]
        self.assertTrue(committed, "no committed release note to check")
        completed = run([sys.executable, "-B", str(SCRIPT), "--check"], ROOT)
        self.assertEqual(completed.returncode, 0, completed.stderr)

    def test_every_committed_note_declares_its_range(self):
        for path in NOTES.glob("*.md"):
            if path.name == "README.md":
                continue
            head = path.read_text(encoding="utf-8").split("## ", 1)[0]
            self.assertIn("- range: `", head, f"{path.name} has no range line")
            self.assertIn("- date: `", head, f"{path.name} has no date line")


if __name__ == "__main__":
    unittest.main()

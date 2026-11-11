"""The runbook is generated, and a stale copy must fail a test instead of a launch.

Why: the protocol tells the Operator to read a runbook. A hand-maintained one drifts the first
time an action is added, and a drifted runbook sends an Operator to a stage that no longer exists.
The generator reads `bootstrap_actions.ACTIONS`, so the only thing to assert is "the file on disk
is what the code would generate" plus the anchors the protocol promises.
"""

import re
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]


class RunbookTests(unittest.TestCase):
    def run_generator(self, *args):
        return subprocess.run([sys.executable, "-B", str(ROOT / "generate_runbook.py"), *args],
                              cwd=ROOT, capture_output=True, text=True, timeout=120)

    def test_the_committed_runbook_matches_the_action_table(self):
        completed = self.run_generator("--check")
        self.assertEqual(completed.returncode, 0, completed.stderr)

    def test_every_stage_in_the_action_table_is_listed(self):
        from bootstrap_actions import ACTIONS
        text = (ROOT / "operator-runbook.md").read_text()
        for name in ACTIONS:
            self.assertIn(f"`{name}`", text, f"stage {name} missing from the runbook")

    def test_the_runbook_sends_review_stages_away_from_the_template_path(self):
        # Why: `--from-template` is refused for review stages, so the runbook must not read as if
        # it were a general shortcut.
        text = (ROOT / "operator-runbook.md").read_text()
        self.assertIn("review 阶段用 `--from-template`", text)
        self.assertIn("fields-intent", text)

    def test_the_protocol_points_at_the_runbook_and_the_split_offline_doc(self):
        protocol = (ROOT / "strict-bootstrap-protocol.md").read_text()
        self.assertIn("operator-runbook.md", protocol)
        self.assertIn("strict-bootstrap-offline.md", protocol)
        # The moved chapters must not still be inline: the split is the point.
        self.assertNotIn("## 10. Phase 2", protocol)

    def test_the_protocol_has_no_dangling_section_numbers(self):
        # Why: two cross-references pointed at "第 11 节 / 第 12 节" after the split, which now
        # live in another file. A number without a target is how a reader ends up re-deriving a
        # chapter that moved.
        protocol = (ROOT / "strict-bootstrap-protocol.md").read_text()
        for number in ("第 10 节", "第 11 节", "第 12 节", "第 13 节"):
            self.assertNotIn(number, protocol, f"{number} still referenced inline")

    def test_the_offline_document_kept_its_chapter_numbers(self):
        offline = (ROOT / "strict-bootstrap-offline.md").read_text()
        for heading in ("## 10.", "## 11.", "## 12.", "## 13."):
            self.assertIn(heading, offline)

    def test_the_protocol_keeps_the_normative_chapters(self):
        protocol = (ROOT / "strict-bootstrap-protocol.md").read_text()
        for heading in ("## 1.", "## 2.", "## 3.", "## 4.", "## 5.", "## 6.", "## 7.", "## 8.", "## 9."):
            self.assertIn(heading, protocol)

    def test_a_stale_runbook_is_refused_not_warned(self):
        target = ROOT / "operator-runbook.md"
        original = target.read_text()
        try:
            target.write_text(original + "\nstale line\n")
            completed = self.run_generator("--check")
            self.assertEqual(completed.returncode, 2)
            self.assertIn("stale", completed.stderr)
        finally:
            target.write_text(original)


if __name__ == "__main__":
    unittest.main()

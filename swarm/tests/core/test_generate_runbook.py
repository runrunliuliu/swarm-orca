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
import tempfile
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
        # Why a temp path: mutating the tracked file and restoring it in `finally` leaves the
        # checkout dirty if the test is interrupted, and that is exactly when someone will be
        # looking at `git status` to find out what happened.
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "operator-runbook.md"
            path.write_text((ROOT / "operator-runbook.md").read_text() + "\nstale line\n")
            completed = self.run_generator("--check", "--path", str(path))
            self.assertEqual(completed.returncode, 2)
            self.assertIn("stale", completed.stderr)

    def test_the_argv_come_from_the_action_builder_not_a_second_entry_point(self):
        # Why: `bootstrap_tool.py pull ...` is a different entry point from the
        # `coordinator_launch.py strict-bootstrap <mode>` argv the action receipt actually
        # returns. A runbook that names the wrong one sends an Operator down a path the tool does
        # not produce.
        text = (ROOT / "operator-runbook.md").read_text()
        self.assertIn("coordinator_launch.py strict-bootstrap pull", text)
        for line in text.splitlines():
            if line.startswith("python3 "):
                self.assertNotIn("bootstrap_tool.py", line)

    def test_the_runbook_carries_no_absolute_path_from_this_checkout(self):
        # Why: `command()` embeds this machine's paths; a committed runbook must stay portable or
        # its own --check fails on the next checkout.
        text = (ROOT / "operator-runbook.md").read_text()
        self.assertNotIn("/mnt/", text)
        self.assertNotIn("/home/", text)
        self.assertIn("<swarm>/coordinator_launch.py", text)

    def test_the_runbook_does_not_offer_an_input_to_complete(self):
        # Why: `complete` reads the candidate pin from contract.outputs; passing --input there
        # would be rejected, so the page must not suggest it.
        text = (ROOT / "operator-runbook.md").read_text()
        complete = [line for line in text.splitlines() if "strict-bootstrap complete" in line]
        self.assertTrue(complete)
        argv = [line for line in text.splitlines()[text.splitlines().index(complete[0]):][:3]
                if not line.lstrip().startswith("#")]
        self.assertNotIn("--input", "\n".join(argv))


if __name__ == "__main__":
    unittest.main()

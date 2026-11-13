"""The incident-triage skill is a document, so its input contract is what can be pinned.

M8 removed the in-process miner; the judgement now lives in `skills/incident-triage/`. That moves the
risk from "clustering code is wrong" to "the skill reads a shape Orca no longer emits, or silently
drops a completeness fact". These assertions pin the contract the skill promises:

* the skill loads through its frontmatter and names the commands it depends on;
* `contract.example.json` carries every record kind and every field a judgement needs, including the
  coverage facts that keep an empty window from reading as "no incidents";
* the report template keeps the reproducibility fields and the durability rule;
* the permissions are stated (no auto-apply, `confirmed` is R1-only).

The example is synthetic; no real Run/Task/Dispatch/terminal ids or paths belong here.
"""

import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SKILL_DIR = ROOT / "skills" / "incident-triage"
SKILL = SKILL_DIR / "SKILL.md"
CONTRACT = SKILL_DIR / "contract.example.json"
TEMPLATE = SKILL_DIR / "report-template.md"

RECORD_KINDS = ["meta", "incident", "pane_clock", "tool_failure", "end"]


class IncidentTriageSkillTests(unittest.TestCase):
    def test_skill_has_frontmatter_and_names_its_commands(self):
        text = SKILL.read_text(encoding="utf-8")
        self.assertTrue(text.startswith("---\n"), "SKILL.md must start with YAML frontmatter")
        frontmatter, body = text.split("\n---\n", 1)
        self.assertIn("name: incident-triage", frontmatter)
        self.assertIn("description:", frontmatter)
        for token in (
            "orca incident export",
            "orca incident decide",
            "--actor",
            "rowsUsed",
            "exportVersion",
            "durable",
            "truncated",
            "uncovered",
            "state_fallback",
            "effectiveStatus",
        ):
            self.assertIn(token, body, f"skill must name {token!r}")

    def test_permissions_are_stated(self):
        body = SKILL.read_text(encoding="utf-8")
        for token in ("Never `confirmed`", "R1", "No auto-apply", "no replacement flag"):
            self.assertIn(token, body, f"skill must state the permission boundary: {token!r}")
        # A skill that told the agent to confirm rows would defeat the R1 split.
        self.assertNotIn("--to confirmed", body)

    def test_contract_example_covers_every_record_kind(self):
        payload = json.loads(CONTRACT.read_text(encoding="utf-8"))
        records = payload["records"]
        self.assertEqual([record["kind"] for record in records], RECORD_KINDS)

        meta = records[0]
        for key in ("view", "exportVersion", "since", "generatedAt", "coverage", "toolProviders", "mirror"):
            self.assertIn(key, meta)
        self.assertEqual(meta["view"], "incident_triage_rows")
        self.assertIn("shadowReplay", meta["coverage"])
        self.assertIn("paneClock", meta["coverage"])
        self.assertIn("covered", meta["toolProviders"])
        self.assertIn("uncovered", meta["toolProviders"])
        self.assertIn("capture", meta["mirror"])

        incident = records[1]
        for key in (
            "id",
            "sourceKind",
            "sourceId",
            "facet",
            "class",
            "status",
            "effectiveStatus",
            "runId",
            "taskId",
            "dispatchId",
            "evidence",
            "archive",
        ):
            self.assertIn(key, incident)
        self.assertIn("pointers", incident["evidence"])
        self.assertIn("unknownBoundaries", incident["evidence"])
        for key in ("pointers", "staged", "pending", "archived", "incomplete", "durable"):
            self.assertIn(key, incident["archive"])

        pane_clock = records[2]
        for key in ("paneKey", "ageMs", "ageBasis", "observedAt", "declaredWait"):
            self.assertIn(key, pane_clock)

        tool_failure = records[3]
        for key in ("sessionId", "turn", "toolName", "errorKind", "exitCode", "observedAt"):
            self.assertIn(key, tool_failure)
        self.assertNotIn("code", tool_failure, "normalised codes were removed in M8-3")

        end = records[4]
        for key in ("counts", "total", "truncated", "dropped"):
            self.assertIn(key, end)

    def test_contract_example_is_synthetic(self):
        text = CONTRACT.read_text(encoding="utf-8")
        for marker in ("inc_example", "host-example", "run_example", "wt_example"):
            self.assertIn(marker, text)
        self.assertNotRegex(text, r"inc_[0-9a-z]{8}_[0-9a-f]{12}")

    def test_report_template_keeps_reproducibility_and_durability(self):
        template = TEMPLATE.read_text(encoding="utf-8")
        for token in (
            "inputSha256",
            "exportVersion",
            "completeness",
            "rowsUsed",
            "sourceKeys",
            "Unknowns",
            "coverage",
            "durable",
            "partial window",
        ):
            self.assertIn(token, template, f"report template must keep {token!r}")
        self.assertIn("confirmed` is not proposed", template)


if __name__ == "__main__":
    unittest.main()

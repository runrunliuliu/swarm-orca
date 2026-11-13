import json
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

import start_grant  # noqa: E402
from start_grant import REFUSED, build_record, hand, mint, objective_hash, parse_repo, state  # noqa: E402

DEADLINE = "2999-01-01T00:00:00+00:00"


class FakeCli:
    """A CLI that answers one scripted payload per invocation and records argv."""

    def __init__(self, directory: Path) -> None:
        self.dir = directory
        self.path = directory / "fake-orca"
        self.path.write_text(textwrap.dedent('''\
            #!/bin/sh
            printf '%s\\n' "$@" >> "$(dirname "$0")/argv.txt"
            cat "$(dirname "$0")/answer.json"
            exit "$(cat "$(dirname "$0")/answer.exit")"
            '''))
        self.path.chmod(0o755)
        self.answer({"ok": True, "result": {"grant": {}, "effectsApplied": True}}, 0)

    def answer(self, payload, exit_code: int = 0) -> None:
        (self.dir / "answer.json").write_text(
            payload if isinstance(payload, str) else json.dumps(payload))
        (self.dir / "answer.exit").write_text(str(exit_code))

    def calls(self) -> list[list[str]]:
        path = self.dir / "argv.txt"
        if not path.exists():
            return []
        text = path.read_text().splitlines()
        calls, current = [], []
        for line in text:
            current.append(line)
            if line == "--json":
                calls.append(current)
                current = []
        return calls


class StartGrantTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)
        self.approval = self.dir / "approval.md"
        self.approval.write_text("owner approved: review the parser, read only\n")
        self.cli = FakeCli(self.dir)

    def record(self, **overrides):
        fields = dict(
            objective="review the parser, read only",
            max_workers=8,
            deadline=DEADLINE,
            task_source=str(self.approval),
            repos=[parse_repo("repo-1")],
        )
        fields.update(overrides)
        return build_record(**fields)

    # --- the hash has to be the runtime's, exactly -------------------------------------------

    def test_objective_hash_matches_javascripts_canonical_json(self):
        # Pinned against `hashCanonical` in the runtime: sha256(JSON.stringify(text)). The cases that
        # differ between Python's default json and JavaScript are non-ASCII, quotes, and newlines.
        expected = {
            "review the parser": "f694ee2a57d26030d1c91cc96ef1ac147e081f9c5779eeb5126f7b83de44d4fe",
            "复核：解析器": "fe0d5ccdcbbbb35d9531f8a454130dd006f7a76f9b0d14ea7226de6d21190f57",
            'a"b\\c\n': "bc66ad49348b837dbb56a89b331dfa7f2bb8e89af2cbe0983d0e72846b2dbff3",
        }
        for text, digest in expected.items():
            with self.subTest(text=text):
                self.assertEqual(objective_hash(text), digest)

    # --- the record -------------------------------------------------------------------------

    def test_record_carries_the_reviewed_evidence_and_no_minter(self):
        record = self.record(writable_roots=["/tmp/scratch"], spend="capped:5")
        self.assertNotIn("minter", record, "the server writes the minter; a client cannot know it")
        self.assertEqual(record["objectiveHash"], objective_hash(record["objectiveText"]))
        self.assertEqual(record["taskSource"]["path"], str(self.approval))
        self.assertTrue(record["taskSource"]["sha256"])
        self.assertEqual(record["repos"], [{"repoId": "repo-1", "worktreeIds": None}])
        self.assertEqual(record["spend"], {"kind": "capped", "limitUsd": 5})
        self.assertIs(record["executionAuthorized"], False)

    def test_repo_scope_parsing_is_unambiguous(self):
        self.assertEqual(parse_repo("repo-1"), {"repoId": "repo-1", "worktreeIds": None})
        self.assertEqual(
            parse_repo("repo-1:wt-a,wt-b"), {"repoId": "repo-1", "worktreeIds": ["wt-a", "wt-b"]}
        )
        for bad in ("", "repo-1:"):
            with self.subTest(bad=bad):
                with self.assertRaises(start_grant.Refused):
                    parse_repo(bad)

    def test_refuses_records_that_would_be_unsubmittable(self):
        cases = {
            "task_source_not_absolute": dict(task_source="relative.md"),
            "deadline_not_after_mint_at": dict(deadline="1999-01-01T00:00:00+00:00"),
            "max_workers_invalid": dict(max_workers=0),
            "spend_invalid": dict(spend="capped:0"),
            "repos_required": dict(repos=[]),
        }
        for reason, overrides in cases.items():
            with self.subTest(reason=reason):
                with self.assertRaises(start_grant.Refused) as caught:
                    self.record(**overrides)
                self.assertEqual(caught.exception.reason, reason)

    def test_deadline_without_a_timezone_is_refused(self):
        with self.assertRaises(ValueError):
            self.record(deadline="2999-01-01T00:00:00")

    # --- mint -------------------------------------------------------------------------------

    def test_mint_publishes_one_file_and_submits_that_exact_file(self):
        record = self.record()
        result = mint(record=record, directory=str(self.dir), from_handle="term_minter",
                      cli=str(self.cli.path))
        target = self.dir / f"{record['grantId']}.json"
        self.assertTrue(target.is_file())
        self.assertEqual(result["record"]["path"], str(target))
        self.assertEqual(result["record"]["sha256"], start_grant.file_ref(target)["sha256"])
        submitted = self.cli.calls()[0]
        self.assertEqual(submitted[0:2], ["orchestration", "start-grant-mint"])
        self.assertIn(str(target), submitted)

    def test_a_retry_resubmits_the_same_bytes_instead_of_regenerating_them(self):
        record = self.record()
        first = mint(record=record, directory=str(self.dir), from_handle="term_minter",
                     cli=str(self.cli.path))
        second = mint(record=record, directory=str(self.dir), from_handle="term_minter",
                      cli=str(self.cli.path))
        self.assertEqual(first["record"]["sha256"], second["record"]["sha256"])
        self.assertEqual(len(self.cli.calls()), 2)

    def test_a_second_record_under_the_same_id_is_refused_without_touching_the_file(self):
        record = self.record()
        mint(record=record, directory=str(self.dir), from_handle="term_minter", cli=str(self.cli.path))
        other = dict(record, maxWorkers=9)
        with self.assertRaises(start_grant.Refused) as caught:
            mint(record=other, directory=str(self.dir), from_handle="term_minter",
                 cli=str(self.cli.path))
        self.assertEqual(caught.exception.reason, "record_exists_with_other_contents")
        stored = json.loads((self.dir / f"{record['grantId']}.json").read_text())
        self.assertEqual(stored["maxWorkers"], 8)
        self.assertEqual(len(self.cli.calls()), 1, "a refused mint never reaches the runtime")

    def test_a_typed_refusal_is_reported_with_its_code(self):
        self.cli.answer({"ok": False, "error": {"code": "start_grant_invalid_record"}}, 0)
        with self.assertRaises(start_grant.Refused) as caught:
            mint(record=self.record(), directory=str(self.dir), from_handle="term_minter",
                 cli=str(self.cli.path))
        self.assertEqual(caught.exception.reason, "start_grant_invalid_record")

    def test_an_unreadable_answer_is_unverifiable_rather_than_success(self):
        self.cli.answer("not json", 0)
        with self.assertRaises(start_grant.Refused) as caught:
            mint(record=self.record(), directory=str(self.dir), from_handle="term_minter",
                 cli=str(self.cli.path))
        self.assertEqual(caught.exception.reason, "answer_unreadable")

    # --- state ------------------------------------------------------------------------------

    def test_state_reports_the_runtime_record_and_whether_the_local_file_still_matches(self):
        record = self.record()
        mint(record=record, directory=str(self.dir), from_handle="term_minter", cli=str(self.cli.path))
        target = self.dir / f"{record['grantId']}.json"
        stored = json.loads(target.read_text())
        runtime_record = dict(stored, minter={"terminalHandle": "term_minter"})
        self.cli.answer({"ok": True, "result": {
            "grant": runtime_record,
            "state": {"valid": True, "expired": False, "revoked": False},
            "run": None,
            "workers": {"active": 0, "max": 8},
        }}, 0)
        result = state(grant_id=record["grantId"], record=str(target), cli=str(self.cli.path))
        self.assertTrue(result["local_matches_runtime"])
        self.assertIsNone(result["run"])
        self.assertEqual(result["workers"], {"active": 0, "max": 8})

        drifted = dict(runtime_record, maxWorkers=9)
        self.cli.answer({"ok": True, "result": {"grant": drifted, "state": {"valid": True},
                                                "run": None, "workers": {"active": 0, "max": 9}}}, 0)
        result = state(grant_id=record["grantId"], record=str(target), cli=str(self.cli.path))
        self.assertFalse(result["local_matches_runtime"])
        self.assertEqual(len(self.cli.calls()), 3)

    def test_state_without_a_local_record_only_reports_the_runtime_side(self):
        self.cli.answer({"ok": True, "result": {
            "grant": {"grantId": "g"}, "state": {"valid": True}, "run": {"id": "run_1"},
            "workers": {"active": 1, "max": 2},
        }}, 0)
        result = state(grant_id="g", cli=str(self.cli.path))
        self.assertNotIn("local_record", result)
        self.assertEqual(result["run"], {"id": "run_1"})

    # --- hand -------------------------------------------------------------------------------

    def test_hand_delivers_one_message_carrying_the_pinned_record(self):
        record = self.record()
        mint(record=record, directory=str(self.dir), from_handle="term_minter", cli=str(self.cli.path))
        target = self.dir / f"{record['grantId']}.json"
        reference = start_grant.file_ref(target)
        hand(grant_id=record["grantId"], record_ref=reference, to_handle="term_coord",
             cli=str(self.cli.path))
        sent = self.cli.calls()[1]
        self.assertEqual(sent[0:2], ["orchestration", "send"])
        payload = json.loads(sent[sent.index("--payload") + 1])
        self.assertEqual(payload["kind"], "start_grant_handoff")
        self.assertEqual(payload["grant_id"], record["grantId"])
        self.assertEqual(payload["record"], {"path": reference["path"],
                                             "sha256": reference["sha256"]})

    # --- the CLI surface --------------------------------------------------------------------

    def test_the_cli_returns_five_on_a_refusal_and_prints_the_reason(self):
        completed = subprocess.run(
            [sys.executable, "-B", str(ROOT / "start_grant.py"), "mint",
             "--objective", "x", "--max-workers", "0", "--deadline", DEADLINE,
             "--task-source", str(self.approval), "--repo", "repo-1",
             "--from", "term_minter", "--record-dir", str(self.dir)],
            capture_output=True, text=True, timeout=120)
        self.assertEqual(completed.returncode, REFUSED)
        self.assertIn("max_workers_invalid", completed.stderr)


if __name__ == "__main__":
    unittest.main()

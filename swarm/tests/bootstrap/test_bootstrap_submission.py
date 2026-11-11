"""Operator candidate/owner-output boundary; native identity remains test-only.

Focused guards use a confirmed tool intent. The production S1-S5 flow separately
consumes real pull actions and unchanged request schemas for all three stages.
"""

from contextlib import contextmanager, redirect_stdout
import io
import os
from pathlib import Path
import unittest
from unittest.mock import patch

from bootstrap_tool import RoleTool, SUBMIT_TARGETS, cli_main
from coordinator_io import canonical, digest, file_ref, parse, pinned, publish_new
import bootstrap.test_bootstrap_production as production_tests


@contextmanager
def submission_fixture(name="fields-intent", *, legacy=False, real_stage=False):
    with production_tests.production() as (f, owner, identity, client, owner_ref):
        if real_stage:
            from bootstrap_role_fixture import RoleWorkflow
            action = RoleWorkflow(f, identity, owner_ref).until(name)
        identity.actor = "operator"
        tool = RoleTool(f.control, client, "operator")
        try:
            target = tool.paths[SUBMIT_TARGETS[name]]
            # An owner-confirmed intent is sufficient to exercise submit's
            # pre-publication guards; no live model or fabricated approval.
            if legacy:
                intent, _ = tool.intent(name, "operator", [], request=f.control.attempt_binding)
                action = dict(intent=intent, result_path=target)
            elif not real_stage:
                action = tool.action(name, target, request=f.control.attempt_binding)
            yield f, owner, client, owner_ref, tool, action
        finally:
            tool.close()


class SubmissionTests(unittest.TestCase):
    def assert_unchanged(self, owner, attempted, confirmations):
        self.assertEqual(owner.attempted, attempted)
        self.assertEqual(owner.confirmations, confirmations)
        self.assertTrue(owner.armed)

    def test_direct_final_input_rejected_before_commit_for_all_operator_stages(self):
        for name in SUBMIT_TARGETS:
            with self.subTest(name=name), submission_fixture(name) as (f, owner, client, _, tool, action):
                final = Path(action["result_path"])
                publish_new(final, {"candidate": "mistaken direct final write"})
                ref, stamp = file_ref(final), final.stat().st_mtime_ns
                attempted, confirmations = dict(owner.attempted), set(owner.confirmations)
                with patch.object(client, "commit_new", side_effect=AssertionError("must not commit")), \
                        self.assertRaisesRegex(ValueError, "bootstrap_candidate_is_owner_output"):
                    tool.submit(action["intent"], ref)
                self.assert_unchanged(owner, attempted, confirmations)
                self.assertEqual(file_ref(final), ref)
                self.assertEqual(final.stat().st_mtime_ns, stamp)
                self.assertEqual(client.query(f.control, ref).status, "durability_unverified")

    def test_valid_candidate_does_not_adopt_unconfirmed_final(self):
        with submission_fixture() as (f, owner, client, _, tool, action):
            final, candidate = Path(action["result_path"]), Path(action["submission"]["candidate_path"])
            for target in (final, candidate):
                publish_new(target, {"candidate": "identical bytes are not owner confirmation"})
            original = file_ref(final)
            attempted, confirmations = dict(owner.attempted), set(owner.confirmations)
            with patch.object(client, "commit_new", side_effect=AssertionError("must not commit")), \
                    self.assertRaisesRegex(ValueError, "bootstrap_owner_output_unconfirmed"):
                tool.submit(action["intent"], file_ref(candidate))
            self.assert_unchanged(owner, attempted, confirmations)
            self.assertEqual(file_ref(final), original)
            self.assertEqual(client.query(f.control, original).status, "durability_unverified")

    def test_wrong_candidate_path_and_other_stage_candidate_are_rejected(self):
        with submission_fixture() as (f, owner, client, _, tool, action):
            attempted, confirmations = dict(owner.attempted), set(owner.confirmations)
            for target in (f.root / "elsewhere.json", Path(tool.submission("contract-intent")["candidate_path"]),
                           Path(tool.paths["contract_review"])):
                publish_new(target, {"candidate": "wrong path"})
                with self.subTest(target=target.name), self.assertRaisesRegex(ValueError, "candidate_path_mismatch"):
                    tool.submit(action["intent"], file_ref(target))
            self.assert_unchanged(owner, attempted, confirmations)
            self.assertFalse(Path(action["result_path"]).exists())

    def test_candidate_symlink_and_hardlink_are_rejected(self):
        for link in ("symlink", "hardlink"):
            with self.subTest(link=link), submission_fixture() as (f, owner, client, _, tool, action):
                source = f.root / "linked-source.json"
                publish_new(source, {"candidate": "aliased bytes"})
                candidate = Path(action["submission"]["candidate_path"])
                if link == "symlink":
                    candidate.symlink_to(source)
                else:
                    os.link(source, candidate)
                ref = dict(path=str(candidate), sha256=file_ref(source)["sha256"])
                attempted, confirmations = dict(owner.attempted), set(owner.confirmations)
                with self.assertRaisesRegex(ValueError, "bootstrap_candidate_" + link + "_forbidden"):
                    tool.submit(action["intent"], ref)
                self.assert_unchanged(owner, attempted, confirmations)
                self.assertFalse(Path(action["result_path"]).exists())

    def test_candidate_sha_and_prepublication_recheck_reject_changes(self):
        for when in ("before_submit", "before_commit"):
            with self.subTest(when=when), submission_fixture(real_stage=True) as (f, owner, client, _, tool, action):
                candidate = Path(action["submission"]["candidate_path"])
                publish_new(candidate, action["payload"]["candidate_template"])
                ref = file_ref(candidate)
                attempted, confirmations = dict(owner.attempted), set(owner.confirmations)
                original = client.commit_new
                def mutate_then_commit(*args, **kwargs):
                    candidate.write_bytes(b"changed")
                    return original(*args, **kwargs)
                if when == "before_submit":
                    candidate.write_bytes(b"changed")
                with patch.object(client, "commit_new", side_effect=mutate_then_commit), \
                        self.assertRaisesRegex(ValueError, "file_pin_changed"):
                    tool.submit(action["intent"], ref)
                self.assert_unchanged(owner, attempted, confirmations)
                self.assertFalse(Path(action["result_path"]).exists())

    def test_from_template_materializes_the_fields_candidate_and_says_so(self):
        # Why: the fields candidate is fully determined by the contract, so writing it by hand is
        # a turn spent copying a template. The tool may materialize it, but the reply has to say
        # that the bytes were materialized rather than authored - an auditor reading only
        # "execution_authorized: false" cannot tell the difference.
        with submission_fixture(real_stage=True) as (f, owner, client, _, tool, action):
            self.assertEqual(action["action"], "fields-intent")
            result = tool.submit(action["intent"], from_template=True)
            self.assertTrue(result["materialized_from_template"])
            self.assertFalse(result["authored"])
            self.assertEqual(Path(result["result"]["path"]), Path(action["result_path"]))
            self.assertEqual(parse(pinned(result["result"])),
                             action["payload"]["candidate_template"])

    def test_candidate_ref_is_none_when_the_tool_materializes_the_bytes(self):
        # Why this exists: the direct tool call passes source_ref=None, so a CLI that fabricated
        # {path: None, sha256: None} kept the unit test green while the documented command could
        # never work. The argv contract is pinned here instead of through a live runtime.
        from argparse import Namespace
        from bootstrap_tool import candidate_ref
        self.assertIsNone(candidate_ref(Namespace(from_template=True, input=None, input_sha256=None)))
        self.assertEqual(candidate_ref(Namespace(from_template=False, input="/c.json", input_sha256="ab")),
                         {"path": "/c.json", "sha256": "ab"})

    def test_from_template_is_refused_outside_submit_before_any_connection(self):
        output = io.StringIO()
        with redirect_stdout(output):
            code = cli_main(["readiness", "--owner", "/nonexistent", "--owner-sha256", "00" * 32,
                             "--actor", "operator", "--intent", "/nonexistent",
                             "--intent-sha256", "00" * 32, "--from-template", "--execute"])
        self.assertNotEqual(code, 0)
        self.assertIn("bootstrap_from_template_requires_submit", output.getvalue())

    def test_a_rejected_from_template_submit_leaves_no_candidate_behind(self):
        # Why: the bytes are the tool's. If validation refuses them, keeping the file would make
        # the next attempt fail on a candidate the caller never wrote - and the failure would look
        # like the caller's mistake.
        with submission_fixture(real_stage=True) as (f, owner, client, _, tool, action):
            candidate = Path(action["submission"]["candidate_path"])
            with patch.object(type(tool), "validate_candidate",
                       side_effect=ValueError("bootstrap_fields_invalid")), \
                    self.assertRaisesRegex(ValueError, "bootstrap_fields_invalid"):
                tool.submit(action["intent"], from_template=True)
            self.assertFalse(candidate.exists(), "materialized candidate survived a rejection")
            self.assertFalse(Path(action["result_path"]).exists())

    def test_from_template_refuses_a_review_stage(self):
        # Why: a review candidate carries decision/notes/reviewed_at. Materializing it would put
        # the tool's bytes where a reviewer's judgement belongs.
        with submission_fixture("contract-intent", real_stage=True) as (f, owner, client, _, tool, action):
            with self.assertRaisesRegex(ValueError, "bootstrap_from_template_not_allowed"):
                tool.submit(action["intent"], from_template=True)
            self.assertFalse(Path(action["result_path"]).exists())

    def test_from_template_refuses_when_the_pinned_template_drifted(self):
        # Why: the intent records the template it handed out. If the authorities now produce a
        # different one, the recorded intent is stale and must not be silently upgraded.
        with submission_fixture(real_stage=True) as (f, owner, client, _, tool, action):
            with patch.object(tool, "template", return_value={"drifted": True}), \
                    self.assertRaisesRegex(ValueError, "bootstrap_template_drift"):
                tool.submit(action["intent"], from_template=True)
            self.assertFalse(Path(action["result_path"]).exists())

    def test_from_template_still_runs_the_candidate_validator(self):
        # Why: the second write path must not become a second validation path. Breaking the
        # validator has to break --from-template exactly as it breaks a hand-authored submit.
        with submission_fixture(real_stage=True) as (f, owner, client, _, tool, action):
            attempted, confirmations = dict(owner.attempted), set(owner.confirmations)
            with patch("bootstrap_tool.contract_fields",
                       side_effect=ValueError("bootstrap_fields_invalid")), \
                    self.assertRaisesRegex(ValueError, "bootstrap_fields_invalid"):
                tool.submit(action["intent"], from_template=True)
            self.assert_unchanged(owner, attempted, confirmations)
            self.assertFalse(Path(action["result_path"]).exists())

    def test_old_intent_is_not_rewritten_or_silently_upgraded(self):
        with submission_fixture(legacy=True) as (f, owner, client, _, tool, action):
            original = pinned(action["intent"])
            candidate = Path(tool.submission("fields-intent")["candidate_path"])
            publish_new(candidate, {"candidate": "new contract cannot upgrade old intent"})
            attempted, confirmations = dict(owner.attempted), set(owner.confirmations)
            with self.assertRaisesRegex(ValueError, "submission_contract_mismatch"):
                tool.submit(action["intent"], file_ref(candidate))
            with self.assertRaisesRegex(ValueError, "bootstrap_intent_mismatch"):
                tool.action("fields-intent", action["result_path"], request=f.control.attempt_binding)
            self.assertEqual(pinned(action["intent"]), original)
            self.assert_unchanged(owner, attempted, confirmations)

    def test_submit_reply_loss_queries_exact_final_pin_without_republication(self):
        with submission_fixture(real_stage=True) as (f, owner, client, _, tool, action):
            candidate = Path(action["submission"]["candidate_path"])
            publish_new(candidate, action["payload"]["candidate_template"])
            ref = file_ref(candidate)
            final_ref = dict(ref, path=action["result_path"])
            original = client.commit_new
            def commit_then_lose_reply(*args, **kwargs):
                result = original(*args, **kwargs)
                if kwargs["target"] == action["result_path"]:
                    raise TimeoutError("test reply lost after owner commit")
                return result
            with patch.object(client, "commit_new", side_effect=commit_then_lose_reply) as commit:
                with self.assertRaises(TimeoutError):
                    tool.submit(action["intent"], ref)
                self.assertEqual(client.query(f.control, final_ref).status, "confirmed")
                with self.assertRaisesRegex(ValueError, "result_already_committed"):
                    tool.submit(action["intent"], ref)
                self.assertEqual(commit.call_count, 2)
            self.assertTrue(owner.armed)
            self.assertEqual(pinned(final_ref), pinned(ref))

    def test_unpinned_or_mismatched_submission_contract_is_rejected(self):
        with submission_fixture() as (f, owner, client, _, tool, action):
            candidate = Path(action["submission"]["candidate_path"])
            publish_new(candidate, {"candidate": "original bytes"})
            attempted, confirmations = dict(owner.attempted), set(owner.confirmations)
            wrong_pin = dict(action["intent"], sha256=digest(b"not the intent"))
            with self.assertRaisesRegex(ValueError, "file_pin_changed"):
                tool.submit(wrong_pin, file_ref(candidate))
            self.assert_unchanged(owner, attempted, confirmations)
            # A confirmed but incompatible contract is still not authority to
            # reinterpret the candidate path. Never rewrite the original intent.
            other_name = "contract-intent"
            other = tool.submission(other_name)
            other["candidate_path"] = str(candidate)
            intent, _ = tool.intent(other_name, "operator", [], submission=other)
            attempted, confirmations = dict(owner.attempted), set(owner.confirmations)
            with self.assertRaisesRegex(ValueError, "submission_contract_mismatch"):
                tool.submit(intent, file_ref(candidate))
            self.assert_unchanged(owner, attempted, confirmations)
            self.assertFalse(Path(action["result_path"]).exists())
            self.assertFalse(Path(tool.paths["contract_review"]).exists())

    def test_produce_tells_operator_to_use_candidate_submit(self):
        for name in SUBMIT_TARGETS:
            with self.subTest(name=name), submission_fixture(name) as (f, owner, client, _, tool, action):
                attempted, confirmations = dict(owner.attempted), set(owner.confirmations)
                with self.assertRaisesRegex(ValueError, "bootstrap_operator_action_requires_candidate_submit"):
                    tool.produce(action["intent"])
                self.assert_unchanged(owner, attempted, confirmations)
                self.assertFalse(Path(action["result_path"]).exists())

    def test_reserved_candidate_path_is_refused_before_new_intent(self):
        with submission_fixture() as (f, owner, client, _, tool, action):
            candidate = tool.submission("contract-intent")["candidate_path"]
            tool.b["file_tool_evidence_paths"].append(candidate)
            attempted, confirmations = dict(owner.attempted), set(owner.confirmations)
            with self.assertRaisesRegex(ValueError, "bootstrap_candidate_reserved_path"):
                tool.action("contract-intent", tool.paths["contract_review"])
            self.assert_unchanged(owner, attempted, confirmations)
            self.assertFalse(Path(tool.paths["contract-intent"]).exists())

    def test_cli_reports_actionable_reason_without_publishing(self):
        with submission_fixture() as (f, owner, client, owner_ref, tool, action):
            tool.close()  # Release the role lock for the independent CLI invocation.
            target = action["result_path"]
            attempted, confirmations = dict(owner.attempted), set(owner.confirmations)
            output = io.StringIO()
            with redirect_stdout(output):
                code = cli_main(["submit", "--owner", owner_ref["path"], "--owner-sha256", owner_ref["sha256"],
                    "--actor", "operator", "--intent", action["intent"]["path"],
                    "--intent-sha256", action["intent"]["sha256"], "--input", target,
                    "--input-sha256", digest(b"not even written"), "--execute"])
            result = parse(output.getvalue().encode())
            self.assertEqual(code, 2)
            self.assertEqual(result["reason"], "bootstrap_candidate_is_owner_output")
            self.assertNotIn(target, output.getvalue())
            self.assert_unchanged(owner, attempted, confirmations)
            self.assertFalse(Path(target).exists())


if __name__ == "__main__":
    unittest.main()

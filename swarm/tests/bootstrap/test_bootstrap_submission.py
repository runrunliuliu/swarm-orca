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
from coordinator_io import digest, file_ref, parse, pinned, publish_new
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
                original = client.commit_batch
                def mutate_then_commit(*args, **kwargs):
                    candidate.write_bytes(b"changed")
                    return original(*args, **kwargs)
                if when == "before_submit":
                    candidate.write_bytes(b"changed")
                with patch.object(client, "commit_batch", side_effect=mutate_then_commit), \
                        self.assertRaisesRegex(ValueError, "file_pin_changed"):
                    tool.submit(action["intent"], ref)
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

    def test_a_lost_reply_leaves_the_whole_unit_durable_and_unrepeatable(self):
        """Record and output are one admission, so a lost reply cannot split them."""
        with submission_fixture(real_stage=True) as (f, owner, client, _, tool, action):
            candidate = Path(action["submission"]["candidate_path"])
            publish_new(candidate, action["payload"]["candidate_template"])
            ref = file_ref(candidate)
            final_ref = dict(ref, path=action["result_path"])
            original = client.commit_batch
            def commit_then_lose_reply(*args, **kwargs):
                original(*args, **kwargs)
                raise TimeoutError("test reply lost after the unit was admitted")
            with patch.object(client, "commit_batch", side_effect=commit_then_lose_reply) as commit:
                with self.assertRaises(TimeoutError):
                    tool.submit(action["intent"], ref)
            # Either both targets are durable or neither: here the owner admitted both.
            self.assertEqual(client.query(f.control, final_ref).status, "confirmed")
            self.assertEqual(commit.call_count, 1)
            with self.assertRaisesRegex(ValueError, "submission_requires_reconciliation"):
                tool.submit(action["intent"], ref)
            self.assertTrue(owner.armed)
            self.assertEqual(pinned(final_ref), pinned(ref))

    def test_a_busy_on_the_unit_proves_nothing_was_admitted_and_the_retry_works(self):
        """attempt19/24 died because a busy could arrive between record and output.

        The unit is one admission now, so that window is gone: a busy leaves no
        record and no output, and the same call succeeds once the owner is free.
        """
        from bootstrap_actions import completion_slot
        from observation_budget import ObservationBusy

        with submission_fixture(real_stage=True) as (f, owner, client, _, tool, action):
            candidate = Path(action["submission"]["candidate_path"])
            publish_new(candidate, action["payload"]["candidate_template"])
            ref = file_ref(candidate)
            original = client.commit_batch
            calls = []

            def busy_once(*args, **kwargs):
                calls.append(1)
                if len(calls) == 1:
                    raise ObservationBusy()
                return original(*args, **kwargs)

            with patch.object(client, "commit_batch", side_effect=busy_once):
                with self.assertRaises(ObservationBusy):
                    tool.submit(action["intent"], ref)
                self.assertFalse(Path(completion_slot(tool.root, "fields-intent")).exists())
                self.assertFalse(Path(action["result_path"]).exists())
                result = tool.submit(action["intent"], ref)
            self.assertTrue(Path(completion_slot(tool.root, "fields-intent")).exists())
            self.assertEqual(result["result"]["path"], action["result_path"])
            self.assertTrue(Path(action["result_path"]).exists())

    def test_a_failed_output_write_never_leaves_a_reconcilable_record(self):
        """The batch records each target just before writing it, record last.

        So when an output write fails, the record was never recorded and no
        `reconcile(path=record)` entry can publish it alone — the attempt19/24 fence
        cannot be rebuilt through the supported recovery path.
        """
        import bootstrap_control
        from bootstrap_actions import completion_slot

        with submission_fixture(real_stage=True) as (f, owner, client, _, tool, action):
            candidate = Path(action["submission"]["candidate_path"])
            publish_new(candidate, action["payload"]["candidate_template"])
            ref = file_ref(candidate)
            record = completion_slot(tool.root, "fields-intent")
            real = bootstrap_control.io.publish_new
            calls = []

            def fail_on_result(path, raw):
                calls.append(str(path))
                if str(path) == action["result_path"]:
                    raise OSError("test write failure")
                return real(path, raw)

            with patch("bootstrap_control.io.publish_new", side_effect=fail_on_result):
                with self.assertRaises(ValueError) as caught:
                    tool.submit(action["intent"], ref)
            self.assertEqual(caught.exception.commit_state, "unknown")
            self.assertFalse(Path(record).exists())
            self.assertFalse(Path(action["result_path"]).exists())
            # The one supported recovery entry must refuse to publish it.
            owner_stub = tool
            owner_stub.actor = "operator"
            with self.assertRaises(ValueError) as refused:
                client.rpc("reconcile", path=record)
            self.assertIn("bootstrap_original_commit_unknown", str(refused.exception))

    def test_the_record_fence_outranks_a_busy_owner(self):
        """attempt24: five retries reported a permanent fence as a transient busy.

        `submit()` asked the owner first, so a busy executor hid the record that no
        retry could ever cross. The fence is now read from disk before that call, and
        when the final output already exists the answer is "already done".
        """
        from bootstrap_actions import completion_slot
        from observation_budget import ObservationBusy

        with submission_fixture(real_stage=True) as (f, owner, client, _, tool, action):
            candidate = Path(action["submission"]["candidate_path"])
            publish_new(candidate, action["payload"]["candidate_template"])
            ref = file_ref(candidate)
            tool.submit(action["intent"], ref)
            self.assertTrue(Path(completion_slot(f.root, "fields-intent")).exists())
            with patch.object(client, "commit_new", side_effect=ObservationBusy()), \
                    patch.object(client, "query", side_effect=ObservationBusy()):
                with self.assertRaisesRegex(ValueError, "submission_requires_reconciliation"):
                    tool.submit(action["intent"], ref)

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

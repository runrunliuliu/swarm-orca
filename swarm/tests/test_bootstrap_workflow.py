"""Shared action protocol, validation-before-admission, conservative recovery."""

from contextlib import contextmanager
from datetime import timedelta
import os
from pathlib import Path
import unittest
from unittest.mock import patch

from bootstrap_actions import ACTIONS, completion_slot, plan_actions
from bootstrap_control import slots_for
from bootstrap_protocol import EVENTS
from bootstrap_s5 import role_plan
from bootstrap_tool import RoleTool
from coordinator_io import canonical, digest, file_ref, parse, pinned, publish_new
from bootstrap_role_fixture import RoleWorkflow
from test_bootstrap_production import production


@contextmanager
def workflow_fixture(name, **kwargs):
    with production(**kwargs) as (f, owner, identity, client, owner_ref):
        workflow = RoleWorkflow(f, identity, owner_ref)
        action = workflow.until(name)
        tool = RoleTool(f.control, client, ACTIONS[name].actor)
        try:
            yield f, owner, client, workflow, tool, action
        finally:
            tool.close()


class WorkflowTests(unittest.TestCase):
    def untouched(self, owner, before, action):
        self.assertEqual((owner.attempted, owner.confirmations), before)
        self.assertFalse(Path(action["result_path"]).exists())
        self.assertFalse(Path(completion_slot(Path(action["intent"]["path"]).parent.parent, action["action"])).exists())
        self.assertTrue(owner.armed)

    def test_registry_plan_and_owner_slots_agree(self):
        with production() as (f, owner, identity, client, owner_ref):
            plan = role_plan(owner_ref)
            self.assertEqual(plan["actions"], plan_actions(f.b))
            for action in plan["actions"]:
                name = action["action"]
                spec = ACTIONS[name]
                self.assertEqual(owner.slots[f.paths[spec.target]], spec.actor)
                self.assertEqual(owner.slots[str(f.root / "control" / (name + ".json"))], spec.actor)
                if spec.mode != "produce":
                    self.assertEqual(owner.slots[completion_slot(f.root, name)], spec.actor)
                    self.assertEqual(action["submission"]["schema_version"], 2)
                    for output in action["submission"]["outputs"]:
                        self.assertNotIn(output["candidate_path"], slots_for(f.b))
                        self.assertEqual(owner.slots[output["final_path"]], spec.actor)

    def test_malformed_fields_rejected_before_any_admission(self):
        with workflow_fixture("fields-intent") as (f, owner, client, workflow, tool, action):
            good = workflow.candidate_value(action)
            bad = [b"{", canonical([])]
            for key, value in (("runtime", "other"), ("operator", {}), ("coordinator", {}),
                               ("workspace", {}), ("role_skill", {}), ("schema_version", 2),
                               ("freshness", {}), ("run", "not-a-new-session"), ("observation", {})):
                bad.append(canonical(dict(good, **{key: value})))
            candidate = Path(action["submission"]["candidate_path"])
            before = (dict(owner.attempted), set(owner.confirmations))
            for raw in bad:
                with self.subTest(raw=raw[:100]):
                    candidate.write_bytes(raw)
                    with self.assertRaises((ValueError, KeyError, TypeError)):
                        tool.complete(action["intent"])
                    self.untouched(owner, before, action)
            candidate.write_bytes(canonical(good))
            tool.complete(action["intent"])
            self.assertEqual(tool.inspect_action(action["intent"])["state"], "confirmed")

    def test_review_binding_time_schema_and_judgment_checked_before_publication(self):
        for name in ("contract-intent", "readiness-intent"):
            with self.subTest(name=name), workflow_fixture(name) as (f, owner, client, workflow, tool, action):
                good = workflow.candidate_value(action)
                candidate = Path(action["submission"]["candidate_path"])
                before = (dict(owner.attempted), set(owner.confirmations))
                variants = [("request", f.control.attempt_binding), ("subject_refs", []), ("evidence_refs", []),
                            ("operator", {}), ("decision", "automatic"), ("notes", ""),
                            ("reviewed_at", "2001-01-01T00:00:00+00:00"),
                            ("reviewed_at", "2099-01-01T00:00:00+00:00"),
                            ("identity_verified", True), ("execution_authorized", True), ("schema_version", 2)]
                for key, value in variants:
                    with self.subTest(key=key, value=value):
                        candidate.write_bytes(canonical(dict(good, **{key: value})))
                        with self.assertRaises(ValueError):
                            tool.complete(action["intent"])
                        self.untouched(owner, before, action)
                # The generated template is deliberately not an approval.
                candidate.write_bytes(canonical(action["payload"]["candidate_template"]))
                with self.assertRaises(ValueError):
                    tool.complete(action["intent"])
                self.untouched(owner, before, action)
                candidate.write_bytes(canonical(good))
                tool.complete(action["intent"])
                self.assertEqual(tool.inspect_action(action["intent"])["state"], "confirmed")

    def test_rejection_is_preserved_but_never_advances_marker(self):
        for name, blocked in (("contract-intent", EVENTS[2]), ("readiness-intent", EVENTS[3])):
            with self.subTest(name=name), workflow_fixture(name) as (f, owner, client, workflow, tool, action):
                value = dict(workflow.candidate_value(action), decision="reject", notes="Independent negative review")
                publish_new(Path(action["submission"]["candidate_path"]), value)
                tool.complete(action["intent"])
                ref = file_ref(action["result_path"])
                self.assertEqual(client.query(f.control, ref).status, "confirmed")
                self.assertEqual(parse(pinned(ref))["decision"], "reject")
                with self.assertRaisesRegex(ValueError, "operator_rejected"):
                    tool.step()
                self.assertFalse(Path(f.paths[blocked]).exists())

    def test_readiness_batch_order_count_paths_and_later_pin_checked_before_first_commit(self):
        with workflow_fixture("final-evidence-intent", probe_names=["a.json", "b.json"]) as (f, owner, client, workflow, tool, action):
            workflow.write_candidates(action)
            outputs = action["submission"]["outputs"]
            refs = [file_ref(output["candidate_path"]) for output in outputs]
            before = (dict(owner.attempted), set(owner.confirmations))
            bad_last = dict(refs[-1], sha256=digest(b"wrong"))
            cases = [[], refs[:1], refs + refs[:1], list(reversed(refs)), [refs[0], bad_last],
                     [refs[0], dict(refs[-1], path=outputs[-1]["final_path"])]]
            for bad in cases:
                with self.subTest(refs=bad), self.assertRaises(ValueError):
                    tool.submit_readiness(action["intent"], bad)
                self.untouched(owner, before, action)
                self.assertTrue(all(not Path(o["final_path"]).exists() for o in outputs))
            tool.complete(action["intent"])
            inspection = tool.inspect_action(action["intent"])
            self.assertEqual(inspection["state"], "confirmed")
            self.assertEqual(len(inspection["outputs"]), 3)

    def test_probe_aliases_and_existing_finals_are_not_adopted(self):
        for mode in ("symlink", "hardlink", "final"):
            with self.subTest(mode=mode), workflow_fixture("final-evidence-intent") as (f, owner, client, workflow, tool, action):
                output = action["submission"]["outputs"][0]
                source = f.root / "external-probe.json"
                publish_new(source, {"offline": True})
                ref = dict(file_ref(source), path=output["candidate_path"])
                if mode == "symlink":
                    Path(ref["path"]).symlink_to(source)
                elif mode == "hardlink":
                    os.link(source, ref["path"])
                else:
                    publish_new(Path(ref["path"]), pinned(file_ref(source)))
                    publish_new(Path(output["final_path"]), pinned(file_ref(source)))
                before = (dict(owner.attempted), set(owner.confirmations))
                with self.assertRaisesRegex(ValueError, "bootstrap_(candidate_.*forbidden|owner_output_unconfirmed)"):
                    tool.submit_readiness(action["intent"], [ref])
                self.untouched(owner, before, action)

    def test_probe_stem_collisions_fail_before_intent(self):
        with production(probe_names=["same.json", "same.txt"]) as (f, owner, identity, client, owner_ref):
            tool = RoleTool(f.control, client, "coordinator")
            try:
                before = dict(owner.attempted)
                with self.assertRaisesRegex(ValueError, "candidate_reserved_path"):
                    tool.action("final-evidence-intent", f.paths["final_readiness"])
                self.assertEqual(owner.attempted, before)
            finally:
                tool.close()

    def test_corruption_before_batch_admission_does_not_publish_any_output(self):
        with workflow_fixture("final-evidence-intent", probe_names=["a.json", "b.json"]) as (f, owner, client, workflow, tool, action):
            workflow.write_candidates(action)
            before = (dict(owner.attempted), set(owner.confirmations))
            original = client.commit_new
            def change(*args, **kwargs):
                Path(action["submission"]["outputs"][-1]["candidate_path"]).write_bytes(b"changed")
                return original(*args, **kwargs)
            with patch.object(client, "commit_new", side_effect=change), self.assertRaisesRegex(ValueError, "file_pin_changed"):
                tool.complete(action["intent"])
            self.untouched(owner, before, action)

    def test_partial_batch_is_inspected_read_only_and_never_replayed(self):
        with workflow_fixture("final-evidence-intent", probe_names=["a.json", "b.json"]) as (f, owner, client, workflow, tool, action):
            workflow.write_candidates(action)
            original = client.commit_new
            outputs = action["submission"]["outputs"]
            def lose_reply(*args, **kwargs):
                result = original(*args, **kwargs)
                if kwargs["target"] == outputs[0]["final_path"]:
                    raise TimeoutError("first probe reply lost")
                return result
            with patch.object(client, "commit_new", side_effect=lose_reply), self.assertRaises(TimeoutError):
                tool.complete(action["intent"])
            before = (dict(owner.attempted), set(owner.confirmations))
            with patch.object(client, "commit_new", side_effect=AssertionError("must not mutate")):
                result = tool.inspect_action(action["intent"])
                self.assertEqual(result["state"], "reconciliation_required")
                self.assertEqual(result["submission_record_status"], "confirmed")
                self.assertEqual(result["outputs"][0]["status"], "confirmed")
                self.assertFalse(result["retry_allowed"])
                with self.assertRaisesRegex(ValueError, "submission_requires_reconciliation"):
                    tool.complete(action["intent"])
            self.assertEqual((owner.attempted, owner.confirmations), before)
            self.assertFalse(Path(outputs[1]["final_path"]).exists())
            self.assertFalse(Path(action["result_path"]).exists())

    def test_submission_record_reply_loss_and_visible_unconfirmed_final_never_authorize_retry(self):
        with workflow_fixture("fields-intent") as (f, owner, client, workflow, tool, action):
            workflow.write_candidates(action)
            original = client.commit_new
            def lose_reply(*args, **kwargs):
                original(*args, **kwargs)
                raise TimeoutError("submission record reply lost")
            with patch.object(client, "commit_new", side_effect=lose_reply), self.assertRaises(TimeoutError):
                tool.complete(action["intent"])
            publish_new(Path(action["result_path"]), pinned(file_ref(action["submission"]["candidate_path"])))
            before = (dict(owner.attempted), set(owner.confirmations))
            with patch.object(client, "commit_new", side_effect=AssertionError("must not mutate")):
                result = tool.inspect_action(action["intent"])
                self.assertEqual(result["state"], "reconciliation_required")
                self.assertEqual(result["outputs"][0]["status"], "durability_unverified")
                self.assertFalse(result["retry_allowed"])
                with self.assertRaisesRegex(ValueError, "submission_requires_reconciliation"):
                    tool.complete(action["intent"])
            self.assertEqual((owner.attempted, owner.confirmations), before)

    def test_wrong_stage_and_legacy_operation_are_not_executed_or_upgraded(self):
        with production() as (f, owner, identity, client, owner_ref):
            tool = RoleTool(f.control, client, "coordinator")
            try:
                action = tool.action("final-evidence-intent", f.paths["final_readiness"])
                workflow = RoleWorkflow(f, identity, owner_ref)
                workflow.write_candidates(action)
                before = (dict(owner.attempted), set(owner.confirmations))
                with self.assertRaisesRegex(ValueError, "action_stage_mismatch"):
                    tool.complete(action["intent"])
                self.untouched(owner, before, action)
                intent, _ = tool.intent("caller-intent", "coordinator", [])
                raw = pinned(intent)
                with self.assertRaisesRegex(ValueError, "action_contract_mismatch"):
                    tool.complete(intent)
                self.assertEqual(pinned(intent), raw)
                self.assertFalse(Path(f.root / "control" / "caller-execute.json").exists())
            finally:
                tool.close()

    def test_inspection_after_stop_and_expiry_never_enters_execution_or_takes_writer_lock(self):
        with workflow_fixture("fields-intent") as (f, owner, client, workflow, tool, action):
            workflow.write_candidates(action)
            tool.complete(action["intent"])
            client.stop(f.control)
            f.base.clock += timedelta(hours=1)
            before = (dict(owner.attempted), set(owner.confirmations))
            # Keep the existing role writer lock held and forbid construction of
            # any execution tool: the actual returned CLI remains read-only.
            with patch("bootstrap_tool.RoleTool", side_effect=AssertionError("no execution adapter")):
                result = workflow.returned_command(action, "inspect_argv")
            self.assertEqual(result["state"], "confirmed")
            self.assertFalse(result["retry_allowed"])
            self.assertFalse(result["execution_authorized"])
            self.assertEqual((owner.attempted, owner.confirmations), before)
            self.assertFalse(owner.armed)

class NonExecutionRetryTests(unittest.TestCase):
    """A busy owner admitted nothing, so the same intent may be retried in place."""

    def authority(self, replies):
        from bootstrap_protocol import Confirmation
        from coordinator_io import digest

        class Stub:
            def __init__(self):
                self.calls = 0

            def query(self, control, target):
                return Confirmation(control, target, "confirmed")

            def commit_new(self, control, *, actor, target, raw, prerequisites, recheck):
                self.calls += 1
                outcome = replies[self.calls - 1]
                if outcome is not None:
                    raise outcome
                return Confirmation(control, {"path": target, "sha256": digest(raw)}, "confirmed")

        return Stub()

    def setUp(self):
        import tempfile
        self.temp = tempfile.TemporaryDirectory(prefix="s5-retry-")
        self.addCleanup(self.temp.cleanup)
        self.target = Path(self.temp.name) / "x.json"
        self.target.write_bytes(b"{}\n")

    def run_commit(self, authority, retry_seconds=5):
        from bootstrap_s5 import commit_confirmed
        return commit_confirmed(authority, "control", actor="operator", target=str(self.target),
                                raw=b"{}\n", prerequisites=[], recheck=lambda: None,
                                retry_seconds=retry_seconds)

    def test_busy_replies_are_retried_until_the_commit_lands(self):
        from observation_budget import ObservationBusy
        authority = self.authority([ObservationBusy(), ObservationBusy(), None])
        with patch("bootstrap_s5.time.sleep"):
            self.assertEqual(self.run_commit(authority)["path"], str(self.target))
        self.assertEqual(authority.calls, 3)

    def test_unknown_or_failed_commit_is_never_retried(self):
        for error in (ValueError("bootstrap_new_bytes_changed"), OSError("io")):
            with self.subTest(error=error):
                authority = self.authority([error, None])
                with self.assertRaises((ValueError, OSError)):
                    self.run_commit(authority)
                self.assertEqual(authority.calls, 1)

    def test_retry_budget_is_bounded(self):
        from observation_budget import ObservationBusy
        authority = self.authority([ObservationBusy()] * 3)
        with patch("bootstrap_s5.time.sleep"), self.assertRaises(ValueError):
            self.run_commit(authority, retry_seconds=-1)
        self.assertEqual(authority.calls, 1)


if __name__ == "__main__":
    unittest.main()

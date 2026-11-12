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
from bootstrap.test_bootstrap_production import production


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
            original = client.commit_batch
            def change(*args, **kwargs):
                Path(action["submission"]["outputs"][-1]["candidate_path"]).write_bytes(b"changed")
                return original(*args, **kwargs)
            with patch.object(client, "commit_batch", side_effect=change), self.assertRaisesRegex(ValueError, "file_pin_changed"):
                tool.complete(action["intent"])
            self.untouched(owner, before, action)

    def test_a_lost_batch_reply_is_inspected_read_only_and_never_replayed(self):
        """The record and every probe are one admission, so a lost reply cannot split them."""
        with workflow_fixture("final-evidence-intent", probe_names=["a.json", "b.json"]) as (f, owner, client, workflow, tool, action):
            workflow.write_candidates(action)
            original = client.commit_batch
            outputs = action["submission"]["outputs"]
            def lose_reply(*args, **kwargs):
                original(*args, **kwargs)
                raise TimeoutError("batch reply lost after the unit was admitted")
            with patch.object(client, "commit_batch", side_effect=lose_reply), self.assertRaises(TimeoutError):
                tool.complete(action["intent"])
            before = (dict(owner.attempted), set(owner.confirmations))
            with patch.object(client, "commit_batch", side_effect=AssertionError("must not mutate")):
                result = tool.inspect_action(action["intent"])
                # The unit landed whole, so the action is complete — and still not
                # retryable: a complete action is never re-submitted.
                self.assertEqual(result["state"], "confirmed")
                self.assertEqual(result["submission_record_status"], "confirmed")
                for item in result["outputs"]:
                    self.assertEqual(item["status"], "confirmed")
                self.assertFalse(result["retry_allowed"])
                with self.assertRaisesRegex(ValueError, "submission_requires_reconciliation"):
                    tool.complete(action["intent"])
            self.assertEqual((owner.attempted, owner.confirmations), before)
            # The unit is whole: nothing announces a probe that does not exist.
            for output in outputs:
                self.assertTrue(Path(output["final_path"]).exists())
            self.assertTrue(Path(action["result_path"]).exists())

    def test_the_fence_is_unchanged_by_a_visible_unconfirmed_final(self):
        """A hand-written output never turns a recorded submission into a retry."""
        with workflow_fixture("fields-intent") as (f, owner, client, workflow, tool, action):
            workflow.write_candidates(action)
            original = client.commit_batch
            def lose_reply(*args, **kwargs):
                original(*args, **kwargs)
                raise TimeoutError("submission reply lost")
            with patch.object(client, "commit_batch", side_effect=lose_reply), self.assertRaises(TimeoutError):
                tool.complete(action["intent"])
            Path(action["result_path"]).write_bytes(b"hand written\n")
            before = (dict(owner.attempted), set(owner.confirmations))
            with patch.object(client, "commit_batch", side_effect=AssertionError("must not mutate")):
                result = tool.inspect_action(action["intent"])
                # Overwriting a confirmed output is a pin change, not a new intent.
                self.assertEqual(result["state"], "reconciliation_required")
                self.assertEqual(result["outputs"][0]["status"], "durability_unverified")
                self.assertFalse(result["retry_allowed"])
                with self.assertRaisesRegex(ValueError, "submission_requires_reconciliation"):
                    tool.complete(action["intent"])
            self.assertEqual((owner.attempted, owner.confirmations), before)

    def test_a_batch_runs_the_same_per_target_admission_as_a_single_commit(self):
        """`commit_new` calls `admit_target` per target; a batch must not bypass it."""
        from bootstrap_control import CommitOwner

        with production() as (f, owner, identity, client, _):
            identity.actor = "operator"
            target = str(f.root.parent / "lifecycle" / "spec.json")
            (f.root.parent / "lifecycle").mkdir(mode=0o700, exist_ok=True)
            admit_target = CommitOwner.admit_target
            seen = []

            def record(self, control, actor, path, raw):
                seen.append(path)
                return admit_target(self, control, actor, path, raw)

            with patch.object(CommitOwner, "admit_target", record), \
                    self.assertRaises(ValueError):
                # Any refusal is fine; the invariant is that admission ran per target.
                client.commit_batch(f.control, actor="operator",
                                    entries=[(target, b"{}\n"), (str(f.root / "control" / "probe.json"), b"{}\n")],
                                    prerequisites=[], recheck=lambda: None)
            self.assertIn(target, seen)

    def test_a_probe_output_written_between_validation_and_admission_still_refuses(self):
        """The owner-side recheck must see the probe outputs, not the caller's snapshot."""
        with workflow_fixture("final-evidence-intent", probe_names=["a.json", "b.json"]) as (f, owner, client, workflow, tool, action):
            workflow.write_candidates(action)
            outputs = action["submission"]["outputs"]
            original = client.commit_batch

            def write_then_commit(*args, **kwargs):
                Path(outputs[0]["final_path"]).write_bytes(b"raced\n")
                return original(*args, **kwargs)

            with patch.object(client, "commit_batch", side_effect=write_then_commit), \
                    self.assertRaisesRegex(ValueError, "bootstrap_owner_output_unconfirmed"):
                tool.complete(action["intent"])
            self.assertFalse(Path(outputs[1]["final_path"]).exists())

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

    def authority(self, replies, queries=None):
        from bootstrap_protocol import Confirmation
        from coordinator_io import digest

        class Stub:
            def __init__(self):
                self.calls = 0
                self.queries = list(queries or [])

            def query(self, control, target):
                if self.queries:
                    outcome = self.queries.pop(0)
                    if outcome is not None:
                        raise outcome
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

    def test_rpc_prefixed_non_execution_codes_are_retried(self):
        # The owner rejects a mutation as bootstrap_rpc_rejected:<code>, so the
        # bare exception classes never reach the client on that path.
        for code in ("bootstrap_owner_busy_not_executed", "bootstrap_native_identity_timeout",
                     "bootstrap_identity_snapshot_expired"):
            with self.subTest(code=code):
                authority = self.authority([ValueError("bootstrap_rpc_rejected:" + code), None])
                with patch("bootstrap_s5.time.sleep"):
                    self.assertEqual(self.run_commit(authority)["path"], str(self.target))
                self.assertEqual(authority.calls, 2)

    def test_reconciliation_codes_are_never_retried(self):
        for code in ("bootstrap_commit_requires_reconciliation",
                     "bootstrap_tool_timeout_requires_reconciliation",
                     "bootstrap_role_or_path_mismatch", "bootstrap_new_bytes_changed"):
            with self.subTest(code=code):
                authority = self.authority([ValueError("bootstrap_rpc_rejected:" + code), None])
                with self.assertRaises(ValueError):
                    self.run_commit(authority)
                self.assertEqual(authority.calls, 1)

    def test_confirmation_after_commit_never_recommits(self):
        # The bytes are already admitted, so only the read-only confirmation may
        # be retried; re-entering commit_new would report a reconciliation error
        # for work that actually landed.
        from observation_budget import ObservationBusy
        authority = self.authority([None], queries=[ObservationBusy(), ObservationBusy(), None])
        with patch("bootstrap_s5.time.sleep"):
            self.assertEqual(self.run_commit(authority)["path"], str(self.target))
        self.assertEqual(authority.calls, 1)
        self.assertEqual(authority.queries, [])

    def test_exhausted_confirmation_reports_an_unknown_outcome(self):
        from observation_budget import ObservationBusy
        from bootstrap_s5 import CONFIRMATION_PENDING
        authority = self.authority([None], queries=[ObservationBusy()] * 4)
        with patch("bootstrap_s5.time.sleep"), self.assertRaises(ValueError) as caught:
            self.run_commit(authority, retry_seconds=-1)
        self.assertEqual(str(caught.exception), CONFIRMATION_PENDING)
        self.assertEqual(authority.calls, 1)



class AdvanceLoopTests(unittest.TestCase):
    """The loop shape: one mechanical step, then stop at the judgement boundary."""

    def tool(self, pulls, markers=()):
        from bootstrap_tool import RoleTool
        tool = object.__new__(RoleTool)
        tool.actor = "operator"
        tool.pull = lambda timeout: pulls.pop(0)
        tool.local_check = lambda: {"validated_markers": list(markers)}
        tool.submission = lambda name: {"outputs": [{"candidate_path": "/not-authored"}]}
        tool.completed = []
        tool.complete = lambda intent: (tool.completed.append(intent["path"]),
                                       {"path": "/committed", "sha256": "z"})[1]
        return tool

    def action(self, name, path):
        return {"state": "action", "action": name, "intent": {"path": path, "sha256": "x"}}

    def test_completes_a_mechanical_step_then_stops_at_judgement(self):
        tool = self.tool([self.action("observe-intent", "/i1"),
                          self.action("fields-intent", "/i2")])
        result = tool.advance(timeout=5, poll=1)
        self.assertEqual(result["state"], "needs_role_judgement")
        self.assertEqual(tool.completed, ["/i1"])
        self.assertEqual([step["action"] for step in result["steps"]], ["observe-intent"])
        self.assertFalse(result["execution_authorized"])

    def test_never_completes_a_submit_stage_without_an_authored_candidate(self):
        tool = self.tool([self.action("contract-intent", "/i1")])
        self.assertEqual(tool.advance(timeout=5, poll=1)["state"], "needs_role_judgement")
        self.assertEqual(tool.completed, [])

    def test_reconciliation_required_stops_before_any_commit(self):
        tool = self.tool([{"state": "reconciliation_required", "action": "observe-intent",
                           "intent": {"path": "/i1", "sha256": "x"}}])
        self.assertEqual(tool.advance(timeout=5, poll=1)["state"], "reconciliation_required")
        self.assertEqual(tool.completed, [])

    def test_stage_boundary_returns_before_pulling(self):
        tool = self.tool([], markers=[0, 1, 2])
        self.assertEqual(tool.advance(until_stage=2, timeout=5)["state"], "stage_reached")

    def test_pending_pull_is_not_permission(self):
        tool = self.tool([{"state": "pending", "reason": "waiting_stage"}])
        self.assertEqual(tool.advance(timeout=5, poll=1)["state"], "pending")
        self.assertEqual(tool.completed, [])


class AdvanceDecisionTests(unittest.TestCase):
    """A bounded advance may only complete what the tool itself would produce."""

    class Spec:
        def __init__(self, mode):
            self.mode = mode

    def decide(self, result, *, candidates=False):
        from bootstrap_tool import advance_decision
        modes = {"caller-intent": "produce", "observe-intent": "produce",
                 "fields-intent": "submit", "contract-intent": "submit",
                 "readiness-intent": "submit", "final-evidence-intent": "readiness"}
        return advance_decision(result, spec_of=lambda name: self.Spec(modes[name]),
                                candidates_exist=lambda name: candidates)

    def test_stage_boundaries_and_pending_are_not_permission(self):
        for result in ({}, {"state": "pending", "reason": "waiting_stage"},
                       {"state": "request_ready"}, {"state": "s5_ready"}):
            with self.subTest(result=result):
                self.assertEqual(self.decide(result), "stop")

    def test_reconciliation_required_never_advances(self):
        self.assertEqual(self.decide({"state": "reconciliation_required",
                                      "action": "caller-intent"}), "stop-reconciliation")

    def test_only_mechanical_produce_actions_are_completed(self):
        for name in ("caller-intent", "observe-intent"):
            self.assertEqual(self.decide({"state": "action", "action": name}), "complete")

    def test_submit_stages_stop_until_the_role_authored_the_candidate(self):
        for name in ("fields-intent", "contract-intent", "readiness-intent",
                     "final-evidence-intent"):
            with self.subTest(name=name):
                self.assertEqual(self.decide({"state": "action", "action": name}),
                                 "stop-judgement")
                self.assertEqual(self.decide({"state": "action", "action": name}, candidates=True),
                                 "complete")

    def test_unknown_action_stops(self):
        self.assertEqual(self.decide({"state": "action", "action": "made-up"}), "stop-judgement")


if __name__ == "__main__":
    unittest.main()

"""Shared contract only: no provider, native runtime, domain checker or process."""
import copy
import unittest

from coordinator_loop import checkpoint_route, phase_contract, transition


class LoopTests(unittest.TestCase):
    def test_both_strict_launch_modes_keep_business_task_separate_from_recovery(self):
        for phase in ("strict-bootstrap", "strict-tui-bootstrap"):
            text = phase_contract(phase)
            self.assertNotIn("input schema v3", text)
            for rule in ("input schema v4", "task_source pin", "contract_fields pin", "separate recovery_note",
                         "never replace the business objective with a recovery substep"):
                with self.subTest(phase=phase, rule=rule):
                    self.assertIn(rule, text)

    def test_tui_turns_yield_before_expiry_without_inline_self_consumption(self):
        text = phase_contract("strict-tui-bootstrap")
        for rule in ("coordinator_tui_continue.py check", "checkpoint_by", "do not consume its own continuation inline",
                     "unchanged startup pins", "empty model turns", "stop and preserve the gap",
                     "--action-seconds", "false action_allowed", "coordinator_tui_continue.py turn-end",
                     "process the whole Delivery", "then ack its deliveryId"):
            self.assertIn(rule, text)

    def test_scheduler_duplicate_wakeup_keeps_journal_and_requires_current_turn_audit(self):
        text = phase_contract("strict-tui-bootstrap")
        for rule in ("Before ending every schema v2 turn", "check alone does not",
                     "Initialize only once", "duplicate initialization messages",
                     "not create a new journal", "never rewrite timestamps",
                     "without sending repeated initialization reminders"):
            self.assertIn(rule, text)
        self.assertNotIn("turn-end is optional audit", text)

    def fixture(self, domain="software", statuses=("actionable", "actionable")):
        names = {"software": ("fix", "review"), "data-audit": ("inventory", "sample")}[domain]
        specs = [dict(id=k, acceptance="verified " + k, evidence_kind="artifact") for k in names]
        contract = dict(requirements=specs)
        record = dict(requirements=[], paths=[], barriers=[], next_action=None)
        for spec, status in zip(specs, statuses):
            key = spec["id"]
            record["requirements"].append(dict(spec, status=status, path_review_ref="review/" + key,
                evidence=[dict(kind="artifact", ref="evidence/" + key)] if status == "met" else []))
            if status == "met":
                continue
            record["paths"].append(dict(id=key, requirement_id=key, operation="perform " + key,
                                       status=status, barrier_id=key if status != "actionable" else None))
            if status in {"waiting", "blocked"}:
                record["barriers"].append(dict(id=key, path_ids=[key], condition="dependency changes",
                    evidence_refs=["native/" + key], alternatives_ref="alternatives/" + key))
        decision = ("continue" if "actionable" in statuses else "wait" if "waiting" in statuses
                    else "blocked" if "blocked" in statuses else "complete")
        record["decision"] = decision
        if decision in {"continue", "wait"}:
            status = "actionable" if decision == "continue" else "waiting"
            key = names[statuses.index(status)]
            record["next_action"] = dict(id="action-" + key, owner="coordinator",
                kind="implement" if decision == "continue" else "wait", path_ids=[key],
                deliverables=["evidence/" + key], validation="verify " + key)
        return contract, record

    def test_two_business_actions_without_operator_replanning_in_two_domains(self):
        for domain in ("software", "data-audit"):
            with self.subTest(domain=domain):
                contract, first = self.fixture(domain)
                _, second = self.fixture(domain, ("met", "actionable"))
                _, last = self.fixture(domain, ("met", "met"))
                actions = []
                for before, after in ((first, second), (second, last)):
                    route = checkpoint_route(before, contract)
                    self.assertEqual((route.kind, route.owner), ("coordinator_turn", "coordinator"))
                    actions.append(before["next_action"]["id"])
                    transition(before, after, {"status": "executed"}, {"new-content"})
                self.assertEqual(len(set(actions)), 2)
                self.assertEqual(checkpoint_route(last, contract).kind, "acceptance_review")

    def test_local_blocker_does_not_override_independent_work(self):
        contract, record = self.fixture(statuses=("blocked", "actionable"))
        self.assertEqual(checkpoint_route(record, contract).kind, "coordinator_turn")
        for decision in ("wait", "blocked", "complete"):
            with self.subTest(decision=decision):
                record["decision"] = decision
                with self.assertRaisesRegex(ValueError, "conflicts_with_remaining_work"):
                    checkpoint_route(record, contract)

    def test_wait_precedes_local_blocker_and_needs_boundary_evidence(self):
        contract, record = self.fixture(statuses=("blocked", "waiting"))
        self.assertEqual(checkpoint_route(record, contract).kind, "dependency_wait")
        for field in ("condition", "evidence_refs", "path_ids"):
            broken = copy.deepcopy(record)
            broken["barriers"][1].pop(field)
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "boundary_evidence_missing"):
                checkpoint_route(broken, contract)

    def test_wait_cannot_relabel_a_continue_action(self):
        contract, record = self.fixture(statuses=("waiting", "met"))
        record["next_action"]["kind"] = "implement"
        with self.assertRaisesRegex(ValueError, "next_action_decision_mismatch"):
            checkpoint_route(record, contract)

    def test_blocked_is_review_claim_not_independent_acceptance(self):
        contract, record = self.fixture(statuses=("blocked", "blocked"))
        route = checkpoint_route(record, contract)
        self.assertEqual((route.decision, route.kind, route.owner), ("blocked", "alternatives_review", None))

    def test_marker_or_report_never_becomes_a_decision(self):
        contract, record = self.fixture()
        record.update(marker="WAVE1_RESULTS_READY", report="final report", process_exit=0)
        self.assertEqual(checkpoint_route(record, contract).decision, "continue")
        for decision in (None, "WAVE1_RESULTS_READY", "continue_wave2", "final", "COMPLETE", []):
            with self.subTest(decision=decision), self.assertRaisesRegex(ValueError, "invalid_checkpoint_decision"):
                checkpoint_route(dict(record, decision=decision), contract)

    def test_original_acceptance_cannot_be_removed_or_relaxed(self):
        contract, record = self.fixture(statuses=("met", "met"))
        for mode in ("remove", "relax", "duplicate", "empty-evidence"):
            broken = copy.deepcopy(record)
            if mode == "remove":
                broken["requirements"].pop()
            elif mode == "relax":
                broken["requirements"][0]["acceptance"] = "workers finished"
            elif mode == "duplicate":
                broken["requirements"].append(broken["requirements"][0])
            else:
                broken["requirements"][0]["evidence"] = []
            with self.subTest(mode=mode), self.assertRaises(ValueError):
                checkpoint_route(broken, contract)

    def test_one_shot_report_ends_at_its_original_acceptance(self):
        contract = {"requirements": [{"id": "report", "acceptance": "one reviewed report"}]}
        record = dict(requirements=[dict(contract["requirements"][0], status="met",
                      evidence=[dict(kind="artifact", ref="reviewed-report")])],
                      paths=[], barriers=[], decision="complete", next_action=None)
        self.assertEqual(checkpoint_route(record, contract).kind, "acceptance_review")

    def test_continue_needs_action_with_deliverable_validation_and_ready_target(self):
        contract, record = self.fixture(statuses=("blocked", "actionable"))
        for update in ({"id": ""}, {"owner": ""}, {"deliverables": []}, {"validation": ""},
                       {"path_ids": []}, {"path_ids": ["unknown"]}, {"path_ids": ["fix"]},
                       {"path_ids": ["fix", "review"]}):
            broken = copy.deepcopy(record)
            broken["next_action"].update(update)
            with self.subTest(update=update), self.assertRaises(ValueError):
                checkpoint_route(broken, contract)

    def test_unsupported_executor_preserves_business_decision_and_input(self):
        contract, record = self.fixture()
        record["next_action"]["owner"] = "unknown-owner"
        original = copy.deepcopy(record)
        route = checkpoint_route(record, contract)
        self.assertEqual((route.decision, route.kind), ("continue", "unsupported_executor"))
        self.assertEqual(record, original)

    def test_operator_receives_specific_action_not_business_control(self):
        contract, record = self.fixture()
        record["next_action"]["owner"] = "outer-operator"
        route = checkpoint_route(record, contract)
        self.assertEqual((route.decision, route.kind), ("continue", "operator_handoff"))

    def test_no_progress_cannot_advance_action_or_acceptance(self):
        _, before = self.fixture()
        transition(before, copy.deepcopy(before), {"status": "no_progress"}, set())
        after = copy.deepcopy(before)
        after["next_action"]["id"] = "another-plan"
        with self.assertRaisesRegex(ValueError, "action_advanced_without_execution"):
            transition(before, after, {"status": "no_progress"}, set())
        _, after = self.fixture(statuses=("met", "met"))
        with self.assertRaisesRegex(ValueError, "remaining_path_disappeared"):
            transition(before, after, {"status": "no_progress"}, set())

    def test_real_action_cannot_hide_unrelated_ready_work(self):
        _, before = self.fixture()
        _, after = self.fixture(statuses=("actionable", "blocked"))
        with self.assertRaisesRegex(ValueError, "independent_path_silently_blocked"):
            transition(before, after, {"status": "executed"}, {"content"})

    def test_immutable_fields_preserve_json_types(self):
        contract, record = self.fixture()
        contract["requirements"][0]["minimum_samples"] = 1
        record["requirements"][0]["minimum_samples"] = True
        with self.assertRaisesRegex(ValueError, "acceptance_requirements_changed"):
            checkpoint_route(record, contract)
        _, before = self.fixture()
        before["next_action"]["parameters"] = {"count": 1}
        after = copy.deepcopy(before)
        after["next_action"]["parameters"]["count"] = True
        with self.assertRaisesRegex(ValueError, "action_advanced_without_execution"):
            transition(before, after, {"status": "no_progress"}, set())

    def test_distinct_phase_contracts_and_unknown_phase_rejection(self):
        for phase in ("bootstrap", "recovery", "run", "closeout"):
            text = phase_contract(phase)
            self.assertIn("Phase: " + phase + ".", text)
            self.assertIn("one-shot", text)
            for other in {"bootstrap", "recovery", "run", "closeout"} - {phase}:
                self.assertNotIn("Phase: " + other + ".", text)
        self.assertNotIn("MUST NOT dispatch", phase_contract("run"))
        with self.assertRaisesRegex(ValueError, "unsupported_coordinator_phase"):
            phase_contract("wave1")

    def test_strict_phase_routes_later_waves_without_replaying_startup(self):
        text = phase_contract("strict-bootstrap")
        self.assertIn("one-time phase boundaries, not per-wave checks", text)
        self.assertIn("Never replay a started attempt", text)
        self.assertIn("identity/owner/generation and progress checks", text)
        self.assertIn("strict-v1 has no supported shell resume", text)
        self.assertIn("strict-config-plan / strict-config-wait", text)
        self.assertIn("source-to-snapshot mappings", text)
        self.assertIn("not a supported follow-up channel", text)

    def test_dispatch_phases_use_the_fixed_worker_plan_entry(self):
        from pathlib import Path
        import coordinator_launch
        helper = str(Path(coordinator_launch.__file__).resolve())
        for phase in ("run", "recovery", "strict-bootstrap", "strict-tui-bootstrap"):
            with self.subTest(phase=phase):
                text = phase_contract(phase)
                self.assertIn(helper, text)
                self.assertIn("worker-plan --request", text)
                self.assertIn("choose only model", text)
                self.assertIn("Operator-reviewed profiles_sha256", text)
                self.assertIn("never agent/effort/backend_variant", text)
                self.assertIn("argv unchanged", text)
                self.assertIn("task_title with spec", text)
                self.assertIn("first-dispatch helper argv, never a raw worker-start", text)
                self.assertIn("later waves omit first_dispatch", text)
        self.assertNotIn("worker-plan", phase_contract("bootstrap"))


if __name__ == "__main__":
    unittest.main()

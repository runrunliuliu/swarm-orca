"""Local claim/return integration; all native/model operations use the driver fixture."""

from contextlib import redirect_stdout
import copy
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch

import coordinator_driver as driver
import coordinator_handoff as handoff
from coordinator_io import publish_new
import coordinator.test_coordinator_driver as fixtures


class HandoffTests(unittest.TestCase):
    def setUp(self):
        self.f = fixtures.DriverTests()
        self.f.setUp()
        self.addCleanup(self.f.doCleanups)
        self.record = self.f.checkpoint("continue", self.f.start + fixtures.timedelta(seconds=1))
        self.record["next_action"]["owner"] = "outer-operator"
        self.f.initial(self.record)

    def prepare(self, config, journal):
        if journal.data["current"] is None:
            driver.initialize(config, journal, self.f.snapshot)
        action = driver.obligation(config, journal.data["current"]["checkpoint"], self.record,
                                   journal.data["attempts"] + 1, executor="outer-operator")
        return handoff.prepare(config, journal, action)

    def report(self, status="executed"):
        evidence = self.f.cwd / "operator-evidence.json"
        self.f.write(evidence, {"platform_observation": "fixture", "status": status})
        target = self.f.root / "operator-report.json"
        self.f.write(target, {"status": status, "evidence": [driver.file_ref(evidence)]})
        return driver.file_ref(target)

    def accept(self, config, entry):
        return handoff.accept(config, entry, "submit-operator", skills_read=True)

    def returned(self, config, entry, status="executed"):
        accepted = self.accept(config, entry)
        return handoff.return_result(config, entry, "submit-operator", accepted["sha256"], self.report(status))

    def cli(self, config, *args):
        output = io.StringIO()
        with redirect_stdout(output):
            code = driver.main(["--config", config.filename, "--config-sha256", config.sha256, *args])
        return code, json.loads(output.getvalue())

    def test_handoff_waits_without_model_then_reviews_before_research_resumes(self):
        self.f.script = [{"artifact": "independent operator evidence review"},
                         {"artifact": "business result", "decision": "complete"}]
        polls = []
        with self.f.journal() as (config, journal):
            def wait(_):
                self.assertEqual(self.f.captured, [])
                self.assertIsNone(journal.data["outcome"])
                polls.append(True)
                entry = next(iter(journal.data["operator_requests"].values()))
                if len(polls) == 2:
                    self.accept(config, entry)
                elif len(polls) == 3:
                    _, refs, _ = handoff.observe(config, entry)
                    handoff.return_result(config, entry, "submit-operator",
                                          refs["acceptance"]["sha256"], self.report())
            self.assertEqual(self.f.run_driver(config, journal, sleep=wait),
                             "complete_pending_independent_acceptance")
            self.assertEqual(len(polls), 3)
            self.assertEqual(journal.data["attempts"], 2)
            self.assertEqual(len(journal.data["operator_requests"]), 1)
            first = driver.read_json(config.root / "turn-000001/action-receipt.json")
            self.assertEqual(first["action"]["mode"], "review_operator_result")
            self.assertEqual(first["action"]["operator_result"], first["operator_handoff"]["result"])
            second = driver.read_json(config.root / "turn-000002/action-receipt.json")
            self.assertIsNone(second["operator_handoff"])
            self.assertNotIn("mode", second["action"])

    def test_planning_only_review_reuses_result_and_does_not_reset_guard(self):
        self.f.script = [{"record": copy.deepcopy(self.record)}, {"record": copy.deepcopy(self.record)}]
        with self.f.journal() as (config, journal):
            entry = self.prepare(config, journal)
            returned = self.returned(config, entry)
            self.assertEqual(self.f.run_driver(config, journal, sleep=lambda _: self.fail("already returned")),
                             "no_progress_recovery_exhausted")
            self.assertEqual(journal.data["no_progress_turns"], 2)
            self.assertEqual(journal.data["seen_progress"], [])
            self.assertEqual(len(journal.data["operator_requests"]), 1)
            for target in config.root.glob("turn-*/action-receipt.json"):
                self.assertEqual(driver.read_json(target)["action"]["operator_result"], returned)

    def test_unknown_outcome_is_latched_without_review_or_replay(self):
        config = self.f.config()
        with self.f.journal(config) as (_, journal):
            self.returned(config, self.prepare(config, journal), "unknown")
            self.assertEqual(self.f.run_driver(config, journal), "operator_outcome_unknown_requires_reconciliation")
        with self.f.journal(config) as (_, journal):
            self.assertEqual(self.f.run_driver(config, journal), "operator_outcome_unknown_requires_reconciliation")
        self.assertEqual(self.f.captured, [])

    def test_interrupted_wait_resumes_same_claim_not_a_new_execution(self):
        config = self.f.config()
        with self.f.journal(config) as (_, journal):
            entry = self.prepare(config, journal)
            accepted = self.accept(config, entry)
            with self.assertRaises(KeyboardInterrupt):
                self.f.run_driver(config, journal, sleep=lambda _: (_ for _ in ()).throw(KeyboardInterrupt()))
            self.assertIsNone(journal.data["pending"])
            self.assertIsNone(journal.data["outcome"])
        self.f.script = [{"artifact": "review and result", "decision": "complete"}]
        with self.f.journal(config) as (_, journal):
            def wait(_):
                restored = next(iter(journal.data["operator_requests"].values()))
                self.assertEqual(restored["acceptance"], accepted)
                handoff.return_result(config, restored, "submit-operator", accepted["sha256"], self.report())
            self.assertEqual(self.f.run_driver(config, journal, sleep=wait),
                             "complete_pending_independent_acceptance")
            self.assertEqual(len(journal.data["operator_requests"]), 1)

    def test_claim_requires_named_operator_and_explicit_read_declaration(self):
        with self.f.journal() as (config, journal):
            entry = self.prepare(config, journal)
            for actor, read, error in (("other", True, "operator_identity_mismatch"),
                                       ("submit-operator", False, "operator_skill_read_confirmation_required")):
                with self.subTest(actor=actor, read=read), self.assertRaisesRegex(ValueError, error):
                    handoff.accept(config, entry, actor, skills_read=read)
            self.assertEqual(handoff.observe(config, entry)[0], "awaiting_operator_acceptance")

    def test_operator_config_is_required_and_strict(self):
        for value in (None, False, {}, {"id": ""}, {"id": 1}, {"id": "two operators"},
                      {"id": "submit-operator", "command": "ignored"}):
            self.f.config_data["outer_operator"] = value
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "invalid_outer_operator"):
                self.f.config()
        del self.f.config_data["outer_operator"]
        with self.assertRaisesRegex(ValueError, "invalid_driver_config"):
            self.f.config()
        self.assertFalse((self.f.archive / "coordinator-driver").exists())

    def test_external_wait_can_be_handed_off_without_fake_native_dispatch(self):
        self.record = self.f.checkpoint("wait", self.f.start + fixtures.timedelta(seconds=1))
        self.record["next_action"]["owner"] = "outer-operator"
        self.f.initial(self.record)
        self.f.script = [{"artifact": "review of completed external wait", "decision": "complete"}]
        with self.f.journal() as (config, journal):
            def wait(_):
                self.assertEqual(self.f.captured, [])
                self.returned(config, next(iter(journal.data["operator_requests"].values())))
            self.assertEqual(self.f.run_driver(config, journal, sleep=wait),
                             "complete_pending_independent_acceptance")
            self.assertEqual(journal.data["attempts"], 1)

    def test_exclusive_claim_never_overwrites_first_claim(self):
        with self.f.journal() as (config, journal):
            entry = self.prepare(config, journal)
            ref = self.accept(config, entry)
            with self.assertRaisesRegex(ValueError, "operator_action_already_claimed"):
                self.accept(config, entry)
            self.assertEqual(driver.file_ref(Path(ref["path"])), ref)

    def test_return_requires_exact_acceptance_and_actual_evidence(self):
        with self.f.journal() as (config, journal):
            entry = self.prepare(config, journal)
            accepted = self.accept(config, entry)
            report = self.report()
            with self.assertRaisesRegex(ValueError, "operator_acceptance_mismatch"):
                handoff.return_result(config, entry, "submit-operator", "0" * 64, report)
            self.f.write(Path(report["path"]), {"status": "executed", "evidence": []})
            with self.assertRaisesRegex(ValueError, "operator_execution_evidence_required"):
                handoff.return_result(config, entry, "submit-operator", accepted["sha256"],
                                      driver.file_ref(Path(report["path"])))

    def test_duplicate_return_never_replaces_original_result(self):
        with self.f.journal() as (config, journal):
            entry = self.prepare(config, journal)
            original = self.returned(config, entry)
            _, refs, _ = handoff.observe(config, entry)
            with self.assertRaisesRegex(ValueError, "operator_result_not_expected"):
                handoff.return_result(config, entry, "submit-operator", refs["acceptance"]["sha256"],
                                      driver.file_ref(self.f.root / "operator-report.json"))
            self.assertEqual(driver.file_ref(Path(original["path"])), original)

    def test_not_executed_return_is_not_failed_or_successful_execution(self):
        with self.f.journal() as (config, journal):
            entry = self.prepare(config, journal)
            accepted = self.accept(config, entry)
            target = self.f.root / "not-executed.json"
            self.f.write(target, {"status": "not_executed", "evidence": []})
            handoff.return_result(config, entry, "submit-operator", accepted["sha256"], driver.file_ref(target))
            status, _, report = handoff.observe(config, entry)
            self.assertEqual(status, "operator_result_ready")
            self.assertEqual(report["status"], "not_executed")
            self.assertEqual(journal.data["seen_progress"], [])

    def test_changed_accepted_receipt_is_not_accepted_after_driver_observed_it(self):
        with self.f.journal() as (config, journal):
            entry = self.prepare(config, journal)
            ref = self.accept(config, entry)
            handoff.poll(config, journal, entry)
            self.f.write(Path(ref["path"]), {})
            with self.assertRaisesRegex(ValueError, "file_pin_changed"):
                handoff.poll(config, journal, entry)

    def test_cross_action_result_replay_and_missing_acceptance_are_rejected(self):
        with self.f.journal() as (config, journal):
            entry = self.prepare(config, journal)
            ref = self.returned(config, entry)
            result = driver.read_json(ref["path"])
            result["request"] = {"path": "other", "sha256": "0" * 64}
            self.f.write(Path(ref["path"]), result)
            with self.assertRaisesRegex(ValueError, "operator_result_mismatch"):
                handoff.observe(config, entry)
            Path(ref["path"]).with_name("accepted.json").unlink()
            with self.assertRaisesRegex(ValueError, "operator_result_without_acceptance"):
                handoff.observe(config, entry)

    def test_result_cannot_use_control_files_or_outside_scope_as_evidence(self):
        with self.f.journal() as (config, journal):
            entry = self.prepare(config, journal)
            for ref in (entry["request"], driver.file_ref(self.f.brief), driver.file_ref(self.f.skill)):
                with self.subTest(ref=ref), self.assertRaisesRegex(ValueError, "progress_artifact_outside_scope"):
                    handoff.validate_report(config, {"status": "executed", "evidence": [ref]})

    def test_outside_scope_is_rejected_before_reading_contents(self):
        with self.f.journal() as (config, _):
            ref = driver.file_ref(self.f.brief)
            with patch("coordinator_io.pinned", side_effect=AssertionError("must not read outside scope")):
                with self.assertRaisesRegex(ValueError, "progress_artifact_outside_scope"):
                    handoff.validate_report(config, {"status": "executed", "evidence": [ref]})

    def test_symlink_receipt_is_not_observed_or_overwritten(self):
        with self.f.journal() as (config, journal):
            entry = self.prepare(config, journal)
            target = Path(entry["request"]["path"]).with_name("accepted.json")
            target.symlink_to(self.f.brief)
            with self.assertRaisesRegex(ValueError, "canonical_nonsymlink_path_required"):
                handoff.observe(config, entry)
            with self.assertRaisesRegex(ValueError, "operator_action_already_claimed"):
                self.accept(config, entry)
            self.assertTrue(target.is_symlink())

    def test_claim_cli_checks_native_identity_without_coordinator_pty_or_execution(self):
        with self.f.journal() as (config, journal):
            entry = self.prepare(config, journal)
            with patch.object(driver, "observe_binding", return_value=self.f.snapshot) as fence, \
                    patch.object(driver, "live_fence", side_effect=AssertionError("not the Coordinator")):
                code, result = self.cli(config, "--accept-handoff", entry["request"]["sha256"],
                                        "--operator-id", "submit-operator", "--confirm-skill-read")
            self.assertEqual(code, 0)
            self.assertEqual(result["status"], "operator_action_claimed_not_executed")
            fence.assert_called_once()
            self.assertFalse(self.f.captured)

    def test_cli_status_is_read_only_and_claim_denial_creates_no_acceptance(self):
        with self.f.journal() as (config, journal):
            entry = self.prepare(config, journal)
            before = driver.file_ref(config.root / "state.json")
            with patch.object(driver, "observe_binding", side_effect=driver.progress_watch.StopObservation("runtime_access_denied")):
                code, status = self.cli(config, "--handoff-status")
                self.assertEqual((code, status["status"]), (0, "awaiting_operator_acceptance"))
                code, status = self.cli(config, "--accept-handoff", entry["request"]["sha256"],
                                        "--operator-id", "submit-operator", "--confirm-skill-read")
            self.assertEqual((code, status["reason"]), (2, "runtime_access_denied"))
            self.assertEqual(driver.file_ref(config.root / "state.json"), before)
            self.assertEqual(handoff.observe(config, entry)[0], "awaiting_operator_acceptance")

    def test_stop_pending_and_outcome_prevent_claim_before_native_queries(self):
        with self.f.journal() as (config, journal):
            entry = self.prepare(config, journal)
            for blocker in ("STOP", "pending", "outcome"):
                if blocker == "STOP":
                    self.f.write(config.root / "STOP", "operator stop")
                else:
                    journal.data[blocker] = {} if blocker == "pending" else "operator_stop"
                    journal.save()
                with self.subTest(blocker=blocker), patch.object(driver, "observe_binding",
                        side_effect=AssertionError("no native query when claim is blocked")):
                    code, result = self.cli(config, "--accept-handoff", entry["request"]["sha256"],
                                            "--operator-id", "submit-operator", "--confirm-skill-read")
                    self.assertEqual((code, result["reason"]), (2, "operator_claim_not_allowed"))
                if blocker == "STOP":
                    (config.root / "STOP").unlink()
                else:
                    journal.data[blocker] = None
                    journal.save()
            self.assertEqual(handoff.observe(config, entry)[0], "awaiting_operator_acceptance")

    def test_state_change_or_unfinished_save_before_claim_prevents_acceptance(self):
        with self.f.journal() as (config, journal):
            entry = self.prepare(config, journal)
            for incomplete in (False, True):
                def fence(_):
                    if incomplete:
                        self.f.write(config.root / "state.next.json", journal.data)
                    else:
                        journal.stop("operator_stop")
                    return self.f.snapshot
                with self.subTest(incomplete=incomplete), patch.object(driver, "observe_binding", side_effect=fence):
                    code, result = self.cli(config, "--accept-handoff", entry["request"]["sha256"],
                                            "--operator-id", "submit-operator", "--confirm-skill-read")
                    self.assertEqual((code, result["reason"]), (2, "operator_request_changed_before_claim"))
                if incomplete:
                    (config.root / "state.next.json").unlink()
                journal.data["outcome"] = None
                journal.save()
            self.assertEqual(handoff.observe(config, entry)[0], "awaiting_operator_acceptance")

    def test_late_return_can_be_archived_but_never_clears_stop_or_launches(self):
        with self.f.journal() as (config, journal):
            entry = self.prepare(config, journal)
            accepted = self.accept(config, entry)
            journal.stop("operator_stop")
            report = self.report("unknown")
            with patch.object(driver, "observe_binding", side_effect=AssertionError("no native call for a late result")):
                code, status = self.cli(config, "--return-handoff", entry["request"]["sha256"],
                                        "--operator-id", "submit-operator", "--acceptance-sha256", accepted["sha256"],
                                        "--result", report["path"], "--result-sha256", report["sha256"])
            self.assertEqual((code, status["status"]), (0, "operator_result_recorded_not_accepted"))
            self.assertEqual(driver.read_json(config.root / "state.json")["outcome"], "operator_stop")
            self.assertFalse(self.f.captured)

    def test_receipt_publication_is_atomic_and_no_clobber(self):
        target = self.f.root / "atomic.json"
        original_link = driver.os.link
        def check_complete(source, dest):
            self.assertFalse(target.exists())
            self.assertEqual(driver.read_json(source), {"complete": True})
            original_link(source, dest)
        with patch("coordinator_io.os.link", side_effect=check_complete):
            publish_new(target, {"complete": True})
        with self.assertRaises(FileExistsError):
            publish_new(target, {"complete": False})
        self.assertEqual(driver.read_json(target), {"complete": True})
        self.assertFalse(list(self.f.root.glob(".atomic.json.*")))


if __name__ == "__main__":
    unittest.main()

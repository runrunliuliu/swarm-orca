import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import progress_watch as watch


class ProgressWatchTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.config = dict(run="run_test", runtime="runtime_test", workspace="repo::/work",
                           terminal="term_test", incarnation="inc_test", expected_generation=6,
                           max_workers=16, progress_file=str(self.root / "progress.json"),
                           driver_binding=dict(path=str(self.root / "driver.json"), sha256="d" * 64))
        self.launch = dict(process_receipt=str(self.root / "process.json"), plan_sha256="a" * 64,
                           process_intent=str(self.root / "intent.json"), launch_started_at=watch.utc(800),
                           resume_session="same-session")
        self.attempt = 0
        # These unit tests isolate reports, receipts and native observations. The
        # real pinned Journal adapter is exercised in test_coordinator_state.py.
        adapter = patch.object(watch, "follow_launch", side_effect=self.selected_launch)
        adapter.start()
        self.addCleanup(adapter.stop)
        self.intent = dict(plan_sha256=self.launch["plan_sha256"], started_at=watch.utc(800),
                           phase="run", resume_session="same-session")
        (self.root / "intent.json").write_text(json.dumps(self.intent))
        self.native = dict(run=dict(id="run_test", consumer_generation=6, coordinator_handle="term_test"),
                           workers=[], tasks=[], inventory_complete=True,
                           terminals=[dict(handle="term_test", incarnationId="inc_test", worktreeId="repo::/work")])

    def selected_launch(self, config, _previous):
        cursor = dict(attempt=self.attempt, plan_sha256=self.launch["plan_sha256"],
                      started_at=self.launch["launch_started_at"])
        return dict(config, **self.launch), dict(cursor=cursor, phase="between_turns",
            no_progress_turns=0, loop_liveness="not_inferred_from_files")

    def report(self, **updates):
        data = dict(schema_version=1, run_id="run_test", consumer_generation=6,
                    coordinator_handle="term_test", updated_at=watch.utc(1000), phase="development",
                    milestone_id="fixed-dependency", training={})
        data.update(updates)
        (self.root / "progress.json").write_text(json.dumps(data))
        return watch.reported(self.config, self.native, 1000)

    def worker(self, **updates):
        data = dict(dispatch="ctx_1", task="task_1", state="abandoned", dispatch_status="failed",
                    resource="owned", release="retained", liveness="unverifiable")
        data.update(updates)
        return data

    def receipt(self, **updates):
        value = dict(self.intent, child_pid=123, exit_code=0, ended_at=watch.utc(900),
                     observed_by="direct-parent-wait-not-signed-attestation")
        value.update(updates)
        (self.root / "process.json").write_text(json.dumps(value))

    def test_positive_exit_not_terminal_presence(self):
        self.assertEqual(watch.coordinator(self.config, self.native), "terminal_present_agent_exit_unknown")
        self.receipt()
        self.assertEqual(watch.coordinator(self.config, self.native), "exited_direct_parent_receipt")

    def authority_receipt(self, **updates):
        self.config["authority_binding"] = dict(scope_id="scope-test", authority_sha256="a" * 64,
                                               context_sha256="c" * 64)
        return dict(schema_version=1, run_id=self.config["run"], **self.config["authority_binding"],
                    checkpoint_sha256="b" * 64, checked_at=watch.utc(999),
                    status="consistent", error_code=None, grants_authority=False) | updates

    def test_authority_receipt_is_reported_not_verified(self):
        receipt = self.authority_receipt()
        report = self.report(authority_check=receipt, checkpoint_sha256="b" * 64)
        self.assertEqual(report["authority"]["status"], "reported_consistent")
        self.assertFalse(report["authority"]["independently_verified"])
        snapshot, _ = watch.summarize(self.config, self.native, report, {}, 1000)
        self.assertNotIn("authority_check_unavailable", snapshot["alerts"])

    def test_checker_boolean_is_not_denial_or_a_configured_authority_check(self):
        report = self.report(execution_authorized=False)
        self.assertEqual(report["authority"]["status"], "not_configured")
        snapshot, _ = watch.summarize(self.config, self.native, report, {}, 1000)
        self.assertFalse(any("authority" in alert for alert in snapshot["alerts"]))
        self.authority_receipt()
        self.assertEqual(self.report(execution_authorized=False)["authority"]["status"], "missing")

    def test_authority_conflict_alerts_even_when_phase_is_not_blocked(self):
        for code in ("authority_handoff_conflict", "authority_blocker_conflict", "platform_blocker_conflict",
                     "technical_blocker_conflict"):
            report = self.report(authority_check=self.authority_receipt(status="failed", error_code=code),
                                 checkpoint_sha256="b" * 64)
            snapshot, _ = watch.summarize(self.config, self.native, report, {}, 1000)
            self.assertIn("reported_authority_conflict", snapshot["alerts"])
        receipt = self.authority_receipt(status="failed", error_code="secret-do-not-echo", checkpoint_sha256=None)
        report = self.report(authority_check=receipt)
        self.assertEqual(report["authority"]["status"], "reported_check_failed")
        self.assertNotIn("secret-do-not-echo", json.dumps(report))

    def test_authority_binding_freshness_checkpoint_and_malformed_guards(self):
        for updates, expected in ((dict(run_id="other"), "binding_mismatch"),
                                   (dict(scope_id="other"), "binding_mismatch"),
                                   (dict(authority_sha256="d" * 64), "binding_mismatch"),
                                   (dict(context_sha256="d" * 64), "binding_mismatch"),
                                   (dict(checked_at=watch.utc(600)), "stale"),
                                   (dict(checked_at=watch.utc(1200)), "invalid"),
                                   (dict(schema_version=True), "invalid"),
                                   (dict(grants_authority=True), "invalid"),
                                   (dict(status=[]), "invalid"),
                                   (dict(checkpoint_sha256=None), "invalid"),
                                   (dict(checkpoint_sha256="d" * 64), "invalid")):
            report = self.report(authority_check=self.authority_receipt(**updates), checkpoint_sha256="b" * 64)
            self.assertEqual(report["authority"]["status"], expected)
            snapshot, _ = watch.summarize(self.config, self.native, report, {}, 1000)
            self.assertIn("authority_check_unavailable", snapshot["alerts"])

    def test_authority_diagnostics_do_not_suppress_blocked_or_stale_report(self):
        receipt = self.authority_receipt(checked_at=watch.utc(0))
        report = self.report(authority_check=receipt, checkpoint_sha256="b" * 64,
                             phase="blocked", updated_at=watch.utc(0))
        snapshot, _ = watch.summarize(self.config, self.native, report, {}, 1000)
        self.assertIn("coordinator_reports_blocked", snapshot["alerts"])
        self.assertIn("progress_report_stale", snapshot["alerts"])
        self.assertIn("authority_check_unavailable", snapshot["alerts"])

    def test_stale_report_is_separate_from_current_native_lifecycle(self):
        report = self.report(updated_at=watch.utc(0))
        snapshot, _ = watch.summarize(self.config, self.native, report, {}, 1000)
        views = snapshot["status_views"]
        self.assertIn("progress_report_stale", snapshot["alerts"])
        self.assertEqual(views["native_lifecycle"]["status"], "current")
        self.assertEqual(views["native_lifecycle"]["updated_at"], watch.utc(1000))
        self.assertEqual(views["coordinator_report"]["freshness"], "stale")
        self.assertEqual(views["coordinator_report"]["age_seconds"], 1000)
        self.assertEqual(views["execution_state"]["source"], "native_lifecycle")
        self.assertEqual(views["acceptance_state"], {
            "status": "not_evaluated",
            "source": "not_derived_from_execution_or_progress_status"})
        self.assertEqual(views["summary_freshness"], "stale")

    def test_markdown_does_not_present_stale_report_as_current_state(self):
        report = self.report(updated_at=watch.utc(0))
        snapshot, _ = watch.summarize(self.config, self.native, report, {}, 1000)
        rendered = watch.markdown(snapshot)
        self.assertIn("Execution state (native lifecycle)", rendered)
        self.assertIn("Coordinator report: status=reported, freshness=stale", rendered)
        self.assertIn("Acceptance state: not_evaluated", rendered)

    def test_wrong_plan_exit_ignored(self):
        self.receipt(plan_sha256="other")
        self.assertEqual(watch.coordinator(self.config, self.native), "launch_binding_mismatch_agent_exit_unknown")

    def test_replacement_intent_is_not_a_driver_launch(self):
        for session in (None, "same-session", "", False):
            self.intent.update(phase="replacement", resume_session=session)
            (self.root / "intent.json").write_text(json.dumps(self.intent))
            self.receipt()
            self.assertEqual(watch.coordinator(self.config, self.native), "launch_binding_mismatch_agent_exit_unknown")

    def test_run_intent_requires_exact_driver_session(self):
        for session in (None, "", False, "another-session"):
            self.intent["resume_session"] = session
            (self.root / "intent.json").write_text(json.dumps(self.intent))
            self.receipt()
            self.assertEqual(watch.coordinator(self.config, self.native), "launch_binding_mismatch_agent_exit_unknown")
        self.intent.pop("resume_session")
        (self.root / "intent.json").write_text(json.dumps(self.intent))
        self.receipt()
        self.assertEqual(watch.coordinator(self.config, self.native), "launch_binding_mismatch_agent_exit_unknown")

    def test_receipt_requires_all_launch_fields(self):
        for key in ("plan_sha256", "started_at", "phase", "resume_session"):
            self.receipt()
            receipt = watch.file_json(self.root / "process.json")
            receipt.pop(key)
            (self.root / "process.json").write_text(json.dumps(receipt))
            self.assertEqual(watch.coordinator(self.config, self.native), "launch_binding_mismatch_agent_exit_unknown")

    def test_same_session_resume_newer_progress_invalidates_old_exit(self):
        self.receipt()
        snap, state = watch.summarize(self.config, self.native, self.report(), {}, 1000)
        self.assertEqual(snap["coordinator"], "launch_binding_stale_agent_exit_unknown")
        self.assertNotIn("exited_direct_parent_receipt", snap["alerts"])
        self.assertTrue(state["launch_binding_stale"])
        self.assertEqual(snap["configured_launch"]["ended_at"], watch.utc(900))

    def test_stale_binding_survives_report_loss_and_state_reload(self):
        self.receipt()
        self.report()
        watch.tick(self.config, self.root, {}, 1000, self.fake)
        restored = watch.validate_state(watch.file_json(self.root / "state.json"))
        (self.root / "progress.json").unlink()
        watch.tick(self.config, self.root, restored, 1060, self.fake)
        snap = watch.file_json(self.root / "status.json")
        self.assertEqual(snap["coordinator"], "launch_binding_stale_agent_exit_unknown")

    def test_selected_later_launch_accepts_its_own_exit(self):
        self.attempt = 1
        self.intent.update(started_at=watch.utc(950), plan_sha256="b" * 64)
        self.launch.update(launch_started_at=watch.utc(950), plan_sha256="b" * 64)
        (self.root / "intent.json").write_text(json.dumps(self.intent))
        self.receipt(ended_at=watch.utc(1050))
        snap, _ = watch.summarize(self.config, self.native, self.report(), {}, 1100)
        self.assertEqual(snap["coordinator"], "exited_direct_parent_receipt")
        self.assertEqual(snap["configured_launch"]["started_at"], watch.utc(950))
        self.assertEqual(snap["configured_launch"]["ended_at"], watch.utc(1050))
        self.assertEqual(snap["configured_launch"]["scope"], "driver_selected_launch_only")

    def test_same_plan_different_attempt_receipt_rejected(self):
        for updates in (dict(started_at=watch.utc(700)), dict(resume_session="other"), dict(phase="prepare")):
            with self.subTest(updates=updates):
                self.receipt(**updates)
                self.assertEqual(watch.coordinator(self.config, self.native), "launch_binding_mismatch_agent_exit_unknown")

    def test_intent_disagrees_with_pinned_launch(self):
        self.receipt()
        for updates in (dict(started_at=watch.utc(700)), dict(plan_sha256="other"),
                        dict(resume_session=None), dict(phase="prepare")):
            (self.root / "intent.json").write_text(json.dumps(dict(self.intent, **updates)))
            self.assertEqual(watch.coordinator(self.config, self.native), "launch_binding_mismatch_agent_exit_unknown")

    def test_pending_launch_without_intent_cannot_assert_exit(self):
        self.receipt()
        self.launch["launch_started_at"] = None
        self.assertEqual(watch.coordinator(self.config, self.native), "launch_intent_not_observed_agent_exit_unknown")

    def test_changed_generation_workspace_incarnation_cannot_assert_exit(self):
        self.receipt()
        for group, field, value in (("run", "consumer_generation", 7), ("run", "id", "other"),
                                    ("terminal", "worktreeId", "other"), ("terminal", "incarnationId", "other")):
            native = copy.deepcopy(self.native)
            (native["run"] if group == "run" else native["terminals"][0])[field] = value
            self.assertNotEqual(watch.coordinator(self.config, native), "exited_direct_parent_receipt")

    def test_malformed_exit_or_future_timestamps_cannot_assert_exit(self):
        for updates in (dict(ended_at=watch.utc(1100)), dict(ended_at=watch.utc(799)),
                        dict(ended_at="bad"), dict(ended_at="1970-01-01T00:15:00"),
                        dict(exit_code=True), dict(child_pid=True), dict(child_pid=0),
                        dict(observed_by="capture-failed-child-exit-unknown")):
            with self.subTest(updates=updates):
                self.receipt(**updates)
                self.assertEqual(watch.coordinator(self.config, self.native, now=1000), "terminal_present_agent_exit_unknown")

    def test_unverified_report_does_not_invalidate_exit(self):
        self.receipt()
        for updates in (dict(consumer_generation=5), dict(updated_at=watch.utc(2000))):
            report = self.report(**updates)
            self.assertEqual(watch.coordinator(self.config, self.native, report, 1000), "exited_direct_parent_receipt")

    def test_future_launch_is_not_accepted(self):
        self.receipt()
        evidence = watch.observed_launch(self.config, self.native, {}, {}, 700)
        self.assertEqual(evidence["status"], "driver_launch_evidence_unavailable_agent_exit_unknown")
        self.assertEqual(evidence["reason"], "driver_intent_time_invalid")

    def test_owner_changed_does_not_rebind(self):
        self.native["run"]["coordinator_handle"] = "term_new"
        self.assertEqual(watch.coordinator(self.config, self.native), "owner_changed_unverified")

    def test_unknown_retained_reserves_slot(self):
        self.native["workers"] = [self.worker()]
        snap, _ = watch.summarize(self.config, self.native, self.report(), {}, 1000)
        self.assertEqual(snap["active_dispatches"], 0)
        self.assertEqual(snap["conservative_occupied"], 1)

    def test_released_and_absent_not_counted(self):
        self.native["workers"] = [self.worker(resource="released", liveness="exited"), self.worker(dispatch="ctx_2", resource=None, dispatch_status="completed")]
        snap, _ = watch.summarize(self.config, self.native, self.report(), {}, 1000)
        self.assertEqual(snap["conservative_occupied"], 0)

    def test_heartbeat_not_business_progress(self):
        report = self.report()
        _, previous = watch.summarize(self.config, self.native, report, {}, 1000)
        self.report(updated_at=watch.utc(2000))
        report = watch.reported(self.config, self.native, 2000)
        snap, _ = watch.summarize(self.config, self.native, report, previous, 2000)
        self.assertIn("development_inactivity_diagnostic_not_death", snap["alerts"])

    def test_expected_wait_not_death(self):
        report = self.report(expected_wait_until=watch.utc(3000), wait_reason="known slow test")
        _, previous = watch.summarize(self.config, self.native, report, {}, 1000)
        snap, _ = watch.summarize(self.config, self.native, report, previous, 2000)
        self.assertNotIn("development_inactivity_diagnostic_not_death", snap["alerts"])

    def test_unknown_training_not_zero(self):
        report = self.report(phase="training")
        snap, _ = watch.summarize(self.config, self.native, report, {}, 1000)
        self.assertIsNone(report["training"]["active_count"])
        self.assertIn("training_visibility_unknown", snap["alerts"])

    def test_training_report_freshness(self):
        report = self.report(training=dict(active_count=0, observed_at=watch.utc(999), scope="user", evidence="audit.json"))
        self.assertEqual(report["training"]["active_count"], 0)
        stale = watch.reported(self.config, self.native, 1400)
        self.assertIsNone(stale["training"]["active_count"])

    def test_wrong_report_generation_rejected(self):
        self.assertEqual(self.report(consumer_generation=5)["status"], "identity_mismatch")

    def test_report_identity_aliases_are_rejected_even_if_matching(self):
        for key, matching in (("run", "run_test"), ("generation", 6), ("terminal", "term_test")):
            for value in (matching, None, "wrong"):
                with self.subTest(key=key, value=value):
                    self.assertEqual(self.report(**{key: value}), {"status": "identity_mismatch"})
        self.report()
        data = watch.file_json(self.root / "progress.json")
        for key, alias in (("run_id", "run"), ("consumer_generation", "generation"),
                           ("coordinator_handle", "terminal")):
            data[alias] = data.pop(key)
        (self.root / "progress.json").write_text(json.dumps(data))
        self.assertEqual(watch.reported(self.config, self.native, 1000), {"status": "identity_mismatch"})

    def test_report_identity_exact_types(self):
        cases = [("schema_version", bad) for bad in (None, True, 1.0, "1", 2)]
        cases += [("consumer_generation", bad) for bad in (None, True, 6.0, "6", 0, -1)]
        cases += [(key, bad) for key in ("run_id", "coordinator_handle") for bad in (None, 1, [], {})]
        for key, bad in cases:
            with self.subTest(key=key, bad=bad):
                self.assertEqual(self.report(**{key: bad})["status"], "identity_mismatch")

    def test_report_requires_all_canonical_identity_fields(self):
        for missing in ("schema_version", "run_id", "consumer_generation", "coordinator_handle"):
            self.report()
            data = watch.file_json(self.root / "progress.json")
            data.pop(missing)
            (self.root / "progress.json").write_text(json.dumps(data))
            self.assertEqual(watch.reported(self.config, self.native, 1000)["status"], "identity_mismatch")

    def test_report_identity_is_bound_to_native_run_owner_and_generation(self):
        self.report()
        for key, bad in (("id", "other-run"), ("consumer_generation", 7),
                         ("coordinator_handle", "other-terminal"), ("consumer_generation", 6.0)):
            with self.subTest(key=key, bad=bad):
                native = copy.deepcopy(self.native)
                native["run"][key] = bad
                self.assertEqual(watch.reported(self.config, native, 1000)["status"], "identity_mismatch")

    def test_report_does_not_rebind_driver_launch(self):
        self.native["run"].update(consumer_generation=7, coordinator_handle="term_new")
        report = self.report(consumer_generation=7, coordinator_handle="term_new")
        self.assertEqual(report["status"], "reported")
        snap, _ = watch.summarize(self.config, self.native, report, {}, 1000)
        self.assertIn("consumer_generation_changed", snap["alerts"])
        self.assertIn("owner_changed_unverified", snap["alerts"])

    def test_report_requires_valid_timestamp_phase_and_training(self):
        for updates, status in ((dict(updated_at=watch.utc(2000)), "invalid_timestamp"),
                                (dict(phase="not-a-phase"), "invalid_phase"),
                                (dict(training=None), "missing_or_invalid")):
            self.assertEqual(self.report(**updates)["status"], status)

    def test_whole_file_rewrites_do_not_fake_progress_or_mutate_report(self):
        self.report()
        watch.tick(self.config, self.root, {}, 1000, self.fake)
        previous = watch.validate_state(watch.file_json(self.root / "state.json"))
        for now in (1060, 2000):
            self.report(updated_at=watch.utc(now))
            before = (self.root / "progress.json").read_bytes()
            previous = watch.tick(self.config, self.root, previous, now, self.fake)
            snap = watch.file_json(self.root / "status.json")
            self.assertEqual(snap["reported_progress"]["status"], "reported")
            self.assertNotIn("progress_report_unavailable", snap["alerts"])
            self.assertEqual(previous["reported_progress_epoch"], 1000)
            self.assertEqual((self.root / "progress.json").read_bytes(), before)
        self.assertIn("development_inactivity_diagnostic_not_death", snap["alerts"])

    def test_valid_report_clears_unavailable_alert_once_after_state_reload(self):
        self.report(consumer_generation=5)
        watch.tick(self.config, self.root, {}, 1000, self.fake)
        previous = watch.validate_state(watch.file_json(self.root / "state.json"))
        self.report()
        commands = []
        def fake(args, runtime):
            commands.append(args)
            return self.fake(args, runtime)
        for now in (1060, 1120):
            previous = watch.tick(self.config, self.root, previous, now, fake)
        events = [json.loads(line) for line in (self.root / "alerts.jsonl").read_text().splitlines()]
        self.assertEqual([(e["kind"], e["alert"]) for e in events],
                         [("raised", "progress_report_unavailable"), ("cleared", "progress_report_unavailable")])
        self.assertEqual(commands, [
            ["status"], ["orchestration", "run-show", "--id", "run_test"],
            ["orchestration", "worker-list", "--run", "run_test", "--include-remote"],
            ["orchestration", "task-list", "--run", "run_test", "--brief"],
            ["terminal", "list", "--worktree", "id:repo::/work"]] * 2)

    def test_rejected_alias_report_cannot_invalidate_matched_exit(self):
        self.receipt()
        report = self.report(generation=6)
        self.assertEqual(watch.coordinator(self.config, self.native, report, 1000), "exited_direct_parent_receipt")
        report = self.report()
        self.assertEqual(watch.coordinator(self.config, self.native, report, 1000), "launch_binding_stale_agent_exit_unknown")

    def test_future_report_rejected(self):
        self.assertEqual(self.report(updated_at=watch.utc(2000))["status"], "invalid_timestamp")

    def test_arbitrary_text_not_exported(self):
        report = self.report(summary="SECRET", next_action="SECRET", blocker="SECRET", training=dict(scope="SECRET"))
        self.assertNotIn("SECRET", json.dumps(report))

    def fake(self, args, _runtime):
        if args[0] == "status":
            return {}
        if args[:2] == ["orchestration", "run-show"]:
            return {"run": self.native["run"]}
        if args[:2] == ["orchestration", "worker-list"]:
            return dict(scope=dict(run="run_test"), workers=[], page=dict(total=0, hasMore=False, nextCursor=None))
        if args[:2] == ["orchestration", "task-list"]:
            return dict(runId="run_test", count=0, tasks=[])
        if args[:2] == ["terminal", "list"]:
            return dict(truncated=False, terminals=self.native["terminals"])
        raise AssertionError("Unexpected command")

    def test_queries_only(self):
        commands = []
        def fake(args, runtime):
            commands.append(args)
            return self.fake(args, runtime)
        watch.collect(self.config, fake)
        self.assertEqual(len(commands), 5)
        self.assertNotIn("check", str(commands))
        with self.assertRaises(watch.ObservationError):
            watch.query(["orchestration", "worker-release"], "runtime_test")

    def test_pagination_incomplete_rejected(self):
        def fake(args, runtime):
            result = self.fake(args, runtime)
            if args[1:2] == ["worker-list"]:
                result["page"] = dict(total=1, hasMore=True, nextCursor=None)
            return result
        with self.assertRaises(watch.ObservationError):
            watch.collect(self.config, fake)

    def test_all_worker_pages(self):
        def fake(args, runtime):
            result = self.fake(args, runtime)
            if args[1:2] == ["worker-list"]:
                second = "--cursor" in args
                result["workers"] = [dict(dispatchId="ctx_2" if second else "ctx_1")]
                result["page"] = dict(total=2, hasMore=not second, nextCursor=None if second else "next")
            return result
        self.assertEqual(len(watch.collect(self.config, fake)["workers"]), 2)

    def test_more_than_100_worker_pages(self):
        def fake(args, runtime):
            result = self.fake(args, runtime)
            if args[1:2] == ["worker-list"]:
                page = int(args[args.index("--cursor") + 1]) if "--cursor" in args else 0
                result["workers"] = [dict(dispatchId=f"ctx_{page}")]
                result["page"] = dict(total=105, hasMore=page < 104,
                                      nextCursor=str(page + 1) if page < 104 else None)
            return result
        self.assertEqual(len(watch.collect(self.config, fake)["workers"]), 105)

    def test_repeated_worker_cursor_still_rejected(self):
        def fake(args, runtime):
            result = self.fake(args, runtime)
            if args[1:2] == ["worker-list"]:
                result["page"] = dict(total=2, hasMore=True, nextCursor="same")
            return result
        with self.assertRaisesRegex(watch.ObservationError, "pagination_incomplete"):
            watch.collect(self.config, fake)

    def test_terminal_partial_rejected(self):
        def fake(args, runtime):
            result = self.fake(args, runtime)
            if args[0] == "terminal":
                result["truncated"] = True
            return result
        with self.assertRaises(watch.ObservationError):
            watch.collect(self.config, fake)

    def test_failure_does_not_repeat_last_counts(self):
        def fail(*_args):
            raise watch.ObservationError("runtime_mismatch")
        watch.tick(self.config, self.root, {"last_success_at":watch.utc(900)}, 1000, fail)
        data = watch.file_json(self.root / "status.json")
        self.assertEqual(data["native_query_status"], "unknown")
        self.assertNotIn("active_dispatches", data)

    def test_dedup_alerts_and_recovery(self):
        def fail(*_args):
            raise watch.ObservationError("native_query_failed")
        state = watch.tick(self.config, self.root, {}, 1000, fail)
        state = watch.tick(self.config, self.root, state, 1060, fail)
        self.assertEqual(len((self.root / "alerts.jsonl").read_text().splitlines()), 1)
        watch.tick(self.config, self.root, state, 1120, self.fake)
        self.assertIn('"cleared"', (self.root / "alerts.jsonl").read_text())

    def test_symlink_rejected(self):
        (self.root / "target").write_text("{}")
        (self.root / "link").symlink_to(self.root / "target")
        with self.assertRaises(OSError):
            watch.file_json(self.root / "link")

    def summary_epochs(self):
        return [watch.stamp(json.loads(line)["observed_at"])
                for line in (self.root / "summaries.jsonl").read_text().splitlines()]

    def test_summary_cadence_across_successful_ticks(self):
        state = {}
        for now in range(1000, 1601, 60):
            state = watch.tick(self.config, self.root, state, now, self.fake)
        self.assertEqual(self.summary_epochs(), [1000, 1300, 1600])
        self.assertEqual(state["last_summary_epoch"], 1600)

    def test_summary_cadence_survives_restart_between_due_ticks(self):
        state = watch.tick(self.config, self.root, {}, 1000, self.fake)
        watch.tick(self.config, self.root, state, 1060, self.fake)
        # Read the actual persisted state as main() does after a clean restart.
        restored = watch.validate_state(watch.file_json(self.root / "state.json"))
        state = watch.tick(self.config, self.root, restored, 1120, self.fake)
        self.assertEqual(self.summary_epochs(), [1000])
        state = watch.tick(self.config, self.root, state, 1299, self.fake)
        watch.tick(self.config, self.root, state, 1300, self.fake)
        self.assertEqual(self.summary_epochs(), [1000, 1300])

    def test_summary_cadence_on_unknown_recovery_and_alert_change(self):
        def fail(*_args):
            raise watch.ObservationError("inventory_changed_during_pagination")
        state = watch.tick(self.config, self.root, {}, 1000, self.fake)
        state = watch.tick(self.config, self.root, state, 1060, fail)
        state = watch.tick(self.config, self.root, state, 1120, self.fake)
        self.report(phase="blocked")
        state = watch.tick(self.config, self.root, state, 1180, self.fake)
        state = watch.tick(self.config, self.root, state, 1240, self.fake)
        watch.tick(self.config, self.root, state, 1300, self.fake)
        self.assertEqual(self.summary_epochs(), [1000, 1300])

    def test_summary_cadence_long_gap_emits_once_without_backfill(self):
        state = watch.tick(self.config, self.root, {}, 1000, self.fake)
        state = watch.tick(self.config, self.root, state, 2000, self.fake)
        state = watch.tick(self.config, self.root, state, 2060, self.fake)
        watch.tick(self.config, self.root, state, 2120, self.fake)
        self.assertEqual(self.summary_epochs(), [1000, 2000])

    def test_generation_alert(self):
        self.native["run"]["consumer_generation"] = 7
        snap, _ = watch.summarize(self.config, self.native, {}, {}, 1000)
        self.assertIn("consumer_generation_changed", snap["alerts"])

    def test_atomic_recovers_with_stale_temporary(self):
        (self.root / "status.json.new").write_text("historical crash evidence")
        watch.atomic(self.root / "status.json", {"ok": True})
        self.assertEqual(watch.file_json(self.root / "status.json"), {"ok": True})
        self.assertEqual((self.root / "status.json.new").read_text(), "historical crash evidence")

    def test_atomic_failed_replace_preserves_previous(self):
        watch.atomic(self.root / "status.json", {"old": True})
        with patch.object(watch.os, "replace", side_effect=OSError("test")):
            with self.assertRaises(OSError):
                watch.atomic(self.root / "status.json", {"new": True})
        self.assertEqual(watch.file_json(self.root / "status.json"), {"old": True})
        self.assertEqual(list(self.root.glob("*.tmp")), [])

    def test_malformed_training_is_unknown(self):
        for value in (["bad"], [], None, "bad", 1):
            self.assertEqual(self.report(training=value)["status"], "missing_or_invalid")

    def test_native_live_is_not_unknown(self):
        self.native["workers"] = [self.worker(liveness="live", dispatch_status="dispatched")]
        snap, _ = watch.summarize(self.config, self.native, self.report(), {}, 1000)
        self.assertEqual(snap["owned_unknown"], 0)
        self.assertEqual(snap["conservative_occupied"], 1)

    def test_settled_but_live_still_reserves_slot(self):
        self.native["workers"] = [self.worker(liveness="live", dispatch_status="completed")]
        snap, _ = watch.summarize(self.config, self.native, self.report(), {}, 1000)
        self.assertEqual(snap["active_dispatches"], 0)
        self.assertEqual(snap["conservative_occupied"], 1)

    def test_malformed_native_shapes_write_unknown(self):
        for command, bad in (("run-show", {"run": []}), ("worker-list", {"scope": []}),
                             ("worker-list", {"scope": {"run": "run_test"}, "page": []}),
                             ("task-list", {"tasks": [None]}), ("list", {"truncated": False, "terminals": [1]})):
            def fake(args, runtime):
                return bad if args[1:2] == [command] else self.fake(args, runtime)
            watch.tick(self.config, self.root, {}, 1000, fake)
            self.assertEqual(watch.file_json(self.root / "status.json")["native_query_status"], "unknown")

    def test_malformed_nested_worker_is_unknown(self):
        for field, value in (("resource", []), ("projection", []), ("projection", {"liveness": []})):
            def fake(args, runtime):
                result = self.fake(args, runtime)
                if args[1:2] == ["worker-list"]:
                    result["workers"] = [{"dispatchId": "ctx_1", field: value}]
                    result["page"]["total"] = 1
                return result
            watch.tick(self.config, self.root, {}, 1000, fake)
            self.assertEqual(watch.file_json(self.root / "status.json")["native_query_status"], "unknown")

    def test_decode_shapes_and_private_native_error(self):
        for data in ([], {"ok": True, "_meta": []}, {"ok": True, "_meta": {"runtimeId": "runtime_test"}, "result": []}):
            with self.assertRaises(watch.ObservationError):
                watch.decode_response(json.dumps(data), 0, "runtime_test")
        with self.assertRaisesRegex(watch.StopObservation, "^runtime_access_denied$"):
            watch.decode_response(json.dumps({"ok": False, "error": {"code": "runtime_access_denied", "message": "SECRET"}}), 1, "runtime_test")
        with self.assertRaisesRegex(watch.StopObservation, "^native_query_failed$"):
            watch.decode_response(json.dumps({"ok": False, "error": {"code": ["SECRET"]}}), 1, "runtime_test")

    def test_stop_latch_survives_restart_and_invalid_contents(self):
        calls = []
        def fail(*args):
            calls.append(args)
            raise watch.StopObservation("runtime_access_denied")
        watch.tick(self.config, self.root, {}, 1000, fail)
        self.assertEqual(len(calls), 1)
        # Simulates restart even without state.json: independent latch still stops reads.
        state = watch.tick(self.config, self.root, {}, 1060, fail)
        self.assertEqual(len(calls), 1)
        (self.root / "query-stop.json").write_text("interrupted or invalid")
        watch.tick(self.config, self.root, state, 1120, fail)
        self.assertEqual(len(calls), 1)

    def test_config_validation_and_output_binding(self):
        config = copy.deepcopy(self.config)
        guid = "a643eefc-3dcd-44f3-b92c-3c0ecfc4121a"
        config.update(runtime=guid, incarnation=guid, terminal="term_" + guid,
                      run="run_db5d14ca5304", workspace=guid + "::/work")
        watch.validate_config(config)
        binding = dict(scope_id="scope-test", authority_sha256="a" * 64, context_sha256="c" * 64)
        watch.validate_config(dict(config, authority_binding=binding))
        for bad in (None, [], {}, dict(binding, scope_id=True), dict(binding, authority_sha256="short"),
                    dict(binding, context_sha256=False), dict(binding, extra="rejected")):
            with self.assertRaises(ValueError):
                watch.validate_config(dict(config, authority_binding=bad))
        watch.bind_output(self.root, config)
        watch.bind_output(self.root, config)
        changed = dict(config, expected_generation=7)
        with self.assertRaises(ValueError):
            watch.bind_output(self.root, changed)
        for field, bad in (("run", []), ("runtime", "wrong"), ("expected_generation", True),
                           ("max_workers", 0), ("workspace", "active"), ("progress_file", "relative"),
                           ("driver_binding", None), ("driver_binding", {}),
                           ("driver_binding", dict(path="relative", sha256="d" * 64)),
                           ("driver_binding", dict(path=config["driver_binding"]["path"], sha256="short"))):
            with self.subTest(field=field), self.assertRaises(ValueError):
                watch.validate_config(dict(config, **{field: bad}))
        for field in config:
            partial = dict(config)
            partial.pop(field)
            with self.subTest(missing=field), self.assertRaisesRegex(ValueError, "invalid_watch_config"):
                watch.validate_config(partial)
        for field, value in self.launch.items():
            with self.subTest(static_field=field), self.assertRaisesRegex(ValueError, "invalid_watch_config"):
                watch.validate_config(dict(config, **{field: value}))
        static_config = dict(config, **self.launch)
        del static_config["driver_binding"]
        with self.assertRaisesRegex(ValueError, "invalid_watch_config"):
            watch.validate_config(static_config)
        rebound = dict(config, driver_binding=dict(config["driver_binding"], sha256="e" * 64))
        with self.assertRaises(ValueError):
            watch.bind_output(self.root, rebound)

    def test_nonfinite_json_and_invalid_state_rejected(self):
        (self.root / "bad.json").write_text('{"epoch":NaN}')
        with self.assertRaises(ValueError):
            watch.file_json(self.root / "bad.json")
        for value in ({"last_summary_epoch": "yesterday"}, {"alerts": [1]}, {"peak_observed_occupied": True},
                      {"launch_binding_stale": "false"}):
            with self.assertRaises(ValueError):
                watch.validate_state(value)


if __name__ == "__main__":
    unittest.main()


class QueryAllowlistTests(unittest.TestCase):
    """Standalone-lifecycle fences route orchestration strict-caller-check through
    progress_watch.query. These tests drive the real routing function and spawn a stub
    CLI, so a missing approved prefix fails here instead of only in a live lifecycle pull.
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.calls = self.root / "calls.txt"
        stub = self.root / "orca-stub"
        stub.write_text(
            "#!/bin/sh\n"
            "printf '%s\\n' \"$*\" >> " + str(self.calls) + "\n"
            "printf '%s' '{\"ok\":true,\"_meta\":{\"runtimeId\":\"rt\"},"
            "\"result\":{\"caller\":{\"terminalHandle\":\"term_x\"}}}'\n")
        stub.chmod(0o755)
        patched = patch.object(watch, "CLI", str(stub))
        patched.start()
        self.addCleanup(patched.stop)

    def test_strict_caller_check_is_allowlisted_and_reaches_the_client(self):
        result = watch.query(["orchestration", "strict-caller-check"], "rt", 10)
        self.assertEqual(result["caller"]["terminalHandle"], "term_x")
        self.assertIn("orchestration strict-caller-check --json", self.calls.read_text())

    def test_unlisted_verb_is_still_refused_without_spawning(self):
        with self.assertRaises(watch.ObservationError) as caught:
            watch.query(["orchestration", "send", "--to", "run:run_x"], "rt", 10)
        self.assertEqual(str(caught.exception), "query_not_allowlisted")
        self.assertFalse(self.calls.exists())


class MonitorNativeRoutingTests(unittest.TestCase):
    """operator_monitor.native is the route the standalone-lifecycle fence uses.

    The allowlist lives in progress_watch.query, so a verb missing there fails inside
    native() before any client process starts. These tests drive native() itself and
    only replace the client process.
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.calls = self.root / "calls.txt"
        stub = self.root / "orca-stub"
        stub.write_text(
            "#!/bin/sh\n"
            "printf '%s\\n' \"$*\" >> " + str(self.calls) + "\n"
            "printf '%s' '{\"ok\":true,\"_meta\":{\"runtimeId\":\"rt\"},"
            "\"result\":{\"caller\":{\"terminalHandle\":\"term_x\"}}}'\n")
        stub.chmod(0o755)
        patched = patch.object(watch, "CLI", str(stub))
        patched.start()
        self.addCleanup(patched.stop)

    def test_native_routes_strict_caller_check_to_the_client(self):
        import operator_monitor
        result = operator_monitor.native(["orchestration", "strict-caller-check"], "rt", 10)
        self.assertEqual(result["caller"]["terminalHandle"], "term_x")
        self.assertIn("orchestration strict-caller-check --json", self.calls.read_text())

    def test_native_still_refuses_unlisted_verb_without_spawning(self):
        import operator_monitor
        with self.assertRaises(watch.ObservationError) as caught:
            operator_monitor.native(["orchestration", "dispatch", "--task", "task_x"], "rt", 10)
        self.assertEqual(str(caught.exception), "query_not_allowlisted")
        self.assertFalse(self.calls.exists())

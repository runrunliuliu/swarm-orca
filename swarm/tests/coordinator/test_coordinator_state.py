"""Read-only watcher integration against the same fixture journal used by the driver."""

import copy
import io
import json
from pathlib import Path
import time
import unittest
from unittest.mock import patch

import coordinator_driver as driver
import coordinator_state
from coordinator_input import bind_prompt
import progress_watch as watch
import coordinator.test_coordinator_driver as fixtures


class DriverObservationTests(unittest.TestCase):
    def setUp(self):
        self.f = fixtures.DriverTests()
        self.f.setUp()
        self.addCleanup(self.f.doCleanups)
        context = self.f.journal()
        self.config, self.journal = context.__enter__()
        self.addCleanup(context.__exit__, None, None, None)
        driver.initialize(self.config, self.journal, self.f.snapshot)
        b = self.config.data["binding"]
        self.watch = {k: b[k] for k in ("runtime", "run", "terminal", "incarnation", "workspace")}
        self.watch.update(expected_generation=b["generation"], max_workers=16,
                          progress_file=str(self.f.root / "progress.json"),
                          driver_binding={"path": self.config.filename, "sha256": self.config.sha256})
        self.native = copy.deepcopy(self.f.snapshot)
        self.native["terminals"] = [{"handle": b["terminal"], "incarnationId": b["incarnation"],
                                     "worktreeId": b["workspace"]}]
        self.previous = {}

    def observe(self):
        observed_at = time.time() + 1
        snapshot, self.previous = watch.summarize(self.watch, self.native,
            watch.reported(self.watch, self.native, observed_at), self.previous, observed_at)
        watch.validate_state(self.previous)
        return snapshot

    def pending(self):
        attempt = self.journal.data["attempts"] + 1
        directory = self.config.root / ("turn-%06d" % attempt)
        directory.mkdir()
        prompt = directory / "prompt.md"
        self.f.write(prompt, "fixture pending prompt")
        plan = bind_prompt(self.f.plan, prompt)
        target = directory / "launch-plan.json"
        self.f.write(target, plan)
        action = driver.obligation(self.config, self.journal.data["current"]["checkpoint"],
                                   self.f.checkpoint("continue"), attempt)
        self.journal.data.update(attempts=attempt,
            pending={"attempt": attempt, "plan": driver.file_ref(target), "action": action})
        self.journal.save()
        return target

    def test_seed_launch_is_selected_from_fixed_config_without_duplicate_static_fields(self):
        snapshot = self.observe()
        self.assertEqual(snapshot["coordinator"], "exited_direct_parent_receipt")
        evidence = snapshot["configured_launch"]
        self.assertEqual(evidence["scope"], "driver_selected_launch_only")
        self.assertEqual(evidence["plan_sha256"], self.config.data["previous_plan"]["sha256"])
        self.assertEqual(evidence["driver"]["cursor"]["attempt"], 0)
        self.assertEqual(evidence["driver"]["loop_liveness"], "not_inferred_from_files")

    def test_driver_state_requires_current_schema_and_operator_history(self):
        current = copy.deepcopy(self.journal.data)
        missing_history = dict(current)
        del missing_history["operator_requests"]
        missing_background = dict(current)
        del missing_background["background_jobs"]
        for invalid in (dict(current, schema_version=1), dict(current, schema_version=2),
                        missing_history, missing_background):
            with self.subTest(state=invalid):
                self.journal.data = invalid
                self.journal.save()
                with self.assertRaisesRegex(ValueError, "invalid_driver_state"):
                    self.journal.validate()
                self.assertEqual(self.observe()["configured_launch"]["reason"], "invalid_driver_state")

    def test_driver_follow_rejects_previous_config_schema(self):
        self.f.config_data["schema_version"] = 4
        self.f.write(self.f.config_file, self.f.config_data)
        self.watch["driver_binding"] = driver.file_ref(self.f.config_file)
        self.assertEqual(self.observe()["configured_launch"]["reason"], "unsupported_driver_schema")

    def test_new_pending_intent_never_uses_previous_exit(self):
        self.observe()
        plan = self.pending()
        snapshot = self.observe()
        self.assertEqual(snapshot["coordinator"], "launch_intent_not_observed_agent_exit_unknown")
        self.assertEqual(snapshot["configured_launch"]["process_receipt"], str(plan.with_suffix(".process.json")))
        self.assertEqual(snapshot["configured_launch"]["driver"]["phase"], "launch_pending")
        self.assertIsNone(self.previous["driver_cursor"]["started_at"])

    def test_real_fixture_turns_follow_pending_then_settled_receipts(self):
        self.observe()
        snapshots = []
        self.f.script = [{"artifact": "v1"}, {"artifact": "v2", "decision": "complete"}]
        def capture(plan, output):
            snapshots.append(self.observe())
            code = self.f.capture(plan, output)
            snapshots.append(self.observe())
            return code
        self.assertEqual(driver.drive(self.config, self.journal, capture=capture,
            fence=lambda _: copy.deepcopy(self.f.snapshot), output=io.BytesIO()),
            "complete_pending_independent_acceptance")
        self.assertTrue(all(s["coordinator"] != "exited_direct_parent_receipt" for s in snapshots[::2]))
        self.assertTrue(all(s["coordinator"] == "exited_direct_parent_receipt" for s in snapshots[1::2]))
        final = self.observe()
        self.assertEqual(final["configured_launch"]["driver"]["cursor"]["attempt"], 2)
        self.assertEqual(final["configured_launch"]["driver"]["phase"], "stopped")

    def test_stale_conflict_clears_only_after_verified_later_launch(self):
        self.f.write(Path(self.watch["progress_file"]), {"schema_version": 1, "run_id": "run_test",
            "consumer_generation": 6, "coordinator_handle": "term_test", "updated_at": watch.utc(time.time()),
            "phase": "development", "training": {}})
        self.assertEqual(self.observe()["coordinator"], "launch_binding_stale_agent_exit_unknown")
        self.assertTrue(self.previous["launch_binding_stale"])
        self.assertEqual(self.previous["stale_driver_attempt"], 0)
        self.f.script = [{"artifact": "result", "decision": "complete"}]
        def capture(plan, output):
            self.observe()
            self.assertTrue(self.previous["launch_binding_stale"])
            self.assertEqual(self.previous["stale_driver_attempt"], 0)
            code = self.f.capture(plan, output)
            self.assertEqual(self.observe()["coordinator"], "exited_direct_parent_receipt")
            self.assertFalse(self.previous["launch_binding_stale"])
            return code
        driver.drive(self.config, self.journal, capture=capture,
                     fence=lambda _: copy.deepcopy(self.f.snapshot), output=io.BytesIO())
        self.assertFalse(self.observe()["coordinator"].startswith("launch_binding_stale"))

    def test_invalid_or_missing_driver_state_never_falls_back_to_seed_exit(self):
        self.observe()
        target = self.config.root / "state.json"
        saved = target.read_bytes()
        for payload in (b"{}", b"", b'{"duplicate":1,"duplicate":2}'):
            target.write_bytes(payload)
            self.assertEqual(self.observe()["coordinator"], "driver_launch_evidence_unavailable_agent_exit_unknown")
        target.unlink()
        self.assertEqual(self.observe()["coordinator"], "driver_launch_evidence_unavailable_agent_exit_unknown")
        target.write_bytes(saved)
        self.assertEqual(self.observe()["coordinator"], "exited_direct_parent_receipt")

    def test_unbound_operator_fields_are_not_exported_from_driver_state(self):
        self.journal.data["current"]["operator_request"] = {"body": "PRIVATE_REQUEST"}
        self.journal.save()
        snapshot = self.observe()
        self.assertEqual(snapshot["configured_launch"]["reason"], "operator_request_binding_mismatch")
        self.assertNotIn("PRIVATE_REQUEST", json.dumps(snapshot))

    def test_operator_history_requires_exact_paths_and_receipt_chain(self):
        key = "a" * 64
        directory = self.config.root / ("operator-" + key)
        entry = {"request": {"path": str(directory / "request.json"), "sha256": "b" * 64},
                 "acceptance": None, "result": None}
        self.journal.data["operator_requests"] = {key: entry}
        self.journal.data["current"]["operator_request"] = entry["request"]
        self.journal.save()
        self.assertEqual(self.observe()["configured_launch"]["driver"]["phase"], "operator_handoff")
        entry["result"] = {"path": str(directory / "result.json"), "sha256": "c" * 64}
        self.journal.save()
        self.assertEqual(self.observe()["configured_launch"]["reason"], "operator_result_without_acceptance")
        entry["result"] = None
        entry["request"]["path"] = str(self.f.brief)
        self.journal.save()
        self.assertEqual(self.observe()["configured_launch"]["reason"], "operator_receipt_path_mismatch")

    def test_rollback_does_not_discard_last_verified_cursor(self):
        original = copy.deepcopy(self.journal.data)
        self.observe()
        self.pending()
        self.observe()
        cursor = self.previous["driver_cursor"]
        self.journal.data = original
        self.journal.save()
        snapshot = self.observe()
        self.assertEqual(snapshot["configured_launch"]["reason"], "driver_attempt_rollback")
        self.assertEqual(self.previous["driver_cursor"], cursor)

    def test_unknown_pending_and_partial_state_write_are_not_clean_exit(self):
        self.pending()
        self.f.write(self.config.root / "state.next.json", {})
        snapshot = self.observe()
        self.assertEqual(snapshot["configured_launch"]["reason"], "unreconciled_state_write")

    def test_same_attempt_cannot_change_plan_or_process_start(self):
        plan = self.pending()
        self.f.receipts(plan, self.f.start, self.f.end)
        self.observe()
        intent = driver.read_json(plan.with_suffix(".process-intent.json"))
        intent["started_at"] = self.f.end.isoformat()
        self.f.write(plan.with_suffix(".process-intent.json"), intent)
        self.assertEqual(self.observe()["configured_launch"]["reason"], "driver_cursor_changed")

    def test_plan_escape_policy_drift_and_wrong_executor_are_rejected(self):
        target = self.pending()
        original = copy.deepcopy(self.journal.data["pending"])
        self.journal.data["pending"]["plan"] = self.config.data["previous_plan"]
        self.journal.save()
        self.assertEqual(self.observe()["configured_launch"]["reason"], "driver_launch_path_mismatch")
        self.journal.data["pending"] = original
        self.journal.data["pending"]["action"]["executor"] = "outer-operator"
        self.journal.save()
        self.assertEqual(self.observe()["configured_launch"]["reason"], "driver_attempt_mismatch")
        self.journal.data["pending"]["action"]["executor"] = "coordinator"
        plan = driver.read_json(target)
        plan["argv"] = ["/bin/true"]
        self.f.write(target, plan)
        self.journal.data["pending"]["plan"] = driver.file_ref(target)
        self.journal.save()
        self.assertEqual(self.observe()["configured_launch"]["reason"], "driver_launch_policy_changed")

    def test_owner_and_generation_changes_still_refuse_exit(self):
        for field in ("coordinator_handle", "consumer_generation"):
            saved = self.native["run"][field]
            self.native["run"][field] = "other"
            self.assertNotEqual(self.observe()["coordinator"], "exited_direct_parent_receipt")
            self.native["run"][field] = saved

    def test_fixed_driver_config_hash_is_rechecked_each_observation(self):
        self.observe()
        Path(self.config.filename).write_bytes(Path(self.config.filename).read_bytes() + b" ")
        snapshot = self.observe()
        self.assertEqual(snapshot["configured_launch"]["reason"], "file_pin_changed")

    def test_session_change_between_driver_and_receipt_reads_cannot_assert_exit(self):
        def changed(config, previous):
            resolved, projection = coordinator_state.follow_launch(config, previous)
            for key in ("process_intent", "process_receipt"):
                target = Path(resolved[key])
                receipt = driver.read_json(target)
                receipt["resume_session"] = "different-session"
                self.f.write(target, receipt)
            return resolved, projection
        with patch.object(watch, "follow_launch", side_effect=changed):
            self.assertEqual(self.observe()["coordinator"], "launch_binding_mismatch_agent_exit_unknown")

    def test_state_change_during_observation_is_unknown_until_next_tick(self):
        original = coordinator_state.file_ref
        reads = []
        def changed(target):
            ref = original(target)
            if Path(target).name == "state.json":
                reads.append(True)
                if len(reads) == 2:
                    ref["sha256"] = "0" * 64
            return ref
        with patch.object(coordinator_state, "file_ref", side_effect=changed):
            self.assertEqual(self.observe()["configured_launch"]["reason"], "driver_state_changed_during_observation")
        self.assertEqual(self.observe()["coordinator"], "exited_direct_parent_receipt")

    def test_query_stop_latch_is_not_bypassed_by_driver_follow(self):
        directory = self.f.root / "monitor"
        directory.mkdir(mode=0o700)
        self.f.write(directory / "query-stop.json", {"reason": "runtime_access_denied"})
        watch.tick(self.watch, directory, {}, call=lambda *_: self.fail("latched native query"))
        snapshot = watch.file_json(directory / "status.json")
        self.assertEqual(snapshot["native_query_status"], "unknown")
        self.assertIn("native_queries_stopped_operator_action_required", snapshot["alerts"])

    def test_driver_binding_config_and_cursor_types_are_strict(self):
        guid = "12345678-1234-1234-1234-123456789012"
        config = dict(self.watch, runtime=guid, incarnation=guid, terminal="term_" + guid,
                      run="run_123456789012", workspace=guid + "::/work")
        watch.validate_config(config)
        with self.assertRaisesRegex(ValueError, "invalid_watch_config"):
            watch.validate_config(dict(config, plan_sha256="a" * 64))
        with self.assertRaisesRegex(ValueError, "invalid_file_pin"):
            watch.validate_config(dict(config, driver_binding={"path": "/x", "sha256": None}))
        self.observe()
        for changes in ({"attempt": True}, {"started_at": "bad"}, {"plan_sha256": "bad"}):
            state = dict(self.previous, driver_cursor=dict(self.previous["driver_cursor"], **changes))
            with self.subTest(changes=changes), self.assertRaisesRegex(ValueError, "invalid driver cursor"):
                watch.validate_state(state)


if __name__ == "__main__":
    unittest.main()

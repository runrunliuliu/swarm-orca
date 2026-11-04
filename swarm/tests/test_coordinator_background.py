"""Offline training/research overlap; fake native workers, no real Agents or Jobs."""

import copy
import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

import coordinator_background as background
import coordinator_driver as driver
import coordinator_handoff as handoff
import coordinator_operator as operator
import coordinator_state
from coordinator_io import canonical, digest, file_ref, publish_new, read_json, replace_json
import test_coordinator_operator as fixtures


class BackgroundTests(unittest.TestCase):
    def setUp(self):
        self.o = fixtures.OperatorTests()
        self.o.setUp()
        self.addCleanup(self.o.doCleanups)
        self.f = self.o.f
        self.o.data["routes"]["path"]["completion"] = "background"

    def submitted(self):
        config = self.o.prepare(self.o.config())
        self.assertEqual(operator.tick(config), "returning")
        self.assertEqual(operator.tick(config), "operator_result_ready")
        _, refs, report = handoff.observe(config.driver, self.o.entry)
        self.assertEqual(report["status"], "submitted")
        self.assertEqual(self.o.methods(), ["probe", "execute"])
        return config, background.entry(refs)

    def query(self, status):
        def call(ref, request, **kwargs):
            self.assertEqual(request["method"], "query")
            return self.o.reply(request, status, "fixture-job-1")
        return call

    def test_training_overlaps_two_research_workers_and_reviews_in_same_coordinator(self):
        f = self.f
        f.contract["requirements"] += [dict(id=k, acceptance="independently reviewed research", evidence_kind="artifact")
                                        for k in ("research-a", "research-b")]
        f.write(f.contract_file, f.contract)
        f.config_data["contract"] = f.json_ref(f.contract_file)
        ledger = read_json(f.ledger_file)
        ledger["events"][0]["patch"].update({"permissions.training": "granted", "permissions.agent_launch": "granted"})
        f.write(f.ledger_file, ledger)
        ledger_pin = f.json_ref(f.ledger_file)["sha256"]
        auth = read_json(f.handoff_file)
        auth.update(authority_sha256=ledger_pin, fields=ledger["events"][0]["patch"])
        f.write(f.handoff_file, auth)
        catalog = read_json(f.catalog_file)
        catalog.update(authority_sha256=ledger_pin, contract_sha256=f.config_data["contract"]["sha256"])
        catalog["paths"][0]["permissions"] = ["training"]
        catalog["paths"] += [dict(id=k, operation=k, permissions=["research", "agent_launch"])
                             for k in ("research-a", "research-b")]
        f.write(f.catalog_file, catalog)
        f.config_data["authority"].update(ledger=f.json_ref(f.ledger_file), handoff=f.json_ref(f.handoff_file),
                                          path_catalog=f.json_ref(f.catalog_file))

        def record(decision, action_paths, *, done=(), waiting=()):
            r = f.checkpoint("continue")
            r.update(decision=decision, paths=[], requirements=[], barriers=[])
            for spec, key, operation in zip(f.contract["requirements"],
                    ("path", "research-a", "research-b"),
                    ("produce verified source", "research-a", "research-b")):
                status = "met" if key in done else "waiting" if key in waiting else "actionable"
                r["requirements"].append(dict(spec, status=status,
                    path_review_ref=None if status == "met" else "reviewed",
                    evidence=[{"kind": "artifact", "ref": "fixture-reviewed"}] if status == "met" else []))
                if status != "met":
                    barrier = "wait-" + key if status == "waiting" else None
                    r["paths"].append(dict(id=key, requirement_id=spec["id"], operation=operation,
                                            status=status, barrier_id=barrier))
                    if barrier:
                        r["barriers"].append(dict(id=barrier, kind="dependency_running", path_ids=[key],
                            evidence_refs=["fixture-native"], condition="dependency change", attempt_refs=[],
                            recovery_limit=None, alternatives_ref=None))
            r["next_action"] = None if decision == "complete" else dict(r["next_action"],
                id="action-" + "-".join(action_paths), path_ids=action_paths,
                kind="wait" if decision == "wait" else "implement")
            return r

        initial = record("continue", ["path"])
        initial["next_action"]["owner"] = "outer-operator"
        initial["observed_at"] = self.o.record["observed_at"]
        self.o.record = initial
        f.initial(initial)
        config = self.o.config()
        finish_training = False
        polls, turns, unchanged_waits = [], [], []

        def provider(ref, request, **kwargs):
            if request["method"] != "query":
                return operator.invoke(ref, request, **kwargs)
            polls.append(request["job"])
            return self.o.reply(request, "succeeded" if finish_training else "running", "fixture-job-1")

        def during_turn(plan):
            text = Path(read_json(plan)["prompt_file"]).read_text()
            protocol = json.loads(text[text.index("\n{\n") + 1:])
            turns.append(protocol)
            # A query must not touch the actively changing model/session evidence.
            with patch.object(driver, "current_evidence", side_effect=AssertionError("pending model evidence read")):
                if len(turns) > 1:
                    operator.tick(config, call=provider)
            if len(turns) == 2:
                f.snapshot["workers"] = [dict(dispatch=k, dispatch_status="running", resource="owned",
                    liveness="running", attention={"requires_action": False}) for k in ("dispatch-a", "dispatch-b")]
            if len(turns) == 3:
                for w in f.snapshot["workers"]:
                    w.update(dispatch_status="completed", resource="released", liveness="exited")

        specs = [
            record("continue", ["research-a", "research-b"], waiting=["path"]),
            record("wait", ["research-a", "research-b"], waiting=["path", "research-a", "research-b"]),
            record("continue", ["research-a"], waiting=["path"]),
            record("continue", ["research-b"], done=["research-a"], waiting=["path"]),
            record("wait", ["path"], done=["research-a", "research-b"], waiting=["path"]),
            record("complete", [], done=["path", "research-a", "research-b"])]
        f.script = [dict(record=r, artifact="verified work " + str(i), filename="evidence-%d.json" % i,
                         waiting_dispatches=["dispatch-a", "dispatch-b"] if i == 1 else [], mutate=during_turn)
                    for i, r in enumerate(specs)]

        def wait(_):
            nonlocal finish_training
            if len(f.captured) == 5:
                unchanged_waits.append(len(f.captured))
                finish_training = len(unchanged_waits) == 3
            self.assertLess(len(unchanged_waits), 5)
            self.assertNotIn(len(f.captured), [1, 2, 3, 4])
            operator.tick(config, call=provider)

        with f.journal(config.driver) as (d, journal), operator.locked(config):
            self.assertEqual(f.run_driver(d, journal, sleep=wait), "complete_pending_independent_acceptance")
            self.assertEqual(journal.data["attempts"], 6)
            job = next(iter(journal.data["background_jobs"].values()))
            self.assertEqual(job["consumed"], job["latest"])
        self.assertEqual(unchanged_waits, [5, 5, 5])
        self.assertEqual(self.o.methods().count("execute"), 1)
        self.assertEqual(len(turns[2]["native_snapshot"]["workers"]), 2)
        self.assertTrue(all(t["binding"]["session"] == f.config_data["binding"]["session"] for t in turns))
        self.assertTrue(all(next(iter(t["background_jobs"].values()))["status"] != "succeeded" for t in turns[:5]))
        self.assertEqual(next(iter(turns[-1]["background_jobs"].values()))["status"], "succeeded")
        self.assertNotIn("background_events", turns[3]["action"])
        self.assertNotIn("background_events", turns[4]["action"])

    def test_pending_settlement_uses_pinned_frontier_then_receives_later_event(self):
        config, job = self.submitted()
        waiting = self.f.checkpoint("wait")
        self.f.script = [dict(record=waiting, artifact="submission independently checked", filename="accepted.txt"),
                         dict(decision="complete", artifact="terminal result independently reviewed", filename="review.txt")]
        with self.f.journal(config.driver) as (d, journal):
            with patch.object(driver, "settle_prepared", side_effect=KeyboardInterrupt), self.assertRaises(KeyboardInterrupt):
                self.f.run_driver(d, journal)
            old = copy.deepcopy(journal.data)
            operator.tick(config, call=self.query("succeeded"))
            self.assertEqual(read_json(d.root / "state.json"), old)
            self.assertEqual(self.f.run_driver(d, journal), "complete_pending_independent_acceptance")
            self.assertEqual(journal.data["attempts"], 2)
            self.assertEqual(len(self.f.captured), 2)
        self.assertEqual(self.o.methods().count("execute"), 1)

    def test_submit_crash_recovers_query_only_and_acknowledges_live_job(self):
        config = self.o.prepare(self.o.config())
        def crash(ref, request, **kwargs):
            reply = operator.invoke(ref, request, **kwargs)
            if request["method"] == "execute":
                raise KeyboardInterrupt()
            return reply
        with self.assertRaises(KeyboardInterrupt):
            operator.tick(config, call=crash)
        operator.tick(config)
        operator.tick(config)
        self.assertEqual(self.o.methods(), ["probe", "execute", "query"])
        self.assertEqual(handoff.observe(config.driver, self.o.entry)[2]["status"], "submitted")

    def test_head_publish_crash_recovers_query_only_and_terminal_is_sticky(self):
        config, job = self.submitted()
        original = background.replace_json
        def crash(target, value):
            original(target, value)
            raise KeyboardInterrupt()
        with patch.object(background, "replace_json", side_effect=crash), self.assertRaises(KeyboardInterrupt):
            operator.tick(config, call=self.query("succeeded"))
        with patch.object(operator, "invoke", side_effect=AssertionError("terminal queried")):
            operator.tick(config, call=lambda *a, **k: self.fail("terminal queried"))
        self.assertEqual(background.observe(config.driver, job)["status"], "succeeded")
        proof = self.f.cwd / "late-proof.json"
        publish_new(proof, {"late": True})
        with self.assertRaisesRegex(ValueError, "background_transition_invalid"):
            background.publish(config.driver, job, "running", [file_ref(proof)])

    def test_event_file_without_head_is_not_consumed_and_recovers_query_only(self):
        config, job = self.submitted()
        with patch.object(background, "replace_json", side_effect=KeyboardInterrupt), self.assertRaises(KeyboardInterrupt):
            operator.tick(config, call=self.query("succeeded"))
        self.assertEqual(len(list(self.o.directory.glob("background-*.json"))), 1)
        self.assertFalse((self.o.directory / "background-head.json").exists())
        self.assertEqual(background.observe(config.driver, job)["status"], "queued")
        operator.tick(config, call=self.query("succeeded"))
        view = background.observe(config.driver, job)
        self.assertEqual((view["status"], view["sequence"]), ("succeeded", 1))
        self.assertEqual(self.o.methods(), ["probe", "execute"])

    def test_submitted_report_crash_recovers_exact_job_before_query(self):
        config = self.o.prepare(self.o.config())
        original = operator.replace_json
        def crash(target, value):
            if value.get("phase") == "returning":
                raise KeyboardInterrupt()
            original(target, value)
        with patch.object(operator, "replace_json", side_effect=crash), self.assertRaises(KeyboardInterrupt):
            operator.tick(config)
        self.assertIsNone(self.o.state()["job"])
        self.assertEqual(operator.tick(config), "operator_result_ready")
        operator.tick(config, call=self.query("running"))
        self.assertEqual(self.o.state()["job"], "fixture-job-1")
        self.assertEqual(self.o.methods(), ["probe", "execute"])

    def test_unknown_recovery_is_local_bounded_and_keeps_reservation(self):
        config, job = self.submitted()
        calls = []
        def timeout(ref, request, **kwargs):
            calls.append(request["method"])
            raise subprocess.TimeoutExpired("fixture", 1)
        for _ in range(5):
            operator.tick(config, call=timeout)
        self.assertEqual(calls, ["query", "query"])
        self.assertEqual(self.o.state()["phase"], "background_stopped")
        self.assertEqual(background.observe(config.driver, job)["status"], "unknown")
        self.assertIsNone(read_json(config.driver.root / "state.json")["outcome"])
        self.assertFalse((config.driver.root / "operator-stop.json").exists())
        state = read_json(config.driver.root / "state.json")
        outstanding = operator.reservations(config, state)
        probe = operator.invoke(config.data["adapters"]["fixture"], dict(method="probe", operation_key="probe",
                                binding=config.driver.data["binding"]), cwd=str(self.f.cwd), timeout=1)
        self.assertEqual(operator.admission(config, probe, outstanding=outstanding, path_ids=["renamed-path"]),
                         "training_capacity_exhausted")
        self.assertEqual(operator.admission(config, probe, outstanding=outstanding, path_ids=["path"]),
                         "operator_background_path_occupied")
        probe.update(training_slots=0)
        self.assertIsNone(operator.admission(config, probe, outstanding=outstanding, path_ids=["research"]))

    def test_unknown_counter_crash_does_not_grant_extra_queries(self):
        config, job = self.submitted()
        with patch.object(background, "publish", side_effect=KeyboardInterrupt):
            for _ in range(2):
                with self.assertRaises(KeyboardInterrupt):
                    operator.tick(config, call=self.query("unknown"))
        operator.tick(config, call=lambda *a, **k: self.fail("exhausted Job queried"))
        self.assertEqual(background.observe(config.driver, job)["status"], "unknown")
        self.assertEqual(self.o.state()["phase"], "background_stopped")

    def test_live_job_cannot_disappear_satisfy_requirement_or_complete(self):
        config, job = self.submitted()
        jobs = {"job": background.observe(config.driver, job)}
        before = self.f.checkpoint("wait")
        for change in ({"paths": []}, {"decision": "complete"},
                       {"requirements": [dict(before["requirements"][0], status="met")]}):
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, "active_background_job_not_preserved"):
                background.guard(before | change, jobs, {})

    def test_terminal_requires_review_and_reservation_releases_only_after_review(self):
        config, job = self.submitted()
        operator.tick(config, call=self.query("succeeded"))
        with self.f.journal(config.driver) as (d, journal):
            background.collect(d, journal)
            jobs = background.views(d, journal.data)
            self.assertTrue(operator.reservations(config, journal.data))
            with self.assertRaisesRegex(ValueError, "background_result_not_reviewed"):
                background.guard(self.f.checkpoint("complete"), jobs, {})
            background.guard(self.f.checkpoint("complete"), jobs, background.events(d, journal.data))
            for job in journal.data["background_jobs"].values():
                job["consumed"] = job["latest"]
            self.assertEqual(operator.reservations(config, journal.data), [])

    def test_no_progress_does_not_consume_event(self):
        config, job = self.submitted()
        with self.f.journal(config.driver) as (d, journal):
            background.collect(d, journal)
            events = background.events(d, journal.data)
            action = dict(background_events=events)
            _, reviewed, paths = driver.background_review(d, journal.data, action, self.f.checkpoint("wait"),
                                                          {"status": "no_progress"}, set())
            self.assertEqual((reviewed, paths), ({}, set()))
            self.assertEqual(background.events(d, journal.data), events)

    def test_event_pin_and_rollback_are_rejected(self):
        config, job = self.submitted()
        operator.tick(config, call=self.query("running"))
        job["latest"] = background.observe(config.driver, job)["latest"]
        operator.tick(config, call=self.query("succeeded"))
        job["latest"] = background.observe(config.driver, job)["latest"]
        event = read_json(job["latest"]["path"])
        replace_json(self.o.directory / "background-head.json", {"event": event["previous"]})
        with self.assertRaisesRegex(ValueError, "background_history_rollback"):
            background.observe(config.driver, job)
        replace_json(self.o.directory / "background-head.json", {"event": job["latest"]})
        event["job"] = "another-job"
        self.f.write(Path(job["latest"]["path"]), event)
        with self.assertRaisesRegex(ValueError, "file_pin_changed"):
            background.observe(config.driver, job)

    def test_background_identity_failure_prevents_query(self):
        config, _ = self.submitted()
        with patch.object(driver, "observe_binding", side_effect=ValueError("run_ownership_changed")):
            with self.assertRaisesRegex(ValueError, "run_ownership_changed"):
                operator.tick(config, call=lambda *a, **k: self.fail("stale owner queried"))

    def test_manual_submission_is_not_automatically_adopted_or_zero_reserved(self):
        config = self.o.prepare(self.o.config())
        d = config.driver
        request = handoff.load_request(d, self.o.entry["request"])
        accepted = handoff.accept(d, self.o.entry, config.actor, skills_read=True)
        proof, report = config.evidence / "manual-proof.json", config.evidence / "manual-report.json"
        publish_new(proof, {"source": "manual operator", "job": "manual-job"})
        publish_new(report, {"status": "submitted", "evidence": [file_ref(proof)], "background": {
            "operation_key": digest(canonical({"driver": d.sha256, "action": request["action"]["action_sha256"]})),
            "job": "manual-job", "status": "running"}})
        handoff.return_result(d, self.o.entry, config.actor, accepted["sha256"], file_ref(report))
        self.assertEqual(operator.tick(config, call=lambda *a, **k: self.fail("manual Job adopted")),
                         "operator_result_ready")
        self.assertFalse((self.o.directory / "executor.json").exists())
        outstanding = operator.reservations(config, read_json(d.root / "state.json"))
        self.assertEqual(len(outstanding), 1)
        self.assertIsNone(outstanding[0]["reservation"])
        probe = operator.invoke(config.data["adapters"]["fixture"], dict(method="probe", operation_key="probe",
                                binding=d.data["binding"]), cwd=str(self.f.cwd), timeout=1)
        self.assertEqual(operator.admission(config, probe, outstanding=outstanding, path_ids=["unrelated"]),
                         "operator_background_reservation_unknown")

    def test_watch_projection_exposes_only_journaled_refs_without_consuming_events(self):
        config, job = self.submitted()
        operator.tick(config, call=self.query("running"))
        with self.f.journal(config.driver) as (d, journal):
            background.collect(d, journal)
            operator.tick(config, call=self.query("succeeded"))
            b = d.data["binding"]
            watch = {k: b[k] for k in ("runtime", "run", "terminal", "incarnation", "workspace")}
            watch.update(expected_generation=b["generation"], driver_binding={"path": d.filename, "sha256": d.sha256})
            state_before = (d.root / "state.json").read_bytes()
            with patch.object(coordinator_state.Journal, "save", side_effect=AssertionError("watch wrote state")):
                _, projected = coordinator_state.follow_launch(watch, {})
            self.assertEqual(projected["background_jobs"], journal.data["background_jobs"])
            self.assertEqual((d.root / "state.json").read_bytes(), state_before)
            self.assertEqual(next(iter(background.views(d, journal.data).values()))["status"], "running")
            self.assertEqual(background.observe(d, job)["status"], "succeeded")
            self.assertTrue(all(j["consumed"] is None for j in projected["background_jobs"].values()))

    def test_old_schemas_and_missing_completion_are_explicitly_rejected(self):
        self.o.data["schema_version"] = 1
        with self.assertRaisesRegex(ValueError, "invalid_operator_config"):
            self.o.config()
        self.o.data["schema_version"] = 2
        del self.o.data["routes"]["path"]["completion"]
        with self.assertRaisesRegex(ValueError, "operator_route_not_reviewed"):
            self.o.config()
        self.f.config_data["schema_version"] = 4
        with self.assertRaisesRegex(ValueError, "invalid_driver_config"):
            self.f.config()


if __name__ == "__main__":
    unittest.main()

"""Offline Operator integration; no real runtime, model or training submissions."""

from contextlib import redirect_stdout
import io
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

import coordinator_driver as driver
import coordinator_handoff as handoff
import coordinator_operator as operator
from coordinator_io import file_ref, now, publish_new, read_json
import coordinator.test_coordinator_driver as fixtures


# Run the pinned program in a real isolated subprocess. Its only writes are to
# this test's temporary provider state; no external commands or services exist.
ADAPTER = '''
import datetime, json, pathlib, sys
request = json.load(sys.stdin)
target = pathlib.Path(PROVIDER_STATE)
state = json.loads(target.read_text()) if target.exists() else {"methods":[],"keys":[]}
method = request["method"]
state["methods"].append(method)
state["keys"].append(request["operation_key"])
target.write_text(json.dumps(state))
if method == "probe":
    reply = {"scope":request["binding"]["run"],"complete":True,
      "observed_at":datetime.datetime.now(datetime.timezone.utc).isoformat(),
      "used":{"tokens":10,"cost_micro_usd":100},
      "reserved":{"tokens":0,"cost_micro_usd":0},
      "estimate":{"tokens":5,"cost_micro_usd":50},
      "active_training_trials":0,"training_slots":1}
else:
    status = "queued" if method == "execute" else (
        "running" if state["methods"].count("query") == 1 else "succeeded")
    reply = {"operation_key":request["operation_key"],"status":status,
             "job":"fixture-job-1","evidence":{"source":"test-provider","status":status}}
print(json.dumps(reply))
'''


class OperatorTests(unittest.TestCase):
    def setUp(self):
        self.f = fixtures.DriverTests()
        self.f.setUp()
        self.addCleanup(self.f.doCleanups)
        self.record = self.f.checkpoint("continue", self.f.start + fixtures.timedelta(seconds=1))
        self.record["next_action"]["owner"] = "outer-operator"
        self.f.initial(self.record)
        self.provider = self.f.root / "provider.json"
        adapter = self.f.root / "adapter.py"
        self.f.write(adapter, "PROVIDER_STATE = " + repr(str(self.provider)) + "\n" + ADAPTER)
        evidence = self.f.cwd / "operator-evidence"
        evidence.mkdir()
        self.config_file = self.f.root / "operator.json"
        self.data = {"schema_version": 2, "enabled": True, "driver_binding": None,
            "adapters": {"fixture": file_ref(adapter)},
            "routes": {"path": {"operation": "produce verified source", "adapter": "fixture",
                                "kinds": ["implement", "wait"], "completion": "terminal"}},
            "evidence_root": str(evidence), "budget": {"run_started_at": self.f.start.isoformat(),
                "deadline_at": None, "max_tokens": 100, "max_cost_micro_usd": 1000},
            "poll_seconds": 1, "rpc_timeout_seconds": 1, "max_unknown_polls": 2}
        self.addCleanup(patch.stopall)
        patch.object(driver, "observe_binding", return_value=self.f.snapshot).start()

    def config(self):
        d = self.f.config()
        self.data["driver_binding"] = {"path": d.filename, "sha256": d.sha256}
        self.f.write(self.config_file, self.data)
        return operator.Config(str(self.config_file), file_ref(self.config_file)["sha256"])

    def prepare(self, config):
        with self.f.journal(config.driver) as (d, journal):
            driver.initialize(d, journal, self.f.snapshot)
            action = driver.obligation(d, journal.data["current"]["checkpoint"], self.record,
                                       1, executor="outer-operator")
            self.entry = handoff.prepare(d, journal, action)
        self.directory = Path(self.entry["request"]["path"]).parent
        return config

    def state(self):
        return read_json(self.directory / "executor.json")

    def methods(self):
        return read_json(self.provider)["methods"] if self.provider.exists() else []

    @staticmethod
    def reply(request, status="unknown", job=None):
        return {"operation_key": request["operation_key"], "status": status, "job": job,
                "evidence": {"fixture": True}}

    def cli(self, config, *args):
        output = io.StringIO()
        with redirect_stdout(output):
            code = operator.main(["--config", config.ref["path"], "--config-sha256",
                                  config.ref["sha256"], *args])
        return code, output.getvalue()

    def test_real_adapter_executes_once_waits_then_original_coordinator_reviews(self):
        config = self.config()
        self.f.script = [{"artifact": "independent review", "decision": "complete"}]
        statuses = []
        with self.f.journal(config.driver) as (d, journal), operator.locked(config):
            def wait(_):
                self.assertEqual(self.f.captured, [])
                statuses.append(operator.tick(config))
                self.assertLess(len(statuses), 8)
            self.assertEqual(self.f.run_driver(d, journal, sleep=wait),
                             "complete_pending_independent_acceptance")
            receipt = read_json(d.root / "turn-000001/action-receipt.json")
            self.assertEqual(receipt["action"]["mode"], "review_operator_result")
            self.assertEqual(receipt["binding"]["session"], fixtures.SID)
        self.assertEqual(statuses, ["waiting", "waiting", "returning", "operator_result_ready"])
        self.assertEqual(self.methods(), ["probe", "execute", "query", "query"])
        self.assertEqual(len(set(read_json(self.provider)["keys"])), 1)

    def test_wait_only_never_probes_or_executes(self):
        self.record = self.f.checkpoint("wait", self.f.start + fixtures.timedelta(seconds=1))
        self.record["next_action"]["owner"] = "outer-operator"
        self.f.initial(self.record)
        config = self.prepare(self.config())
        for _ in range(3):
            operator.tick(config)
        self.assertEqual(self.methods(), ["query", "query"])
        self.assertEqual(handoff.observe(config.driver, self.entry)[2]["status"], "executed")

    def test_interrupt_after_submit_recovers_by_key_without_resubmitting(self):
        config = self.prepare(self.config())
        def crash(ref, request, **kwargs):
            result = operator.invoke(ref, request, **kwargs)
            if request["method"] == "execute":
                raise KeyboardInterrupt()
            return result
        with self.assertRaises(KeyboardInterrupt):
            operator.tick(config, call=crash)
        self.assertEqual(self.state()["phase"], "executing")
        self.assertIsNone(self.state()["job"])
        for _ in range(3):
            operator.tick(config)
        self.assertEqual(self.methods().count("execute"), 1)
        self.assertEqual(handoff.observe(config.driver, self.entry)[0], "operator_result_ready")

    def test_report_publish_crash_returns_exact_report_without_another_query(self):
        config = self.prepare(self.config())
        original = operator.replace_json
        def crash(target, value):
            if value["phase"] == "returning":
                raise KeyboardInterrupt()
            original(target, value)
        with patch.object(operator, "replace_json", side_effect=crash):
            operator.tick(config)
            operator.tick(config)
            with self.assertRaises(KeyboardInterrupt):
                operator.tick(config)
        report = file_ref(self.directory / "executor-report.json")
        calls = self.methods()
        self.assertEqual(operator.tick(config), "operator_result_ready")
        self.assertEqual(self.methods(), calls)
        self.assertEqual(read_json(self.directory / "result.json")["report"], report)

    def test_return_receipt_crash_does_not_return_twice(self):
        config = self.prepare(self.config())
        for _ in range(3):
            operator.tick(config)
        original = handoff.return_result
        def crash(*args):
            original(*args)
            raise KeyboardInterrupt()
        with patch.object(handoff, "return_result", side_effect=crash), self.assertRaises(KeyboardInterrupt):
            operator.tick(config)
        self.assertEqual(operator.tick(config), "operator_result_ready")
        self.assertEqual(self.methods().count("execute"), 1)

    def test_timeout_reconciliation_is_bounded_and_returned_unknown(self):
        config = self.prepare(self.config())
        def timeout(ref, request, **kwargs):
            if request["method"] == "probe":
                return operator.invoke(ref, request, **kwargs)
            raise subprocess.TimeoutExpired("fixture", 1)
        self.assertEqual(operator.tick(config, call=timeout), "executing")
        self.assertEqual(operator.tick(config, call=timeout), "returning")
        self.assertEqual(operator.tick(config, call=timeout), "operator_outcome_unknown_requires_reconciliation")
        self.assertEqual(operator.tick(config), "operator_outcome_unknown_requires_reconciliation")

    def test_unknown_query_does_not_replay_execute(self):
        config = self.prepare(self.config())
        operator.tick(config)
        methods = []
        def unknown(ref, request, **kwargs):
            methods.append(request["method"])
            return self.reply(request, job="fixture-job-1")
        for _ in range(3):
            operator.tick(config, call=unknown)
        self.assertEqual(methods, ["query", "query"])
        self.assertEqual(handoff.observe(config.driver, self.entry)[2]["status"], "unknown")

    def test_changed_job_latches_stop(self):
        config = self.prepare(self.config())
        operator.tick(config)
        def changed(ref, request, **kwargs):
            return self.reply(request, "succeeded", "other-job")
        with self.assertRaisesRegex(ValueError, "operator_job_changed"):
            operator.tick(config, call=changed)
        self.assertEqual(operator.tick(config), "operator_stopped")
        self.assertEqual(self.methods().count("execute"), 1)

    def test_incomplete_stale_or_unknown_usage_never_submits(self):
        config = self.prepare(self.config())
        def incomplete(ref, request, **kwargs):
            reply = operator.invoke(ref, request, **kwargs)
            reply["complete"] = False
            return reply
        with self.assertRaisesRegex(ValueError, "operator_usage_incomplete"):
            operator.tick(config, call=incomplete)
        self.assertEqual(self.methods(), ["probe"])
        self.assertEqual(operator.tick(config), "operator_stopped")

    def test_budget_refusal_returns_not_executed_for_coordinator_to_decide(self):
        self.data["budget"]["max_tokens"] = 12
        config = self.prepare(self.config())
        self.assertEqual(operator.tick(config), "returning")
        operator.tick(config)
        self.assertEqual(handoff.observe(config.driver, self.entry)[2]["status"], "not_executed")
        self.assertEqual(self.methods(), ["probe"])

    def test_admission_counts_reservations_cost_capacity_and_requires_fresh_complete_usage(self):
        config = self.config()
        base = {"scope": "run_test", "observed_at": now(), "complete": True,
                "used": {"tokens": 10, "cost_micro_usd": 100},
                "reserved": {"tokens": 80, "cost_micro_usd": 800},
                "estimate": {"tokens": 20, "cost_micro_usd": 200},
                "active_training_trials": 0, "training_slots": 1}
        self.assertEqual(operator.admission(config, base), "operator_tokens_budget_exhausted")
        base["estimate"]["tokens"] = 0
        self.assertEqual(operator.admission(config, base), "operator_cost_micro_usd_budget_exhausted")
        base["active_training_trials"] = 1
        self.assertEqual(operator.admission(config, base), "training_capacity_exhausted")
        for changes, error in [({"observed_at": (self.f.start - fixtures.timedelta(days=1)).isoformat()}, "usage_stale"),
                ({"active_training_trials": None}, "occupancy_unknown"),
                ({"used": {"tokens": None, "cost_micro_usd": 1}}, "usage_unknown")]:
            with self.subTest(changes=changes), self.assertRaisesRegex(ValueError, error):
                operator.admission(config, base | changes)

    def test_deadline_never_restarts_on_resume(self):
        self.data["budget"]["deadline_at"] = self.f.end.isoformat()
        config = self.prepare(self.config())
        operator.tick(config)
        operator.tick(config)
        self.assertEqual(self.methods(), [])
        self.assertEqual(handoff.observe(config.driver, self.entry)[2]["status"], "not_executed")

    def test_manual_claim_is_not_adopted(self):
        config = self.prepare(self.config())
        handoff.accept(config.driver, self.entry, config.actor, skills_read=True)
        with self.assertRaisesRegex(ValueError, "operator_claim_owned_elsewhere"):
            operator.tick(config)
        self.assertEqual(self.methods(), [])

    def test_claim_crash_does_not_adopt_unrecorded_acceptance(self):
        config = self.prepare(self.config())
        original = driver.operator_command
        def crash(*args):
            original(*args)
            raise KeyboardInterrupt()
        with patch.object(driver, "operator_command", side_effect=crash), self.assertRaises(KeyboardInterrupt):
            operator.tick(config)
        with self.assertRaisesRegex(ValueError, "operator_claim_recovery_required"):
            operator.tick(config)
        self.assertEqual(self.methods(), [])

    def test_pins_lock_and_stop(self):
        config = self.prepare(self.config())
        with operator.locked(config):
            with self.assertRaises(BlockingIOError), operator.locked(config):
                pass
        publish_new(config.driver.root / "STOP", {"reason": "test"})
        self.assertEqual(operator.tick(config), "driver_stopped")
        self.assertEqual(self.methods(), [])
        self.f.write(Path(self.data["adapters"]["fixture"]["path"]), "changed")
        with self.assertRaisesRegex(ValueError, "file_pin_changed"):
            config.revalidate()

    def test_default_cli_is_offline_and_disabled_execution_is_rejected(self):
        self.data["enabled"] = False
        config = self.config()
        code, output = self.cli(config)
        self.assertEqual(code, 0)
        self.assertIn("no_execution", output)
        self.assertFalse(config.driver.root.exists())
        with self.assertRaisesRegex(ValueError, "operator_disabled"):
            self.cli(config, "--execute", "--confirm-skill-read", "--once")

    def test_cli_native_denial_persists_stop_without_retry(self):
        config = self.prepare(self.config())
        with patch.object(driver, "observe_binding", side_effect=ValueError("runtime_access_denied")) as observe:
            self.assertEqual(self.cli(config, "--execute", "--confirm-skill-read", "--once")[0], 2)
            self.assertEqual(self.cli(config, "--execute", "--confirm-skill-read", "--once")[0], 2)
            self.assertEqual(observe.call_count, 1)
        self.assertTrue((config.driver.root / "operator-stop.json").exists())
        self.assertEqual(self.methods(), [])

    def test_exact_route_required(self):
        self.data["routes"]["path"]["operation"] = "submit anything"
        with self.assertRaisesRegex(ValueError, "operator_route_not_reviewed"):
            self.config()

    def test_wait_does_not_bypass_original_operation_permission(self):
        self.record = self.f.checkpoint("wait", self.f.start + fixtures.timedelta(seconds=1))
        self.record["next_action"]["owner"] = "outer-operator"
        self.f.initial(self.record)
        catalog = read_json(self.f.catalog_file)
        catalog["paths"][0]["permissions"] = ["training"]
        self.f.write(self.f.catalog_file, catalog)
        self.f.config_data["authority"]["path_catalog"] = self.f.json_ref(self.f.catalog_file)
        config = self.prepare(self.config())
        with self.assertRaisesRegex(ValueError, "operator_operation_not_authorized"):
            operator.tick(config)
        self.assertEqual(self.methods(), [])

    def test_authority_token_and_time_caps_cannot_be_increased(self):
        ledger = read_json(self.f.ledger_file)
        fields = ledger["events"][0]["patch"]
        fields["limits.tokens"] = {"mode": "bounded", "value": 50}
        fields["limits.time_seconds"] = {"mode": "bounded", "value": 60}
        self.f.write(self.f.ledger_file, ledger)
        pin = self.f.json_ref(self.f.ledger_file)["sha256"]
        for target in (self.f.handoff_file, self.f.catalog_file):
            value = read_json(target)
            value["authority_sha256"] = pin
            if "fields" in value:
                value["fields"] = fields
            self.f.write(target, value)
        self.f.config_data["authority"].update(ledger=self.f.json_ref(self.f.ledger_file),
            handoff=self.f.json_ref(self.f.handoff_file), path_catalog=self.f.json_ref(self.f.catalog_file))
        with self.assertRaisesRegex(ValueError, "operator_budget_exceeds_authority"):
            self.config()
        self.data["budget"]["max_tokens"] = 50
        with self.assertRaisesRegex(ValueError, "operator_budget_exceeds_authority"):
            self.config()
        self.data["budget"]["deadline_at"] = (self.f.start + fixtures.timedelta(seconds=60)).isoformat()
        self.config()

    def test_malformed_provider_reply_is_not_retried(self):
        config = self.prepare(self.config())
        operator.tick(config)
        with self.assertRaisesRegex(ValueError, "operator_adapter_reply_invalid"):
            operator.tick(config, call=lambda *a, **k: {"status": "succeeded"})
        self.assertEqual(operator.tick(config), "operator_stopped")

    def test_stop_between_probe_and_execute_prevents_submission(self):
        config = self.prepare(self.config())
        def stop(ref, request, **kwargs):
            reply = operator.invoke(ref, request, **kwargs)
            publish_new(config.driver.root / "STOP", {"reason": "test"})
            return reply
        with self.assertRaisesRegex(ValueError, "operator_driver_not_active"):
            operator.tick(config, call=stop)
        self.assertEqual(self.methods(), ["probe"])

    def test_failed_operation_returns_to_coordinator_then_research_continues(self):
        config = self.prepare(self.config())
        def fail(ref, request, **kwargs):
            if request["method"] == "probe":
                return operator.invoke(ref, request, **kwargs)
            return self.reply(request, "failed", "failed-job")
        operator.tick(config, call=fail)
        operator.tick(config, call=fail)
        self.f.script = [{"artifact": "negative evidence analyzed, alternative selected"},
                         {"artifact": "alternative experiment checked", "decision": "complete"}]
        with self.f.journal(config.driver) as (d, journal):
            self.assertEqual(self.f.run_driver(d, journal), "complete_pending_independent_acceptance")
            self.assertEqual(journal.data["attempts"], 2)
            receipt = read_json(d.root / "turn-000001/action-receipt.json")
            self.assertEqual(receipt["operator_handoff"]["report"]["status"], "failed")

    def test_existing_operator_config_binding_cannot_be_replaced(self):
        config = self.prepare(self.config())
        with operator.locked(config):
            pass
        self.data["poll_seconds"] = 2
        changed = self.config()
        with self.assertRaisesRegex(ValueError, "operator_config_changed"), operator.locked(changed):
            pass

    def test_returned_report_cannot_be_changed_on_restart(self):
        config = self.prepare(self.config())
        for _ in range(3):
            operator.tick(config)
        target = self.directory / "executor-report.json"
        changed = read_json(target)
        changed["status"] = "failed"
        self.f.write(target, changed)
        with self.assertRaisesRegex(ValueError, "operator_report_changed"):
            operator.tick(config)

    def test_ready_state_without_acceptance_is_never_executed(self):
        config = self.prepare(self.config())
        with patch.object(driver, "operator_command", side_effect=KeyboardInterrupt), self.assertRaises(KeyboardInterrupt):
            operator.tick(config)
        target = self.directory / "executor.json"
        changed = read_json(target)
        changed["phase"] = "ready"
        self.f.write(target, changed)
        with self.assertRaisesRegex(ValueError, "operator_acceptance_changed"):
            operator.tick(config)
        self.assertEqual(self.methods(), [])


if __name__ == "__main__":
    unittest.main()

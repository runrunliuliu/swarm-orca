"""Static adapter compatibility and software control-chain regressions."""

import copy
import os
from datetime import timedelta
from pathlib import Path
import unittest
from unittest.mock import patch

from coordinator_domain import SOFTWARE, selection
from coordinator_io import canonical, digest, now, read_json, replace_json, timestamp
from coordinator_startup import build_session_contract, identity, validate
from coordinator_tui_checkpoint import validate_record
from coordinator_tui_continue import load, validate_config
from coordinator_tui_prepare import prepare, validate_inputs
from test_software_development import SoftwareFixture
import test_coordinator_tui_continue as continuation
import test_coordinator_tui_scheduler as scheduler
import test_coordinator_tui_workflow as workflow


class DomainTests(unittest.TestCase):
    def setUp(self):
        self.f = continuation.ContinuationTests()
        self.f.setUp()
        self.addCleanup(self.f.doCleanups)

    def software(self):
        self.s = SoftwareFixture(self.f)
        self.s.publish()
        return self.s

    def test_legacy_rsi_unchanged_and_unknown_adapter_refused(self):
        self.assertEqual(selection(self.f.config, self.f.c), "rsi-authorized-progress-v1")
        validate_record(self.f.record, self.f.config, self.f.c)
        self.f.record["domain_check"]["adapter"] = SOFTWARE
        with self.assertRaisesRegex(ValueError, "adapter_unsupported"):
            validate_record(self.f.record, self.f.config, self.f.c)

    def test_software_config_and_startup_identity(self):
        before = digest(canonical(identity(self.f.c)))
        self.software()
        self.assertNotEqual(before, digest(canonical(identity(self.f.c))))
        validate_config(self.f.config)
        validate_record(self.f.record, self.f.config, self.f.c)
        fields = {k: v for k, v in self.f.c.items() if k not in ("schema_version", "freshness", "run")}
        session = build_session_contract(fields)
        self.assertEqual(session["domain_binding"], self.f.config["domain_binding"])
        self.assertEqual(identity(dict(self.f.c, run=None)), identity(self.f.c))
        self.assertEqual(identity(session)["domain_binding"], self.s.binding)

    def test_deletion_cannot_downgrade_config_or_startup(self):
        self.software()
        for mutation in ("config", "startup", "both"):
            config, contract = copy.deepcopy(self.f.config), copy.deepcopy(self.f.c)
            if mutation in ("config", "both"):
                del config["domain_binding"]
            if mutation in ("startup", "both"):
                del contract["domain_binding"]
            with self.subTest(mutation=mutation), self.assertRaisesRegex(ValueError, "binding_changed"):
                if mutation == "both":
                    validate(contract)
                else:
                    selection(config, contract)

    def test_conflicting_binding_and_rsi_fields(self):
        self.software()
        self.f.config["authority_binding"] = {}
        with self.assertRaisesRegex(ValueError, "conflict"):
            validate_config(self.f.config)
        del self.f.config["authority_binding"]
        self.f.config["domain_binding"]["adapter"] = "unknown"
        with self.assertRaisesRegex(ValueError, "binding_changed"):
            validate_config(self.f.config)

    def test_projection_and_forged_receipt_refused(self):
        self.software()
        original = copy.deepcopy(self.f.record)
        self.f.record["checkpoint"]["next_action"]["id"] = "forged"
        with self.assertRaisesRegex(ValueError, "projection_mismatch"):
            validate_record(self.f.record, self.f.config, self.f.c)
        self.f.record = original
        self.f.record["domain_check"]["receipt"] = self.s.put(dict(ok=True, consistent=True))
        with self.assertRaisesRegex(ValueError, "receipt_mismatch"):
            validate_record(self.f.record, self.f.config, self.f.c)

    def inputs(self):
        self.f.t.f.bootstrap.chmod(0o700)
        return dict({k: self.f.config[k] for k in ("contract", "dispatch_gate", "acceptance", "deadline", "scheduler", "domain_binding")},
                    schema_version=2, output_dir=str(self.f.t.f.bootstrap / "software-prepared"),
                    **{k: self.f.record["domain_check"][k] for k in ("source", "receipt")})

    def test_prepare_versioned_software_publishes_last(self):
        self.software()
        result = prepare(self.s.put(self.inputs()), call=self.f.query)
        config, _, _ = load(result["config"])
        self.assertEqual(config["domain_binding"], self.s.binding)
        self.assertEqual(config["schema_version"], 2)
        self.assertEqual(read_json(result["publication"]["path"]), result["config"])
        self.assertFalse(self.f.sends)

    def test_prepare_rejects_downgrade_and_stale_current_tree(self):
        self.software()
        inputs = self.inputs()
        inputs["schema_version"] = 1
        with self.assertRaisesRegex(ValueError, "domain_version_required"):
            validate_inputs(inputs)
        inputs["schema_version"] = 2
        self.s.code.write_text("value = 2\n")
        with self.assertRaisesRegex(ValueError, "snapshot_changed"):
            prepare(self.s.put(inputs), call=self.f.query)
        self.assertFalse(Path(inputs["output_dir"]).exists())

    def test_previous_turn_refused_before_prepare_publication(self):
        self.software()
        self.s.source["observed_at"] = (timestamp(now()) - timedelta(minutes=1)).isoformat()
        ref = self.s.put(self.s.source)
        import software_development
        self.f.record["domain_check"].update(source=ref, receipt=self.s.put(software_development.check(self.s.binding, self.f.c, ref)))
        inputs = self.inputs()
        with self.assertRaisesRegex(ValueError, "not_from_current_turn"):
            prepare(self.s.put(inputs), call=self.f.query)
        self.assertFalse(Path(inputs["output_dir"]).exists())

    def test_strict_start_original_objective_workers_and_request_deadline(self):
        from coordinator_strict_start import validate_inputs as start_inputs
        from coordinator_request_prepare import source_contract_fields
        self.software()
        contract = dict(self.f.c, run=None)
        config = dict(schema_version=1, contract=self.f.config["contract"],
                      caller_receipt=contract["observation"]["caller_receipt"],
                      readiness_evidence=[contract["skill_read_evidence"]], directory=str(self.s.archive),
                      objective=self.s.task["objective"], max_workers=self.s.task["policy"]["max_workers"],
                      deadline=self.f.config["deadline"], request_id="00000000-0000-0000-0000-000000000001")
        start_inputs(config, contract)
        for key, value in (("objective", "different task"), ("max_workers", 2)):
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "startup_task_changed"):
                start_inputs(dict(config, **{key: value}), contract)
        fields = {k: v for k, v in contract.items() if k not in ("schema_version", "freshness")}
        expected = {k: fields[k] for k in ("cli", "runtime", "workspace", "coordinator")}
        expected.update(readiness_evidence=config["readiness_evidence"], task_deadline=self.s.task["policy"]["deadline"])
        source_contract_fields(expected, fields)
        expected["task_deadline"] = "2999-01-01T00:00:00+00:00"
        with self.assertRaisesRegex(ValueError, "deadline_changed"):
            source_contract_fields(expected, fields)

    def test_partial_prepare_retains_attempt_without_publication(self):
        from coordinator_io import publish_new
        self.software()
        inputs = self.inputs()
        output = Path(inputs["output_dir"])
        def interrupted(target, value):
            if target.name == "continuation.json":
                raise OSError("simulated publication failure")
            return publish_new(target, value)
        with patch("coordinator_tui_prepare.publish_new", side_effect=interrupted):
            with self.assertRaises(OSError):
                prepare(self.s.put(inputs), call=self.f.query)
        self.assertTrue((output / "initialization-intent.json").exists())
        self.assertFalse((output / "continuation-ref.json").exists())
        with self.assertRaisesRegex(ValueError, "already_started_preserve"):
            prepare(self.s.put(inputs), call=self.f.query)

    def test_source_receipt_and_acceptance_scope_before_read(self):
        import coordinator_io
        self.software()
        outsider = self.f.t.ref("outside-software.json", {"private": "must not be read"})
        for key in ("source", "receipt", "acceptance"):
            record, config = copy.deepcopy(self.f.record), copy.deepcopy(self.f.config)
            if key == "acceptance":
                config[key] = outsider
            else:
                record["domain_check"][key] = outsider
            with self.subTest(key=key), patch("coordinator_io.read_bytes", wraps=coordinator_io.read_bytes) as reader:
                with self.assertRaises(ValueError):
                    if key == "acceptance":
                        validate_config(config)
                    else:
                        validate_record(record, config, self.f.c)
                self.assertNotIn(outsider["path"], [str(c.args[0]) for c in reader.call_args_list])


class SoftwareChainTests(unittest.TestCase):
    def setUp(self):
        self.s = scheduler.SchedulerTests()
        self.s.setUp()
        self.addCleanup(self.s.doCleanups)
        self.d = SoftwareFixture(self.s.f)
        self.s.f.config["scheduler"] = self.s.m.sender
        self.s.f.config["turn_protocol"] = "workflow-v2"
        self.s.f.config_ref = self.s.f.t.ref("software-scheduled-config.json", self.s.f.config)
        self.s.m.data["continuation"] = self.s.f.config_ref
        self.s.m.config = self.s.m.configure()
        self.d.publish()
        self.end_turn()

    def end_turn(self):
        self.s.ended = dict(thread_id=self.s.f.c["coordinator"]["session"], completed_turn=dict(
            turn_id=f"software-turn-{self.d.counter}", context_at=(timestamp(self.d.source["observed_at"]) - timedelta(milliseconds=1)).isoformat(),
            completed_at=now(), prefix_bytes=self.d.counter, prefix_sha256="a" * 64))

    def test_workflow_settle_ack_turn_end_then_next_scheduler_cycle(self):
        self.assertEqual(self.s.tick()["state"], "continuation_enqueued")
        w = workflow.WorkflowTests()
        w.init_workflow(self.s)
        self.addCleanup(w.doCleanups)
        self.assertTrue(w.begin()["execute_action"])
        self.assertFalse(w.begin()["execute_action"])
        proof = self.d.put({"execution": "fixture"})
        w.result = self.d.put(dict(action_id=w.action_id, checkpoint=w.old, status="executed", evidence=[proof]))
        w.processed = self.d.put(dict(delivery_id=w.delivery["deliveryId"], messages=[
            dict(id=w.delivery["messages"][0]["id"], evidence=[w.result]), dict(id="fact-extra", evidence=[proof])]))
        # A real file change exercises historical settlement (not a copied RSI source).
        before = digest(self.d.code.read_bytes())
        self.d.code.write_text("value = 2\n")
        self.d.source["snapshot"] = self.d.freeze()
        self.d.source["changes"] = [dict(path=str(self.d.code), operation="modify", before=before,
                                         after=digest(self.d.code.read_bytes()))]
        self.d.complete(only_first=True)
        w.next_ref = self.d.publish()
        replace_json(Path(self.s.f.config["checkpoint_head"]), w.old)
        w.receipt_path = self.d.archive / "workflow-complete.json"
        result = w.finish()
        self.assertTrue(w.acked)
        self.assertEqual(result["state"], "submitted")
        self.end_turn()
        with patch.dict(os.environ, self.s.m.environment, clear=True):
            self.assertEqual(self.s.tick()["state"], "continuation_enqueued")

    def test_changed_owner_still_blocks_software(self):
        self.s.m.run["coordinator_handle"] = "different-owner"
        with self.assertRaisesRegex(ValueError, "coordinator_changed"):
            self.s.tick()
        self.assertFalse(self.s.m.messages)


if __name__ == "__main__":
    unittest.main()

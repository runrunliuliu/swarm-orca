"""Initialization exercises production validators; native reads are fixtures."""

from datetime import timedelta
from pathlib import Path
import shlex
import sys
import unittest
from unittest.mock import patch

from coordinator_io import canonical, digest, file_ref, now, read_json, replace_json, timestamp
from coordinator_tui_continue import load
from coordinator_tui_prepare import prepare
from trae_coordinator import ContextFreshnessError
import test_coordinator_tui_continue as continuation


class PrepareTests(unittest.TestCase):
    def setUp(self):
        self.f = continuation.ContinuationTests()
        self.f.setUp()
        self.addCleanup(self.f.doCleanups)
        f = self.f
        source_ref = f.record["domain_check"]["source"]
        source = read_json(source_ref["path"])
        source["observed_at"] = now()
        replace_json(Path(source_ref["path"]), source)
        receipt_ref = f.record["domain_check"]["receipt"]
        receipt = read_json(receipt_ref["path"])
        receipt["authority_check"]["checkpoint_sha256"] = digest(canonical(source))
        replace_json(Path(receipt_ref["path"]), receipt)
        self.output = f.t.f.bootstrap / "prepared"
        f.t.f.bootstrap.chmod(0o700)
        self.inputs = {k: f.config[k] for k in ("contract", "dispatch_gate", "acceptance", "deadline")}
        self.inputs.update(schema_version=1, source=file_ref(source_ref["path"]),
            receipt=file_ref(receipt_ref["path"]), output_dir=str(self.output),
            scheduler=dict(terminal="term_sender", incarnation="inc_sender", workspace="ws_sender"))

    def prepare(self):
        ref = self.f.t.ref("bootstrap/init-inputs.json", self.inputs)
        return prepare(ref, call=self.f.query)

    def test_initialization_publishes_loadable_schema2_without_send(self):
        result = self.prepare()
        self.assertEqual(result["state"], "initialized")
        self.assertEqual(read_json(self.output / "continuation-ref.json"), result["config"])
        config, contract, root = load(result["config"])
        self.assertEqual(config["schema_version"], 2)
        self.assertEqual(read_json(root / "tui-continuation-binding.json"), result["config"])
        self.assertFalse((root / "outbox.json").exists())
        self.assertEqual(self.f.sends, [])
        self.assertFalse(result["execution_authorized"])
        self.assertEqual(shlex.split(result["turn_end_command"]), [str(Path(sys.executable).resolve()),
            str(Path(__file__).resolve().parents[1] / "coordinator_tui_continue.py"),
            "turn-end", "--config", result["config"]["path"], "--config-sha256", result["config"]["sha256"]])
        self.assertIn("turn_end_audit", result["next_step"])
        readiness = result["continuation_readiness"]
        self.assertTrue(readiness["continuation_config_ready"])
        self.assertEqual(readiness["continuation_config"], result["config"])
        self.assertTrue(readiness["checkpoint_head_ready"])
        self.assertEqual(readiness["checkpoint_head"], file_ref(self.output / "checkpoint-head.json"))
        self.assertEqual(readiness["initial_checkpoint"], result["checkpoint"])
        self.assertTrue(readiness["state_binding_ready"])
        self.assertEqual(readiness["state_binding"], file_ref(self.output / "state" / "tui-continuation-binding.json"))
        self.assertTrue(readiness["monitor_deploy_required"])
        self.assertTrue(readiness["turn_end_audit_required"])
        self.assertTrue(readiness["scheduler_first_checkpoint_required"])
        self.assertEqual(readiness["scheduler_completion_condition"], "claim_action_settle_ack_next_checkpoint")
        self.assertEqual(readiness["live4_completion_condition"],
                         "two_complete_scheduler_cycles_after_real_turn_end")
        from operator_monitor_deploy import prepare as monitor_prepare
        state, output = self.f.t.f.bootstrap / "monitor-state", self.f.t.f.bootstrap / "monitor-out"
        state.mkdir(mode=0o700)
        output.mkdir(mode=0o700)
        with patch("progress_watch.CLI", contract["cli"]["path"]):
            plan = monitor_prepare(result["config"], str(state), str(output),
                call=lambda args, runtime, timeout: self.f.query(contract["cli"]["path"], runtime, args))
        self.assertTrue(Path(plan["path"]).is_file())

    def test_existing_success_or_partial_attempt_is_never_reset(self):
        self.output.mkdir(mode=0o700)
        with self.assertRaisesRegex(ValueError, "already_started"):
            self.prepare()
        self.assertEqual(list(self.output.iterdir()), [])

    def test_workflow_protocol_is_explicit_and_preserved(self):
        self.inputs["turn_protocol"] = "workflow-v2"
        result = self.prepare()
        config, _, _ = load(result["config"])
        self.assertEqual(config["turn_protocol"], "workflow-v2")
        readiness = result["continuation_readiness"]
        self.assertEqual(readiness["role_completion"]["coordinator"],
                         ["begin", "process_whole_batch", "submit", "inspect_submission_and_turn_end"])

    def test_unknown_workflow_protocol_prevents_all_writes(self):
        self.inputs["turn_protocol"] = "workflow-v99"
        with self.assertRaisesRegex(ValueError, "turn_protocol_invalid"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_explicit_null_deadline_publishes_without_whole_run_cutoff(self):
        self.inputs["deadline"] = None
        result = self.prepare()
        config, _, _ = load(result["config"])
        self.assertIsNone(config["deadline"])
        self.assertEqual(result["freshness"]["valid_until"], result["freshness"]["context_expires_at"])
        self.assertEqual(self.f.sends, [])

    def test_invalid_deadline_prevents_all_writes(self):
        self.inputs["deadline"] = ""
        with self.assertRaisesRegex(ValueError, "deadline_invalid"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_bad_domain_pin_prevents_all_writes(self):
        self.inputs["source"]["sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "file_pin_changed"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_invalid_domain_receipt_prevents_all_writes(self):
        receipt = read_json(self.inputs["receipt"]["path"])
        receipt["authority_check"]["checkpoint_sha256"] = "0" * 64
        self.inputs["receipt"] = self.f.t.ref("bootstrap/invalid-receipt.json", receipt)
        with self.assertRaisesRegex(ValueError, "receipt_binding_mismatch"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_changed_acceptance_prevents_all_writes(self):
        acceptance = read_json(self.inputs["acceptance"]["path"])
        acceptance["requirements"][0]["acceptance"] = "weaker criterion"
        self.inputs["acceptance"] = self.f.t.ref("bootstrap/changed-acceptance.json", acceptance)
        with self.assertRaisesRegex(ValueError, "acceptance_requirements_changed"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_output_outside_roots_prevents_all_writes(self):
        parent = self.f.t.f.root / "outside"
        parent.mkdir(mode=0o700)
        target = parent / "prepared"
        self.inputs["output_dir"] = str(target)
        with self.assertRaisesRegex(ValueError, "output_outside_roots"):
            self.prepare()
        self.assertFalse(target.exists())

    def test_inputs_changed_during_native_checks_prevent_publication(self):
        def change_inputs(cli, runtime, args):
            replace_json(self.f.t.f.root / "bootstrap/init-inputs.json", {"changed": True})
            return self.f.query(cli, runtime, args)
        ref = self.f.t.ref("bootstrap/init-inputs.json", self.inputs)
        with self.assertRaisesRegex(ValueError, "file_pin_changed"):
            prepare(ref, call=change_inputs)
        self.assertFalse(self.output.exists())

    def test_future_domain_checkpoint_prevents_all_writes(self):
        source = read_json(self.inputs["source"]["path"])
        source["observed_at"] = (timestamp(now()) + timedelta(minutes=1)).isoformat()
        self.inputs["source"] = self.f.t.ref("bootstrap/future-source.json", source)
        receipt = read_json(self.inputs["receipt"]["path"])
        receipt["authority_check"]["checkpoint_sha256"] = digest(canonical(source))
        self.inputs["receipt"] = self.f.t.ref("bootstrap/future-receipt.json", receipt)
        with self.assertRaisesRegex(ValueError, "not_from_current_turn"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_30_minute_contract_accepts_previous_1117_second_bootstrap(self):
        from coordinator_startup import identity
        contract = read_json(self.inputs["contract"]["path"])
        contract["freshness"]["context_max_age_seconds"] = 1800
        self.inputs["contract"] = self.f.t.ref("bootstrap/new-contract.json", contract)
        gate = read_json(self.inputs["dispatch_gate"]["path"])
        gate.update(contract_sha256=self.inputs["contract"]["sha256"],
                    identity_sha256=digest(canonical(identity(contract))))
        self.inputs["dispatch_gate"] = self.f.t.ref("bootstrap/new-gate.json", gate)
        observed = timestamp(now()) - timedelta(seconds=1117)
        self.f.observer_mock.return_value["observed_at"] = observed.isoformat()
        result = self.prepare()
        self.assertEqual(timestamp(result["freshness"]["context_expires_at"]),
                         observed + timedelta(seconds=1800))
        self.assertEqual(self.f.sends, [])

    def test_changed_owner_prevents_all_writes(self):
        self.f.owner = "another"
        with self.assertRaisesRegex(ValueError, "run_owner_changed"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_agent_sender_refuses_before_initialization(self):
        def bad(cli, runtime, args):
            result = self.f.query(cli, runtime, args)
            if args[:2] == ["terminal", "show"] and args[-1] == "term_sender":
                result["terminal"]["agentIdentity"] = "trae"
            return result
        ref = self.f.t.ref("bootstrap/init-inputs.json", self.inputs)
        with self.assertRaisesRegex(ValueError, "operator_terminal_unverifiable"):
            prepare(ref, call=bad)
        self.assertFalse(self.output.exists())

    def test_stale_context_prevents_all_writes(self):
        self.f.observer_mock.return_value["observed_at"] = (timestamp(now()) - timedelta(seconds=901)).isoformat()
        with self.assertRaises(ContextFreshnessError):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_checkpoint_from_previous_turn_cannot_initialize(self):
        self.f.observer_mock.return_value["observed_at"] = now()
        with self.assertRaisesRegex(ValueError, "not_from_current_turn"):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_failure_at_final_fence_preserves_partial_without_publication(self):
        fresh = self.f.observer_mock.return_value
        self.f.observer_mock.side_effect = [fresh, ValueError("lost identity")]
        with self.assertRaisesRegex(ValueError, "lost identity"):
            self.prepare()
        self.assertTrue((self.output / "initialization-intent.json").exists())
        self.assertFalse((self.output / "continuation-ref.json").exists())
        with self.assertRaisesRegex(ValueError, "already_started"):
            self.prepare()
        self.assertEqual(self.f.sends, [])

    def test_cli_requires_explicit_execute(self):
        import contextlib
        import io
        from coordinator_tui_prepare import main
        out = io.StringIO()
        with contextlib.redirect_stdout(out), patch("coordinator_tui_prepare.prepare") as prepared:
            status = main(["--inputs", "/not-read", "--inputs-sha256", "0" * 64])
        self.assertEqual(status, 2)
        prepared.assert_not_called()
        self.assertIn("tui_prepare_execute_required", out.getvalue())


if __name__ == "__main__":
    unittest.main()

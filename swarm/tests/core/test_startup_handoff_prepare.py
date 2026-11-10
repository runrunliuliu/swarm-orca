"""Lifecycle input/plan/contract shape, CLI argument and revenue-policy refusals.

No real Agent, Run, Worker, send or service.
"""

from contextlib import redirect_stdout
from datetime import timedelta
import io
from unittest.mock import patch

from coordinator_io import parse, timestamp
import coordinator_tui_continue as continuation
import operator_startup as startup
import startup_handoff as handoff

from startup_handoff_fixture import HandoffCase


class PrepareTests(HandoffCase):
    def test_new_prepare_refuses_old_schema_and_missing_mode(self):
        with self.assertRaisesRegex(ValueError, "startup_new_inputs_v2_required"):
            startup.prepare(self.f.t.ref("bootstrap/old-inputs.json", self.old.inputs), str(self.output))
        value = dict(self.inputs)
        del value["execution"]
        with self.assertRaisesRegex(ValueError, "startup_inputs_invalid"):
            startup.prepare(self.f.t.ref("bootstrap/missing-inputs.json", value), str(self.output))
        self.assertEqual(list(self.output.iterdir()), [])


    def test_new_prepare_requires_independently_fixed_runtime_policy(self):
        value = dict(self.inputs)
        del value["runtime"]
        with self.assertRaisesRegex(ValueError, "startup_runtime_policy_required"):
            startup.prepare(self.f.t.ref("bootstrap/missing-runtime.json", value), str(self.output))
        self.assertEqual(list(self.output.iterdir()), [])


    def test_new_contract_cannot_strip_lifecycle_and_mode(self):
        self.configure()
        self.initialize()
        config = {k: v for k, v in self.config.items() if k not in ("execution", "startup_lifecycle", "startup_evidence")}
        with self.assertRaisesRegex(ValueError, "startup_lifecycle_required"):
            continuation.validate_config(config)


    def test_mode_missing_lifecycle_rejected_before_initialization(self):
        config = dict(self.f.config, execution={"mode": "autonomous", "trigger": None})
        with self.assertRaisesRegex(ValueError, "startup_lifecycle_required"):
            continuation.validate_config(config)


    def test_cli_missing_or_irrelevant_arguments_fail_before_native_io(self):
        for mode, extra, reason in [
                ("trigger-ready", [], "startup_input_pin_required"),
                ("refresh-review", [], "startup_input_pin_required"),
                ("accept", [], "startup_action_required"),
                ("complete", ["--action", "materials"], "startup_input_pin_required"),
                ("pull", ["--action", "review"], "startup_unexpected_action"),
                ("complete", ["--action", "dispatch", "--input", "/unused", "--input-sha256", "0" * 64],
                 "startup_unexpected_input")]:
            with self.subTest(mode=mode, extra=extra), patch.object(handoff, "context") as context, \
                    redirect_stdout(io.StringIO()) as output:
                code = handoff.main([mode, "--plan", "/unused", "--plan-sha256", "0" * 64,
                                     "--actor", "operator", "--execute", *extra])
                self.assertEqual(code, 2)
                self.assertEqual(parse(output.getvalue().encode())["reason"], reason)
                context.assert_not_called()


    def test_generated_inspect_command_remains_accepted(self):
        self.configure()
        argv = handoff.commands(self.ref, "materials", "coordinator")["inspect_argv"]
        with patch.object(handoff, "inspect", return_value=dict(ok=True)) as inspect, \
                redirect_stdout(io.StringIO()):
            self.assertEqual(handoff.main(argv[3:]), 0)
        inspect.assert_called_once()


    def test_coordinator_cannot_widen_reviewed_runtime_deadline(self):
        self.configure()
        self.initialize()
        for deadline in (None, (timestamp(self.config["deadline"]) + timedelta(hours=1)).isoformat()):
            with self.subTest(deadline=deadline), self.assertRaisesRegex(ValueError, "startup_runtime_deadline_changed"):
                continuation.validate_config(dict(self.config, deadline=deadline))


    def test_explicit_reviewed_null_deadline_is_preserved(self):
        from startup_runtime import established
        self.inputs["runtime"]["deadline"] = None
        self.configure(mode="manual", workers="not-applicable")
        self.initialize()
        self.assertIsNone(self.config["deadline"])
        after = (timestamp(self.inputs["bootstrap_deadline"]) + timedelta(hours=1)).isoformat()
        with patch("startup_runtime.now", return_value=after), patch("coordinator_tui_continue.now", return_value=after):
            self.assertEqual(established(self.ref, self.config_ref)[0]["runtime"], self.inputs["runtime"])
        with self.assertRaisesRegex(ValueError, "startup_runtime_deadline_changed"):
            continuation.validate_config(dict(self.config, deadline=self.f.config["deadline"]))


if __name__ == "__main__":
    unittest.main()

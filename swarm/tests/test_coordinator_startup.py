import contextlib
import copy
from datetime import datetime, timedelta, timezone
import io
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch

from coordinator_io import canonical, digest, file_ref, timestamp
from coordinator_creation_time import creation_bounds
from coordinator_launch import main
from coordinator_startup import build_session_contract, cli_main, run_gate
from trae_coordinator import ContextFreshnessError
import test_trae_coordinator as trae_tests


class StartupGateTests(unittest.TestCase):
    def setUp(self):
        # Exercise real stream/log observation, not an always-successful stub.
        self.fixture = trae_tests.TraeCoordinatorTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.root = self.fixture.root
        self.base_query = self.fixture.native_fixture()
        self.operator = {"handle": "term_operator", "incarnationId": "inc_operator",
                         "connected": True, "orphaned": False}
        self.run = {"id": "run_test", "consumer_generation": 1,
                    "coordinator_handle": "term_test", "created_at": None}
        self.workers = {"scope": {"run": "run_test"}, "workers": [],
                        "page": {"total": 0, "hasMore": False}}
        self.queries, self.query_hook, self.sequence = [], None, 0
        self.contract = {
            "schema_version": 1, "adapter": "trae-exec-stream-v1",
            "cli": self.ref("cli", "fake-cli-never-executed"), "runtime": "runtime_test",
            "workspace": {"id": "workspace_test", "path": str(self.fixture.cwd)},
            "operator": {"terminal": "term_operator", "incarnation": "inc_operator",
                         "provider": "trae", "session": "operator-session"},
            "coordinator": {"terminal": "term_test", "incarnation": "inc_test",
                            "session": trae_tests.SID},
            "runtime_config": file_ref(self.fixture.runtime),
            "role_skill": self.ref("SKILL.md", "role instructions", self.fixture.cwd),
            "handoff": self.ref("handoff.md", "approved bootstrap brief"),
            "skill_read_evidence": self.ref("skill-read.json", {"fixture": "tool audit reference"}),
            "observation": {"cursor": 2, "log_root": str(self.root),
                            "roots": [str(self.fixture.bootstrap)]}, "run": None,
        }
        for target in ("coordinator_startup.native", "trae_coordinator.native"):
            patcher = patch(target, side_effect=self.query)
            patcher.start()
            self.addCleanup(patcher.stop)
        environ = patch.dict(os.environ, {}, clear=True)
        environ.start()
        self.addCleanup(environ.stop)

    def ref(self, name, value, root=None):
        target = (root or self.root) / name
        target.write_text(value if isinstance(value, str) else json.dumps(value))
        return file_ref(target)

    def query(self, cli, runtime, args):
        self.queries.append(args)
        if self.query_hook:
            self.query_hook(args)
        if args[:2] == ["terminal", "show"] and args[-1] == "term_operator":
            return {"terminal": copy.deepcopy(self.operator)}
        if args[:2] == ["orchestration", "run-show"]:
            return {"run": copy.deepcopy(self.run)}
        if args[:2] == ["orchestration", "worker-list"]:
            return copy.deepcopy(self.workers)
        return self.base_query(cli, runtime, args)

    def gate(self, *, phase="session", actor="operator", previous=None):
        self.sequence += 1
        self.contract_ref = self.ref(f"contract-{self.sequence}.json", self.contract)
        return run_gate(self.contract_ref, phase=phase, actor=actor, previous=previous)

    def prepare_dispatch(self):
        self.prior = self.ref("session-receipt.json", self.gate())
        self.run["created_at"] = datetime.now(timezone.utc).isoformat()
        self.contract["run"] = {"id": "run_test", "generation": 1}

    def use_v2(self, *, context_max_age=900, receipt_ttl=60):
        self.contract.update(schema_version=2, freshness={
            "context_max_age_seconds": context_max_age,
            "gate_receipt_ttl_seconds": receipt_ttl})

    def age_context(self, seconds):
        self.fixture.context["timestamp"] = (
            self.fixture.now - timedelta(seconds=seconds)).isoformat()
        target = self.root / "2026" / "10" / "17" / ("rollout-time-" + trae_tests.SID + ".jsonl")
        target.write_text("".join(json.dumps(r) + "\n"
                                  for r in (self.fixture.meta, self.fixture.context)))

    def cli_gate(self):
        ref = self.ref("cli-contract.json", self.contract)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = cli_main(["--contract", ref["path"], "--contract-sha256", ref["sha256"],
                             "--phase", "session", "--actor", "operator"])
        return code, json.loads(out.getvalue())

    def new_contract_fields(self):
        return {key: copy.deepcopy(value) for key, value in self.contract.items()
                if key not in ("schema_version", "freshness", "run")}

    def test_new_contract_defaults_materialized_before_gate(self):
        fields = self.new_contract_fields()
        original = copy.deepcopy(fields)
        self.contract = build_session_contract(fields)
        self.assertEqual(fields, original)
        self.assertEqual(self.contract["schema_version"], 2)
        self.assertEqual(self.contract["freshness"], {
            "context_max_age_seconds": 1800, "gate_receipt_ttl_seconds": 180})
        self.assertIsNone(self.contract["run"])
        self.assertNotIn("ok", self.contract)
        self.assertEqual(self.queries, [])
        self.age_context(1117)  # Previous live bootstrap duration, now within 30 minutes.
        receipt = self.gate()
        self.assertTrue(receipt["ok"])
        self.assertEqual(receipt["schema_version"], 2)
        self.assertEqual(receipt["binding"]["freshness"], self.contract["freshness"])
        self.assertEqual(timestamp(receipt["valid_until"]),
                         timestamp(receipt["completed_at"]) + timedelta(seconds=180))

    def test_new_contract_does_not_share_mutable_defaults_or_input(self):
        fields = self.new_contract_fields()
        original = copy.deepcopy(fields)
        first = build_session_contract(fields)
        first["freshness"]["context_max_age_seconds"] = 1
        first["freshness"]["gate_receipt_ttl_seconds"] = 1
        first["observation"]["roots"].clear()
        second = build_session_contract(fields)
        self.assertEqual(second["freshness"]["context_max_age_seconds"], 1800)
        self.assertEqual(second["freshness"]["gate_receipt_ttl_seconds"], 180)
        self.assertEqual(fields, original)
        self.assertEqual(second["observation"], original["observation"])

    def test_new_contract_rejects_migration_and_policy_overrides(self):
        fields = self.new_contract_fields()
        for extra in ({"schema_version": 1}, {"schema_version": 2},
                      {"freshness": None}, {"freshness": {"context_max_age_seconds": 3600,
                                                         "gate_receipt_ttl_seconds": 300}}):
            with self.subTest(extra=extra), self.assertRaisesRegex(ValueError, "new_contract_fields_required"):
                build_session_contract({**fields, **extra})
        with self.assertRaisesRegex(ValueError, "new_contract_fields_required"):
            build_session_contract(self.contract)
        self.assertEqual(self.queries, [])

    def test_new_contract_only_for_session_phase(self):
        fields = self.new_contract_fields()
        self.assertIsNone(build_session_contract({**fields, "run": None})["run"])
        with self.assertRaisesRegex(ValueError, "new_contract_requires_session_phase"):
            build_session_contract({**fields, "run": {"id": "run_existing", "generation": 1}})
        self.assertEqual(self.queries, [])

    def test_new_contract_still_requires_valid_identity_and_pinned_inputs(self):
        fields = self.new_contract_fields()
        del fields["operator"]
        with self.assertRaisesRegex(ValueError, "invalid_startup_contract"):
            build_session_contract(fields)
        fields = self.new_contract_fields()
        fields["operator"]["terminal"] = fields["coordinator"]["terminal"]
        with self.assertRaisesRegex(ValueError, "independent_terminal_required"):
            build_session_contract(fields)
        fields = self.new_contract_fields()
        Path(fields["handoff"]["path"]).write_text("changed")
        with self.assertRaisesRegex(ValueError, "file_pin_changed"):
            build_session_contract(fields)
        self.assertEqual(self.queries, [])

    def test_new_contract_cli_outputs_v2_without_native_calls_or_file_writes(self):
        fields = self.new_contract_fields()
        ref = self.ref("new-fields.json", fields)
        files_before = set(self.root.rglob("*"))
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = main(["startup-contract", "--input", ref["path"], "--input-sha256", ref["sha256"]])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out.getvalue()), build_session_contract(fields))
        self.assertEqual(set(self.root.rglob("*")), files_before)
        self.assertEqual(self.queries, [])

    def test_new_contract_cli_rejects_bad_pin_without_exporting_input(self):
        ref = self.ref("new-fields.json", self.new_contract_fields())
        Path(ref["path"]).write_text("secret input payload")
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = main(["startup-contract", "--input", ref["path"], "--input-sha256", ref["sha256"]])
        self.assertEqual(code, 2)
        result = json.loads(out.getvalue())
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "startup_contract_build_failed")
        self.assertNotIn("secret", out.getvalue())
        self.assertNotIn(str(self.root), out.getvalue())
        self.assertEqual(self.queries, [])

    def test_v1_identity_and_context_deadline_unchanged(self):
        result = self.gate()
        old_identity = {key: self.contract[key] for key in (
            "adapter", "cli", "runtime", "workspace", "operator", "coordinator",
            "runtime_config", "role_skill", "handoff", "skill_read_evidence")}
        self.assertEqual(result["schema_version"], 1)
        self.assertEqual(result["identity_sha256"], digest(canonical(old_identity)))
        self.assertEqual(result["binding"], old_identity)
        self.assertEqual(timestamp(result["valid_until"]), self.fixture.now + timedelta(seconds=300))
        self.assertNotIn("freshness", result)

    def test_v2_pins_startup_anchor_across_gate_and_first_dispatch(self):
        self.use_v2()
        from trae_coordinator import observe
        anchor = observe(cli=self.contract["cli"]["path"], runtime="runtime_test", terminal="term_test",
                         incarnation="inc_test", workspace="workspace_test", cwd=str(self.fixture.cwd),
                         cursor=2, log_root=str(self.root), roots=[str(self.fixture.bootstrap)])
        ref = self.ref("startup-anchor.json", anchor)
        self.contract["observation"]["startup_anchor"] = ref
        def no_stream(args):
            self.assertNotEqual(args[:2], ["terminal", "read"])
        self.query_hook = no_stream
        self.prepare_dispatch()
        receipt = self.gate(phase="first-dispatch", previous=self.prior)
        self.assertEqual(receipt["binding"]["startup_anchor"], ref)
        self.contract["observation"].pop("startup_anchor")
        with self.assertRaisesRegex(ValueError, "previous_operator_gate_mismatch"):
            self.gate(phase="first-dispatch", previous=self.prior)

    def test_v1_does_not_silently_enable_startup_anchor(self):
        self.contract["observation"]["startup_anchor"] = self.contract["skill_read_evidence"]
        with self.assertRaisesRegex(ValueError, "invalid_observation"):
            self.gate()

    def test_v1_stale_context_has_safe_actionable_error(self):
        self.age_context(347)
        code, result = self.cli_gate()
        self.assertEqual(code, 2)
        self.assertEqual(result["error"], "session_context_stale")
        self.assertEqual(result["max_age_seconds"], 300)
        self.assertGreaterEqual(result["age_seconds"], 347)
        self.assertNotIn(str(self.root), json.dumps(result))

    def test_v2_slow_bootstrap_passes_with_short_receipt(self):
        self.use_v2()
        self.age_context(347)
        result = self.gate()
        self.assertEqual(result["schema_version"], 2)
        self.assertEqual(result["context_observed_at"], self.fixture.context["timestamp"])
        self.assertGreaterEqual(result["context_age_seconds"], 347)
        self.assertEqual(result["freshness"], self.contract["freshness"])
        self.assertEqual(result["binding"]["freshness"], self.contract["freshness"])
        self.assertEqual(timestamp(result["valid_until"]),
                         timestamp(result["completed_at"]) + timedelta(seconds=60))

    def test_v2_receipt_cannot_outlive_context(self):
        self.use_v2()
        self.age_context(870)
        result = self.gate()
        self.assertEqual(result["valid_until"], result["context_expires_at"])
        self.assertEqual(timestamp(result["valid_until"]),
                         timestamp(self.fixture.context["timestamp"]) + timedelta(seconds=900))
        self.assertLess(timestamp(result["valid_until"]),
                        timestamp(result["completed_at"]) + timedelta(seconds=60))

    def test_new_180_second_receipt_still_capped_by_context_expiry(self):
        self.contract = build_session_contract(self.new_contract_fields())
        self.age_context(1700)
        result = self.gate()
        self.assertEqual(result["valid_until"], result["context_expires_at"])
        self.assertEqual(timestamp(result["valid_until"]),
                         timestamp(self.fixture.context["timestamp"]) + timedelta(seconds=1800))
        self.assertLess(timestamp(result["valid_until"]),
                        timestamp(result["completed_at"]) + timedelta(seconds=180))

    def test_new_context_expires_after_30_minutes(self):
        self.contract = build_session_contract(self.new_contract_fields())
        self.age_context(1801)
        with self.assertRaises(ContextFreshnessError):
            self.gate()

    def test_v2_stale_and_future_context_errors(self):
        self.use_v2()
        for age, error in ((901, "session_context_stale"), (-30, "session_context_in_future")):
            self.age_context(age)
            with self.subTest(age=age):
                code, result = self.cli_gate()
                self.assertEqual(code, 2)
                self.assertEqual(result["error"], error)
                self.assertEqual(result["max_age_seconds"], 900)
                self.assertNotIn(str(self.root), json.dumps(result))

    def test_v2_context_expiring_during_gate_reports_age(self):
        self.use_v2()
        self.age_context(890)
        started = self.fixture.now
        with patch("coordinator_startup.now", side_effect=[started.isoformat(),
                   (started + timedelta(seconds=11)).isoformat()]):
            code, result = self.cli_gate()
        self.assertEqual(code, 2)
        self.assertEqual(result["error"], "session_context_expired_during_gate")
        self.assertEqual(result["age_seconds"], 901)
        self.assertEqual(result["max_age_seconds"], 900)

    def test_gate_rejects_clock_moving_backwards(self):
        self.use_v2()
        started = self.fixture.now + timedelta(seconds=10)
        with patch("coordinator_startup.now", side_effect=[started.isoformat(),
                   (started - timedelta(seconds=1)).isoformat()]):
            with self.assertRaisesRegex(ValueError, "gate_clock_moved_backwards"):
                self.gate()

    def test_v2_freshness_policy_is_explicit_and_strict(self):
        self.use_v2()
        valid = copy.deepcopy(self.contract)
        for value in (None, [], {}, {**valid["freshness"], "extra": 1}):
            self.contract = {**valid, "freshness": value}
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "invalid_freshness_policy"):
                self.gate()
        for key, limit in (("context_max_age_seconds", 3600), ("gate_receipt_ttl_seconds", 300)):
            for value in (None, True, 60.0, "60", 0, -1, limit + 1):
                self.contract = copy.deepcopy(valid)
                self.contract["freshness"][key] = value
                with self.subTest(key=key, value=value), self.assertRaisesRegex(ValueError, "invalid_" + key):
                    self.gate()
            self.contract = copy.deepcopy(valid)
            del self.contract["freshness"][key]
            with self.assertRaisesRegex(ValueError, "invalid_freshness_policy"):
                self.gate()
        self.contract = copy.deepcopy(valid)
        del self.contract["freshness"]
        with self.assertRaisesRegex(ValueError, "invalid_startup_contract"):
            self.gate()
        self.contract = {**valid, "schema_version": 1}
        with self.assertRaisesRegex(ValueError, "invalid_startup_contract"):
            self.gate()
        self.assertEqual(self.queries, [])

    def test_v2_uses_pinned_policy_not_hardcoded_defaults(self):
        self.use_v2(context_max_age=1200, receipt_ttl=30)
        self.age_context(1000)
        result = self.gate()
        self.assertEqual(timestamp(result["context_expires_at"]),
                         timestamp(self.fixture.context["timestamp"]) + timedelta(seconds=1200))
        self.assertEqual(timestamp(result["valid_until"]),
                         timestamp(result["completed_at"]) + timedelta(seconds=30))

    def test_v2_freshness_policy_cannot_change_between_phases(self):
        self.use_v2()
        self.prepare_dispatch()
        for key in self.contract["freshness"]:
            self.contract["freshness"][key] += 1
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "previous_operator_gate_mismatch"):
                self.gate(phase="first-dispatch", previous=self.prior)
            self.contract["freshness"][key] -= 1

    def test_v1_receipt_cannot_be_reused_with_v2_contract(self):
        self.prepare_dispatch()
        self.use_v2()
        with self.assertRaisesRegex(ValueError, "previous_operator_gate_mismatch"):
            self.gate(phase="first-dispatch", previous=self.prior)

    def test_v2_run_must_be_created_while_session_receipt_valid(self):
        self.use_v2()
        self.prepare_dispatch()
        receipt = json.loads(Path(self.prior["path"]).read_text())
        receipt["valid_until"] = receipt["completed_at"]
        prior = self.ref("expired-session.json", receipt)
        with self.assertRaisesRegex(ValueError, "run_created_after_session_gate_expired"):
            self.gate(phase="first-dispatch", previous=prior)

    def test_v2_session_receipt_may_be_historical_after_timely_run_creation(self):
        self.use_v2()
        self.prepare_dispatch()
        receipt = json.loads(Path(self.prior["path"]).read_text())
        receipt["valid_until"] = creation_bounds(self.run["created_at"])[1].isoformat()
        prior = self.ref("historical-session.json", receipt)
        result = self.gate(phase="first-dispatch", previous=prior)
        self.assertTrue(result["ok"])
        self.assertGreater(timestamp(result["started_at"]), timestamp(receipt["valid_until"]))

    def test_v2_partial_native_second_at_ttl_is_not_dispatch_evidence(self):
        self.use_v2()
        self.prepare_dispatch()
        receipt = json.loads(Path(self.prior["path"]).read_text())
        created = timestamp(receipt["completed_at"]).replace(microsecond=0) + timedelta(seconds=2)
        self.run["created_at"] = created.isoformat(timespec="seconds").replace("+00:00", "Z")
        receipt["valid_until"] = (created + timedelta(seconds=0.25)).isoformat()
        prior = self.ref("partial-second-session.json", receipt)
        with patch("coordinator_startup.now", return_value=(created + timedelta(seconds=1)).isoformat()):
            with self.assertRaisesRegex(ValueError, "run_created_after_session_gate_expired"):
                self.gate(phase="first-dispatch", previous=prior)

    def test_v2_same_second_as_gate_remains_ambiguous_not_backdated(self):
        self.use_v2()
        self.prepare_dispatch()
        receipt = json.loads(Path(self.prior["path"]).read_text())
        created = timestamp(receipt["completed_at"]).replace(microsecond=0)
        self.run["created_at"] = created.isoformat(timespec="seconds").replace("+00:00", "Z")
        with self.assertRaisesRegex(ValueError, "run_predates_session_gate"):
            self.gate(phase="first-dispatch", previous=self.prior)

    def test_v2_three_stage_gate_rechecks_native_context(self):
        self.use_v2()
        self.age_context(347)
        self.test_operator_then_coordinator_recheck()

    def test_v2_expired_dispatch_receipt_rejected(self):
        self.use_v2()
        self.test_expired_operator_dispatch_receipt_rejected()

    def test_v2_dispatch_receipt_expiring_during_recheck_rejected(self):
        self.use_v2()
        self.test_operator_receipt_expiring_during_coordinator_gate_rejected()

    def test_v2_coordinator_receipt_cannot_extend_operator_deadline(self):
        self.use_v2()
        self.prepare_dispatch()
        operator = self.gate(phase="first-dispatch", previous=self.prior)
        prior = self.ref("operator-receipt.json", operator)
        os.environ["ORCA_TERMINAL_HANDLE"] = "term_test"
        result = self.gate(phase="first-dispatch", actor="coordinator", previous=prior)
        self.assertEqual(result["valid_until"], operator["valid_until"])

    def test_new_dispatch_window_survives_60_seconds_but_does_not_renew_180(self):
        self.contract = build_session_contract(self.new_contract_fields())
        self.prepare_dispatch()
        operator = self.gate(phase="first-dispatch", previous=self.prior)
        prior = self.ref("operator-receipt.json", operator)
        os.environ["ORCA_TERMINAL_HANDLE"] = "term_test"
        checked_at = timestamp(operator["completed_at"]) + timedelta(seconds=61)
        with patch("coordinator_startup.now", return_value=checked_at.isoformat()):
            result = self.gate(phase="first-dispatch", actor="coordinator", previous=prior)
        self.assertEqual(result["valid_until"], operator["valid_until"])
        self.assertEqual(timestamp(result["valid_until"]),
                         timestamp(operator["completed_at"]) + timedelta(seconds=180))
        expired = timestamp(operator["valid_until"]) + timedelta(microseconds=1)
        with patch("coordinator_startup.now", return_value=expired.isoformat()):
            with self.assertRaisesRegex(ValueError, "operator_dispatch_gate_stale_or_changed"):
                self.gate(phase="first-dispatch", actor="coordinator", previous=prior)

    def test_v2_older_context_still_checks_owner_generation(self):
        self.use_v2()
        self.age_context(347)
        self.test_owner_and_generation_not_just_run_id()

    def test_v2_older_context_still_checks_worker_inventory(self):
        self.use_v2()
        self.age_context(347)
        self.test_existing_workers_and_incomplete_inventory_rejected()

    def test_v2_older_context_still_checks_native_identity(self):
        self.use_v2()
        self.age_context(347)
        self.test_owner_change_during_observation_rejected()

    def test_v2_older_context_still_checks_pinned_files(self):
        self.use_v2()
        self.age_context(347)
        self.test_pinned_skill_change_during_observation_rejected()

    def test_v2_older_context_still_checks_effective_settings(self):
        self.use_v2()
        for key, value in (("model", "other"), ("approval_policy", "on-request")):
            old = self.fixture.context["payload"][key]
            self.fixture.context["payload"][key] = value
            self.age_context(347)
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "settings mismatch"):
                self.gate()
            self.fixture.context["payload"][key] = old

    def test_raw_native_error_cannot_impersonate_local_timing_error(self):
        with patch("coordinator_startup.native", side_effect=ValueError("actual turn settings stale")):
            code, result = self.cli_gate()
        self.assertEqual(code, 2)
        self.assertEqual(result["error"], "startup_gate_failed")
        self.assertNotIn("age_seconds", result)

    def test_session_gate_does_not_require_a_run(self):
        result = self.gate()
        self.assertTrue(result["ok"])
        self.assertIsNone(result["run"])
        self.assertFalse(result["execution_authorized"])
        self.assertFalse(any(q[0] == "orchestration" for q in self.queries))

    def test_operator_then_coordinator_recheck(self):
        self.prepare_dispatch()
        operator = self.gate(phase="first-dispatch", previous=self.prior)
        self.assertFalse(any(q[:2] == ["orchestration", "run-current"] for q in self.queries))
        prior = self.ref("operator-receipt.json", operator)
        os.environ["ORCA_TERMINAL_HANDLE"] = "term_test"
        result = run_gate(self.contract_ref, phase="first-dispatch", actor="coordinator", previous=prior)
        self.assertTrue(result["ok"])
        self.assertEqual(result["run"]["coordinator_handle"], "term_test")
        self.assertIn(["orchestration", "run-current", "--from", "term_test"], self.queries)
        allowed = {("status",), ("terminal", "show"), ("terminal", "read"),
                   ("worktree", "show"), ("orchestration", "run-show"),
                   ("orchestration", "worker-list"), ("orchestration", "run-current")}
        self.assertTrue(all(tuple(q[:2]) in allowed for q in self.queries))

    def test_same_operator_terminal_or_provider_session_rejected(self):
        for field, value, error in (("terminal", "term_test", "independent_terminal"),
                                    ("session", trae_tests.SID, "independent_session")):
            old = self.contract["operator"][field]
            self.contract["operator"][field] = value
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, error):
                self.gate()
            self.contract["operator"][field] = old
        self.assertEqual(self.queries, [])

    def test_owner_and_generation_not_just_run_id(self):
        self.prepare_dispatch()
        for field, value in (("coordinator_handle", "term_operator"),
                             ("consumer_generation", 2), ("consumer_generation", True),
                             ("id", "run_wrong")):
            old = self.run[field]
            self.run[field] = value
            with self.subTest(field=field, value=value), self.assertRaisesRegex(ValueError, "ownership"):
                self.gate(phase="first-dispatch", previous=self.prior)
            self.run[field] = old

    def test_missing_pre_run_receipt_not_retroactively_accepted(self):
        self.contract["run"] = {"id": "run_test", "generation": 1}
        with self.assertRaisesRegex(ValueError, "previous_operator_gate_required"):
            self.gate(phase="first-dispatch")

    def test_old_run_cannot_be_relabelled_as_new(self):
        self.prepare_dispatch()
        self.run["created_at"] = "2020-01-01T00:00:00+00:00"
        with self.assertRaisesRegex(ValueError, "predates"):
            self.gate(phase="first-dispatch", previous=self.prior)

    def test_existing_workers_and_incomplete_inventory_rejected(self):
        self.prepare_dispatch()
        original = copy.deepcopy(self.workers)
        for update in ({"workers": [{"dispatchStatus": "completed"}], "page": {"total": 1, "hasMore": False}},
                       {"page": {"total": 0, "hasMore": True}},
                       {"page": {"total": False, "hasMore": False}}, {"page": {}},
                       {"scope": {"run": "wrong"}}):
            self.workers = {**original, **update}
            with self.subTest(update=update), self.assertRaisesRegex(ValueError, "inventory"):
                self.gate(phase="first-dispatch", previous=self.prior)

    def test_owner_change_during_observation_rejected(self):
        self.prepare_dispatch()
        def change(args):
            if args[:2] == ["terminal", "read"]:
                self.run["consumer_generation"] = 2
        self.query_hook = change
        with self.assertRaisesRegex(ValueError, "ownership"):
            self.gate(phase="first-dispatch", previous=self.prior)

    def test_worker_appearing_during_observation_rejected(self):
        self.prepare_dispatch()
        def change(args):
            if args[:2] == ["terminal", "read"]:
                self.workers["page"]["total"] = 1
        self.query_hook = change
        with self.assertRaisesRegex(ValueError, "inventory"):
            self.gate(phase="first-dispatch", previous=self.prior)

    def test_actual_stream_not_requested_session_id(self):
        self.contract["coordinator"]["session"] = "00000000-0000-0000-0000-000000000000"
        with self.assertRaisesRegex(ValueError, "thread changed"):
            self.gate()

    def test_operator_identity_and_caller_conflicts(self):
        self.operator["incarnationId"] = "recreated"
        with self.assertRaisesRegex(ValueError, "operator_identity"):
            self.gate()
        os.environ["ORCA_TERMINAL_HANDLE"] = "term_test"
        with self.assertRaisesRegex(ValueError, "operator_native_context"):
            self.gate()

    def test_coordinator_needs_operator_dispatch_receipt_and_own_context(self):
        self.prepare_dispatch()
        with self.assertRaisesRegex(ValueError, "previous_operator_gate_mismatch"):
            self.gate(phase="first-dispatch", actor="coordinator", previous=self.prior)
        operator = self.gate(phase="first-dispatch", previous=self.prior)
        prior = self.ref("operator-receipt.json", operator)
        with self.assertRaisesRegex(ValueError, "coordinator_native_context"):
            self.gate(phase="first-dispatch", actor="coordinator", previous=prior)

    def test_expired_operator_dispatch_receipt_rejected(self):
        self.prepare_dispatch()
        receipt = self.gate(phase="first-dispatch", previous=self.prior)
        receipt["valid_until"] = receipt["started_at"]
        prior = self.ref("expired-operator.json", receipt)
        os.environ["ORCA_TERMINAL_HANDLE"] = "term_test"
        with self.assertRaisesRegex(ValueError, "stale_or_changed"):
            self.gate(phase="first-dispatch", actor="coordinator", previous=prior)

    def test_coordinator_cannot_change_dispatch_contract_after_operator_gate(self):
        self.prepare_dispatch()
        prior = self.ref("operator-receipt.json", self.gate(phase="first-dispatch", previous=self.prior))
        self.contract["observation"]["cursor"] += 1
        os.environ["ORCA_TERMINAL_HANDLE"] = "term_test"
        with self.assertRaisesRegex(ValueError, "stale_or_changed"):
            self.gate(phase="first-dispatch", actor="coordinator", previous=prior)

    def test_operator_receipt_expiring_during_coordinator_gate_rejected(self):
        self.prepare_dispatch()
        receipt = self.gate(phase="first-dispatch", previous=self.prior)
        started = datetime.now(timezone.utc)
        receipt["valid_until"] = (started + timedelta(seconds=1)).isoformat()
        prior = self.ref("operator-receipt.json", receipt)
        os.environ["ORCA_TERMINAL_HANDLE"] = "term_test"
        with patch("coordinator_startup.now", side_effect=[started.isoformat(),
                   (started + timedelta(seconds=2)).isoformat()]):
            with self.assertRaisesRegex(ValueError, "operator_dispatch_gate_expired_during_gate"):
                self.gate(phase="first-dispatch", actor="coordinator", previous=prior)

    def test_coordinator_receipt_cannot_extend_operator_receipt_validity(self):
        self.prepare_dispatch()
        receipt = self.gate(phase="first-dispatch", previous=self.prior)
        receipt["valid_until"] = (datetime.now(timezone.utc) + timedelta(seconds=60)).isoformat()
        prior = self.ref("operator-receipt.json", receipt)
        os.environ["ORCA_TERMINAL_HANDLE"] = "term_test"
        result = self.gate(phase="first-dispatch", actor="coordinator", previous=prior)
        self.assertEqual(result["valid_until"], receipt["valid_until"])

    def test_previous_receipt_change_during_observation_rejected(self):
        self.prepare_dispatch()
        def change(args):
            if args[:2] == ["terminal", "read"]:
                Path(self.prior["path"]).write_text("changed")
        self.query_hook = change
        with self.assertRaisesRegex(ValueError, "file_pin_changed"):
            self.gate(phase="first-dispatch", previous=self.prior)

    def test_session_evidence_expiring_during_gate_rejected(self):
        started = datetime.now(timezone.utc)
        with patch("coordinator_startup.now", side_effect=[started.isoformat(),
                   (started + timedelta(seconds=301)).isoformat()]):
            with self.assertRaisesRegex(ValueError, "expired_during_gate"):
                self.gate()

    def test_wrong_phase_or_failed_previous_receipt_rejected(self):
        with self.assertRaisesRegex(ValueError, "phase_run_mismatch"):
            self.gate(phase="first-dispatch")
        self.prepare_dispatch()
        receipt = json.loads(Path(self.prior["path"]).read_text())
        receipt["ok"] = False
        failed = self.ref("failed.json", receipt)
        with self.assertRaisesRegex(ValueError, "previous_operator_gate_mismatch"):
            self.gate(phase="first-dispatch", previous=failed)

    def test_changed_handoff_invalidates_previous_gate(self):
        self.prepare_dispatch()
        self.contract["handoff"] = self.ref("other-handoff.md", "different instructions")
        with self.assertRaisesRegex(ValueError, "previous_operator_gate_mismatch"):
            self.gate(phase="first-dispatch", previous=self.prior)

    def test_skill_from_other_worktree_rejected(self):
        self.contract["role_skill"] = self.ref("SKILL.md", "neighbour")
        with self.assertRaisesRegex(ValueError, "role_skill_outside_workspace"):
            self.gate()

    def test_pinned_skill_change_during_observation_rejected(self):
        def change(args):
            if args[:2] == ["terminal", "read"]:
                Path(self.contract["role_skill"]["path"]).write_text("modified")
        self.query_hook = change
        with self.assertRaisesRegex(ValueError, "file_pin_changed"):
            self.gate()

    def test_unsupported_adapter_no_codex_fallback(self):
        self.contract["adapter"] = "codex-local"
        with self.assertRaisesRegex(ValueError, "unsupported_startup_adapter"):
            self.gate()
        self.assertEqual(self.queries, [])

    def test_cli_route_and_sanitized_failure(self):
        with patch("coordinator_startup.cli_main", return_value=2) as command:
            self.assertEqual(main(["startup-gate", "--phase", "session"]), 2)
        command.assert_called_once_with(["--phase", "session"])
        ref = self.ref("contract.json", self.contract)
        out = io.StringIO()
        with patch("coordinator_startup.native", side_effect=ValueError("secret native payload")), contextlib.redirect_stdout(out):
            code = cli_main(["--contract", ref["path"], "--contract-sha256", ref["sha256"],
                             "--phase", "session", "--actor", "operator"])
        self.assertEqual(code, 2)
        self.assertNotIn("secret", out.getvalue())
        self.assertEqual(json.loads(out.getvalue())["decision"], "stop")


if __name__ == "__main__":
    unittest.main()

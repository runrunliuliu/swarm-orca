"""Readiness freeze ordering and unchanged real strict handshake (native mocked)."""

import copy
from datetime import timedelta
import io
import json
import os
from pathlib import Path
import stat
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

from coordinator_io import file_ref, parse, pinned, publish_new, timestamp
from coordinator_launch import main
from coordinator_strict_prepare import prepare, cli_main as legacy_main
from coordinator_strict_start import load, wait_and_create
import test_coordinator_strict_start as start_tests


class StrictPrepareTests(unittest.TestCase):
    def setUp(self):
        self.start = start_tests.StrictStartTests()
        self.start.setUp()
        self.addCleanup(self.start.doCleanups)
        self.gate = self.start.gate
        self.directory = self.start.directory
        self.directory.chmod(0o700)
        self.fields = self.gate.ref("new-fields.json", self.gate.new_contract_fields())
        self.input = {key: copy.deepcopy(value) for key, value in self.start.config.items()
                      if key != "contract"}
        self.input.update(contract_fields=self.fields, max_workers=8)
        self.source_ref = self.input["readiness_evidence"][0]
        self.source_path = Path(self.source_ref["path"])
        self.ref = self.gate.ref("prepare.json", self.input)
        clock = patch("coordinator_strict_prepare.now", side_effect=lambda: self.start.clock.isoformat())
        clock.start()
        self.addCleanup(clock.stop)

    def run_prepare(self):
        with patch.dict(os.environ, {"ORCA_TERMINAL_HANDLE": "term_operator"}):
            return prepare(self.ref)

    def assert_no_native(self):
        self.assertEqual(self.start.calls, [])
        self.assertEqual(self.gate.queries, [])

    def test_frozen_raw_bytes_contract_then_config_defaults_and_no_native_calls(self):
        # Preserve whitespace/newlines, not just semantic JSON hashes.
        raw = b'{  "read": "final" }\n\n'
        self.source_path.write_bytes(raw)
        self.source_ref = file_ref(self.source_path)
        fields = self.gate.new_contract_fields()
        fields["skill_read_evidence"] = self.source_ref
        self.input["contract_fields"] = self.gate.ref("final-fields.json", fields)
        self.input["readiness_evidence"] = [self.source_ref, self.source_ref]
        self.ref = self.gate.ref("final-prepare.json", self.input)
        writes = []

        def record(target, value):
            writes.append(target.name)
            return publish_new(target, value)

        with patch("coordinator_strict_prepare.publish_new", side_effect=record):
            result = self.run_prepare()
        self.assertFalse(result["operator_identity_verified"])
        self.assertFalse(result["execution_authorized"])
        config, contract, _, _ = load(result["config"])
        self.assertEqual(config["max_workers"], 8)
        self.assertEqual(config["request_id"], self.input["request_id"])
        self.assertEqual(config["deadline"], self.input["deadline"])
        self.assertEqual(contract["schema_version"], 2)
        self.assertEqual(contract["freshness"], {
            "context_max_age_seconds": 1800, "gate_receipt_ttl_seconds": 180})
        self.assertIsNone(contract["run"])
        frozen = contract["skill_read_evidence"]
        self.assertNotEqual(frozen["path"], self.source_ref["path"])
        self.assertEqual(frozen["sha256"], self.source_ref["sha256"])
        self.assertEqual(pinned(frozen), raw)
        self.assertEqual(self.source_path.read_bytes(), raw)
        self.assertEqual(config["readiness_evidence"], [frozen])
        self.assertEqual(writes, ["prepare-intent.json", "readiness-000.snapshot",
                                 "session-contract.json", "prepared-inputs.json", "start.json"])
        receipt = parse(pinned(result["preparation"]))
        self.assertEqual(receipt["readiness_snapshots"], [
            {"source": self.source_ref, "snapshot": frozen}])
        for target in self.directory.iterdir():
            self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)
        self.assert_no_native()

    def test_wrong_operator_context_fails_before_any_writes(self):
        # Fixtures start in Coordinator context: do not clear/borrow the environment.
        with self.assertRaisesRegex(ValueError, "operator_native_context_mismatch"):
            prepare(self.ref)
        self.assertEqual(list(self.directory.iterdir()), [])
        self.assert_no_native()

    def test_external_operator_without_hint_is_explicitly_not_authenticated(self):
        with patch.dict(os.environ, {}, clear=True):
            result = prepare(self.ref)
        self.assertFalse(result["operator_identity_verified"])
        self.assertEqual(result["operator_context"], "absent_requires_independent_identity_audit")
        self.assert_no_native()

    def test_stale_reviewed_pin_never_gets_automatically_refreshed(self):
        self.source_path.write_text("producer changed the final evidence")
        with self.assertRaisesRegex(ValueError, "file_pin_changed"):
            self.run_prepare()
        self.assertEqual(list(self.directory.iterdir()), [])
        self.assert_no_native()

    def test_source_drift_during_preparation_leaves_evidence_but_no_start_config(self):
        def race(target, value):
            publish_new(target, value)
            if target.name == "readiness-000.snapshot":
                self.source_path.write_text("producer is still writing")

        with patch("coordinator_strict_prepare.publish_new", side_effect=race):
            with self.assertRaisesRegex(ValueError, "file_pin_changed"):
                self.run_prepare()
        self.assertTrue((self.directory / "prepare-intent.json").exists())
        self.assertFalse((self.directory / "start.json").exists())
        self.assert_no_native()

    def test_source_update_after_freeze_cannot_mutate_config_and_handshake_still_passes(self):
        result = self.run_prepare()
        self.source_path.write_text("a later producer attempt, not the reviewed evidence")
        self.start.ref = result["config"]
        created = wait_and_create(self.start.ref)
        self.assertTrue(created["ok"])
        self.assertEqual(len(self.start.creates()), 1)
        self.assertFalse(created["workers_dispatched"])
        self.assertTrue(created["first_dispatch_gates_required"])

    def test_snapshot_tampering_still_fails_closed(self):
        result = self.run_prepare()
        config = parse(pinned(result["config"]))
        Path(config["readiness_evidence"][0]["path"]).write_text("tampered")
        with self.assertRaisesRegex(ValueError, "file_pin_changed"):
            wait_and_create(result["config"])
        self.assert_no_native()
        self.assertFalse((self.directory / "ready.json").exists())

    def test_new_contract_allows_response_after_old_60_second_window(self):
        result = self.run_prepare()
        self.start.ref = result["config"]
        self.start.response_delay = 61
        self.assertTrue(wait_and_create(result["config"])["ok"])
        self.assertEqual(len(self.start.creates()), 1)

    def test_new_contract_still_rejects_response_after_180_seconds(self):
        self.input["deadline"] = (self.start.clock + timedelta(seconds=300)).isoformat()
        self.ref = self.gate.ref("long-prepare.json", self.input)
        result = self.run_prepare()
        self.start.ref = result["config"]
        self.start.response_delay = 181
        with self.assertRaisesRegex(ValueError, "create_requires_reconciliation"):
            wait_and_create(result["config"])
        self.assertEqual(len(self.start.creates()), 1)
        self.assertTrue((self.directory / "create-response.json").exists())
        self.assertFalse((self.directory / "created.json").exists())

    def test_invalid_wait_window_rejected_before_preparation_writes(self):
        for seconds, code in ((0, "deadline_expired"), (901, "bounded_to_900_seconds")):
            self.input["deadline"] = (self.start.clock + timedelta(seconds=seconds)).isoformat()
            self.ref = self.gate.ref("deadline-prepare.json", self.input)
            with self.subTest(seconds=seconds), self.assertRaisesRegex(ValueError, code):
                self.run_prepare()
            self.assertEqual(list(self.directory.iterdir()), [])
            self.assert_no_native()

    def test_deadline_expiring_during_preparation_leaves_evidence_but_no_start(self):
        def expire(target, value):
            publish_new(target, value)
            if target.name == "readiness-000.snapshot":
                self.start.clock = timestamp(self.input["deadline"])

        with patch("coordinator_strict_prepare.publish_new", side_effect=expire):
            with self.assertRaisesRegex(ValueError, "deadline_expired"):
                self.run_prepare()
        self.assertTrue((self.directory / "prepare-intent.json").exists())
        self.assertFalse((self.directory / "start.json").exists())
        self.assert_no_native()

    def test_repeated_attempt_never_overwrites_any_file(self):
        self.run_prepare()
        original = {f.name: f.read_bytes() for f in self.directory.iterdir()}
        with self.assertRaisesRegex(ValueError, "directory_not_empty"):
            self.run_prepare()
        self.assertEqual(original, {f.name: f.read_bytes() for f in self.directory.iterdir()})
        self.assert_no_native()

    def test_private_directory_and_authorized_roots_required_without_chmod(self):
        self.directory.chmod(0o755)
        with self.assertRaisesRegex(ValueError, "private_directory_required"):
            self.run_prepare()
        self.assertEqual(stat.S_IMODE(self.directory.stat().st_mode), 0o755)
        self.assertEqual(list(self.directory.iterdir()), [])
        self.input["directory"] = str(self.start.root)
        self.ref = self.gate.ref("out-of-scope.json", self.input)
        with self.assertRaisesRegex(ValueError, "outside_roots"):
            self.run_prepare()
        self.assert_no_native()

    def test_missing_execute_and_safe_context_error_from_cli(self):
        for flags, expected in (([], "strict_prepare_explicit_execute_required"),
                                (["--execute"], "operator_native_context_mismatch")):
            out = io.StringIO()
            with redirect_stdout(out):
                status = legacy_main(["--input", self.ref["path"],
                               "--input-sha256", self.ref["sha256"], *flags])
            self.assertEqual(status, 2)
            self.assertEqual(json.loads(out.getvalue())["error"], expected)
        self.assertEqual(list(self.directory.iterdir()), [])
        self.assert_no_native()

    def test_atomic_raw_publisher_never_replaces_existing_bytes(self):
        target = self.directory / "bytes.snapshot"
        publish_new(target, b"first\r\n")
        with self.assertRaises(FileExistsError):
            publish_new(target, b"replacement\n")
        self.assertEqual(target.read_bytes(), b"first\r\n")

    def test_denied_or_colliding_publication_stops_without_followup_write(self):
        for error in (PermissionError, FileExistsError):
            attempt = self.directory / error.__name__
            attempt.mkdir(mode=0o700)
            self.input["directory"] = str(attempt)
            self.ref = self.gate.ref(error.__name__ + "-input.json", self.input)
            writes = []

            def reject(target, value):
                writes.append(target.name)
                if target.name == "readiness-000.snapshot":
                    raise error("unavailable")
                return publish_new(target, value)

            with patch("coordinator_strict_prepare.publish_new", side_effect=reject):
                with self.assertRaises(error):
                    self.run_prepare()
            self.assertEqual(writes, ["prepare-intent.json", "readiness-000.snapshot"])
            self.assertTrue((attempt / "prepare-intent.json").exists())
            self.assertFalse((attempt / "start.json").exists())
        self.assert_no_native()

    def test_all_evidence_frozen_and_cli_success_returns_reviewable_pins(self):
        extra = self.gate.ref("file-tools.json", {"fixture": "write/read/rename/read audit"})
        self.input["readiness_evidence"].append(extra)
        self.ref = self.gate.ref("multiple-input.json", self.input)
        out = io.StringIO()
        with patch.dict(os.environ, {"ORCA_TERMINAL_HANDLE": "term_operator"}), redirect_stdout(out):
            status = legacy_main(["--input", self.ref["path"],
                           "--input-sha256", self.ref["sha256"], "--execute"])
        self.assertEqual(status, 0)
        result = json.loads(out.getvalue())
        config, _, _, _ = load(result["config"])
        self.assertEqual(len(config["readiness_evidence"]), 2)
        for source, snapshot in zip(self.input["readiness_evidence"], config["readiness_evidence"]):
            self.assertEqual(pinned(source), pinned(snapshot))
            self.assertNotEqual(source["path"], snapshot["path"])
        self.assertIn("--execute", result["plan"]["wait_argv"])
        self.assert_no_native()

    def test_original_validation_is_not_weakened_by_preparation(self):
        for field, value, code in (("max_workers", True, "max_workers_required"),
                                   ("deadline", "2000-01-01T00:00:00+00:00", "deadline_expired"),
                                   ("readiness_evidence", [], "readiness_evidence_required")):
            bad = dict(self.input, **{field: value})
            self.ref = self.gate.ref(field + "-bad-input.json", bad)
            with self.assertRaisesRegex(ValueError, code):
                self.run_prepare()
            self.assertEqual(list(self.directory.iterdir()), [])
        self.assert_no_native()


if __name__ == "__main__":
    unittest.main()

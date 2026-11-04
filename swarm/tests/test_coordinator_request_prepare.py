"""Request-only prepare/review: real byte IO and gates, mocked native service only."""

from contextlib import redirect_stderr, redirect_stdout
from datetime import timedelta
import errno
import io
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

from coordinator_io import (canonical, file_ref, parse, pinned, publish_directory_new,
                            publish_new)
from coordinator_launch import main
from coordinator_prepared_commit import publish_bundle_new
from coordinator_request_prepare import (config_for, contract_for, prepare_request,
                                         review_request)
from coordinator_strict_delivery import deliver, wait_for_config
from coordinator_strict_start import load, wait_and_create
import test_coordinator_strict_request as request_tests


class RequestPrepareTests(unittest.TestCase):
    def setUp(self):
        self.integration = request_tests.StrictRequestIntegrationTests()
        self.integration.setUp()
        self.addCleanup(self.integration.doCleanups)
        self.f = self.integration.f
        self.directory, self.root = self.f.directory, self.f.bootstrap

    def prepare(self):
        return self.f.prepare()

    def review(self, decision="approve"):
        with patch.dict(os.environ, {"ORCA_TERMINAL_HANDLE": "term_operator"}):
            return review_request(self.f.ref, decision=decision, notes="fixture independent review")

    def deliver(self, review=None):
        with patch.dict(os.environ, {"ORCA_TERMINAL_HANDLE": "term_operator"}):
            return deliver(self.f.ref, self.f.result["config"], self.f.result["preparation"], review)

    def assert_unpublished(self):
        self.assertFalse(self.directory.exists())
        self.assertFalse((self.root / "strict-config-ready.json").exists())
        self.f.assert_no_start()

    def changed_request(self, **changes):
        self.f.expected.update(changes)
        self.f.ref = self.f.gate.ref("strict-config-request.json", self.f.expected, self.root)

    def test_exact_single_final_readiness_with_embedded_probe_not_expanded(self):
        source = self.f.expected["readiness_evidence"][0]
        raw = b'{ "kind":"final-readiness", "probe":{"path":"/not-to-be-read","sha256":"invalid"} }\n\n'
        Path(source["path"]).write_bytes(raw)
        source = file_ref(Path(source["path"]))
        fields = parse(pinned(self.f.expected["contract_fields"]))
        fields["skill_read_evidence"] = source
        self.changed_request(readiness_evidence=[source],
                             contract_fields=self.f.gate.ref("fields-final.json", fields))
        result = self.prepare()
        config, contract, _, _ = load(result["config"])
        receipt = parse(pinned(result["preparation"]))
        self.assertEqual(len(config["readiness_evidence"]), 1)
        self.assertEqual(len(receipt["readiness_snapshots"]), 1)
        self.assertEqual(pinned(config["readiness_evidence"][0]), raw)
        self.assertEqual(contract["skill_read_evidence"], config["readiness_evidence"][0])
        self.assertEqual(config["request"], self.f.ref)
        for key in ("request_id", "deadline", "objective", "max_workers", "directory", "caller_receipt"):
            self.assertEqual(config[key], self.f.expected[key])
        self.assertEqual({p.name for p in self.directory.iterdir()}, {
            "start.json", "session-contract.json", "prepared-inputs.json", "readiness-000.snapshot",
            "prepared-commit.json"})
        for p in self.directory.iterdir():
            self.assertEqual(stat.S_IMODE(p.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.directory.stat().st_mode), 0o700)
        self.assertFalse(result["execution_authorized"])
        self.assertFalse(result["operator_identity_verified"])
        self.f.assert_no_start()

    def test_cli_refuses_operator_overrides_before_any_write(self):
        flags = ["--request", self.f.ref["path"], "--request-sha256", self.f.ref["sha256"], "--execute"]
        for option in ("--input", "--readiness-evidence", "--contract-fields", "--directory", "--objective"):
            with self.subTest(option=option), redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                main(["strict-start-prepare", *flags, option, "operator-edited"])
            self.assert_unpublished()
            self.assertEqual(list(self.root.glob(".strict-start-staging-*")), [])

    def test_duplicate_request_evidence_rejected_before_staging(self):
        self.changed_request(readiness_evidence=self.f.expected["readiness_evidence"] * 2)
        with self.assertRaisesRegex(ValueError, "duplicate_evidence"):
            self.prepare()
        self.assert_unpublished()
        self.assertEqual(list(self.root.glob(".strict-start-staging-*")), [])

    def test_missing_skill_pin_and_bound_run_rejected_before_staging(self):
        fields = parse(pinned(self.f.expected["contract_fields"]))
        for changes in ({"skill_read_evidence": self.f.gate.ref("different.json", {})},
                        {"run": {"id": "run_old", "generation": 1}}, {"runtime": "different"}):
            self.changed_request(contract_fields=self.f.gate.ref("bad-fields.json", dict(fields, **changes)))
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.prepare()
            self.assert_unpublished()
            self.assertEqual(list(self.root.glob(".strict-start-staging-*")), [])

    def test_invalid_generated_contract_fields_rejected_before_staging(self):
        fields = parse(pinned(self.f.expected["contract_fields"]))
        self.changed_request(contract_fields=self.f.gate.ref("unknown-field.json", dict(fields, unknown=True)))
        with self.assertRaisesRegex(ValueError, "invalid_startup_contract"):
            self.prepare()
        self.assert_unpublished()
        self.assertEqual(list(self.root.glob(".strict-start-staging-*")), [])

    def test_wrong_operator_and_nonprivate_parent_stop_without_chmod(self):
        with self.assertRaisesRegex(ValueError, "operator_native_context_mismatch"):
            prepare_request(self.f.ref)
        self.root.chmod(0o755)
        with self.assertRaisesRegex(ValueError, "private_parent_required"):
            self.prepare()
        self.assertEqual(stat.S_IMODE(self.root.stat().st_mode), 0o755)
        self.assert_unpublished()

    def test_all_staged_write_crashes_keep_final_absent_and_diagnostic_staging(self):
        for failed_name in ("readiness-000.snapshot", "session-contract.json", "prepared-inputs.json", "start.json"):
            writes = []

            def crash(target, value):
                writes.append(target.name)
                publish_new(target, value)
                if target.name == failed_name:
                    raise OSError("injected crash")

            with self.subTest(failed_name=failed_name), patch(
                    "coordinator_request_prepare.publish_new", side_effect=crash), self.assertRaises(OSError):
                self.prepare()
            self.assertEqual(writes[-1], failed_name)
            self.assert_unpublished()
        self.assertEqual(len(list(self.root.glob(".strict-start-staging-*"))), 4)

    def test_commit_crash_and_permission_denial_no_retry_or_cleanup(self):
        for error in (OSError("crash"), PermissionError("denied")):
            with patch("coordinator_request_prepare.publish_bundle_new", side_effect=error) as commit:
                with self.assertRaises(OSError):
                    self.prepare()
                commit.assert_called_once()
            self.assert_unpublished()
        self.assertEqual(len(list(self.root.glob(".strict-start-staging-*"))), 2)

    def test_final_collision_even_empty_does_not_replace_other_claimant(self):
        def compete(staging, target, *args, **kwargs):
            target.mkdir(mode=0o700)
            publish_bundle_new(staging, target, *args, **kwargs)

        with patch("coordinator_request_prepare.publish_bundle_new", side_effect=compete):
            with self.assertRaises(FileExistsError):
                self.prepare()
        self.assertEqual(list(self.directory.iterdir()), [])
        self.assertEqual(len(list(self.root.glob(".strict-start-staging-*"))), 1)
        self.f.assert_no_start()

    def test_pin_drift_during_staging_never_publishes_final(self):
        for ref in (self.f.ref, self.f.expected["contract_fields"], self.f.expected["readiness_evidence"][0]):
            original = pinned(ref)

            def change(target, value):
                publish_new(target, value)
                if target.name == "start.json":
                    Path(ref["path"]).write_text("changed source")

            with self.subTest(ref=ref["path"]), patch("coordinator_request_prepare.publish_new", side_effect=change):
                with self.assertRaisesRegex(ValueError, "file_pin_changed"):
                    self.prepare()
            self.assert_unpublished()
            Path(ref["path"]).write_bytes(original)

    def test_deadline_expiry_or_clock_rollback_before_commit_keeps_final_absent(self):
        original_clock = self.f.start.clock
        for seconds in (1000, -1000):
            def change(target, value):
                publish_new(target, value)
                if target.name == "start.json":
                    self.f.start.clock += timedelta(seconds=seconds)

            with self.subTest(seconds=seconds), patch("coordinator_request_prepare.publish_new", side_effect=change):
                with self.assertRaises(ValueError):
                    self.prepare()
            self.assert_unpublished()
            self.f.start.clock = original_clock

    def test_future_caller_time_fails_before_creating_staging(self):
        with patch("coordinator_request_prepare.now", return_value="2000-01-01T00:00:00+00:00"):
            with self.assertRaisesRegex(ValueError, "time_invalid"):
                self.prepare()
        self.assert_unpublished()
        self.assertEqual(list(self.root.glob(".strict-start-staging-*")), [])

    def test_late_staging_tamper_detected_before_commit(self):
        from coordinator_strict_start import validate_start_window
        calls = 0

        def tamper(*args, **kwargs):
            nonlocal calls
            result = validate_start_window(*args, **kwargs)
            calls += 1
            # Tamper at the final time check, after the original readback.
            for staging in self.root.glob(".strict-start-staging-*"):
                (staging / "start.json").write_text("changed staging")
            return result

        with patch("coordinator_strict_start.validate_start_window", side_effect=tamper):
            with self.assertRaisesRegex(ValueError, "file_pin_changed"):
                self.prepare()
        self.assertGreater(calls, 0)
        self.assert_unpublished()

    def test_repeat_prepare_never_overwrites_evidence(self):
        self.prepare()
        saved = {p.name: p.read_bytes() for p in self.directory.iterdir()}
        with self.assertRaisesRegex(ValueError, "target_exists"):
            self.prepare()
        self.assertEqual(saved, {p.name: p.read_bytes() for p in self.directory.iterdir()})
        self.f.assert_no_start()

    def test_same_request_produces_identical_staging_bytes_on_replay_without_commit(self):
        with patch("coordinator_request_prepare.publish_bundle_new", side_effect=OSError("before commit")):
            for _ in range(2):
                with self.assertRaises(OSError):
                    self.prepare()
        stages = list(self.root.glob(".strict-start-staging-*"))
        self.assertEqual(len(stages), 2)
        self.assertEqual({p.name: p.read_bytes() for p in stages[0].iterdir()},
                         {p.name: p.read_bytes() for p in stages[1].iterdir()})
        config = config_for(self.f.ref, self.f.expected, contract_for(self.f.expected))
        self.assertEqual((stages[0] / "start.json").read_bytes(), canonical(config) + b"\n")
        self.assert_unpublished()

    def test_missing_review_blocks_delivery_and_direct_waiter_before_native(self):
        result = self.prepare()
        with self.assertRaisesRegex(ValueError, "strict_config_review_required"):
            self.deliver()
        with self.assertRaises(FileNotFoundError):
            wait_and_create(result["config"])
        self.assertEqual(self.f.start.calls, [])
        self.f.assert_no_start()

    def test_reject_cannot_be_replaced_or_published_or_bypassed_by_alternate_path(self):
        self.prepare()
        rejected = self.review("reject")
        saved = pinned(rejected["review"])
        with self.assertRaises(FileExistsError):
            self.review("approve")
        self.assertEqual(pinned(rejected["review"]), saved)
        with self.assertRaisesRegex(ValueError, "review_rejected"):
            self.deliver(rejected["review"])
        receipt = dict(parse(saved), decision="approve")
        alternate = self.f.gate.ref("alternate-review.json", receipt)
        with self.assertRaisesRegex(ValueError, "review_path_mismatch"):
            self.deliver(alternate)
        with self.assertRaisesRegex(ValueError, "review_rejected"):
            wait_and_create(self.f.result["config"])
        self.f.assert_no_start()

    def test_request_hash_change_invalidates_old_config_and_review(self):
        self.prepare()
        review = self.review()
        self.changed_request(recovery_note="changed request, same business objective")
        with self.assertRaisesRegex(ValueError, "prepared_request_mismatch"):
            self.deliver(review["review"])
        self.assertFalse((self.root / "strict-config-ready.json").exists())
        self.f.assert_no_start()

    def test_review_and_publication_are_byte_stable_for_same_pinned_inputs_and_clock(self):
        self.prepare()
        reviews, publications = [], []

        def record_review(target, value):
            reviews.append(canonical(value) + b"\n")
            raise OSError("injected before publication")

        with patch("coordinator_request_prepare.publish_new", side_effect=record_review):
            for _ in range(2):
                with self.assertRaises(OSError):
                    self.review()
        self.assertEqual(reviews[0], reviews[1])
        review = self.review()["review"]

        def record_publication(target, value):
            publications.append(canonical(value) + b"\n")
            raise OSError("injected before publication")

        with patch("coordinator_strict_delivery.publish_new", side_effect=record_publication):
            for _ in range(2):
                with self.assertRaises(OSError):
                    self.deliver(review)
        self.assertEqual(publications[0], publications[1])
        self.assertFalse((self.root / "strict-config-ready.json").exists())

    def test_evidence_permission_denial_causes_no_write_or_retry(self):
        with patch("coordinator_request_prepare.snapshots_io.collect", side_effect=PermissionError("denied")) as read:
            with self.assertRaises(PermissionError):
                self.prepare()
        read.assert_called_once()
        self.assert_unpublished()
        self.assertEqual(list(self.root.glob(".strict-start-staging-*")), [])

    def test_operator_appends_deletes_reorders_duplicates_cannot_publish(self):
        extra = self.f.gate.ref("extra-readiness.json", {"fixture": "tool proof"})
        self.changed_request(readiness_evidence=[*self.f.expected["readiness_evidence"], extra])
        result = self.prepare()
        original = parse(pinned(result["config"]))
        refs = original["readiness_evidence"]
        for altered in ([*refs, extra], refs[:1], list(reversed(refs)), refs * 2):
            config = dict(original, readiness_evidence=altered)
            self.f.result["config"] = self.f.gate.ref("start.json", config, self.directory)
            with self.subTest(altered=altered), self.assertRaisesRegex(ValueError, "prepared_request_mismatch"):
                self.review()
            self.assertFalse((self.root / "strict-config-review.json").exists())
            self.assertFalse((self.root / "strict-config-ready.json").exists())
        self.f.assert_no_start()

    def test_approved_review_binds_every_output_and_cannot_be_forged_by_extra_fields(self):
        self.prepare()
        ref = self.review()["review"]
        original = parse(pinned(ref))
        for changes in ({"request": dict(self.f.ref, sha256="0" * 64)}, {"config": {}},
                        {"preparation": {}}, {"operator": {}}, {"identity_verified": True},
                        {"execution_authorized": True}, {"readiness_evidence": []}):
            altered = self.f.gate.ref("strict-config-review.json", dict(original, **changes), self.root)
            with self.subTest(changes=changes), self.assertRaisesRegex(ValueError, "review_mismatch"):
                self.deliver(altered)
            self.assertFalse((self.root / "strict-config-ready.json").exists())

    def test_original_readiness_can_change_after_freeze_but_snapshot_cannot(self):
        result = self.prepare()
        Path(self.f.expected["readiness_evidence"][0]["path"]).write_text("later producer output")
        self.deliver(self.review()["review"])
        self.assertTrue(wait_for_config(self.f.ref)["ok"])
        config = parse(pinned(result["config"]))
        Path(config["readiness_evidence"][0]["path"]).write_text("changed snapshot")
        with self.assertRaisesRegex(ValueError, "file_pin_changed"):
            wait_for_config(self.f.ref)
        self.f.assert_no_start()

    def test_review_later_than_publication_is_not_accepted(self):
        self.prepare()
        ref = self.review()["review"]
        publication = self.deliver(ref)["publication"]
        review = parse(pinned(ref))
        self.f.start.clock += timedelta(seconds=1)
        review["reviewed_at"] = self.f.start.clock.isoformat()
        ref = self.f.gate.ref("strict-config-review.json", review, self.root)
        value = dict(parse(pinned(publication)), review=ref)
        self.f.gate.ref("strict-config-ready.json", value, self.root)
        with self.assertRaisesRegex(ValueError, "review_time_invalid"):
            wait_for_config(self.f.ref)
        self.f.assert_no_start()

    def test_final_live_check_review_drift_stops_receiver(self):
        from coordinator_strict_delivery import live
        self.prepare()
        review = self.review()["review"]
        self.deliver(review)
        calls = 0

        def drift(*args):
            nonlocal calls
            result = live(*args)
            calls += 1
            if calls == 2:
                Path(review["path"]).write_text("changed")
            return result

        with patch("coordinator_strict_delivery.live", side_effect=drift):
            with self.assertRaisesRegex(ValueError, "file_pin_changed"):
                wait_for_config(self.f.ref)
        self.f.assert_no_start()

    def test_review_change_while_waiting_for_gate_prevents_create(self):
        self.prepare()
        review = self.review()["review"]
        self.deliver(review)
        self.f.start.ref = self.f.result["config"]

        def change():
            value = dict(parse(pinned(review)), decision="reject")
            Path(review["path"]).write_bytes(canonical(value) + b"\n")

        self.f.start.post_check = change
        with self.assertRaisesRegex(ValueError, "review_rejected"):
            wait_and_create(self.f.result["config"])
        self.assertEqual(self.f.start.creates(), [])
        self.assertFalse((self.directory / "create-intent.json").exists())

    def test_new_cli_prepare_review_publish_receive_with_explicit_execute(self):
        flags = ["--request", self.f.ref["path"], "--request-sha256", self.f.ref["sha256"]]

        def invoke(mode, extra, actor="term_operator"):
            out = io.StringIO()
            with redirect_stdout(out), patch.dict(os.environ, {"ORCA_TERMINAL_HANDLE": actor}):
                code = main([mode, *flags, *extra])
            return code, json.loads(out.getvalue())

        self.assertEqual(invoke("strict-start-prepare", [])[0], 2)
        self.assert_unpublished()
        code, result = invoke("strict-start-prepare", ["--execute"])
        self.assertEqual(code, 0)
        review_flags = ["--decision", "approve", "--notes", "independent fixture review"]
        self.assertEqual(invoke("strict-config-review", review_flags)[0], 2)
        code, reviewed = invoke("strict-config-review", [*review_flags, "--execute"])
        self.assertEqual(code, 0)
        extra = ["--execute"]
        for key, ref in (("config", result["config"]), ("preparation", result["preparation"]),
                         ("review", reviewed["review"])):
            extra.extend(["--" + key, ref["path"], "--" + key + "-sha256", ref["sha256"]])
        self.assertEqual(invoke("strict-config-publish", extra)[0], 0)
        self.assertEqual(invoke("strict-config-wait", [], "term_test")[0], 0)
        self.f.assert_no_start()


class TuiRequestPrepareTests(unittest.TestCase):
    def test_tui_request_uses_same_request_only_prepare_and_review(self):
        fixture = request_tests.StrictRequestTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        ref = fixture.build()["request"]
        with patch("coordinator_request_prepare.now", side_effect=lambda: fixture.clock.isoformat()), \
                patch("coordinator_strict_start.now", side_effect=lambda: fixture.clock.isoformat()), \
                patch.dict(os.environ, {"ORCA_TERMINAL_HANDLE": "term_operator"}):
            result = prepare_request(ref)
            review = review_request(ref, decision="approve", notes="TUI fixture audit")
            publication = deliver(ref, result["config"], result["preparation"], review["review"])
        config, contract, _, _ = load(result["config"])
        self.assertEqual(config["request"], ref)
        self.assertEqual(contract["adapter"], "trae-tui-runtime-v1")
        self.assertEqual(parse(pinned(publication["publication"]))["review"], review["review"])
        self.assertEqual(fixture.tui.calls, [])


class DirectoryCommitTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.stage, self.target = self.root / "stage", self.root / "strict-start"
        self.stage.mkdir(mode=0o700)
        publish_new(self.stage / "file", b"complete\n")

    def test_real_exclusive_directory_commit(self):
        publish_directory_new(self.stage, self.target)
        self.assertFalse(self.stage.exists())
        self.assertEqual((self.target / "file").read_bytes(), b"complete\n")

    def test_empty_nonempty_symlink_targets_never_replaced(self):
        self.target.mkdir()
        with self.assertRaises(FileExistsError):
            publish_directory_new(self.stage, self.target)
        publish_new(self.target / "old", b"keep")
        with self.assertRaises(FileExistsError):
            publish_directory_new(self.stage, self.target)
        self.assertEqual((self.target / "old").read_bytes(), b"keep")
        link = self.root / "link"
        link.symlink_to(self.target)
        with self.assertRaises(FileExistsError):
            publish_directory_new(self.stage, link)
        self.assertTrue(link.is_symlink())
        self.assertTrue(self.stage.exists())

    def test_unsupported_platform_has_no_unsafe_rename_fallback(self):
        with patch("coordinator_io.sys.platform", "unsupported"), self.assertRaises(OSError) as cm:
            publish_directory_new(self.stage, self.target)
        self.assertEqual(cm.exception.errno, errno.ENOTSUP)
        self.assertTrue(self.stage.exists())
        self.assertFalse(self.target.exists())

    def test_fsync_failure_before_commit_preserves_stage_after_commit_preserves_complete_target(self):
        with patch("coordinator_io.fsync_dir", side_effect=OSError("fsync stage failed")):
            with self.assertRaises(OSError):
                publish_directory_new(self.stage, self.target)
        self.assertTrue(self.stage.exists())
        self.assertFalse(self.target.exists())
        with patch("coordinator_io.fsync_dir", side_effect=[None, OSError("fsync parent failed")]):
            with self.assertRaises(OSError):
                publish_directory_new(self.stage, self.target)
        self.assertFalse(self.stage.exists())
        self.assertEqual((self.target / "file").read_bytes(), b"complete\n")


if __name__ == "__main__":
    unittest.main()

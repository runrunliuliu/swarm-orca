"""Real filesystem marker commits; native gates remain mocked in integration fixtures."""

from concurrent.futures import ThreadPoolExecutor
from contextlib import redirect_stdout
import errno
import io
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from coordinator_io import (canonical, file_ref, fsync_dir, parse, pinned,
                            publish_directory_new, publish_new)
from coordinator_launch import main
from coordinator_prepared_commit import (COMMIT_NAME, commit_value, probe_storage,
                                         publish_bundle_new, verify_commit)
from coordinator_request_prepare import (config_for, contract_for, mappings_for,
                                         prepare_request, review_request)
from coordinator_strict_delivery import deliver, wait_for_config
from coordinator_strict_start import load, plan, publish, wait_and_create
import test_coordinator_strict_request as request_tests


class BundleCommitTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.staging = self.root / "staging"
        self.staging.mkdir(mode=0o700)
        self.target = self.root / "strict-start"
        self.request = {"path": str(self.root / "request.json"), "sha256": "a" * 64}
        self.members = []
        for name in ("a.snapshot", "start.json"):
            publish_new(self.staging / name, b"complete bytes\n")
            self.members.append(dict(file_ref(self.staging / name), path=str(self.target / name)))
        self.progress = {}

    def publish(self, before_commit=lambda: None):
        return publish_bundle_new(self.staging, self.target, self.request, self.members,
                                  before_commit=before_commit, progress=self.progress)

    def test_real_commit_retains_staging_and_has_no_self_reference(self):
        ref = self.publish()
        self.assertEqual(verify_commit(self.target, self.request, self.members), ref)
        self.assertEqual(parse(pinned(ref)), commit_value(self.request, self.members))
        self.assertTrue(self.staging.exists())
        self.assertNotIn(ref, parse(pinned(ref))["files"])

    def test_partial_bundle_and_complete_members_without_marker_are_rejected(self):
        def inspect():
            self.assertEqual(len(list(self.target.iterdir())), len(self.members))
            with self.assertRaises(FileNotFoundError):
                verify_commit(self.target, self.request, self.members)
        self.publish(before_commit=inspect)

    def test_two_simultaneous_claimants_exactly_one_commits(self):
        barrier = threading.Barrier(2)
        def compete():
            barrier.wait(timeout=5)
            try:
                return publish_bundle_new(self.staging, self.target, self.request, self.members,
                                          before_commit=lambda: None, progress={})
            except FileExistsError:
                return None
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(lambda _: compete(), range(2)))
        self.assertEqual(sum(item is not None for item in results), 1)
        verify_commit(self.target, self.request, self.members)

    def test_collision_empty_directory_and_symlink_never_replaced(self):
        self.target.mkdir(mode=0o700)
        with self.assertRaises(FileExistsError):
            self.publish()
        self.assertEqual(list(self.target.iterdir()), [])
        self.target.rmdir()  # This test's empty synthetic directory only.
        self.target.symlink_to(self.staging)
        with self.assertRaises(FileExistsError):
            self.publish()
        self.assertTrue(self.target.is_symlink())

    def test_crash_after_first_member_preserves_uncommitted_directory_and_staging(self):
        def fail(target, value):
            publish_new(target, value)
            raise OSError(errno.EIO, "injected")
        with patch("coordinator_prepared_commit.publish_new", side_effect=fail) as writer:
            with self.assertRaises(OSError):
                self.publish()
        writer.assert_called_once()
        self.assertTrue(self.staging.exists())
        self.assertFalse((self.target / COMMIT_NAME).exists())
        with self.assertRaises(FileExistsError):
            self.publish()

    def test_final_revalidation_failure_never_publishes_marker(self):
        def fail():
            raise ValueError("input_drift")
        with self.assertRaisesRegex(ValueError, "input_drift"):
            self.publish(before_commit=fail)
        self.assertFalse((self.target / COMMIT_NAME).exists())

    def test_fsync_failure_before_commit_leaves_uncommitted_directory(self):
        with patch("coordinator_prepared_commit.fsync_dir", side_effect=OSError(errno.EIO, "injected")):
            with self.assertRaises(OSError):
                self.publish()
        self.assertTrue(self.target.is_dir())
        self.assertFalse((self.target / COMMIT_NAME).exists())

    def test_marker_post_link_fsync_failure_has_unknown_outcome_and_is_not_replayed(self):
        calls = 0
        def fail_final(directory):
            nonlocal calls
            calls += 1
            if calls == len(self.members) + 1:
                raise OSError(errno.EIO, "marker linked, sync failed")
            fsync_dir(directory)
        with patch("coordinator_io.fsync_dir", side_effect=fail_final):
            with self.assertRaises(OSError):
                self.publish()
        self.assertEqual(self.progress["stage"], "publish_commit")
        verify_commit(self.target, self.request, self.members)  # readback, not durability proof
        with self.assertRaises(FileExistsError):
            self.publish()

    def test_readback_rejects_tampered_marker_and_members(self):
        ref = self.publish()
        original = pinned(ref)
        for bad in (dict(parse(original), request={}), dict(parse(original), files=[]),
                    dict(parse(original), schema_version=True), {"unknown": True}, []):
            Path(ref["path"]).write_bytes(canonical(bad) + b"\n")
            with self.assertRaisesRegex(ValueError, "commit_mismatch"):
                verify_commit(self.target, self.request, self.members)
        Path(ref["path"]).write_bytes(original)
        Path(self.members[0]["path"]).write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "file_pin_changed"):
            verify_commit(self.target, self.request, self.members)

    def test_member_paths_and_duplicate_refs_are_rejected_before_claim(self):
        for members in (self.members * 2, [dict(self.members[0], path=str(self.root / "outside"))],
                        [dict(self.members[0], path=str(self.target / COMMIT_NAME))]):
            with self.assertRaises(ValueError):
                publish_bundle_new(self.staging, self.target, self.request, members,
                                   before_commit=lambda: None, progress={})
            self.assertFalse(self.target.exists())

    def test_real_storage_probe_is_exclusive_and_retained(self):
        ref = probe_storage(self.root, self.progress)
        self.assertTrue(parse(pinned(ref))["exclusive"])
        self.assertTrue(Path(self.progress["storage_probe"]).is_dir())
        self.assertFalse(self.target.exists())


class RequestCommitIntegrationTests(unittest.TestCase):
    def setUp(self):
        fixture = request_tests.StrictRequestIntegrationTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        self.f = fixture.f

    def test_missing_marker_blocks_all_start_consumers_before_native(self):
        result = self.f.prepare()
        marker = self.f.directory / COMMIT_NAME
        marker.rename(self.f.directory / "hidden-marker")  # Synthetic interrupted fixture.
        for reader in (load, plan, wait_and_create):
            with self.subTest(reader=reader.__name__), self.assertRaises(FileNotFoundError):
                reader(result["config"])
        with self.assertRaises(FileNotFoundError):
            publish(result["config"], {})
        with patch.dict(os.environ, {"ORCA_TERMINAL_HANDLE": "term_operator"}):
            with self.assertRaises(FileNotFoundError):
                review_request(self.f.ref, decision="approve", notes="must not pass")
            with self.assertRaises(FileNotFoundError):
                deliver(self.f.ref, result["config"], result["preparation"])
        self.assertEqual(self.f.start.calls, [])
        self.f.assert_no_start()

    def test_config_downgrade_cannot_bypass_missing_marker(self):
        result = self.f.prepare()
        (self.f.directory / COMMIT_NAME).unlink()  # Synthetic interruption, not production cleanup.
        config = parse(pinned(result["config"]))
        for version in (1, 2):
            downgraded = dict(config, schema_version=version)
            if version == 1:
                downgraded.pop("request")
            ref = self.f.gate.ref("start.json", downgraded, self.f.directory)
            with self.assertRaisesRegex(ValueError, "downgrade|version_mismatch"):
                load(ref)

    def test_commit_remains_valid_after_later_runtime_files_are_created(self):
        result = self.f.prepare()
        publish_new(self.f.directory / "ready.json", {"synthetic": True})
        self.assertEqual(load(result["config"])[0]["schema_version"], 3)

    def test_late_drift_after_members_before_commit_stops_publication(self):
        from coordinator_prepared_commit import publish_new as original
        def drift(target, value):
            original(target, value)
            if target == self.f.directory / "start.json":
                Path(self.f.expected["readiness_evidence"][0]["path"]).write_text("changed")
        with patch("coordinator_prepared_commit.publish_new", side_effect=drift):
            with self.assertRaisesRegex(ValueError, "file_pin_changed"):
                self.f.prepare()
        self.assertTrue(self.f.directory.is_dir())
        self.assertFalse((self.f.directory / COMMIT_NAME).exists())
        self.f.assert_no_start()

    def test_cli_permission_error_retains_errno_stage_time_and_artifact_paths(self):
        out = io.StringIO()
        with patch("coordinator_prepared_commit.publish_new", side_effect=PermissionError(errno.EACCES, "private")) as writer, \
                patch.dict(os.environ, {"ORCA_TERMINAL_HANDLE": "term_operator"}), redirect_stdout(out):
            code = main(["strict-start-prepare", "--request", self.f.ref["path"],
                         "--request-sha256", self.f.ref["sha256"], "--execute"])
        writer.assert_called_once()
        result = json.loads(out.getvalue())
        self.assertEqual(code, 2)
        self.assertEqual(result["diagnostic"]["errno"], errno.EACCES)
        self.assertEqual(result["diagnostic"]["stage"], "storage_probe")
        self.assertEqual(result["diagnostic"]["request"], self.f.ref)
        self.assertEqual(result["diagnostic"]["checked_at"], self.f.start.clock.isoformat())
        self.assertTrue(Path(result["diagnostic"]["storage_probe"]).is_dir())
        self.assertNotIn("private", out.getvalue())
        self.assertFalse(self.f.directory.exists())
        self.assertEqual(list(self.f.bootstrap.glob(".strict-start-staging-*")), [])

    def test_old_request4_not_prepared_again_but_original_bundle_reads_without_marker(self):
        self.f.expected["schema_version"] = 4
        self.f.ref = self.f.gate.ref("strict-config-request.json", self.f.expected, self.f.bootstrap)
        with patch.dict(os.environ, {"ORCA_TERMINAL_HANDLE": "term_operator"}):
            with self.assertRaisesRegex(ValueError, "new_request_v5_required"):
                prepare_request(self.f.ref)
        # Construct a historical request4/config2/receipt2 fixture using the OLD protocol.
        staging = Path(tempfile.mkdtemp(dir=self.f.bootstrap))
        contract = contract_for(self.f.expected)
        config = config_for(self.f.ref, self.f.expected, contract)
        for item in mappings_for(self.f.expected):
            publish_new(staging / Path(item["snapshot"]["path"]).name, pinned(item["source"]))
        publish_new(staging / "session-contract.json", contract)
        publish_new(staging / "start.json", config)
        publish_new(staging / "prepared-inputs.json", dict(
            schema_version=2, kind="strict_start_prepared_inputs", request=self.f.ref,
            contract_fields=self.f.expected["contract_fields"], contract=config["contract"],
            readiness_snapshots=mappings_for(self.f.expected), prepared_at=self.f.start.clock.isoformat(),
            operator_identity_verified=False, execution_authorized=False))
        publish_directory_new(staging, self.f.directory)
        config_ref = file_ref(self.f.directory / "start.json")
        preparation = file_ref(self.f.directory / "prepared-inputs.json")
        saved = pinned(config_ref)
        with patch.dict(os.environ, {"ORCA_TERMINAL_HANDLE": "term_operator"}):
            reviewed = review_request(self.f.ref, decision="approve", notes="old fixture")
            deliver(self.f.ref, config_ref, preparation, reviewed["review"])
        self.assertTrue(wait_for_config(self.f.ref)["ok"])
        self.assertEqual(pinned(config_ref), saved)
        self.assertFalse((self.f.directory / COMMIT_NAME).exists())


if __name__ == "__main__":
    unittest.main()

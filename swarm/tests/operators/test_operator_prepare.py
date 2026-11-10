"""Pre-session local files/Git only; no native Agent, Run, gate or model calls."""

from concurrent.futures import ThreadPoolExecutor
from contextlib import redirect_stdout
import copy
import errno
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch

from coordinator_io import file_ref, parse, pinned, publish_new
from operator_prepare import main, prepare


class OperatorPrepareTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.git("init", "-q")
        self.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                 "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "baseline")
        self.directory = self.root / "attempt"
        self.directory.mkdir(mode=0o700)
        self.document = self.root / "authority.txt"
        self.document.write_bytes(b"review original user authorization\r\n")
        self.authority = file_ref(self.document)
        self.source = {
            "schema_version": 1, "preparation_id": "task-attempt-1", "directory": str(self.directory),
            "read_roots": [str(self.root)], "write_roots": [str(self.directory)],
            "sources": [{"name": "authority", "ref": self.authority, "format": "bytes"}],
            "authority_refs": [self.authority],
            "baselines": [{"name": "code", "path": str(self.repo),
                           "head": self.git("rev-parse", "HEAD").strip(), "clean": True}]}
        self.save()
        native_patch = patch("trae_coordinator.native")
        self.native = native_patch.start()
        self.addCleanup(native_patch.stop)
        self.addCleanup(self.native.assert_not_called)

    def git(self, *args):
        return subprocess.run(["git", "-C", str(self.repo), *args], check=True,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True).stdout

    def save(self):
        self.input = self.root / "input.json"
        self.input.write_text(json.dumps(self.source))
        self.ref = file_ref(self.input)

    def add_business_task(self, **updates):
        workspace = {"id": "workspace_test", "path": str(self.repo)}
        task = {
            "schema_version": 1, "kind": "strict_business_task", "workspace": workspace,
            "objective": "ship the approved feature", "authorization_refs": [self.authority]}
        task.update(updates)
        task_path = self.root / "business-task.json"
        task_path.write_text(json.dumps(task))
        self.source.update(task_source=file_ref(task_path), task_workspace=workspace,
                           recovery_note="resume the startup handshake only")
        self.save()

    def cli(self, *flags):
        output = io.StringIO()
        with redirect_stdout(output):
            code = main(["prepare", "--input", self.ref["path"],
                         "--input-sha256", self.ref["sha256"], *flags])
        return code, json.loads(output.getvalue())

    def files(self):
        return {p.name: p.read_bytes() for p in self.directory.iterdir()}

    def test_raw_dedup_snapshots_final_manifest_timing_and_audit_stop(self):
        self.source["sources"].append({"name": "same-bytes", "ref": self.authority, "format": "bytes"})
        self.save()
        writes = []

        def record(target, value):
            writes.append(target.name)
            publish_new(target, value)

        with patch("operator_prepare.publish_new", side_effect=record):
            result = prepare(self.ref)
        self.assertEqual(writes, ["prepare-intent.json", "source-000.snapshot",
                                  "source-001.snapshot", "prepared.json"])
        self.assertEqual(result["source_count"], 2)
        self.assertEqual(result["snapshot_count"], 2)  # input + one shared document
        self.assertEqual(result["status"], "awaiting_external_audit")
        self.assertFalse(result["execution_authorized"])
        manifest = parse(pinned(result["preparation"]))
        self.assertEqual(pinned(manifest["input_snapshot"]), self.input.read_bytes())
        self.assertEqual(pinned(manifest["authority_snapshots"][0]), self.document.read_bytes())
        for field in ("authority_interpreted", "operator_identity_verified", "file_tool_probe_verified",
                      "git_writes_verified", "execution_authorized"):
            self.assertFalse(manifest[field])
        self.assertIsNone(manifest["run_id"])
        timing = manifest["timing"]
        self.assertEqual(timing["git_query_count"], 10)
        self.assertGreater(timing["checks_wall_seconds"], 0)
        self.assertGreaterEqual(timing["checks_wall_seconds"], timing["git_query_seconds"])
        for field in ("operator_started_at", "model_responses", "audit_wait_seconds", "run_created_at"):
            self.assertIsNone(timing[field])
        self.assertNotIn(result["preparation"], [m["source"] for m in manifest["snapshots"]])
        for p in self.directory.iterdir():
            self.assertEqual(p.stat().st_mode & 0o777, 0o600)

    def prepared(self):
        code, result = self.cli("--execute")
        self.assertEqual(code, 0, result)
        return result["preparation"]

    def test_verify_prepared_accepts_the_audited_manifest_and_every_frozen_ref(self):
        from operator_prepare import verify_prepared
        prepared = self.prepared()
        checked = verify_prepared(prepared)
        self.assertEqual(checked["preparation_id"], "task-attempt-1")
        self.assertEqual(checked["baseline_count"], 1)
        self.assertTrue(checked["ref_count"] > checked["snapshot_count"])

    def test_verify_prepared_rejects_a_repository_that_moved_after_prepare(self):
        # "Prepared" is a claim about now: a later commit in the baseline repo must
        # stop planning instead of launching against reviewed-but-stale state.
        from operator_prepare import verify_prepared
        prepared = self.prepared()
        self.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                 "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "after-audit")
        with self.assertRaises(ValueError):
            verify_prepared(prepared)

    def test_verify_prepared_rejects_an_auxiliary_snapshot_rewritten_after_audit(self):
        from coordinator_io import parse, pinned
        from operator_prepare import verify_prepared
        prepared = self.prepared()
        value = parse(pinned(prepared))
        target = Path(value["authority_snapshots"][0]["path"])
        target.write_bytes(b"rewritten after audit\n")
        with self.assertRaises(ValueError):
            verify_prepared(prepared)

    def test_verify_prepared_rejects_a_manifest_without_baselines(self):
        # `prepare()` cannot emit an empty baseline list, so accepting one would let
        # a hand-written manifest skip baseline-drift protection entirely.
        from coordinator_io import file_ref, parse, pinned, publish_new
        from operator_prepare import verify_prepared
        prepared = self.prepared()
        value = parse(pinned(prepared))
        value["baselines"] = []
        manifest = self.root / "hand-written.json"
        publish_new(manifest, value)
        with self.assertRaisesRegex(ValueError, "operator_prepare_manifest_baselines_missing"):
            verify_prepared(file_ref(manifest))

    def test_cli_requires_explicit_local_write_and_returns_only_pins(self):
        code, result = self.cli()
        self.assertEqual(code, 2)
        self.assertEqual(result["error"], "operator_prepare_explicit_execute_required")
        self.assertEqual(self.files(), {})
        code, result = self.cli("--execute")
        self.assertEqual(code, 0)
        self.assertNotIn("review original user authorization", json.dumps(result))
        self.assertEqual(parse(pinned(result["preparation"]))["status"], "awaiting_external_audit")

    def test_repeated_attempt_never_overwrites_or_returns_a_cached_success(self):
        prepare(self.ref)
        before = self.files()
        with self.assertRaisesRegex(ValueError, "directory_not_empty"):
            prepare(self.ref)
        self.assertEqual(before, self.files())

    def test_stale_input_or_source_pin_fails_before_intent(self):
        self.document.write_text("changed authority")
        with self.assertRaisesRegex(ValueError, "file_pin_changed"):
            prepare(self.ref)
        self.assertEqual(self.files(), {})
        self.input.write_text("{}")
        with self.assertRaisesRegex(ValueError, "file_pin_changed"):
            prepare(self.ref)
        self.assertEqual(self.files(), {})

    def test_business_task_source_is_strictly_validated_before_freeze(self):
        self.add_business_task(scope_notes="must not pass through")
        with self.assertRaisesRegex(ValueError, "strict_config_task_source_invalid"):
            prepare(self.ref)
        self.assertEqual(self.files(), {})

        code, result = self.cli("--execute")
        self.assertEqual(code, 2)
        self.assertEqual(result["error"], "strict_config_task_source_invalid")
        self.assertEqual(self.files(), {})

    def test_business_objective_snapshots_and_recovery_note_are_preserved(self):
        self.add_business_task()
        result = prepare(self.ref)
        manifest = parse(pinned(result["preparation"]))
        self.assertEqual(result["snapshot_count"], 3)
        self.assertEqual(manifest["business_task"]["objective"], "ship the approved feature")
        self.assertEqual(manifest["business_task"]["recovery_note"], "resume the startup handshake only")
        self.assertNotEqual(manifest["business_task"]["objective"], manifest["business_task"]["recovery_note"])
        self.assertEqual(pinned(manifest["business_task"]["task_source_snapshot"]),
                         pinned(self.source["task_source"]))
        self.assertEqual(pinned(manifest["business_task"]["authorization_snapshots"][0]),
                         self.document.read_bytes())
        self.assertFalse(manifest["authority_interpreted"])
        self.assertFalse(manifest["execution_authorized"])

    def test_malformed_and_duplicate_json_rejected_before_writes(self):
        self.source["sources"][0]["format"] = "json"
        for raw in (b'{"a":1,"a":2}', b'{"x":NaN}', b'{broken'):
            self.document.write_bytes(raw)
            self.source["sources"][0]["ref"] = file_ref(self.document)
            self.source["authority_refs"] = [file_ref(self.document)]
            self.save()
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                prepare(self.ref)
            self.assertEqual(self.files(), {})

    def test_invalid_schema_and_missing_authority_stop_before_git(self):
        valid = copy.deepcopy(self.source)
        for key, value in (("authority_refs", []), ("schema_version", True), ("run_id", "run_fake"),
                           ("baselines", []), ("preparation_id", "../escape"), ("sources", [])):
            self.source = {**valid, key: value}
            self.save()
            with patch("operator_prepare._default_runner") as query, self.assertRaises(ValueError):
                prepare(self.ref)
            query.assert_not_called()
            self.assertEqual(self.files(), {})

    def test_scope_checked_before_source_content_read(self):
        self.source["read_roots"] = [str(self.repo)]  # even the input is outside declared scope
        self.save()
        from coordinator_io import read_bytes
        reads = []

        def record(value):
            reads.append(str(value))
            return read_bytes(value)

        with patch("coordinator_io.read_bytes", side_effect=record), self.assertRaisesRegex(ValueError, "outside_scope"):
            prepare(self.ref)
        self.assertNotIn(str(self.document), reads)
        self.assertEqual(self.files(), {})

    def test_symlink_input_source_or_directory_is_not_normalized_silently(self):
        link = self.root / "link"
        link.symlink_to(self.document)
        self.source["sources"][0]["ref"] = {**self.authority, "path": str(link)}
        self.save()
        with self.assertRaisesRegex(ValueError, "canonical_nonsymlink"):
            prepare(self.ref)
        self.assertEqual(self.files(), {})

    def test_private_output_and_scope_not_repaired_with_chmod(self):
        self.directory.chmod(0o755)
        with self.assertRaisesRegex(ValueError, "private_directory_required"):
            prepare(self.ref)
        self.assertEqual(self.directory.stat().st_mode & 0o777, 0o755)
        self.assertEqual(self.files(), {})

    def test_output_must_not_dirty_a_baseline(self):
        output = self.repo / "prepare"
        output.mkdir(mode=0o700)
        self.source["directory"] = str(output)
        self.source["write_roots"] = [str(self.repo)]
        self.save()
        with self.assertRaisesRegex(ValueError, "overlaps_baseline"):
            prepare(self.ref)
        self.assertEqual(list(output.iterdir()), [])

    def test_exact_git_root_and_head_required(self):
        self.source["baselines"][0]["head"] = "a" * 40
        self.save()
        with self.assertRaisesRegex(ValueError, "baseline_head_changed"):
            prepare(self.ref)
        self.assertEqual(self.files(), {})
        subdir = self.repo / "subdir"
        subdir.mkdir()
        self.source["baselines"][0]["path"] = str(subdir)
        self.save()
        with self.assertRaisesRegex(ValueError, "git_root_mismatch"):
            prepare(self.ref)

    def test_git_failure_stops_before_other_queries_and_hides_stderr(self):
        denied = subprocess.CompletedProcess([], 128, b"", b"private credentials permission denied")
        with patch("operator_prepare._default_runner", return_value=denied) as query:
            code, result = self.cli("--execute")
        self.assertEqual(query.call_count, 1)
        self.assertEqual(code, 2)
        self.assertEqual(result["error"], "operator_prepare_git_query_failed")
        self.assertNotIn("private credentials", json.dumps(result))
        self.assertEqual(self.files(), {})

    def test_git_override_rejected_not_silently_switched(self):
        with patch.dict(os.environ, GIT_DIR=str(self.repo / ".git")):
            with self.assertRaisesRegex(ValueError, "git_context_override"):
                prepare(self.ref)
        self.assertEqual(self.files(), {})

    def test_source_drift_during_snapshot_preserves_partial_attempt(self):
        def race(target, value):
            publish_new(target, value)
            if target.name == "source-001.snapshot":
                self.document.write_text("new authority, not the reviewed bytes")

        with patch("operator_prepare.publish_new", side_effect=race), self.assertRaisesRegex(ValueError, "file_pin_changed"):
            prepare(self.ref)
        self.assertIn("prepare-intent.json", self.files())
        self.assertNotIn("prepared.json", self.files())

    def test_baseline_changes_during_copy_fail_even_if_both_observations_are_dirty(self):
        dirty = self.repo / "untracked"
        dirty.write_text("first")
        self.source["baselines"][0]["clean"] = False
        self.save()

        def race(target, value):
            publish_new(target, value)
            if target.name == "source-001.snapshot":
                dirty.write_text("second")

        with patch("operator_prepare.publish_new", side_effect=race), self.assertRaisesRegex(ValueError, "baseline_drift"):
            prepare(self.ref)
        self.assertNotIn("prepared.json", self.files())

    def test_snapshot_tamper_never_publishes_final_manifest(self):
        def race(target, value):
            publish_new(target, value)
            if target.name == "source-001.snapshot":
                (self.directory / "source-000.snapshot").write_text("tampered")

        with patch("operator_prepare.publish_new", side_effect=race), self.assertRaisesRegex(ValueError, "file_pin_changed"):
            prepare(self.ref)
        self.assertNotIn("prepared.json", self.files())

    def test_readonly_failure_no_fallback_or_followup_write_and_errno_preserved(self):
        calls = []

        def deny(target, value):
            calls.append(target.name)
            if target.name == "source-000.snapshot":
                raise OSError(errno.EROFS, "Read-only file system")
            publish_new(target, value)

        with patch("operator_prepare.publish_new", side_effect=deny):
            code, result = self.cli("--execute")
        self.assertEqual(code, 2)
        self.assertEqual(result["os_error"], "EROFS")
        self.assertEqual(result["decision"], "stop")
        self.assertEqual(calls, ["prepare-intent.json", "source-000.snapshot"])
        self.assertNotIn("prepared.json", self.files())

    def test_interruption_keeps_partial_evidence_and_blocks_reuse(self):
        def interrupt(target, value):
            if target.name == "source-001.snapshot":
                raise KeyboardInterrupt()
            publish_new(target, value)

        with patch("operator_prepare.publish_new", side_effect=interrupt), self.assertRaises(KeyboardInterrupt):
            prepare(self.ref)
        before = self.files()
        with self.assertRaisesRegex(ValueError, "directory_not_empty"):
            prepare(self.ref)
        self.assertEqual(before, self.files())
        self.assertNotIn("prepared.json", before)

    def test_concurrent_claim_only_one_publisher_no_overwrite(self):
        barrier = threading.Barrier(2)

        def race(target, value):
            if target.name == "prepare-intent.json":
                barrier.wait(timeout=10)
            publish_new(target, value)

        def run():
            try:
                return prepare(self.ref)
            except FileExistsError:
                return None

        with patch("operator_prepare.publish_new", side_effect=race), ThreadPoolExecutor(2) as pool:
            results = list(pool.map(lambda _: run(), range(2)))
        self.assertEqual(sum(result is not None for result in results), 1)
        manifest = parse(pinned(next(result for result in results if result)["preparation"]))
        self.assertEqual(len(manifest["snapshots"]), 2)
        self.assertEqual(len(self.files()), 4)


if __name__ == "__main__":
    unittest.main()

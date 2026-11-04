from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from coordinator_io import digest, parse, publish_new
from evidence_archive import archive, verify


class EvidenceArchiveTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.source = self.root / "source"
        self.source.mkdir()
        self.dest = self.root / "archive"
        self.raw = b'{"ok":true,"terminalPreview":"private"}\n'
        (self.source / "receipt.json").write_bytes(self.raw)
        self.items = [dict(path="receipt.json", target="receipts/receipt.json", format="json",
                           sha256=digest(self.raw))]

    def run_archive(self):
        return archive(self.source, self.dest, self.items, dict(decision="blocked", usage=None))

    def test_sanitized_private_snapshot_and_source_unchanged(self):
        result = self.run_archive()
        self.assertTrue(result["ok"])
        self.assertEqual(result["file_count"], 3)
        self.assertEqual(result["gap_count"], 0)
        self.assertNotIn(b"private", (self.dest / "receipts/receipt.json").read_bytes())
        self.assertEqual((self.source / "receipt.json").read_bytes(), self.raw)
        self.assertEqual(self.dest.stat().st_mode & 0o777, 0o700)
        self.assertEqual((self.dest / "manifest.json").stat().st_mode & 0o777, 0o600)
        with self.assertRaisesRegex(ValueError, "archive_destination_exists"):
            self.run_archive()

    def test_mismatch_and_missing_are_gaps_not_repaired_pins(self):
        self.items[0]["sha256"] = "0" * 64
        self.items.append(dict(path="missing.json", target="missing.json", format="json", sha256=None))
        self.assertEqual(self.run_archive()["gap_count"], 2)
        self.assertFalse((self.dest / "receipts/receipt.json").exists())

    def test_unpinned_observation_is_not_historical_proof(self):
        self.items[0]["sha256"] = None
        self.run_archive()
        manifest = parse((self.dest / "manifest.json").read_bytes())
        self.assertFalse(manifest["files"][0]["historical_pin_verified"])

    def test_explicit_json_omissions_keep_source_and_derived_hashes(self):
        self.items[0]["omit_json_paths"] = [["terminalPreview"]]
        self.run_archive()
        value = parse((self.dest / "receipts/receipt.json").read_bytes())
        self.assertEqual(value, dict(ok=True))
        row = parse((self.dest / "manifest.json").read_bytes())["files"][0]
        self.assertEqual(row["source_sha256"], digest(self.raw))
        self.assertEqual(row["omitted_json_paths"], [["terminalPreview"]])

    def test_changes_and_late_additions_invalidate_readback(self):
        self.run_archive()
        (self.dest / "extra.json").write_text("{}")
        with self.assertRaisesRegex(ValueError, "archive_inventory_changed"):
            verify(self.dest)
        (self.dest / "extra.json").unlink()
        (self.dest / "report.json").write_text("{}")
        with self.assertRaisesRegex(ValueError, "archive_readback_changed"):
            verify(self.dest)

    def test_symlink_escape_and_duplicate_targets_rejected_before_writes(self):
        (self.source / "link").symlink_to(self.source, target_is_directory=True)
        self.items[0]["path"] = "link/receipt.json"
        with self.assertRaisesRegex(ValueError, "archive_source_symlink"):
            self.run_archive()
        self.items[0]["path"] = "../receipt.json"
        with self.assertRaisesRegex(ValueError, "archive_relative_path_required"):
            self.run_archive()
        self.assertFalse(self.dest.exists())

    def test_source_change_leaves_unsealed_evidence(self):
        def changing(target, value):
            publish_new(target, value)
            (self.source / "receipt.json").write_text("{}")
        with patch("evidence_archive.publish_new", side_effect=changing):
            with self.assertRaisesRegex(ValueError, "archive_source_changed_before_seal"):
                self.run_archive()
        self.assertFalse((self.dest / "manifest.json").exists())

    def test_reserved_manifest_injection_is_detected(self):
        self.run_archive()
        (self.dest / "receipt-preview-manifest.json").write_text("{}")
        with self.assertRaisesRegex(ValueError, "archive_inventory_changed"):
            verify(self.dest)

    def test_target_collisions_and_duplicate_selection_rejected_before_write(self):
        self.items[0]["target"] = "manifest.json/child"
        with self.assertRaisesRegex(ValueError, "archive_target_collision"):
            self.run_archive()
        self.items[0]["target"] = "receipts/receipt.json"
        self.items.append(dict(self.items[0]))
        with self.assertRaisesRegex(ValueError, "archive_duplicate_or_reserved_path"):
            self.run_archive()
        self.assertFalse(self.dest.exists())

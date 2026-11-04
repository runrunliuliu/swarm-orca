"""Offline regressions for shared evidence readers' former byte ceilings."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

import coordinator_driver as driver
import evidence_policy
import native_preflight as preflight
import progress_watch as watch
from supervisor import receipts, trae_trust


class EvidenceCapacityTests(unittest.TestCase):
    def test_log_reader_source_is_pinned_in_probe_scope(self):
        contract = dict.fromkeys(("runtime_id", "runtime_version", "run_id", "workspace",
            "terminal", "session", "paths", "runtime_state", "adapter", "probe_roots"))
        contract.update(cli="/approved/cli", config_files=[], policy_files=[])
        helper = str(Path(evidence_policy.__file__).with_name("log_io.py").resolve())
        seen = []

        def read(path):
            seen.append(path)
            return str(path).encode()

        original = evidence_policy.probe_scope(contract, [], read)
        self.assertIn(helper, seen)
        changed = evidence_policy.probe_scope(contract, [],
            lambda path: read(path) + (b"changed" if path == helper else b""))
        self.assertNotEqual(original, changed)

    def test_large_evidence_is_read_in_full_by_all_consumers(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory).resolve() / "evidence.json"
            value = {"padding": "x" * (17 * 1024 * 1024)}
            raw = json.dumps(value).encode()
            path.write_bytes(raw)
            path.chmod(0o600)
            readers = (driver.read_bytes, preflight._read_bytes, receipts.read,
                       lambda p: trae_trust.snapshot(p)[0])
            for reader in readers:
                with self.subTest(reader=reader):
                    self.assertEqual(reader(path), raw)
            self.assertEqual(watch.file_json(path), value)
            self.assertEqual(driver.pinned({"path": str(path),
                "sha256": hashlib.sha256(raw).hexdigest()}), raw)
            with self.assertRaisesRegex(ValueError, "file_pin_changed"):
                driver.pinned({"path": str(path), "sha256": "0" * 64})

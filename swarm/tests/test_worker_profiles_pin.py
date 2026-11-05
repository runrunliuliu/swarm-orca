"""The request pin must describe the file the process actually reads.

A private Operator override and the bundled fixture are different review objects.
Pinning one while the process reads the other is a source mismatch, not evidence
that the active file changed, so the two refusals stay distinguishable offline.
"""

import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from coordinator_io import file_ref
from coordinator_worker_profiles import PROFILES, resolve
import offline_env


class WorkerProfilesPinTests(unittest.TestCase):
    def setUp(self):
        # Each case states the active policy explicitly; never inherit a private one.
        self.addCleanup(offline_env.cleared().stop)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.policy = self.root / "private profiles.json"
        self.config = {"schema_version": 1, "scope": "swarm_worker_only", "profiles": {
            "gpt-5.5": {"agent": "trae", "effort": "high",
                        "backend_variant": "max", "blocked_reason": None}}}

    def write(self, config=None):
        self.policy.write_text(json.dumps(self.config if config is None else config))
        return file_ref(self.policy)["sha256"]

    def test_request_pin_must_match_active_source(self):
        private = self.write()
        with patch.dict(os.environ, {"SWARM_WORKER_PROFILES": str(self.policy)}):
            # Pinning the bundled fixture while the process reads the override.
            with self.assertRaisesRegex(ValueError, "worker_profiles_pin_source_mismatch"):
                resolve("gpt-5.5", file_ref(PROFILES)["sha256"])
            # Same call with the pin of the active file stays green.
            _, profile = resolve("gpt-5.5", private)
            self.assertEqual(profile["config"], {"path": str(self.policy), "sha256": private})

    def test_genuinely_changed_active_file_is_not_relabelled(self):
        private = self.write()
        with patch.dict(os.environ, {"SWARM_WORKER_PROFILES": str(self.policy)}):
            self.policy.write_text(json.dumps(self.config) + "\n")
            with self.assertRaisesRegex(ValueError, "file_pin_changed"):
                resolve("gpt-5.5", private)

    def test_identical_bytes_are_not_a_source_mismatch(self):
        copied = self.root / "copy.json"
        copied.write_bytes(PROFILES.read_bytes())
        with patch.dict(os.environ, {"SWARM_WORKER_PROFILES": str(copied)}):
            _, profile = resolve("gpt-5.5", file_ref(copied)["sha256"])
        self.assertEqual(profile["config"]["path"], str(copied))

    def test_unreadable_override_never_falls_back_to_the_bundled_file(self):
        with patch.dict(os.environ, {"SWARM_WORKER_PROFILES": str(self.root / "gone.json")}):
            with self.assertRaisesRegex(ValueError, "worker_profiles_unreadable"):
                resolve("gpt-5.5", file_ref(PROFILES)["sha256"])

    def test_bundled_file_pin_still_rejects_a_real_change(self):
        with tempfile.TemporaryDirectory() as directory:
            changed = Path(directory).resolve() / "profiles.json"
            changed.write_bytes(PROFILES.read_bytes() + b"\n")
            changed_pin = file_ref(changed)["sha256"]
            with patch("coordinator_worker_profiles.PROFILES", changed):
                with self.assertRaisesRegex(ValueError, "file_pin_changed"):
                    resolve("gpt-5.5", file_ref(PROFILES)["sha256"])
                changed.unlink()
                with self.assertRaisesRegex(ValueError, "worker_profiles_unreadable"):
                    resolve("gpt-5.5", changed_pin)


if __name__ == "__main__":
    unittest.main()

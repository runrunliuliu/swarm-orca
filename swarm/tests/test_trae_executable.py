"""Version probing is read-only and never starts a provider/model session."""

from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from trae_coordinator import verify_trae_executable


class TraeExecutableTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name).resolve()
        self.binary = self.root / "binary"
        self.binary.write_bytes(b"test binary; never executed")
        self.entry = self.root / "traex"
        self.entry.symlink_to(self.binary)

    def check(self):
        return verify_trae_executable(str(self.entry), "0.212.1")

    def test_exact_version_and_resolved_binary_pin(self):
        with patch("trae_coordinator.subprocess.run", return_value=subprocess.CompletedProcess(
                [], 0, "traecli 0.212.1\ninstallation: internal\n", "")) as run:
            result = self.check()
        self.assertEqual(run.call_args.args[0], [str(self.binary), "--version"])
        self.assertEqual(run.call_args.kwargs["timeout"], 10)
        self.assertEqual(result["resolved_path"], str(self.binary))
        self.assertEqual(len(result["sha256"]), 64)
        self.assertEqual(result["cli_version"], "0.212.1")

    def test_unknown_malformed_or_wrong_version_refuses(self):
        for output in ("", "traecli 0.211.1\n", "traecli 0.213.1\n", "warning\ntraecli 0.212.1"):
            with self.subTest(output=output), patch("trae_coordinator.subprocess.run",
                    return_value=subprocess.CompletedProcess([], 0, output, "")), \
                    self.assertRaisesRegex(ValueError, "version_mismatch"):
                self.check()

    def test_auto_update_or_in_place_rewrite_during_probe_refuses(self):
        def update(*args, **kwargs):
            self.binary.write_bytes(b"changed binary")
            return subprocess.CompletedProcess([], 0, "traecli 0.212.1\n", "")
        with patch("trae_coordinator.subprocess.run", side_effect=update), \
                self.assertRaisesRegex(ValueError, "executable_changed"):
            self.check()
        other = self.root / "other"
        other.write_bytes(self.binary.read_bytes())
        def swap(*args, **kwargs):
            self.entry.unlink()
            self.entry.symlink_to(other)
            return subprocess.CompletedProcess([], 0, "traecli 0.212.1\n", "")
        with patch("trae_coordinator.subprocess.run", side_effect=swap), \
                self.assertRaisesRegex(ValueError, "executable_changed"):
            self.check()

    def test_failure_timeout_and_permission_denial_are_not_retried(self):
        for error in (PermissionError("denied"), subprocess.TimeoutExpired("traex", 10),
                      subprocess.CalledProcessError(1, "traex")):
            with self.subTest(error=type(error)), patch("trae_coordinator.subprocess.run",
                    side_effect=error) as run, self.assertRaises(type(error)):
                self.check()
            self.assertEqual(run.call_count, 1)

"""Review regressions: local fixtures only, no live Orca or fault injection."""

from contextlib import redirect_stdout
from dataclasses import make_dataclass
import io
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch

import blocking_io
import bootstrap_diagnostics as diagnostics
import bootstrap_tool as tool
import coordinator_tui_continue as tui
from coordinator_tui_errors import failure
from observation_budget import ObservationBusy


class ReviewTests(unittest.TestCase):
    def test_check_allows_slow_native_chain_but_keeps_original_deadline(self):
        for elapsed, expected in ((61, 0), (tui.CHECK_IO_SECONDS + 1, 2)):
            with self.subTest(elapsed=elapsed):
                clock = [0]
                def check(*args, **kwargs):
                    # The very first read is already within the outer budget.
                    operation = blocking_io._current.get()
                    self.assertIsNotNone(operation)
                    self.assertEqual(operation.deadline, tui.CHECK_IO_SECONDS)
                    clock[0] = elapsed
                    return {"ok": True}
                output = io.StringIO()
                with patch.object(tui, "check", side_effect=check), \
                        patch.object(blocking_io.time, "monotonic", side_effect=lambda: clock[0]), \
                        redirect_stdout(output):
                    self.assertEqual(tui.main(["check", "--config", "/fixture", "--config-sha256", "a" * 64,
                                               "--action-seconds", "60"]), expected)
                result = json.loads(output.getvalue())
                if expected:
                    self.assertFalse(result["diagnostics"]["execution_cancelled"])

    def test_close_diagnostic_staging_timeout_is_bounded_and_not_cancellation(self):
        binding = make_dataclass("Binding", ["control_id"])("fixture")
        server = Mock(diagnostic_operation=None)
        server.owner.control = binding
        server.owner.process = {"pid": 1}
        entered, release, exited = threading.Event(), threading.Event(), threading.Event()
        def stalled(*args, **kwargs):
            entered.set()
            try:
                release.wait(2)
                raise OSError("fixture")
            finally:
                exited.set()
        with patch.object(tempfile, "mkdtemp", side_effect=stalled):
            try:
                start = time.monotonic()
                result = diagnostics.close_rejected(server, seconds=.02)
                self.assertLess(time.monotonic() - start, .5)
                self.assertTrue(entered.is_set())
                self.assertEqual(result["staging_state"], "unknown")
                self.assertFalse(result["durable"])
                self.assertFalse(result["execution_cancelled"])
                self.assertTrue(result["archive_pending"])
            finally:
                release.set()
                self.assertTrue(exited.wait(2))

    def test_cli_cleanup_single_owner_for_success_and_startup_failures(self):
        for where in ("normal", "constructor", "serve", "announcement"):
            with self.subTest(where=where):
                owner, server = Mock(), Mock()
                owner.root = Path("/fixture")
                server.close.side_effect = owner.close
                if where == "serve":
                    server.serve.side_effect = ValueError("fixture")
                with patch.object(tool, "pinned", return_value=b"{}"), \
                        patch.object(tool, "parse", return_value={"control": {"control_id": "c", "generation": 1}}), \
                        patch.object(tool, "NativeIdentity"), patch.object(tool, "CommitOwner", return_value=owner), \
                        patch.object(tool, "OwnerServer", return_value=server,
                                     side_effect=ValueError("fixture") if where == "constructor" else None), \
                        patch.object(tool, "file_ref", return_value={},
                                     side_effect=ValueError("fixture") if where == "announcement" else None), \
                        redirect_stdout(io.StringIO()):
                    self.assertEqual(tool.cli_main(["serve", "--execute"]), 0 if where == "normal" else 2)
                owner.close.assert_called_once()
                self.assertEqual(server.close.call_count, 0 if where == "constructor" else 1)

    def test_busy_is_unavailable_not_identity_refresh(self):
        from bootstrap_identity import IdentityVerificationPending
        error = ObservationBusy()
        self.assertNotIsInstance(error, IdentityVerificationPending)
        result = failure(error, "fallback")
        self.assertEqual(result["observation"], "unavailable")
        self.assertFalse(result["execute_action"])
        self.assertNotIn("identity", result["recovery"])


if __name__ == "__main__":
    unittest.main()

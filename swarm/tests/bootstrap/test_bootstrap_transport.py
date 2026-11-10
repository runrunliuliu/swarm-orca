"""Signed reply binding and fail-closed diagnostics, no native agents."""

import copy
from pathlib import Path
import unittest
from unittest.mock import patch

from bootstrap_identity import host_process, process
from bootstrap_transport import Signer, safe_reason, verify
from coordinator_io import canonical, digest


class TransportTests(unittest.TestCase):
    def setUp(self):
        self.signer = Signer()
        self.owner = dict(path="/fixed/owner.json", sha256="a" * 64)
        self.request = dict(control={"generation": "one"}, op="check", args={}, nonce="b" * 64)
        self.payload = dict(owner=self.owner, request_sha256=digest(canonical(self.request)),
                            reply=dict(ok=True, result={"actor": "operator"}))

    def test_roundtrip(self):
        self.assertEqual(verify(self.signer.sign(self.payload), self.signer.public,
                                self.request, self.owner), self.payload["reply"])

    def test_replay_nonce_operation_generation_and_owner_pin_rejected(self):
        envelope = self.signer.sign(self.payload)
        for field, value in (("nonce", "c" * 64), ("op", "arm"), ("args", {"different": True}),
                             ("control", {"generation": "two"})):
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "reply_binding_mismatch"):
                verify(envelope, self.signer.public, dict(self.request, **{field: value}), self.owner)
        with self.assertRaisesRegex(ValueError, "reply_binding_mismatch"):
            verify(envelope, self.signer.public, self.request, dict(self.owner, sha256="d" * 64))

    def test_tampered_reply_wrong_key_and_unsigned_success_rejected(self):
        envelope = self.signer.sign(self.payload)
        changed = copy.deepcopy(envelope)
        changed["payload"]["reply"]["result"]["actor"] = "coordinator"
        for value, public in ((changed, self.signer.public), (envelope, Signer().public),
                              (self.payload["reply"], self.signer.public)):
            with self.subTest(value=value), self.assertRaises(ValueError):
                verify(value, public, self.request, self.owner)

    def test_safe_error_does_not_export_arbitrary_exception_text(self):
        for error in (ValueError("secret path or payload"), OSError("private data"),
                      ValueError("bootstrap_bad\nprivate"), ValueError("bootstrap_" + "x" * 101)):
            self.assertEqual(safe_reason(error), "bootstrap_operation_unverifiable")
        self.assertEqual(safe_reason(ValueError("bootstrap_rpc_rejected:bootstrap_peer_pid_unmapped")),
                         "bootstrap_rpc_rejected:bootstrap_peer_pid_unmapped")
        for code in ("startup_release_window_invalid", "startup_trigger_window_insufficient",
                     "startup_trigger_readiness_expired"):
            self.assertEqual(safe_reason(ValueError(code)), code)
            self.assertEqual(safe_reason(ValueError(code + ": private data")), "bootstrap_operation_unverifiable")

    def test_typed_strict_codes_are_not_collapsed(self):
        # A masked strict_* code sent a live attempt hunting the wrong stage.
        for code in ("strict_config_request_input_invalid", "strict_caller_envelope_invalid",
                     "strict_native_plan_changed", "tui_continuation_deadline"):
            self.assertEqual(safe_reason(ValueError(code)), code)
        for error in (ValueError("strict_config_request_input_invalid: /private/path"),
                      ValueError("strict_Bad")):
            self.assertEqual(safe_reason(error), "bootstrap_operation_unverifiable")

    def test_proc_not_visible_is_not_exit_or_wrong_ancestry(self):
        for error, reason in ((FileNotFoundError(), "process_not_visible"),
                              (PermissionError(), "proc_permission_denied")):
            with patch.object(Path, "read_text", side_effect=error), self.assertRaisesRegex(ValueError, reason):
                process(123)

    def test_host_must_have_coherent_proc_view(self):
        with patch.object(Path, "read_text", return_value="999999 (fake)"), \
                patch("bootstrap_identity.os.getpid", return_value=3), \
                self.assertRaisesRegex(ValueError, "host_proc_view_mismatch"):
            host_process()


if __name__ == "__main__":
    unittest.main()

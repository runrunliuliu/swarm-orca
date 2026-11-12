"""Identity refusals must say which field drifted, and only a recognisable prefix of it."""

import os
from pathlib import Path
import unittest
from unittest.mock import patch

from bootstrap_identity import NativeIdentity, NativeIdentityChanged, identity_pair
from coordinator_io import parse, pinned, publish_new, file_ref
import bootstrap.test_bootstrap_events as events_tests


class IdentityDiagnosticsTests(unittest.TestCase):
    def setUp(self):
        self.events = events_tests.BootstrapEventsTests()
        self.events.setUp()
        self.addCleanup(self.events.doCleanups)
        self.root = Path(self.events.root)
        self.binding = self.events.binding
        self.counter = 0

    def registration(self, **overrides):
        value = {"schema_version": 2, "attempt_binding": self.binding,
                 "profile": str(self.root), "log_root": str(self.root),
                 "roles": {"operator": {"provider": "pi", "session": "session-operator",
                                        "process": {"pid": 101, "start": "1", "boot": "boot",
                                                    "uid": os.getuid()}},
                           "coordinator": {"provider": "pi", "session": "session-coordinator",
                                           "process": {"pid": 102, "start": "2", "boot": "boot",
                                                       "uid": os.getuid()}}}}
        for role, changes in overrides.items():
            value["roles"][role].update(changes)
        self.counter += 1
        target = self.root / f"registration-identity-{self.counter}.json"
        publish_new(target, value)
        return file_ref(target)

    def identity(self, registration):
        with patch("bootstrap_identity.unchanged"), \
                patch("bootstrap_identity.descendant",
                      side_effect=ValueError("bootstrap_peer_wrong_process_tree")):
            return NativeIdentity(type("C", (), {"attempt_binding": self.binding})(), registration)

    def observed(self, *, role_session="session-coordinator", incarnation=None):
        incarnation = self.events.b["coordinator"]["incarnation"] if incarnation is None else incarnation
        terminal = {"incarnationId": incarnation, "ptyId": "pty", "tabId": "tab",
                    "leafId": "leaf", "worktreeId": "wt"}
        return {"identity": {"runtime": {}, "terminal": terminal, "session_id": role_session,
                             "transcript_path": "/tmp/log.jsonl", "host": "h", "uid": os.getuid(),
                             "profile": str(self.root), "log_root": str(self.root),
                             "launch_token_hash": "a" * 64},
                "hook": {"received_at_ms": 1, "evidence_observed_at_ms": 1}}

    def refresh(self, identity, observed):
        with patch("bootstrap_identity.unchanged"), \
                patch.object(identity, "check_local", lambda: None), \
                patch("swarm_ledger.runtime_binding.capture", return_value=observed):
            with self.assertRaises(NativeIdentityChanged) as caught:
                identity.refresh()
        return caught.exception

    def test_a_drifted_session_names_the_field_and_the_role(self):
        exc = self.refresh(self.identity(self.registration()),
                           self.observed(role_session="session-that-drifted"))
        self.assertEqual(str(exc), "bootstrap_native_identity_changed")
        self.assertEqual(exc.diagnostics["role"], "coordinator")
        self.assertFalse(exc.diagnostics["session"]["equal"])
        self.assertEqual(exc.diagnostics["session"]["observed"], "session-…")
        self.assertTrue(exc.diagnostics["incarnation"]["equal"])

    def test_a_drifted_incarnation_names_that_field_too(self):
        exc = self.refresh(self.identity(self.registration()),
                           self.observed(incarnation="incarnation-2"))
        self.assertFalse(exc.diagnostics["incarnation"]["equal"])
        self.assertTrue(exc.diagnostics["session"]["equal"])

    def test_pairs_carry_a_prefix_not_the_identifier(self):
        pair = identity_pair("0123456789abcdef", "0123456789abcdef")
        self.assertEqual(pair["expected"], "01234567…")
        self.assertTrue(pair["equal"])
        self.assertEqual(identity_pair(None, "x"), {"expected": "", "observed": "x", "equal": False})
        short = identity_pair("abc", "abc")
        self.assertEqual(short["expected"], "abc")


if __name__ == "__main__":
    unittest.main()

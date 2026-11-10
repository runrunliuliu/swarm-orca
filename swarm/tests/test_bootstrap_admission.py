"""Exact-target diagnostics for unconfirmed bootstrap evidence; no owner or Agent.

A bare `bootstrap_confirmation_unavailable` made a live attempt blame the S0 skill
pin while the real unconfirmed slot was the caller receipt. These tests keep the
reason code stable (callers compare it) and pin the added routing diagnostics.
"""

import unittest

import bootstrap_admission as admission
from bootstrap_protocol import Confirmation, ControlBinding
from bootstrap_transport import safe_reason


class StubAuthority:
    """Read-only stand-in: records the exact target and returns one status."""

    def __init__(self, status, target=None, state=None):
        self.status, self.target, self.asked, self.state = status, target, [], state

    def query(self, control, target):
        self.asked.append(target)
        return Confirmation(control, self.target or target, self.status, state=self.state)


class ConfirmationDiagnosticTests(unittest.TestCase):
    def setUp(self):
        self.control = ControlBinding(
            dict(path="/tmp/bootstrap/attempt-binding.json", sha256="a" * 64), "control", "generation")
        self.ref = dict(path="/tmp/bootstrap/initial-caller.json", sha256="b" * 64)

    def reject(self, authority):
        with self.assertRaises(ValueError) as caught:
            admission.confirmed(authority, self.control, self.ref)
        return caught.exception

    def test_existing_but_unconfirmed_target_is_named(self):
        authority = StubAuthority("durability_unverified")
        error = self.reject(authority)
        self.assertEqual(str(error), "bootstrap_confirmation_unavailable")
        self.assertEqual(safe_reason(error), "bootstrap_confirmation_unavailable")
        self.assertEqual(error.diagnostics, dict(target=self.ref["path"], sha256=self.ref["sha256"],
                                                status="durability_unverified", state=None,
                                                execution_authorized=False))
        self.assertEqual(authority.asked, [self.ref])

    def test_owner_outcome_state_routes_the_exact_unconfirmed_target(self):
        # A recorded intent that never published is a reconciliation case, not an
        # absent slot: the diagnostics must carry the owner's own class.
        for state in ("not_admitted", "needs_reconcile", "unknown"):
            with self.subTest(state=state):
                error = self.reject(StubAuthority("durability_unverified", state=state))
                self.assertEqual(error.diagnostics["state"], state)
                self.assertEqual(error.diagnostics["target"], self.ref["path"])

    def test_absent_target_reports_not_committed(self):
        error = self.reject(StubAuthority("not_committed"))
        self.assertEqual(error.diagnostics["status"], "not_committed")
        self.assertEqual(error.diagnostics["target"], self.ref["path"])

    def test_confirmation_for_another_target_is_not_accepted(self):
        other = dict(path="/tmp/bootstrap/events/0001-caller-ready.json", sha256="c" * 64)
        error = self.reject(StubAuthority("confirmed", target=other))
        self.assertEqual(error.diagnostics["status"], "confirmed")
        self.assertEqual(error.diagnostics["target"], self.ref["path"])

    def test_confirmed_target_returns_the_pinned_ref(self):
        class Confirmed(StubAuthority):
            def query(self, control, target):
                self.asked.append(target)
                # pinned() re-reads the file, so use a real one.
                return Confirmation(control, target, "confirmed")

        import os, tempfile
        from coordinator_io import digest
        with tempfile.TemporaryDirectory() as temp:
            target = os.path.join(temp, "evidence.json")
            raw = b'{"fixture":true}\n'
            with open(target, "wb") as handle:
                handle.write(raw)
            ref = dict(path=target, sha256=digest(raw))
            authority = Confirmed("confirmed")
            self.assertEqual(admission.confirmed(authority, self.control, ref), ref)


if __name__ == "__main__":
    unittest.main()

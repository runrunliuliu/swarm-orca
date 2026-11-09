"""Real local reader fixtures for both sides of the startup gate; no live writes."""

import copy
import json
import os
import unittest
from unittest.mock import patch

from coordinator_io import file_ref, now
from trae_coordinator import TUI_ADAPTER
import test_coordinator_startup as startup
import test_trae_tui as tui


class OperatorStartupTests(unittest.TestCase):
    def setUp(self):
        self.s = startup.StartupGateTests()
        self.s.setUp()
        self.addCleanup(self.s.doCleanups)
        self.t = tui.TuiTests()
        self.t.setUp()
        self.addCleanup(self.t.doCleanups)
        self.sid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
        self.t.term.update(handle="term_operator", incarnationId="inc_operator")
        self.t.entry["providerSession"]["id"] = self.sid
        self.t.f.meta["payload"]["id"] = self.sid
        self.t.f.write_log()
        self.t.write_state()
        self.s.operator = self.t.term
        self.s.use_v2()
        self.s.contract["operator"]["session"] = self.sid
        self.s.contract.update(adapter=TUI_ADAPTER, runtime_config=file_ref(self.t.f.runtime),
            observation=dict(profile=str(self.t.profile), caller_receipt=self.t.caller_ref,
                log_root=str(self.t.f.root), roots=[str(self.t.f.bootstrap)],
                startup_anchor=self.t.ref("anchor.json", {"fixture": "coordinator observer mocked"})))
        self.mail = {"count": 0, "messages": []}
        self.mail_reads = 0
        self.mail_hook = None
        for target, kwargs in (
                ("trae_tui.native", dict(side_effect=self.t.query)),
                ("trae_tui.observe", dict(side_effect=self.observe_coordinator)),
                ("coordinator_startup.native", dict(side_effect=self.query))):
            p = patch(target, **kwargs)
            p.start()
            self.addCleanup(p.stop)
        p = patch.dict(os.environ, ORCA_TERMINAL_HANDLE="term_operator")
        p.start()
        self.addCleanup(p.stop)

    def observe_coordinator(self, **kwargs):
        return {"thread_id": tui.legacy.SID, "observed_at": now()}

    def query(self, cli, runtime, args):
        if args[:2] == ["orchestration", "check"]:
            self.assertEqual(args, ["orchestration", "check", "--terminal", "term_operator", "--peek"])
            self.mail_reads += 1
            if self.mail_hook:
                self.mail_hook()
            return copy.deepcopy(self.mail)
        if args == ["orchestration", "strict-caller-check"]:
            return copy.deepcopy(self.t.caller)
        if args == ["orchestration", "run-current", "--from", "term_test"]:
            return {"run": copy.deepcopy(self.s.run)}
        return self.s.query(cli, runtime, args)

    def test_session_and_first_dispatch_recheck_real_operator_root(self):
        self.s.prepare_dispatch()
        receipt = self.s.gate(phase="first-dispatch", previous=self.s.prior)
        self.assertEqual(self.mail_reads, 4)
        self.assertTrue(receipt["operator_mailbox_checked"])
        self.assertEqual(receipt["operator_session_trust"], "runtime-state-not-process-attested")
        self.assertEqual(len(receipt["operator_session_evidence_sha256"]), 64)
        self.assertFalse(receipt["execution_authorized"])
        self.assertNotIn("must-never-appear", json.dumps(receipt))
        self.assertFalse(any(args[:2] == ["terminal", "read"] for args in self.t.calls))

    def test_valid_uuid_turn_id_is_not_provider_session(self):
        self.s.contract["operator"]["session"] = "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee"
        with self.assertRaisesRegex(ValueError, "operator_provider_session_mismatch"):
            self.s.gate()

    def test_hook_agreement_without_root_metadata_agreement_is_rejected(self):
        self.t.f.meta["payload"]["id"] = tui.legacy.SID
        self.t.f.write_log()
        with self.assertRaisesRegex(ValueError, "operator_session_runtime_state_unverifiable"):
            self.s.gate()

    def test_pi_operator_is_rejected_before_native_identity_queries(self):
        self.s.contract["operator"]["provider"] = "pi"
        self.t.term["agentIdentity"] = "pi"
        self.t.entry.update(source="pi", payload={"agentType": "pi"})
        self.t.write_state()
        # A Pi pane has no agent-hooks row on this runtime, so the session gate must
        # stop on the provider before it queries or reports a stale-hook style state.
        with self.assertRaisesRegex(ValueError, "operator_session_pi_operator_unverifiable"):
            self.s.gate()
        self.assertEqual(self.t.calls, [])

    def test_unsupported_provider_does_not_guess_another_log_root(self):
        self.s.contract["operator"]["provider"] = "codex"
        with self.assertRaisesRegex(ValueError, "operator_session_provider_unsupported"):
            self.s.gate()
        self.assertEqual(self.t.calls, [])

    def test_native_provider_incarnation_replay_runtime_and_permissions_fail_closed(self):
        for change in ("provider", "incarnation", "replay", "runtime", "permissions"):
            with self.subTest(change=change):
                term, entry, discovery = map(copy.deepcopy, (self.t.term, self.t.entry, self.t.discovery))
                if change == "provider":
                    self.t.term["agentIdentity"] = "codex"
                elif change == "incarnation":
                    self.t.term["incarnationId"] = "changed"
                elif change == "replay":
                    self.t.entry["isReplay"] = True
                elif change == "runtime":
                    self.t.discovery["runtimeId"] = "other"
                self.t.write_state()
                if change == "permissions":
                    (self.t.profile / "agent-hooks" / "last-status.json").chmod(0o644)
                with self.assertRaises(ValueError):
                    self.s.gate()
                self.t.term.clear()
                self.t.term.update(term)
                self.t.entry, self.t.discovery = entry, discovery
                self.t.write_state()

    def test_stale_hook_is_not_refreshed_by_observation(self):
        self.t.entry["evidenceObservedAt"] -= 9999999
        self.t.write_state()
        with self.assertRaisesRegex(ValueError, "operator_session_hook_stale_or_future"):
            self.s.gate()

    def test_log_history_change_between_gate_snapshots_stops(self):
        def change(**kwargs):
            self.t.f.log.write_text(self.t.f.log.read_text().replace("GPT-5.5", "gpt-5.5"))
            return self.observe_coordinator(**kwargs)
        with patch("trae_tui.observe", side_effect=change), \
                self.assertRaisesRegex(ValueError, "operator_session_runtime_state_unverifiable"):
            self.s.gate()

    def test_provider_session_change_between_gate_snapshots_stops(self):
        def change(**kwargs):
            self.t.entry["providerSession"]["id"] = tui.legacy.SID
            self.t.f.meta["payload"]["id"] = tui.legacy.SID
            self.t.f.write_log()
            self.t.write_state()
            return self.observe_coordinator(**kwargs)
        with patch("trae_tui.observe", side_effect=change), \
                self.assertRaisesRegex(ValueError, "operator_session_runtime_state_unverifiable"):
            self.s.gate()

    def test_coordinator_rechecks_operator_identity_but_never_its_mailbox(self):
        self.s.prepare_dispatch()
        previous = self.s.ref("operator-dispatch.json", self.s.gate(
            phase="first-dispatch", previous=self.s.prior))
        reads = self.mail_reads
        self.mail = {"count": 1, "messages": [{"id": "msg_operator_only"}]}
        with patch.dict(os.environ, ORCA_TERMINAL_HANDLE="term_test"):
            receipt = self.s.gate(phase="first-dispatch", actor="coordinator", previous=previous)
        self.assertEqual(self.mail_reads, reads)
        self.assertFalse(receipt["operator_mailbox_checked"])
        self.assertEqual(receipt["operator_session_trust"], "runtime-state-not-process-attested")

    def test_pending_at_entry_stops_before_observer_and_never_consumes(self):
        self.mail = {"count": 1, "messages": [{"id": "msg_stop"}]}
        with self.assertRaisesRegex(ValueError, "operator_pending_messages_require_review"):
            self.s.gate()
        self.assertEqual(self.t.calls, [])
        self.assertEqual(self.mail_reads, 1)

    def test_new_pending_during_gate_stops_at_final_peek(self):
        def arrive():
            if self.mail_reads == 2:
                self.mail = {"count": 1, "messages": [{"id": "msg_stop"}]}
        self.mail_hook = arrive
        with self.assertRaisesRegex(ValueError, "operator_pending_messages_require_review"):
            self.s.gate()
        self.assertEqual(self.mail_reads, 2)

    def test_missing_actor_malformed_mail_or_run_mail_cannot_pass_as_empty(self):
        with patch.dict(os.environ, {}, clear=True), \
                self.assertRaisesRegex(ValueError, "operator_mailbox_native_context_required"):
            self.s.gate()
        for value in ({}, {"count": False, "messages": []}, {"count": 0, "messages": [{}]},
                      {"count": 0, "messages": [], "runId": "run_other"}):
            self.mail = value
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "operator_mailbox_state_unavailable"):
                self.s.gate()

    def test_native_denial_is_not_retried(self):
        with patch("coordinator_startup.native", side_effect=PermissionError("private denial")) as call, \
                self.assertRaises(PermissionError):
            self.s.gate()
        self.assertEqual(call.call_count, 1)


if __name__ == "__main__":
    unittest.main()

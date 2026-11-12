"""Registration collection: pin what the identity gate reads, never what a filename suggests."""

import io
import json
import os
from contextlib import redirect_stdout
from unittest import mock
from pathlib import Path
import tempfile
import unittest

import bootstrap_registration
from coordinator_io import digest
import bootstrap.test_bootstrap_events as events_tests


class RegistrationCollectionTests(unittest.TestCase):
    def setUp(self):
        self.events = events_tests.BootstrapEventsTests()
        self.events.setUp()
        self.addCleanup(self.events.doCleanups)
        self.root = Path(self.events.root)
        self.binding = self.events.binding
        self.temp = tempfile.TemporaryDirectory(prefix="bootstrap-registration-", dir="/tmp")
        self.addCleanup(self.temp.cleanup)
        self.work = Path(self.temp.name).resolve()
        self.log_root = self.work / "sessions"
        self.log_root.mkdir()
        self.profile = self.work / "profile"
        (self.profile / "agent-hooks").mkdir(parents=True)
        self.token = b"launch-token-for-this-pane"
        self.at_ms = int(bootstrap_registration.timestamp("2026-11-12T16:00:00+00:00").timestamp() * 1000)
        self.panes = {
            "coordinator": {"handle": "term_coordinator", "pane": "tab-a:leaf-a",
                            "session": "session-coordinator", "pid": 4101},
            "operator": {"handle": "term_operator", "pane": "tab-b:leaf-b",
                         "session": "session-operator", "pid": 4102},
        }
        for role, pane in self.panes.items():
            self.transcript(role, pane["session"])
        self.write_hooks()

    def transcript(self, role, session):
        target = self.log_root / f"{role}.jsonl"
        target.write_text(json.dumps({"type": "session", "id": session, "cwd": str(self.root)}) + "\n")
        return target

    def hook_row(self, role, **changes):
        pane = self.panes[role]
        entry = {"source": "pi", "worktreeId": "wt", "tabId": pane["pane"].split(":")[0],
                 "payload": {"agentType": "pi"}, "launchTokenHash": digest(self.token),
                 "evidenceObservedAt": self.at_ms,
                 "receivedAt": self.at_ms + 500,
                 "providerSession": {"key": "session_id", "id": pane["session"],
                                     "transcriptPath": str(self.log_root / f"{role}.jsonl")}}
        entry.update(changes)
        return entry

    def write_hooks(self, **per_role):
        entries = {self.panes[role]["pane"]: self.hook_row(role, **per_role.get(role, {}))
                   for role in self.panes}
        (self.profile / "agent-hooks" / "last-status.json").write_text(
            json.dumps({"version": 2, "entries": entries}))

    def collect(self, **updates):
        options = dict(
            bootstrap=str(self.root), expect_attempt="attempt-test",
            binding_sha256=self.binding["sha256"],
            roles={role: {"terminal": pane["handle"], "provider": "pi"}
                   for role, pane in self.panes.items()},
            profile=str(self.profile), log_root=str(self.log_root),
            clock=bootstrap_registration.timestamp("2026-11-12T16:00:00+00:00"),
            proc=lambda pid: {"pid": pid, "start": "12345", "boot": "boot-id", "uid": os.getuid()},
            pids_for_handle=lambda handle: [pane["pid"] for pane in self.panes.values()
                                            if pane["handle"] == handle],
            parent_of=lambda pid: 0,
            environ=lambda pid: {
                b"ORCA_TERMINAL_HANDLE": next(p["handle"] for p in self.panes.values()
                                              if p["pid"] == pid).encode(),
                b"ORCA_PANE_KEY": next(p["pane"] for p in self.panes.values()
                                       if p["pid"] == pid).encode(),
                b"ORCA_AGENT_LAUNCH_TOKEN": self.token})
        options.update(updates)
        return bootstrap_registration.build(**options)

    def refusal(self, **changes):
        with self.assertRaises(bootstrap_registration.CollectionRefused) as caught:
            if "hooks" in changes:
                changes.pop("hooks")
                self.write_hooks(**changes)
                self.collect()
            else:
                self.collect(**changes)
        return caught.exception

    def test_it_pins_the_session_the_hook_names_not_the_filename(self):
        registration, receipt = self.collect()
        self.assertEqual(registration["schema_version"], 2)
        self.assertEqual(set(registration), {"schema_version", "attempt_binding", "profile",
                                             "log_root", "roles"})
        for role, pane in self.panes.items():
            self.assertEqual(set(registration["roles"][role]), {"provider", "process", "session"})
            self.assertEqual(registration["roles"][role]["session"], pane["session"])
            self.assertEqual(registration["roles"][role]["provider"], "pi")
            self.assertEqual(registration["roles"][role]["process"]["pid"], pane["pid"])
            self.assertEqual(receipt["roles"][role]["pane"], pane["pane"])
        self.assertEqual(registration["attempt_binding"],
                         {"path": str(self.root / "attempt-binding.json"),
                          "sha256": self.binding["sha256"]})
        self.assertFalse(receipt["execution_authorized"])

    def test_a_pane_that_is_not_exactly_one_agent_is_refused(self):
        exc = self.refusal(pids_for_handle=lambda handle: [])
        self.assertEqual(str(exc), "bootstrap_registration_pane_not_unique")
        self.assertEqual(exc.diagnostics["pids"], 0)
        exc = self.refusal(pids_for_handle=lambda handle: [1, 2], parent_of=lambda pid: 0)
        self.assertEqual(exc.diagnostics["pids"], 2)
        self.assertEqual(exc.diagnostics["processes"], 2)

    def test_the_shell_that_inherits_the_handle_is_not_the_agent(self):
        # A pane's handle is inherited by its shell; the agent is the leaf, so the collection
        # must pick the pi child (4101) rather than refuse the shared handle.
        parents = {4101: 4100, 4100: 1, 4102: 4100}
        registration, _ = self.collect(
            pids_for_handle=lambda handle: ([4100, 4101] if handle == "term_coordinator"
                                            else [4102]),
            parent_of=lambda pid: parents[pid],
            environ=lambda pid: {
                b"ORCA_TERMINAL_HANDLE": next(p["handle"] for p in self.panes.values()
                                              if p["pid"] == pid or pid == 4100).encode(),
                b"ORCA_PANE_KEY": next(p["pane"] for p in self.panes.values()
                                       if p["pid"] == pid or pid == 4100).encode(),
                b"ORCA_AGENT_LAUNCH_TOKEN": self.token})
        self.assertEqual(registration["roles"]["coordinator"]["process"]["pid"], 4101)
        self.assertEqual(registration["roles"]["operator"]["process"]["pid"], 4102)

    def test_a_missing_hook_row_names_the_pane_prefix(self):
        self.write_hooks()
        hooks = json.loads((self.profile / "agent-hooks" / "last-status.json").read_text())
        del hooks["entries"][self.panes["operator"]["pane"]]
        (self.profile / "agent-hooks" / "last-status.json").write_text(json.dumps(hooks))
        exc = self.refusal()
        self.assertEqual(str(exc), "bootstrap_registration_hook_entry_absent")

    def test_the_launch_token_must_match_the_row(self):
        self.write_hooks(coordinator={"launchTokenHash": "b" * 64})
        exc = self.refusal()
        self.assertEqual(str(exc), "bootstrap_registration_launch_token_mismatch")

    def test_the_declared_provider_must_match_the_row(self):
        self.write_hooks(operator={"source": "trae"})
        exc = self.refusal()
        self.assertEqual(str(exc), "bootstrap_registration_hook_identity_mismatch")
        self.assertEqual(exc.diagnostics["field"], "source")
        self.assertEqual(exc.diagnostics["expected"], "pi")

    def test_a_resumed_or_tool_agent_row_is_not_an_attribution(self):
        for flag in ("providerSessionOnly", "toolAgentId", "restoredUnconfirmed", "isReplay",
                     "structuredHost"):
            with self.subTest(flag=flag):
                self.write_hooks(operator={flag: True})
                exc = self.refusal()
                self.assertEqual(str(exc), "bootstrap_registration_hook_unverifiable")
                self.assertEqual(exc.diagnostics["flag"], flag)
            self.write_hooks()

    def test_a_stale_row_is_refused_instead_of_pinned(self):
        self.write_hooks(coordinator={"evidenceObservedAt": self.at_ms - 3_600_000})
        exc = self.refusal()
        self.assertEqual(str(exc), "bootstrap_registration_hook_stale")

    def test_the_transcript_root_must_pin_the_same_session(self):
        self.transcript("operator", "some-other-session")
        exc = self.refusal()
        self.assertEqual(str(exc), "bootstrap_registration_root_session_mismatch")
        self.assertFalse(exc.diagnostics["hook"] == exc.diagnostics["root"])

    def test_the_transcript_must_live_under_the_declared_log_root(self):
        outside = self.work / "outside.jsonl"
        outside.write_text(json.dumps({"type": "session", "id": self.panes["operator"]["session"]}) + "\n")
        self.write_hooks(operator={"providerSession": {
            "key": "session_id", "id": self.panes["operator"]["session"],
            "transcriptPath": str(outside)}})
        exc = self.refusal()
        self.assertEqual(str(exc), "bootstrap_registration_log_outside_root")

    def test_the_cli_reports_three_when_an_identical_file_is_already_there(self):
        # The help and operator-prepare promise 3 for "nothing written, already identical"; an
        # always-0 answer would read as a fresh pin.
        registration, receipt = self.collect()
        output = self.work / "cli-registration.json"
        argv = ["--bootstrap", str(self.root), "--expect-attempt", "attempt-test",
                "--attempt-binding-sha256", self.binding["sha256"],
                "--profile", str(self.profile), "--log-root", str(self.log_root),
                "--coordinator", "term_coordinator", "--coordinator-provider", "pi",
                "--operator", "term_operator", "--operator-provider", "pi",
                "--output", str(output), "--json"]
        with mock.patch.object(bootstrap_registration, "build",
                               return_value=(registration, receipt)):
            with redirect_stdout(io.StringIO()) as first_out:
                first = bootstrap_registration.cli_main(argv)
            with redirect_stdout(io.StringIO()) as again_out:
                again = bootstrap_registration.cli_main(argv)
        self.assertEqual((first, again), (0, 3))
        self.assertTrue(json.loads(first_out.getvalue())["created"])
        self.assertFalse(json.loads(again_out.getvalue())["created"])
        self.assertEqual(json.loads(again_out.getvalue())["exit"], 3)

    def test_writing_is_create_once_and_reads_back(self):
        registration, _ = self.collect()
        output = self.work / "registration.json"
        first = bootstrap_registration.write(output, registration)
        self.assertTrue(first["created"])
        self.assertEqual(first["sha256"], digest(output.read_bytes()))
        again = bootstrap_registration.write(output, registration)
        self.assertFalse(again["created"])
        self.assertEqual(again["sha256"], first["sha256"])
        with self.assertRaises(bootstrap_registration.CollectionRefused) as caught:
            bootstrap_registration.write(output, dict(registration, log_root="/elsewhere"))
        self.assertEqual(str(caught.exception), "bootstrap_registration_output_conflict")


if __name__ == "__main__":
    unittest.main()

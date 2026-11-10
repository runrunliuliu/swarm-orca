import io
import json
from contextlib import redirect_stdout
import os
import tempfile
import unittest

import pi_hook_preflight as preflight

HASH = "9cc40b089c7e1aa7a0388c85f42bd4e01ec67770d7391ec4f2963d8384f59add"


def usable_row(**overrides):
    row = {"paneKey": "tab:leaf", "source": "pi", "tabId": "tab", "worktreeId": "wt",
           "hookEventName": "agent_start", "providerSession": {
               "key": "session_id", "id": "session", "transcriptPath": "/logs/session.jsonl"},
           "payload": {"state": "working", "prompt": "", "agentType": "pi"},
           "launchTokenHash": HASH, "receivedAt": 1, "evidenceObservedAt": 1}
    row.update(overrides)
    return row


class NoProxyParsing(unittest.TestCase):
    def test_exact_suffix_wildcard_and_port_forms_are_understood(self):
        entries = preflight.parse_no_proxy("127.0.0.1, .example.com,*.internal:8080")
        self.assertTrue(preflight.no_proxy_matches(entries, "127.0.0.1"))
        self.assertTrue(preflight.no_proxy_matches(entries, "api.example.com"))
        self.assertTrue(preflight.no_proxy_matches(entries, "host.internal", 8080))
        self.assertFalse(preflight.no_proxy_matches(entries, "host.internal", 9090))
        self.assertFalse(preflight.no_proxy_matches(entries, "other.example.org"))
        self.assertTrue(preflight.no_proxy_matches(preflight.parse_no_proxy("*"), "anything.invalid"))

    def test_a_cidr_entry_cannot_bypass_loopback(self):
        # The shape that actually broke delivery: loopback declared only as a range.
        entries = preflight.parse_no_proxy("localhost,127.0.0.0/8,::1")
        self.assertFalse(preflight.no_proxy_matches(entries, "127.0.0.1"))
        self.assertEqual([entry["raw"] for entry in entries if entry["cidr"]], ["127.0.0.0/8"])

    def test_ipv6_with_port_is_split_without_losing_the_host(self):
        entries = preflight.parse_no_proxy("[::1]:8080")
        self.assertEqual((entries[0]["hostname"], entries[0]["port"]), ("::1", 8080))


class Transport(unittest.TestCase):
    PROXIED = {"http_proxy": "http://proxy:8118", "https_proxy": "http://proxy:8118",
               "NO_PROXY": "localhost,.corp.example,127.0.0.0/8"}

    def test_cidr_only_loopback_is_reported_as_hijacked_delivery(self):
        channel = preflight.transport(self.PROXIED)
        self.assertEqual(channel["proxy_variable"], "http_proxy")
        self.assertEqual(channel["no_proxy_source"], "NO_PROXY")
        self.assertFalse(channel["loopback_bypasses_proxy"])
        self.assertFalse(channel["global_fetch_delivers"])
        self.assertEqual(channel["reason"], preflight.TRANSPORT_HIJACKED)
        self.assertEqual(channel["cidr_entries_ignored"], ["127.0.0.0/8"])

    def test_a_literal_loopback_entry_keeps_the_post_direct(self):
        channel = preflight.transport(dict(self.PROXIED, NO_PROXY="localhost,127.0.0.1"))
        self.assertTrue(channel["loopback_bypasses_proxy"])
        self.assertTrue(channel["global_fetch_delivers"])
        self.assertEqual(channel["reason"], preflight.TRANSPORT_DIRECT)

    def test_no_proxy_configured_at_all_is_direct(self):
        self.assertEqual(preflight.transport({})["reason"], preflight.TRANSPORT_DIRECT)
        self.assertTrue(preflight.transport({"https_proxy": "http://p:1", "no_proxy": "*"})
                        ["global_fetch_delivers"])

    def test_lowercase_no_proxy_wins_even_when_it_is_weaker(self):
        # The runtime prefers `no_proxy`; a weaker lowercase list must not be
        # silently overridden by a stronger uppercase one in the report.
        channel = preflight.transport({"http_proxy": "http://p:1", "no_proxy": "",
                                       "NO_PROXY": "127.0.0.1"})
        self.assertEqual(channel["no_proxy_source"], "no_proxy")
        self.assertFalse(channel["global_fetch_delivers"])


class RowVerdict(unittest.TestCase):
    def test_absent_row_names_the_missing_channel(self):
        verdict = preflight.row_verdict(None)
        self.assertFalse(verdict["present"])
        self.assertEqual(verdict["reasons"], [preflight.ROW_MISSING])
        self.assertEqual(verdict["missing_evidence"], [preflight.MISSING_PANE_ROW])

    def test_a_delivered_turn_row_is_usable(self):
        verdict = preflight.row_verdict(usable_row(), worktree_id="wt", tab_id="tab")
        self.assertTrue(verdict["usable"])
        self.assertEqual(verdict["reasons"], [preflight.ROW_USABLE])
        self.assertEqual(verdict["missing_evidence"], [])

    def test_a_session_start_only_row_is_a_resume_identity_not_attribution(self):
        verdict = preflight.row_verdict(usable_row(providerSessionOnly=True,
                                                   hookEventName="session_start"))
        self.assertFalse(verdict["usable"])
        self.assertIn(preflight.ROW_PROVIDER_SESSION_ONLY, verdict["reasons"])

    def test_replay_foreign_source_and_mismatch_are_distinguished(self):
        self.assertIn(preflight.ROW_REPLAY_OR_RESTORED,
                      preflight.row_verdict(usable_row(isReplay=True))["reasons"])
        self.assertIn(preflight.ROW_FOREIGN_SOURCE,
                      preflight.row_verdict(usable_row(source="trae"))["reasons"])
        self.assertIn(preflight.ROW_PANE_MISMATCH,
                      preflight.row_verdict(usable_row(), worktree_id="other")["reasons"])

    def test_missing_session_or_commitment_names_the_channel(self):
        no_session = preflight.row_verdict(usable_row(providerSession={"key": "session_id", "id": "s"}))
        self.assertEqual(no_session["missing_evidence"],
                         [preflight.MISSING_SESSION, preflight.MISSING_TRANSCRIPT])
        no_hash = preflight.row_verdict(usable_row(launchTokenHash=None))
        self.assertEqual(no_hash["missing_evidence"], [preflight.MISSING_COMMITMENT])

    def test_usage_accounting_may_read_the_row_without_a_commitment(self):
        verdict = preflight.row_verdict(usable_row(launchTokenHash=None),
                                        require_launch_commitment=False)
        self.assertTrue(verdict["usable"])


class Record(unittest.TestCase):
    def test_a_passing_preflight_still_authorizes_nothing(self):
        record = preflight.preflight(environ={}, row=usable_row(), worktree_id="wt", tab_id="tab")
        self.assertTrue(record["channel_plausible"])
        self.assertIs(record["diagnostic_only"], True)
        self.assertIs(record["execution_authorized"], False)

    def test_transport_reason_is_reported_first_and_blocks_plausibility(self):
        record = preflight.preflight(environ=Transport.PROXIED, row=usable_row(),
                                     worktree_id="wt", tab_id="tab")
        self.assertEqual(record["reasons"][0], preflight.TRANSPORT_HIJACKED)
        self.assertFalse(record["channel_plausible"])

    def test_missing_row_with_direct_transport_reports_the_row_channel(self):
        record = preflight.preflight(environ={}, row=None)
        self.assertEqual(record["missing_evidence"], [preflight.MISSING_PANE_ROW])
        self.assertFalse(record["channel_plausible"])


class Ingress(unittest.TestCase):
    def test_proc_environ_is_nul_separated_and_first_definition_wins(self):
        with tempfile.TemporaryDirectory() as root:
            path = os.path.join(root, "environ")
            with open(path, "wb") as sink:
                sink.write(b"A=1\0http_proxy=http://p:1\0A=2\0NO_PROXY=127.0.0.0/8\0")
            environ = preflight.read_pane_environ(path)
        self.assertEqual(environ["A"], "1")
        self.assertEqual(environ["NO_PROXY"], "127.0.0.0/8")
        self.assertEqual(preflight.transport(environ)["reason"], preflight.TRANSPORT_HIJACKED)

    def test_cli_reads_the_store_and_prints_one_record(self):
        with tempfile.TemporaryDirectory() as root:
            environ_path = os.path.join(root, "environ")
            store_path = os.path.join(root, "last-status.json")
            with open(environ_path, "wb") as sink:
                sink.write(b"http_proxy=http://p:1\0NO_PROXY=127.0.0.0/8\0")
            with open(store_path, "w", encoding="utf-8") as sink:
                json.dump({"version": 2, "entries": {"tab:leaf": usable_row()}}, sink)
            out = io.StringIO()
            with redirect_stdout(out):
                code = preflight.main(["--pane-env", environ_path, "--hook-store", store_path,
                                       "--pane-key", "tab:leaf", "--worktree-id", "wt",
                                       "--tab-id", "tab", "--json"])
        record = json.loads(out.getvalue())
        self.assertEqual(code, 0)
        self.assertFalse(record["channel_plausible"])
        self.assertEqual(record["row"]["reasons"], [preflight.ROW_USABLE])
        self.assertIn(preflight.TRANSPORT_HIJACKED, record["reasons"])


if __name__ == "__main__":
    unittest.main()

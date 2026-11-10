"""Provider capability seam: a declared provider, its evidence, and its refusals.

Pure table tests: no Agent, native CLI, provider process or ledger is involved.
The integration behaviour of both consumers is covered next to them
(`test_operator_session.py`, `test_bootstrap_provider.py`).
"""

from pathlib import Path
import socket
import tempfile
import unittest

import provider_capability as capabilities
from swarm_ledger import runtime_binding


CONSUMERS = {"bootstrap role": capabilities.BOOTSTRAP_ROLE,
             "operator identity": capabilities.OPERATOR_IDENTITY,
             "tui observation": capabilities.TUI_OBSERVATION}


class RefusalTests(unittest.TestCase):
    def refuse(self, provider, evidence, observed=None):
        with self.assertRaises(capabilities.ProviderRefused) as caught:
            capabilities.require(provider, evidence,
                                 required="test_provider_required",
                                 unsupported="test_provider_unsupported",
                                 unavailable="test_{provider}_evidence_unavailable",
                                 observed=observed)
        return caught.exception

    def test_trae_satisfies_every_consumer_with_the_runtime_state_format(self):
        for name, evidence in CONSUMERS.items():
            with self.subTest(consumer=name):
                capability = capabilities.require(
                    "trae", evidence, required="test_provider_required",
                    unsupported="test_provider_unsupported",
                    unavailable="test_{provider}_evidence_unavailable")
                self.assertEqual(capability.provider, "trae")
                self.assertEqual(capability.evidence_format, "runtime-state")
                self.assertEqual(capability.tui_adapter, "trae-tui-runtime-v1")

    def test_unknown_provider_is_unsupported_instead_of_defaulted_to_trae(self):
        # Exact names only: no case folding, no whitespace trimming, no alias.
        for provider in ("codex", "Trae", "trae ", " pi", "unknown"):
            for name, evidence in CONSUMERS.items():
                with self.subTest(provider=provider, consumer=name):
                    refused = self.refuse(provider, evidence)
                    self.assertEqual(refused.code, "test_provider_unsupported")
                    self.assertEqual(refused.missing_evidence, ())

    def test_missing_or_blank_declaration_is_required_never_assumed(self):
        for provider in ("", "   ", None, 7, b"trae"):
            for name, evidence in CONSUMERS.items():
                with self.subTest(provider=provider, consumer=name):
                    self.assertEqual(self.refuse(provider, evidence).code,
                                     "test_provider_required")

    def test_known_provider_without_the_evidence_names_every_missing_channel(self):
        expected = {"bootstrap role": (capabilities.PANE_HOOK_STATUS, capabilities.SESSION_META,
                                       capabilities.TURN_CONTEXT, capabilities.TERMINAL,
                                       capabilities.LAUNCH_COMMITMENT),
                    "operator identity": (capabilities.PANE_HOOK_STATUS, capabilities.SESSION_META,
                                          capabilities.TURN_CONTEXT, capabilities.TERMINAL),
                    "tui observation": (capabilities.PANE_HOOK_STATUS, capabilities.SESSION_META,
                                        capabilities.TURN_CONTEXT, capabilities.TUI_ADAPTER,
                                        capabilities.TERMINAL)}
        for name, evidence in CONSUMERS.items():
            with self.subTest(consumer=name):
                refused = self.refuse("pi", evidence)
                self.assertEqual(refused.code, "test_pi_evidence_unavailable")
                self.assertEqual(refused.provider, "pi")
                self.assertEqual(refused.missing_evidence, expected[name])

    def test_declared_capability_is_rechecked_against_the_observation(self):
        # A provider's table row is a promise, not proof: an observation that
        # omits a required field is refused with that field named.
        observed = {"terminal": {}, "session_id": "s"}
        refused = self.refuse("trae", capabilities.BOOTSTRAP_ROLE, observed=observed)
        self.assertEqual(refused.code, "test_trae_evidence_unavailable")
        self.assertEqual(refused.missing_evidence,
                         (capabilities.TRANSCRIPT, capabilities.LAUNCH_COMMITMENT))
        self.assertEqual(self.refuse("trae", capabilities.OPERATOR_IDENTITY,
                                     observed=observed).missing_evidence,
                         (capabilities.TRANSCRIPT,))

    def test_a_complete_observation_keeps_the_trae_path_accepted(self):
        observed = {"terminal": {}, "session_id": "s", "transcript_path": "/tmp/log.jsonl",
                    "launch_token_hash": "a" * 64}
        capability = capabilities.require(
            "trae", capabilities.BOOTSTRAP_ROLE, required="test_provider_required",
            unsupported="test_provider_unsupported",
            unavailable="test_{provider}_evidence_unavailable", observed=observed)
        self.assertEqual(capability.evidence_format, "runtime-state")

    def test_no_captureless_provider_can_satisfy_any_consumer(self):
        # Guards a future table entry that forgets to declare its gap: without an
        # evidence format the pane row is always reported missing.
        for provider, capability in capabilities.CAPABILITIES.items():
            if capability.evidence_format is not None:
                continue
            for name, evidence in CONSUMERS.items():
                with self.subTest(provider=provider, consumer=name):
                    self.assertIn(capabilities.PANE_HOOK_STATUS,
                                  capability.missing(evidence))

    def test_refusal_is_a_value_error_carrying_the_typed_code(self):
        refused = self.refuse("pi", capabilities.OPERATOR_IDENTITY)
        self.assertIsInstance(refused, ValueError)
        self.assertEqual(str(refused), refused.code)


class ReaderAgreementTests(unittest.TestCase):
    """The table cannot outrun the shared reader it delegates the format to."""

    def test_every_verifiable_provider_is_accepted_by_the_runtime_reader(self):
        with tempfile.TemporaryDirectory(prefix="provider-reader-", dir="/tmp") as directory:
            root = Path(directory).resolve()
            for name in ("profile", "logs"):
                (root / name).mkdir(mode=0o700)
            for provider, capability in capabilities.CAPABILITIES.items():
                if capability.evidence_format is None:
                    continue
                with self.subTest(provider=provider):
                    runtime_binding.configuration(dict(
                        provider=provider, format=capability.evidence_format,
                        host=socket.gethostname(), terminal_handle="term", worktree_id="worktree",
                        profile=str(root / "profile"), log_root=str(root / "logs")))


if __name__ == "__main__":
    unittest.main()

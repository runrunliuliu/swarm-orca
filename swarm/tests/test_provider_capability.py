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

    def test_pi_supplies_role_and_operator_evidence_but_no_tui_adapter(self):
        # Pi identity/transcript evidence is verified; the S2/S5 launch adapter is
        # still Trae-only, so the TUI consumer refuses Pi and names that channel.
        for name in ("bootstrap role", "operator identity"):
            with self.subTest(consumer=name):
                capability = capabilities.require(
                    "pi", CONSUMERS[name], required="test_provider_required",
                    unsupported="test_provider_unsupported",
                    unavailable="test_{provider}_evidence_unavailable")
                self.assertEqual(capability.provider, "pi")
                self.assertEqual(capability.evidence_format, "runtime-state")
                self.assertEqual(capability.records[capabilities.IDENTITY_ROOT], "session")
                self.assertEqual(capability.settings_fields, capabilities.PI_SETTINGS)
        refused = self.refuse("pi", capabilities.TUI_OBSERVATION)
        self.assertEqual(refused.code, "test_pi_evidence_unavailable")
        self.assertEqual(refused.missing_evidence, (capabilities.TUI_ADAPTER,))

    def test_provider_without_an_evidence_channel_names_it_instead_of_defaulting(self):
        # Table-level guard: a declared provider that cannot supply a channel is
        # refused with that channel, not silently swapped for another provider.
        unavailable = capabilities.Capability(
            "fixture", None, (capabilities.SESSION,), {}, (),
            unavailable=(capabilities.PANE_HOOK_STATUS, capabilities.TURN_SETTINGS))
        self.assertEqual(unavailable.missing(capabilities.BOOTSTRAP_ROLE),
                         (capabilities.PANE_HOOK_STATUS, capabilities.TURN_SETTINGS,
                          capabilities.TERMINAL, capabilities.TRANSCRIPT,
                          capabilities.LAUNCH_COMMITMENT, capabilities.IDENTITY_ROOT))

    def test_settings_are_scoped_to_what_each_provider_can_attest(self):
        self.assertIn("thinking_level", capabilities.PI_SETTINGS)
        self.assertNotIn("effort", capabilities.PI_SETTINGS)
        self.assertIn("sandbox_policy", capabilities.TRAE_SETTINGS)
        self.assertNotIn("sandbox_policy", capabilities.PI_SETTINGS)
        # Nothing may be required that no provider attests.
        self.assertEqual(set(capabilities.KNOWN_SETTINGS),
                         set(capabilities.TRAE_SETTINGS) | set(capabilities.PI_SETTINGS))

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
        refused = self.refuse("pi", capabilities.TUI_OBSERVATION)
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

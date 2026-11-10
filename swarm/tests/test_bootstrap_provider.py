"""Bootstrap role providers: declared in the pinned registration, verified, or refused.

No socket, native CLI or provider process runs here. The registration is a real
pinned file and `NativeIdentity` is the production class, so these cases show
which registration is admissible and which typed refusal an operator gets.
The full trae refresh path stays covered by `test_bootstrap_production.py`.
"""

from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

from bootstrap_identity import NativeIdentity
from coordinator_io import file_ref, parse, pinned, publish_new
import provider_capability


class RegistrationProviderTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="bootstrap-provider-", dir="/tmp")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.binding = self.published("attempt-binding.json", {"fixture": "binding"})
        self.control = SimpleNamespace(attempt_binding=self.binding)
        self.counter = 0

    def published(self, name, value):
        """Publish immutable bytes and pin the exact file, as a reviewer would."""
        target = self.root / name
        publish_new(target, value)
        return file_ref(target)

    def registration(self, *, providers=(("operator", "trae"), ("coordinator", "trae")), **overrides):
        roles = {}
        for index, (role, provider) in enumerate(providers):
            role_value = dict(provider=provider,
                              process=dict(pid=101 + index, start="1", boot="boot", uid=0),
                              session="session-" + role)
            roles[role] = role_value
        value = dict(schema_version=2, attempt_binding=self.binding,
                     profile=str(self.root), log_root=str(self.root), roles=roles)
        value.update(overrides)
        self.counter += 1
        return self.published(f"registration-{self.counter}.json", value)

    def identity(self, registration):
        """Construct the production identity without touching /proc or a native CLI."""
        with patch("bootstrap_identity.unchanged"), \
                patch("bootstrap_identity.descendant",
                      side_effect=ValueError("bootstrap_peer_wrong_process_tree")):
            return NativeIdentity(self.control, registration)

    def refused(self, registration):
        with patch("swarm_ledger.runtime_binding.capture",
                   side_effect=AssertionError("unverifiable provider reached the native reader")):
            with self.assertRaises(ValueError) as caught:
                self.identity(registration)
        return caught.exception

    def test_trae_roles_resolve_to_the_runtime_state_format(self):
        identity = self.identity(self.registration())
        for role in ("operator", "coordinator"):
            self.assertEqual(identity.capabilities[role].provider, "trae")
            self.assertEqual(identity.capabilities[role].evidence_format, "runtime-state")

    def test_v1_registration_without_a_provider_is_not_silently_upgraded(self):
        self.assertIn("bootstrap_registration_invalid",
                      str(self.refused(self.registration(schema_version=1))))

    def test_role_registration_must_name_a_provider(self):
        value = parse(pinned(self.registration()))
        del value["roles"]["operator"]["provider"]
        missing = self.published("registration-missing-provider.json", value)
        self.assertIn("bootstrap_role_registration_invalid", str(self.refused(missing)))

    def test_blank_provider_is_required_instead_of_assumed(self):
        refused = self.refused(self.registration(providers=(("operator", "  "), ("coordinator", "trae"))))
        self.assertEqual(str(refused), "bootstrap_registration_provider_required")
        self.assertEqual(refused.missing_evidence, ())

    def test_unknown_provider_is_unsupported_instead_of_defaulted_to_trae(self):
        for provider in ("codex", "Trae", "trae "):
            with self.subTest(provider=provider):
                refused = self.refused(self.registration(
                    providers=(("operator", "trae"), ("coordinator", provider))))
                self.assertEqual(str(refused), "bootstrap_registration_provider_unsupported")

    def test_known_but_unverifiable_provider_names_the_missing_evidence(self):
        for role in ("operator", "coordinator"):
            with self.subTest(role=role):
                providers = [("operator", "trae"), ("coordinator", "trae")]
                providers[0 if role == "operator" else 1] = (role, "pi")
                refused = self.refused(self.registration(providers=providers))
                self.assertEqual(str(refused), f"bootstrap_{role}_provider_evidence_unavailable")
                self.assertEqual(refused.missing_evidence,
                                 (provider_capability.PANE_HOOK_STATUS, provider_capability.SESSION_META,
                                  provider_capability.TURN_CONTEXT, provider_capability.TERMINAL,
                                  provider_capability.LAUNCH_COMMITMENT))

    def test_observed_identity_must_still_carry_the_declared_fields(self):
        identity = self.identity(self.registration())
        with self.assertRaises(provider_capability.ProviderRefused) as caught:
            identity.role_capability("coordinator", observed={"terminal": {}, "session_id": "session"})
        self.assertEqual(str(caught.exception), "bootstrap_coordinator_provider_evidence_unavailable")
        self.assertEqual(caught.exception.missing_evidence,
                         (provider_capability.TRANSCRIPT, provider_capability.LAUNCH_COMMITMENT))
        complete = {"terminal": {}, "session_id": "session", "transcript_path": "/tmp/log.jsonl",
                    "launch_token_hash": "a" * 64}
        self.assertIs(identity.role_capability("coordinator", observed=complete),
                      identity.capabilities["coordinator"])

    def test_independence_checks_still_run_before_any_native_query(self):
        # The capability seam must not become an early-accept path: the original
        # process/incarnation/launch-token gates stay in force for trae roles.
        value = parse(pinned(self.registration()))
        value["roles"]["operator"]["process"] = value["roles"]["coordinator"]["process"]
        shared = self.published("registration-shared-root.json", value)
        with self.assertRaisesRegex(ValueError, "bootstrap_roles_not_independent"):
            self.identity(shared)


if __name__ == "__main__":
    unittest.main()

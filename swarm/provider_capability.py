"""Provider capability seam for the strict bootstrap gate roles.

A gate role's provider is never a constant in the reader code: it is declared in
the reviewed registration (`bootstrap_identity.py`) or in the Operator identity
input (`operator_session.py`), and the declared name is then verified against
native evidence by `swarm_ledger.runtime_binding`. This module holds the one
thing that verification cannot discover by itself — which evidence format, which
identity fields, which transcript records and which effective settings this build
is able to verify for a given provider.

Two refusals are kept distinct, and neither is a default:

- an unknown provider name is refused as unsupported (nothing is guessed);
- a known provider that cannot supply some evidence here is refused with the
  caller's typed code plus the exact missing evidence channels, so the operator
  learns which channel is absent instead of a generic "unverifiable".

A row is only meaningful if `swarm_ledger.runtime_binding` accepts the same
provider name for the declared format; adding a name here without reader support
still refuses, one layer down, with the reader's own typed code.

Deliberately dependency-free: both gates and the CLI import it, so it must not
pull a native reader, a ledger or an error family into the import graph.
"""

# Evidence channels. A refusal names these instead of collapsing them into one
# "unverifiable" string, because the fix differs per channel.
PANE_HOOK_STATUS = "agent_hooks_pane_status"  # per-pane row: source/agentType/providerSession
TERMINAL = "terminal"                         # handle/worktree/tab/leaf/pty/incarnation
SESSION = "session_id"                        # provider session id
TRANSCRIPT = "transcript_path"                # provider transcript under the declared log root
LAUNCH_COMMITMENT = "launch_token_hash"       # hook launchTokenHash vs the pane's launch token
# Semantic transcript evidence; each capability maps it to its own record kind.
IDENTITY_ROOT = "session_root_record"         # record that pins the session id
TURN_SETTINGS = "turn_settings_record"        # per-turn effective model/settings record
TUI_ADAPTER = "tui_adapter"                   # reviewed TUI observation/launch adapter

# Effective settings a provider can actually attest. A reviewed contract may only
# require keys from its provider's tuple; the rest is refused rather than ignored.
TRAE_SETTINGS = ("model", "model_provider", "effort", "model_backend_variant", "approval_policy",
                 "approvals_reviewer", "sandbox_policy", "cwd", "writable_roots")
PI_SETTINGS = ("model", "model_provider", "thinking_level", "cwd")
KNOWN_SETTINGS = tuple(dict.fromkeys(TRAE_SETTINGS + PI_SETTINGS))


class Evidence:
    """Evidence one consumer verifies; a subset of what a provider may supply."""

    __slots__ = ("fields", "records", "tui_adapter")

    def __init__(self, fields, records, tui_adapter=False):
        self.fields, self.records, self.tui_adapter = tuple(fields), tuple(records), tui_adapter


# The bootstrap owner binds both role panes without a TUI transcript reader.
BOOTSTRAP_ROLE = Evidence((TERMINAL, SESSION, TRANSCRIPT, LAUNCH_COMMITMENT), (IDENTITY_ROOT,))
# The Operator gate additionally reads reviewed effective settings per turn.
OPERATOR_IDENTITY = Evidence((TERMINAL, SESSION, TRANSCRIPT), (IDENTITY_ROOT, TURN_SETTINGS))
# The S2 Coordinator observation and the S5 TUI contract need a launch adapter.
TUI_OBSERVATION = Evidence((TERMINAL, SESSION, TRANSCRIPT), (IDENTITY_ROOT, TURN_SETTINGS),
                           tui_adapter=True)


class Capability:
    """What this build can verify for one declared provider.

    evidence_format is the `runtime_binding` capture mode, or None when this
    build has no capture that can attribute the provider's session to a pane at
    all. `records` maps each semantic transcript requirement to the provider's
    record kind; `settings_fields` is what a reviewed contract may require.
    `unavailable` names channels such a provider provably lacks, so a capture
    failure is never reported as a generic state.
    """

    __slots__ = ("provider", "evidence_format", "identity_fields", "records",
                 "settings_fields", "tui_adapter", "unavailable")

    def __init__(self, provider, evidence_format, identity_fields, records,
                 settings_fields, tui_adapter=None, unavailable=()):
        self.provider, self.evidence_format = provider, evidence_format
        self.identity_fields, self.records = tuple(identity_fields), dict(records)
        self.settings_fields = tuple(settings_fields)
        self.tui_adapter, self.unavailable = tui_adapter, tuple(unavailable)

    def missing(self, evidence, observed=None):
        """Missing channels for one consumer, de-duplicated in table order."""
        absent = [] if self.evidence_format is not None else [PANE_HOOK_STATUS]
        absent += [item for item in self.unavailable if item not in absent]
        if evidence.tui_adapter and self.tui_adapter is None:
            absent.append(TUI_ADAPTER)
        absent += [field for field in evidence.fields if field not in self.identity_fields]
        absent += [record for record in evidence.records if record not in self.records]
        if observed is not None:
            # A declared capability is not proof: the observation must carry it.
            absent += [field for field in evidence.fields
                       if field in self.identity_fields and field not in observed]
        return tuple(dict.fromkeys(absent))


CAPABILITIES = {
    # Trae TUI: hook row + transcript root `session_meta` + per-turn `turn_context`.
    "trae": Capability("trae", "runtime-state",
                       (TERMINAL, SESSION, TRANSCRIPT, LAUNCH_COMMITMENT),
                       {IDENTITY_ROOT: "session_meta", TURN_SETTINGS: "turn_context"},
                       TRAE_SETTINGS, tui_adapter="trae-tui-runtime-v1"),
    # Pi TUI: Orca's bundled Pi status extension posts session_id/session_file and
    # the launch token to /hook/pi, and the Pi transcript root is `{"type":"session",
    # "id":<uuid>,"cwd":…}` with per-turn assistant `model`/`provider`/`thinkingLevel`.
    # Pi has no approval/sandbox surface, so only PI_SETTINGS may be required.
    # tui_adapter stays unset until the S2/S5 Pi launch adapter exists: the fields
    # template and the S2 observation must refuse rather than assume one.
    "pi": Capability("pi", "runtime-state",
                     (TERMINAL, SESSION, TRANSCRIPT, LAUNCH_COMMITMENT),
                     {IDENTITY_ROOT: "session", TURN_SETTINGS: "message"},
                     PI_SETTINGS),
}


class ProviderRefused(ValueError):
    """Typed refusal carrying the missing evidence channels, never a default."""

    def __init__(self, code, provider, missing=()):
        super().__init__(code)
        self.code, self.provider = str(code), provider
        self.missing_evidence = tuple(missing)


def declared(provider):
    """Explicit table lookup. An unknown or non-string name returns None."""
    return CAPABILITIES.get(provider) if isinstance(provider, str) else None


def require(provider, evidence, *, required, unsupported, unavailable, observed=None):
    """Resolve one declared provider for one consumer, or refuse with a typed code.

    `required` is used for a missing/blank declaration, `unsupported` for a name
    this build does not know, and `unavailable` (formatted with the resolved
    provider) for a known provider missing evidence. Nothing falls back to
    another provider, format or log root.
    """
    if not isinstance(provider, str) or not provider.strip():
        raise ProviderRefused(required, provider)
    capability = declared(provider)
    if capability is None:
        raise ProviderRefused(unsupported, provider)
    missing = capability.missing(evidence, observed)
    if missing:
        raise ProviderRefused(unavailable.format(provider=capability.provider),
                              capability.provider, missing)
    return capability

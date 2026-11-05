# Session binding and provider adapters

Bind native runtime/worktree/terminal/incarnation and Run/Dispatch to the actual provider session
before verifying effective model, effort, backend variant and permissions. Never infer the Agent
from a model name or select logs by cwd, title, preview or newest timestamp. Approved task selection
wins over defaults; use explicit deployment configuration.

## Select the evidence mode

Choose a supported adapter for the actual provider/version and acceptance requirement. Routine
settings checks do not always require host `/proc` access; process-attestation requirements cannot
silently be downgraded to file evidence.

- [Runtime-state](../../../runtime-session-binding.md) cross-checks exact native/hook/session-log
  mappings with freshness and prefix pins; retain `runtime-state-not-process-attested`.
- Default `config/read`, model catalogs and requested settings are not current-session effective
  settings. Use the adapter's precise thread/session observation; do not create a thread/model turn
  to refresh a read-only check.
- [Preparation](../../../coordinator-preparation.md) and [native preflight](../../../native-preflight.md)
  have narrower provider support than [Trae startup](../../../trae-coordinator.md) and
  [TUI](../../../coordinator-tui.md). Check the selected protocol; do not change provider or drop
  evidence requirements to make a gate pass.
- On denial or identity mismatch preserve evidence and stop affected collection. No automatic switch
  from host receipts to runtime-state, tool/runtime changes or service identity substitution.

## Optional host attestation

Use [host session binding](../../../session-binding.md) only when needed and explicitly authorized.
Writable artifact roots do not solve process-access permissions. Fix runtime/host/UID, worktree,
Run/Dispatch, terminal, trusted public key and exact socket. The collector must bind native identity
through PID/starttime and open log descriptors to the root session, not guess from cwd.

Private keys must be unreadable and collector code/config/state unwritable by the Agent; same-UID
0600/0700 modes do not establish this isolation. Trust inputs must come from independently controlled
sources. A manual `isolation_verified` declaration is not a runtime security mechanism.

The actual Coordinator sandbox must connect to the exact socket, verify nonce/scope/session/freshness
and signatures, and write its evidence. Historical receipts and hand-filled JSON are not substitutes.
Collection failure remains unverifiable; denial prohibits bypass/retry with broader permissions.
Persist collector target locks across restart; resume only through reviewed authorized recovery.
Disconnection is not Agent exit and does not alter native lifecycle.

Running samples cannot be marked final. Child sessions and output after settlement require separate
coverage; avoid double counting. Preserve preflight, binding summaries, key fingerprint and ledger,
then verify archival readback. New source/skills do not install collectors, alter live permissions,
launch Agents or prove unattended operation.

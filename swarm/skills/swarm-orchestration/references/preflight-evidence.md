# Preflight evidence and bounded refresh

Generic policy, not a native API or permission. Every dispatch still requires current authorization,
lifecycle, capacity and budget checks. Evidence preparation does not authorize model turns or Runs.

## Three evidence layers

1. Native live state: query the selected runtime, exact workspace, terminal/incarnation and
   Run/Dispatch relations on every preflight. Historical success is not liveness.
2. Session observation: exact provider session's effective model, effort, backend variant and
   permissions with the adapter's explicit freshness contract. Hook time is not a heartbeat;
   rereading old records or defaults never renews evidence. Do not wake a model to manufacture it.
3. File-tool probes: genuine write/read/rename/read results may be reused only when the adapter
   supports revalidation of the same runtime/version, Run, terminal/incarnation, provider/session,
   settings, canonical directories and configuration/policy/tool hashes. Read back exact probe
   bytes and verify the old name is absent. Extra TTL is configurable; no TTL is not eternal validity.

Recheck the task baseline. A new session, changed model/permissions, known mount/ACL/tool change,
lost/changed probe or unverifiable identity prevents reuse. Limited stat/hash evidence is not a
complete ACL audit, process attestation or proof of current write permission. Shell probes cannot
substitute for the actual editing tool used by the task.

## Refresh is not a task retry

Only freshness expiry with otherwise unchanged identity/authority and no unresolved refusal/failure
permits explicit bounded refresh. Then rerun the full native gate; never automatically dispatch or
switch adapters on failure. Follow [preparation](../../../coordinator-preparation.md) and
[native preflight](../../../native-preflight.md) for exact versions and commands.

Versioned preparation attempts retain original probes, completion times and source hashes, use new
receipt names and explicit attempt limits, and reference the exact preceding successful receipt.
No newest-file discovery, overwrites, skipped attempts or increased limits to evade budgets.
Maintain aggregate preparation accounting; a new directory/contract/Run cannot reset it.
A template that executed no tools may be regenerated read-only; partial writes, permission denials,
identity conflicts or unknown outcomes require preservation and reconciliation, not renaming or a
new tool. Expiry during the gate must reject. Gate success is short-lived, never standing permission.

## Adapter boundary

Use [session binding](session-binding.md) and the actual provider/version's supported tools.
Codex-local preparation is not a Trae Coordinator preflight, and Worker usage tests do not establish
Coordinator startup support. Do not transfer sandbox/approval/editing flags between providers.
Historical v1 preparation retains its fixed-name and TTL semantics; v2 reuse requires its complete
binding/probe evidence and explicit new configuration. Never silently promote old receipts.

# Planned strict runtime restart

Status (2026-10-30): the CLI, native planned-restart lifecycle and Python recovery
adapter are connected in source. Local tests cover retryable startup and two
successive reviewed cycles. **Not deployed or live-accepted.** A full Server/TUI
restart through the Python workflow remains unverified. This document is not an
execution permit.

## Supported slice

Successive planned restarts, Linux, same kernel boot/PID namespace, same private Server
data root/database, surviving original daemon and exact original terminals.
The monitor must be stopped, scheduler-only, with one sent but unclaimed pending
continuation and no active Workers. The original Run, owner, incarnation and
consumer generation remain unchanged. No terminal remapping, new Run or Worker
dispatch is part of restart recovery.

Unplanned restart, missing pre-restart seal, changed terminal identity, another
execution host and disaster recovery are unsupported. A historical Run already
stranded by restart cannot acquire a retrospective seal. Existing same-runtime
recovery still rejects runtime mismatch.

## Connected sequence

```text
source prepare/seal → independent source review → explicit planned Server restart
  → native transition → Python prepare/review/apply
  → original Coordinator claim/action/settle/full ACK/checkpoint
  → complete (new deployment committed last) → monitor and next turn
```

- `operator_continuity_source.seal_source` reuses deployment pins, pending-first
  reconciliation and the existing workflow/monitor/continuation locks. It keeps
  those locks through native prepare and seal; outputs go into a caller-created,
  empty private directory outside the state roots. `observe_source` remains only
  an observation whose locks are released on return.
- `orchestration.plannedRestart` is an explicit maintenance RPC. The CLI invokes it
  directly with the authenticated caller envelope: it must not first call ordinary
  terminal identity resolution, which is unavailable once the source is frozen.
  An unsupported host refuses; there is no alternate-runtime fallback.
- `orcad-planned-source.ts` derives core scope from the pinned plan → config →
  continuation → contract and rechecks native Run/sender/pending-request identity,
  payload, checkpoint head, outbox and file/code pins. It does not interpret or
  recursively expand opaque authorization evidence.
- Source seal blocks ordinary RPC mutations, drains/freezes daemon mutations and
  the common PTY write sink, freezes profile persistence, then checks idle and
  source consistency again. It records inventory and the whole-database seal,
  makes the source DB connection query-only and records the seal in the independent
  lineage journal. Errors after freeze leave writers stopped and evidence intact.
- An independent existing strict terminal reviews on the source Server. Coordinator,
  preparer and sender cannot review. The journal pins the preparation, proposal,
  seal and reviewer; retries reuse the same result.
- `orcad --planned-restart <reviewCanonicalSha256>:<proposalCanonicalSha256>` admits
  an immediate successor under the existing instance lock. It connects only to the
  pinned surviving daemon (no spawn/fallback), verifies the reviewed journal receipt
  and reserves a new immutable boot attempt. The bound DB remains query-only.
- Headless startup restores exact PTY authorities and uses the existing hook server
  attestation/retirement callbacks, as desktop startup already does. Missing hook
  proof is not bypassed. Identity checks, PTY registration, RPC/push setup and pairing
  construction precede commit. Commit records consumption, releases exclusive daemon
  ownership, then enables DB writes; ordinary RPC stays fenced until this completes.
  Post-commit health/readiness reporting failures are logged, not admission rollback.
- The target maintenance boundary derives the transition from the consumed journal
  and checks the current caller/phase. **It binds transport, not business permission.**
  The independent Python recovery review/permit and existing strict orchestration
  checks remain required. Historical config/contract/runtime pins are not rewritten.
- Boot mailbox redrive and federation startup are skipped for this narrow recovery.
  The original pending action is explicitly reconciled through recovery, not sent
  again by a startup scan. Subsequent monitor/TUI rounds use the cross-runtime
  wrappers and existing request IDs, ACK and checkpoint implementation.

Python commands and role handoffs are described in
[the monitor protocol](../../../swarm/operator-monitor-cross-runtime.md).
Scripts do not restart services, grant authorization or declare acceptance passed.

## Retry and the next cycle

```text
reviewed seal → immutable attempt (DB query-only, input frozen)
  → startup checks → journal commit → daemon release → DB activation → serving
```

A failed startup can reserve another attempt under the original instance lock and
deadline, with unchanged review/proposal pins, seal and inventory. Even if the journal
commit or daemon release reply was lost, retry is allowed only when the surviving
daemon proves frozen with no admitted effect. Disconnect before its first effect
returns it to frozen; cleanup `shutdownIfIdle` cannot spend that retry window. After
the first effect, a new runtime cannot reuse the old admission. No TTL extension,
seal deletion, receipt rewriting or automatic service retry is performed.

After recovery finishes and publishes its immutable deployment, the current runtime
may start a new cycle with a fresh proposal, seal and independent reviews. Journal
records are keyed by source cycle/stage/attempt; previous seals and failed attempts
remain. Python reads the committed deployment chain, routes to the current runtime
and uses a per-recovery STOP path without changing the original config. A retained
seal still blocks **ordinary/unplanned startup**; two planned cycles do not enable
arbitrary service restarts.

## Existing safeguards retained

Stable `serverId` differs from per-instance `runtimeId`. The independent lineage
journal is checked before ordinary runtime/browser startup: an expired seal, old DB
backup, removed DB or deleted DB seal metadata cannot reopen normal startup. Schema
validation rejects malformed continuity tables and missing/ineffective immutable
triggers; it does not silently repair them. Legacy unsealed/unenrolled hosts retain
ordinary startup, with this maintenance capability unavailable where unsupported.
Base-only lineage journals can acquire the new planned-restart table. The earlier
unreleased, stage-only table shape is rejected, not migrated or silently repaired.

The existing inventory/snapshot mechanisms are reused, not extended to clone or
backup recovery. Raw file references use `sha256`/`fileSha256`; parsed JSON pins use
explicit `*CanonicalSha256` fields. They are not interchangeable.

## Local evidence and remaining limits

The connected native test uses disk SQLite, lineage/instance locks and a real
DaemonServer socket. It covers two prepare/seal/review/commit/transition cycles,
frozen RPC refusal, original daemon sessions, request replay and repeated full ACK,
plus lost journal-commit and daemon-release replies followed by a new boot attempt.
PTY subprocesses, live authorities, idle evidence and hook attestations are fixtures.
A separate `startOrcad` dependency-wiring test injects browser/profile/PTY/RPC/pairing
startup failures and health/readiness reporting failures; runtime and admission are
mocked there. Python tests cover the CLI envelope, held-lock seal, independent review,
two-cycle recovery/next turn, repeated ACK and interrupted commit-last publication.
Neither suite is a real Server/TUI restart or a cross-language end-to-end run.

Known limits before deployment:

- Two cycles and retry are local evidence, not a real TUI continuity verdict. Retry
  outside the unchanged, unexpired, frozen/no-effect boundary remains unsupported.
- This is a whole-database/daemon maintenance operation. Arbitrary concurrent
  structured sessions, automations, federated/remote writers and unrelated workloads
  have not been proved quiescent. The daemon freezes controlled input, not the PTY
  process itself. Do not treat local fence tests as global live writer exclusion.
- The Server rechecks the core pinned scope but does not independently prove the
  Python process holds its file locks, nor interpret all authorization evidence.
  Target boundary evidence is not a native recovery-permit validator.

The inspected installed Server is still Electron `orca-ide` 1.4.219, and its CLI has
no `planned-restart` verb. This new admission is wired into Node `orcad`, not that
running service. A controlled matching Server/daemon/CLI deployment is required;
restarting the shared Electron service cannot validate it.

Keep these limits explicit rather than adding generic recovery machinery in this
slice. Next evidence is two controlled, authorized cycles through the complete
Python/Server/TUI chain. Then run same-runtime `monitor-restart` and
`live-4`; planned cross-runtime restart does not replace any of the 11 live IDs.

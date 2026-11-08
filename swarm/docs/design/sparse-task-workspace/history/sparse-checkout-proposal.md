# Worktree create: sparse checkout and recoverable creation

## Status and scope

Design proposal, not an implementation or deployment report. The proposed CLI
flags, operation states, and recovery guarantees below are not current released
interfaces. Existing sparse helpers and short-lived create deduplication are
implemented; their presence does not establish end-to-end recovery.

**Superseded in part (2026-11-08).** What this proposal asked for and where it now lives:

| Proposed here | Current state |
| --- | --- |
| Pinned SHA, HEAD/cone readback, tree and required-path checks | implemented — [M0 contract](../m0-contract.md) |
| `worktree create-status --request <id>` and staged states | implemented with a different shape — [M4 status](../reconciliation.md): `orca worktree create-status --repo`, intent journal, `pending/created/failed/needs_reconciliation` |
| Recovery without blind cleanup | partially: failures keep their workspace and are classified read-only; **no automatic recovery, retry or cleanup** |
| Performance comparison as an acceptance gate | dropped: performance is recorded as an observation, never a correctness threshold |

Read the numbered contracts for what is required, and the development plan's status
section for what is merged; treat the rest of this file as pre-implementation history.

This revision incorporates source review of Orca, Git, `actions/checkout`, and
DeepSeek Harness. It authorizes no Agent launch, remote mutation, migration,
cleanup, or service operation. Existing task bindings and Run pins stay unchanged.

## Problem and decisions

Creating a branch is cheap; materializing its checkout and completing workspace
initialization can be expensive. The motivating `swarm-orca` checkout had roughly
31k tracked files, with worktrees potentially on network-backed storage. A caller
can receive `runtime_unavailable` while host-side Git is still writing. Skipping
setup hooks does not skip checkout. Blind retries can create additional resources;
blind cleanup can race a live creator.

Treat this as two independent problems:

1. **Correctness:** creation needs a durable identity, observable stages, a ready
   gate, and reconciliation after lost responses or restart.
2. **Performance:** explicit cone-mode sparse checkout reduces materialized files.
   It does not eliminate transport failures, Git locks, or slow setup.

Use Git's native sparse commands through Orca's existing execution providers;
do not add a Git library or another worktree manager. Preserve full checkout as
the default. Deliver recoverable creation before, or together with, CLI sparse
creation—not after Worker placement and presets.

## Reference implementations and limits

References are pinned review inputs, not dependencies or claims about latest
releases. Check licensing before copying code; prefer adapting behavior and tests.

| Reference | Reviewed material | Adopt | Do not infer or copy |
| --- | --- | --- | --- |
| [Git v2.49.1 sparse-checkout documentation](https://github.com/git/git/blob/v2.49.1/Documentation/git-sparse-checkout.adoc) | Native `set`, worktree-local configuration, cone semantics, sparse-index limitations | Git owns pattern generation and index updates; explicit cone mode; configuration-isolation tests | Modern options work on every Orca execution host; sparse is an access-control boundary |
| [actions/checkout v4.2.2 command manager](https://github.com/actions/checkout/blob/v4.2.2/src/git-command-manager.ts) and [source provider](https://github.com/actions/checkout/blob/v4.2.2/src/git-source-provider.ts) | Sparse settings applied before checkout; separate LFS/submodule steps | TypeScript-to-Git plumbing and phase ordering | Its non-cone pattern-file append, forced checkout, or unsetting `extensions.worktreeConfig` during sparse disable are safe for shared linked worktrees |
| [DeepSeek Harness worktree service](https://github.com/deepseek-ai/deepseek-harness/tree/ce7073d51254c26cd63b22a60835b8f948deb447/packages/experimental/worktree) and [forge consumer](https://github.com/deepseek-ai/deepseek-harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/experimental/client-ui-forge/src/worktree.ts) | `--no-checkout`, prepare/checkout stages, managed cancellation, retained failures, Agent maintenance hold | Separate request from execution; block dependent Agent work until ready; drain owned processes before reporting cancellation | No sparse creation or durable create replay. Do not copy new-branch retries; its restore targets a removed recorded checkout, not a half-written directory |
| [Scalar in Git v2.49.1](https://github.com/git/git/blob/v2.49.1/Documentation/scalar.adoc) | Sparse-first clone and separate object-fetch behavior | Distinguish checkout size, object transfer, and index cost | Install Scalar, change repository defaults, enable maintenance, or convert existing repositories to partial clones |

Further implementation/test references: Git's
[`builtin/sparse-checkout.c`](https://github.com/git/git/blob/v2.49.1/builtin/sparse-checkout.c)
and [`t/t1091-sparse-checkout-builtin.sh`](https://github.com/git/git/blob/v2.49.1/t/t1091-sparse-checkout-builtin.sh).
These are follow-up code-review entry points, not tests executed for this proposal.

## Current Orca implementation and gaps

Paths in this section are relative to `orca/`.

| Surface | Existing behavior | Required change or verification |
| --- | --- | --- |
| `src/shared/worktree/create-types.ts`, `src/shared/rpc-contract/worktree-create-params.ts` | Sparse directory request already exists in shared types and RPC schema | Complete CLI plumbing and capability negotiation, not another parallel request model |
| `src/main/git/worktree-sparse-add.ts` | Calls `addWorktree` with no checkout, then `sparse-checkout init --cone`, `set -- <dirs>`, and `checkout <branch>` | Verify modern/baseline command selection, config isolation, cancellation, and readiness |
| `src/main/runtime/runtime-local-git-worktree-create.ts` | Runtime uses the sparse helper and skips the prepared pool for sparse creation | Preserve runtime parity; this path does not have the IPC create-span recorder |
| `src/main/ipc/worktree-remote.ts` | Local IPC and SSH sparse paths exist; SSH repeats the sparse Git sequence; metadata includes sparse directories/base/preset | Keep execution on the owning host; consolidate policy and tests, not host routing |
| Local sparse helper and SSH sparse error path | Attempt forced worktree rollback and fresh-branch deletion after sparse setup failure | Do not reuse this catch-all cleanup for ambiguous timeout/disconnect; retain uncertain resources |
| `src/main/ipc/sparse-checkout-directories.ts` | Trims, normalizes separators, drops empty/dot entries, deduplicates, rejects absolute paths and `..` | Define stricter new CLI validation without silently changing every legacy consumer |
| `src/main/runtime/orca-runtime-terminal-create-deduplication.ts` | `dedupeWorktreeCreate` keys an in-memory promise by raw repo selector and `clientMutationId`; retains success briefly and drops failure immediately | Canonical target/caller binding, payload checking, durable receipt, restart reconciliation |
| `src/main/runtime/rpc/orchestration-mutation-executor.ts` | Existing durable mutation infrastructure for orchestration and selected prompt mutations | Reuse suitable storage/hash/replay primitives; `worktree.create` is not currently in `isDurableMutation` |

The existing `creationId` progress correlation is not a durable idempotency key.
Do not introduce a third independent identity: keep `clientMutationId` as the
create request identity, map progress to it for negotiated callers, and adapt
legacy UI correlation explicitly. The CLI may expose it as `--request-id`.

## Sparse request and Git execution

### First-version interface

Proposed syntax, not an executable instruction for current releases:

```text
orca worktree create \
  --repo id:<repo-id> \
  --name <name> \
  --base-branch <approved-sha-or-ref> \
  --request-id <client-generated-id> \
  --setup skip \
  --sparse-dir swarm \
  --json
```

Start with repeated `--sparse-dir` only. Defer the redundant JSON flag,
non-cone/file patterns, CLI presets, and automatic selection from task paths.
Reject sparse flags for folder workspaces or reuse of existing worktrees.
Existing non-cone worktrees remain inspectable; creation must not convert them.

New CLI and negotiated runtime validation must agree:

- Require at least one nonempty repository-relative directory; reject `.` as an
  implicit full-checkout request, absolute/drive/UNC paths, traversal, NUL and
  control characters. Reject ambiguous leading/trailing whitespace rather than
  silently selecting another path. Preserve spaces inside directory names.
- Use one defined separator normalization and stable deduplication/order for the
  request hash. Do not use filename extensions to distinguish files from folders.
- Resolve each selected path against the pinned commit tree, not the source
  checkout filesystem, which may itself be sparse. Initially accept existing
  tree directories only; reject blobs, symlink entries, gitlinks, and missing
  paths as selections. A future directory can be created under a selected parent.
- Pass literal argv with an option separator, or a tested Git-compatible stdin
  encoding. Spaces, Unicode, leading hyphens, and quote-prefixed names need
  round-trip tests; Git's stdin format interprets C-style quoted names.
- Bound the number and encoded size of selections and tree-probe output. Oversize
  input fails before mutation; no silent truncation or full-checkout fallback.

### Ordered execution

Reuse the existing base resolver, naming rules, host routing, and sparse helper:

1. Validate authorization, target, capabilities, and inputs; durably reserve the
   operation before side effects. Resolve the base once and persist its full SHA
   before branch/worktree creation. Replays never re-resolve a moving ref.
2. Create the worktree with `--no-checkout`. Claim the exact path exclusively and
   retain the requested branch identity. Do not first do a full checkout and then
   delete out-of-scope files.
3. On capable Git, use native `sparse-checkout set --cone` with sparse index off.
   `set` can itself materialize files: configure cancellation, filters, and limits
   before this call, not only before the final checkout.
4. Complete materialization using the existing tested branch-checkout path against
   the pinned creation result. Verify branch/HEAD consistency and sparse state;
   a directory, `.git` file, or successful `worktree add` alone is not readiness.
5. Persist metadata and perform required include/shared-path materialization.
   Keep its effects explicit; it can add files or links beyond the sparse cone.
6. Publish workspace readiness only after required stages succeed. Setup and
   Agent startup have their own recorded outcomes and never run on replay merely
   because the response was lost.

The older `init --cone` then `set` sequence is a compatibility candidate, not an
unconditional fallback. Follow [Git compatibility](../../../../../orca/docs/reference/git-compatibility.md):
Git 2.25 remains the core-workflow baseline; use host-scoped `GitCapabilityCache`,
narrow unsupported-option detection, and real-binary tests to select commands.
If a safe sparse sequence cannot be established, refuse sparse creation before
allocation where possible. Do not lower safety, globally raise the Git floor,
install Git, or silently perform a full checkout.

### Worktree-local configuration

Git may enable `extensions.worktreeConfig` in the shared repository as part of
sparse initialization. This is a deliberate migration, not a promise that shared
config bytes never change. Require these invariants:

- Main and sibling checkouts keep their effective sparse/full selection, branch,
  HEAD, index, and user files. Do not remove the extension as failure cleanup.
- Serialize Orca-owned configuration initialization by canonical Git common
  directory. Validate preexisting `core.worktree`, `core.bare`, sparse settings,
  and includes; unsafe or unverified migration stops rather than guessing.
- Account for external Git writers: an Orca mutex does not lock them out. Respect
  Git locks, check for drift, and never restore a stale whole-config snapshot.
- Use Git's worktree-aware path/config interfaces, not a guessed `.git/` layout.
- First release keeps sparse index off, including inherited configuration. Test
  index readers before any later opt-in; sparse checkout, sparse index, and
  partial clone are separate features.

### Files, dependencies, and implicit execution

Cone mode includes all files under selected directories **and root/ancestor-level
files**. It is not an exact directory allowlist, a sandbox, or a write grant.
Git merges and other operations may materialize additional paths.

Do not infer selections from `allowed_paths`: read dependencies, applicable
`AGENTS.md`, hidden role skills, shared types, fixtures, build and test configuration
can lie elsewhere. Require the task owner to select sufficient read scope. Before
Agent launch, verify required instruction and dependency paths at the pinned base;
missing sparse content is not permission to fabricate replacement files. Expand
scope only through a separately recorded, authorized operation on the same task
worktree; never silently expand to full checkout or allocate another worktree.

For the first CLI sparse release, require `--setup skip` and no automatic Agent or
default command execution. Later sparse setup must be explicitly `--setup run`,
with dependencies available and successful setup before dependent Agent startup.
Leave legacy full-checkout setup/startup ordering unchanged.

DeepSeek Harness disables hooks, filters, and lazy fetch. Adopt the principle of
explicit side effects, not a silent repository-wide policy change. Before release,
audit every materializing command and the existing Git runner:

- Sparse CLI creation must not implicitly execute repository hooks/filters,
  download LFS or partial-clone objects, initialize submodules, or install deps.
  Apply command-local controls through existing native/WSL/SSH runners.
- Document that skipping filters leaves LFS pointers/encrypted stored blobs; mark
  dependency readiness separately. Hydration/decryption is a separate explicit action.
- A Git version that silently ignores `GIT_NO_LAZY_FETCH` cannot satisfy a local-only
  guarantee. Gate partial-clone creation on verified support, or reject that case;
  do not assume environment variables are enforced on Git 2.25.
- Full-checkout legacy behavior remains compatible. A broader checkout-policy
  change requires its own review, not incidental reuse of a new sparse helper.

## Recoverable creation protocol

### Request identity and storage

Generate the request ID on the client **before sending**. Print/save it before
submission (stderr or a local receipt, preserving one final JSON stdout object).
Automation may supply a previously saved ID. Losing the acceptance response must
not lose the only lookup key.

Extend the existing deduplication entry point and reuse durable mutation primitives
where appropriate; maintain one authoritative operation record, not competing
memory and database results. A record contains:

- Schema version, request ID, authenticated owner, runtime/execution-host identity,
  canonical repository/common-directory identity and reserved target path/branch.
- Canonical requested-input hash and separately pinned resolved plan: base SHA,
  normalized sparse selection/mode, resolved setup/include/startup decisions.
  Hash all effectful inputs; exclude observation-only wait budgets. Protect any
  stored prompt/environment values under existing private-storage rules.
- Current phase, monotonic revision, timestamps, host operation/process identity
  including generation/start identity rather than PID alone, and terminal outcome.
- Verified worktree/instance identity, result, and separate metadata/setup/startup
  substep receipts. Unknown outcomes stay unknown, never zero or success.

Receipt persistence and target reservation precede Git effects. A storage failure
stops admission. Conflicts are checked by canonical execution target as well as
request key, so selector aliases or another caller cannot bypass the reservation.
A request ID is not authorization: status, replay, and cancel recheck caller access.

| Submission | Required behavior |
| --- | --- |
| New submission with a never-used ID and unclaimed target | Durably accept and reserve before starting work |
| Same owner/ID and same normalized input, active | Join/observe the existing operation; no second Git execution |
| Same owner/ID and same input, completed | Return the recorded result; no repeated setup, terminal, or prompt |
| Same owner/ID but different input | Stable conflict before side effects |
| Same owner/ID, failed/cancelled/needs reconciliation | Return the recorded outcome; do not silently start a new attempt |
| Different ID with reserved or retained target | Conflict with inspectable recovery guidance; no new suffix/name |
| Lookup/recovery of an unknown or expired ID | Explicit unknown; lookup must not submit a new create or infer no previous effects |

Keep unresolved reservations until reconciliation. Receipt GC must preserve enough
identity/tombstone information to prevent a delayed replay becoming a new create;
retention and pruning rules are part of the protocol, not the existing short TTL.
A deliberate replacement attempt requires reconciliation and explicit approval,
retains task identity and attempt history, and cannot silently abandon the old path.
A completed receipt is historical evidence, not proof that its worktree or terminal
still exists. Before dependent actions, verify the recorded worktree instance and
resolve current terminal identity; do not reuse stale handles or recreate a deleted
workspace as a side effect of replay.

### Acceptance, status, and readiness

For capability-negotiated clients, accept the operation promptly and let the owning
runtime execute it independently of the observing RPC. A CLI may wait for a bounded
interval, then return a structured pending result and the same request ID. Waiting
expiration and client disconnect do not cancel the operation.

Proposed `worktree create-status --request <id>` and explicit cancel commands are
views/actions over this record, not separate queues. Prefer extending existing
request-query infrastructure when it can retain method-specific recovery rules.

```text
accepted → preparing → registering → sparsifying → checking_out
         → materializing → finalizing → completed
```

For full checkouts, `sparsifying` is skipped. Optional setup/startup are separately
checkpointed before the requested operation completes. Each nonterminal phase can
enter `cancelling`, `failed`, or `needs_reconciliation`; `cancelled` is terminal only
once owned execution has been verified stopped. `workspaceReady` is a separate
fact: a valid checkout can remain ready when a later startup substep fails.

Status reports phase, last durable revision, readiness, retained resources, substep
outcomes, and an observation timestamp. A missing field from an older peer means
unsupported/unknown, not false. Progress may be streamed, but polling the receipt
must recover missed events. Existing scans may list an initializing worktree;
listing it must not grant Agent/terminal command readiness.

### Cancellation and restart

Distinguish transport wait budget, execution-phase deadline, overall operation
budget, and termination grace. Use configurable finite limits and the existing
process providers; do not introduce raw subprocesses or a blanket 60-second limit.
After cancellation/deadline, stop admitting later phases, terminate the owned
process range, and wait for host-confirmed settlement before safe cleanup decisions.
If observation fails, report it rather than claiming cancellation completed.

Follow [SSH execution ownership](../../../../../orca/docs/reference/ssh-execution-boundary.md):
process verdicts are **`live` / `unverifiable` / `exited`**. A disconnected SSH
provider, absent client-side map entry, or expired heartbeat is not exit evidence.
Status can expose the last durable phase while marking current host observation
unverifiable. No local fallback, runtime switching, or reconnect-and-replay loop.

After restart, reconcile before issuing commands:

| Observed state | Recovery |
| --- | --- |
| Same owned creator is live | Observe/rejoin it; do not launch another writer |
| Owner/process state is unverifiable | Keep target reserved and Agent blocked; require host evidence |
| Creator exited; Git and metadata match the pinned completed stage | Seal recoverable metadata/result steps idempotently |
| Creator exited; target absent and no effects verified | Record failed/cancelled state; replacement remains explicit |
| Partial index, lock, unexpected branch/HEAD, or external edits | `needs_reconciliation`; retain and diagnose, do not reset/unlock/delete |
| Checkout ready but setup/terminal/prompt outcome unknown | Preserve ready checkout; inspect substep identity, never rerun blindly |

A crash can occur between effect and receipt commit. Do not promise exactly-once
execution for arbitrary hooks or prompt delivery: checkpoint intent, use existing
terminal/Dispatch identities, and stop on ambiguity. The first release can safely
block ambiguous recovery rather than automatically resume a half-written checkout.

### Failure retention and cleanup

For negotiated recoverable operations, replace unconditional sparse catch-path
rollback with retained-state reporting. Any retained legacy rollback must be limited
to positively settled, exclusively owned fresh resources and separately tested.
Never force-delete a branch after metadata/setup/Agent activity may have begun.

Initial recovery tooling is read-only diagnosis: target path and instance, exact
branch/HEAD, Git registration and locks, index state, ownership, process verdict,
and possible user content. A dirty index that appears to delete all tracked files
is evidence to inspect, not proof of user deletion or a cleanup instruction.

Removal is a distinct authorized action governed by
[worktree delivery](../../../../skills/worktree-delivery/SKILL.md). Recheck ownership and
process state immediately before removal, preserve evidence, prefer native Git and
catalog cleanup, and do not automatically remove locks or recursively delete paths.

## CLI, Worker, and compatibility integration

- Expose requested sparse mode/directories, effective verified sparse state,
  workspace readiness, and request ID in create/show/status results. Stale cached
  metadata must not override Git after an external sparse change.
- Tell Agents that out-of-cone files may be intentionally absent, that ancestor
  files are included, and that sparse scope is independent of write permissions.
- Later Worker support permits sparse only for `new-top-level` / `new-child`.
  Reject it for `current`, exact existing worktrees, or terminal reuse. Bind the
  create request to the Dispatch and record sparse metadata; retry observes that
  creation instead of dispatching another Worker.
- Apply the ready gate in the native executor used by all launch consumers, not
  only CLI validation or a prompt warning. A later terminal launch must also refuse
  a known partial worktree. Do not broaden existing filesystem permissions.
- Follow [remote wire compatibility](../../../../../orca/docs/reference/remote-wire-compatibility.md).
  Negotiate recoverable-create and sparse semantics before sending dependent
  requests; old Zod parsers may strip unknown fields. Never silently drop sparse
  or idempotency requirements to make an older host accept the call.
- Keep old full-create response behavior for legacy callers. New states/methods
  require explicit capability handling; direct IPC, headless runtime, WSL, SSH,
  and Agent-launch entry points must converge on the same readiness and ownership
  rules. Do not claim host-local durability for a client-owned SSH controller.

## Delivery sequence and acceptance

### M0 — settle reuse and compatibility

Trace all create/launch entry points, existing mutation storage, Git capability
boundaries, process cancellation guarantees, and current rollback tests. Produce
one shared execution policy with host-specific adapters, not a second creator.
Fix the operation schema and wire negotiation before exposing flags.

### M1 — recoverable full creation, bounded first scope

Deliver client-owned ID, durable receipt/reservation, phase/status query, safe
cancellation/retention, and the native ready gate. First scope is explicit
`--setup skip` without automatic commands or Agents. Preserve legacy behavior
outside the negotiated path. Unknown crash outcomes may require manual resolution.

### M2 — explicit sparse CLI creation

Add repeated directory flags, commit-tree validation, safe native sparse commands,
configuration isolation, no-implicit-execution policy, metadata/warnings, and
cross-host compatibility. M1 and M2 may ship together; M2 may not bypass M1 safety.

### M3 — setup, startup, and supervised placement

Checkpoint optional side effects, add Worker placement/Dispatch integration, verify
instruction/dependency availability, and test stop/retry without duplicate Agents.
Sparse `--setup run` becomes available only with this gate.

### M4 — optional performance and usability

Reuse the existing `SparsePreset` model for explicit CLI/UI selection. Evaluate
sparse index and sparse-keyed prepared pools only with measured gains and tool
compatibility evidence. Do not automatically apply presets or private policy.
Non-cone creation, automatic cleanup, and partial-clone conversion remain deferred.

### Required test matrix

Tests below are implementation acceptance requirements, not results from this edit.
Reuse and extend `add-sparse-worktree.test.ts`, sparse setup/SSH tests,
`dedupe-worktree-create.spec.ts`, and durable mutation tests beside their owners.

| Area | Required evidence |
| --- | --- |
| Parsing | Repetition/deduplication; invalid absolute/traversal/empty paths; real dotted directories; spaces/Unicode/hyphens/quotes; tree vs blob/symlink/gitlink; bounded input; old-host refusal before effects |
| Git isolation | Main plus two linked worktrees with different sparse/full settings; preexisting worktree config and include rules; concurrent initializers; failed creation; unchanged sibling effective state/index/user files |
| Materialization | No full checkout before sparse configuration; pinned base survives moving HEAD; root/ancestor semantics; ordinary index; effective state verified; missing dependencies block Agent launch |
| Side effects | Hooks/filters/LFS/lazy fetch/submodules do not execute implicitly; missing partial-clone object fails without fetching on supported Git; unsupported guarantees are rejected |
| Idempotency | Concurrent same-ID calls execute once; changed payload conflicts; selector aliases and different callers cannot claim the same target; response loss returns the original result; no failure/TTL-driven replay |
| Crash windows | Interrupt after reservation, Git registration, sparse set, checkout, metadata, and each optional side effect; ready stages reconcile, ambiguous stages block; no automatic new branch or reset |
| Cancellation | CLI disconnect leaves host work owned; explicit cancel/deadline drains the managed range; unreachable host is unverifiable; existing rollback never races a live or unverified writer |
| Readiness | Initializing worktree can be diagnosed but cannot launch commands/Workers; setup/startup failure retains checkout with distinct outcomes; replay never duplicates terminal/prompt/Dispatch |
| Compatibility | Real Git baseline and modern lanes, native/WSL/SSH routing and host-isolated caches, old/new client-host pairs, folder workspace rejection, legacy full-create regressions |
| Performance | Same pinned fixture/base/storage, setup skipped: full versus sparse tracked materialized count/bytes, per-phase time and total time; report repetitions and cache conditions, no unmeasured speedup claim |

Large-repository and interruption acceptance must run only in an explicitly
authorized disposable fixture, never against active task worktrees. Require zero
duplicate resources under response-loss/replay tests and identical selected tracked
content at the pinned base. Root files and declared includes are counted separately
from selected subtrees. Wall-time goals follow measurements on the target storage,
not an arbitrary universal threshold.

## Verification of this document revision

The revision inspected the existing Orca sparse/RPC/runtime/deduplication paths,
DeepSeek Harness at the pinned commit, and fetched the pinned Git documentation
and `actions/checkout` source files listed above. This was source/document review,
not execution of their tests or Orca acceptance. No new CLI surface, recovery
service, sparse configuration, or deployed runtime was created by this update.

# Native adaptive preflight

[`coordinator_launch.py`](coordinator_launch.py) has a read-only
`native-preflight` mode for the native adaptive Swarm path. It is not part of
the fixed-DAG Supervisor, does not create a Run or Worker, and never retries or
launches anything. Run it inside the exact Coordinator terminal named by the
contract; Orca fences `run-current --from` when another terminal tries to act
for that Coordinator.

Start from [the example contract](examples/native-preflight.example.json), use
absolute verified paths, and retain the contract in the private Run archive.
The explicit runtime, Run, workspace, terminal and incarnation IDs are inputs,
not discovered by fuzzy matching.

The `codex-local` adapter supports a **local Codex Coordinator on Linux**. The explicit
`runtime_state.profile` must be the selected CLI's Orca profile, and
`runtime_state.log_root` must be that Coordinator's canonical Codex session root.
Remote execution and other Coordinator providers need their own verified adapter; this mode
does not silently substitute one. Pi has no `native-preflight` Coordinator adapter:
`agent=pi` is only a Worker launch shape ([Worker 参数计划](coordinator-worker-plan.md)),
and v2 rejects it with `unsupported_session_adapter`. This check is separate from
launch planning and from the Operator startup gate; Pi Operator support is handled by
the explicit `operator_session.py` runtime-state observer, not by `native-preflight`.

```bash
python3 coordinator_launch.py native-preflight \
  --contract /absolute/private/native-preflight-contract.json \
  > /absolute/private/native-preflight-receipt.json
```

The helper runs these independent checks through a bounded thread pool:

- current native `status`, exact worktree, exact terminal/incarnation, and the
  Run bound to that Coordinator terminal, binding every successful native
  response envelope to the expected runtime ID;
- selected CLI bytes, Coordinator JSON configs, policy files, canonical task
  directories, and every declared Git HEAD/cleanliness/content baseline;
- fresh runtime-state session evidence and revalidated actual file-tool evidence.

The file-tool evidence must say `batch_count: 1`, cover the canonical archive,
record actual apply-patch, read and rename operations, and bind the exact
runtime/Run/terminal/incarnation/**provider session**. V1 also accepts the SHA256
of the current session evidence as an alternative; v2 requires explicit identity.
The session evidence must match the exact provider session identity, runtime,
Run, terminal, incarnation, model, effort, sandbox and approval settings.
Schema v2 separates session freshness from file-tool proof validity (below).
Neither evidence is a trust or process attestation, and this helper adds no trust-review
gate.

The helper also checks the selected profile's runtime discovery ID/PID against
native status, then resolves only the live native tab/pane's fresh hook entry.
It rejects a changed session ID, replay/restored mappings or a transcript outside
the explicit log root. The exact transcript's first metadata record and latest
complete `turn_context` in the initial-EOF prefix must match the session, cwd, model,
effort, sandbox and approval policy. The prefix is scanned record by record with no
fixed tail-byte cap; missing settings still fail closed. There is
no latest-file search, `/proc` scan, process attestation, or fallback to a stale
session receipt. These independent observations are not an atomic snapshot.

## Layered evidence policy (schema v2)

The example now uses v2. It adds explicit `adapter: "codex-local"`, canonical
`probe_roots` in preparation order (archive, evidence, receipts, workers, ledger,
then deduplicated extra write directories), and:

```json
{
  "freshness": {
    "session_max_age_seconds": 300,
    "file_tool_max_age_seconds": null
  },
  "preparation": {"attempt": 1, "max_attempts": 3}
}
```

Session/hook freshness is a configurable positive integer, not a hard 900-second
ceiling. The example's 300 seconds is a task choice, not a universal default.
A null file-tool TTL is allowed only with a v2 proof: exact explicit identity,
full observed sandbox-policy/model/effort/approval/cwd digest, directory
device/inode/mode/owner, configuration/policy/CLI/adapter implementation hashes,
and original tiny renamed probes with exact bytes and absent original names.
Every preflight rereads that proof. New session evidence cannot re-date the old
file-tool `completed_at`. An optional positive file-tool TTL applies additionally.
The model/runtime configuration files used by preparation must be in `config_files`.

Native liveness/ownership and Git baselines are still checked every time. A hook
is not a heartbeat: reading it again does not refresh its observation time.
Future timestamps beyond clock tolerance fail. Evidence that expires during
preflight fails, too. Successful receipts include `handoff.evidence_valid_until`;
handoff must be immediate, within that window and without a relevant change.
It is not a lease or process attestation. Known permission, mount, ACL or tool
changes require a new actual probe; stat/digests do not detect every such change.

V1 contracts retain their original fields, shared 1–900 second TTL and fixed
preparation filenames. They are not silently weakened. Old receipts without
the v2 proof cannot be upgraded by changing their schema or timestamps.
V2 rejects other adapters; current Trae selection does not authorize a Codex
fallback or mean this helper has Trae Coordinator support.

## Receipt reuse and invalidation

An earlier successful receipt may be supplied as a deduplication hint:

```bash
python3 coordinator_launch.py native-preflight \
  --contract /absolute/private/native-preflight-contract.json \
  --reuse-receipt /absolute/private/prior-preflight-receipt.json
```

`stable.reuse=matched_prior_receipt` means the newly observed stable-input
fingerprint is identical. The fingerprint covers selected CLI content and
identity, runtime/version and explicit lifecycle/session IDs, policy/config
content, canonical path identity, limits, Git HEAD, tracked and staged-index diff bytes, and untracked
path/content bytes. Git queries use `--no-optional-locks` and do not use
`git status`, avoiding optional index-refresh writes. Any change to those inputs
invalidates reuse. Every check is rerun; matching is a deduplication hint, not a
computation cache. Runtime/workspace/terminal/lifecycle and session/file-tool
evidence must pass freshly on every invocation. Missing or malformed prior
receipts are non-reusable hints, while an access denial stops the preflight.
No receipt is live session, permission or trust proof.

For an explicit, append-only preparation refresh, see
[the fixed template](coordinator-preparation.md#v2-分层证据与显式刷新).
`--reuse-receipt` here is still only a preflight fingerprint hint; it does not
perform that refresh or skip any checks.

The compact JSON receipt contains only fixed-schema IDs, hashes, check names,
timings and decisions. It does not copy terminal previews, environment data,
secrets, command output, native error messages or arbitrary evidence fields.
Any failure yields `decision: stop`; preserve the original private execution
record for diagnosis and do not change paths, tools, runtime, model or policy
to bypass a denial.

## Handoff after success

When the authorized contract is unchanged and `ok: true`, do not insert another
model-mediated operator confirmation. The Coordinator invokes the explicit native
`worker-start` once with the already approved IDs and constraints. The receipt's
`dispatch_explicit_task_once` is a preflight result, not a business progress decision
or a single-Worker scheduling policy; later dispatches still require fresh checks
and available authorized capacity. Continue independent actionable work under the
[shared loop contract（部署方提供）](configuration.md#部署政策与历史材料).
Only when none remains should the Coordinator use native blocking
`orchestration check --wait` with a bounded timeout instead of repeated model
polls. A timeout is only a checkpoint and never authorizes retry or replacement.

Each new Worker must still produce fresh actual session evidence and one batch
of write/read/rename/read evidence using its actual native file tools in its
assigned private directory. For Codex this includes apply-patch; do not invent
Codex tool names for another provider. Record these distinct milestones rather than collapsing them into a
single "startup" duration:

1. Run created.
2. Coordinator turn started.
3. Preflight started and completed.
4. Worker dispatch invoked.
5. Worker first genuine tool started.

The helper fills the first four available receipt fields and leaves dispatch
and Worker-tool timestamps null for the lifecycle operator to complete from
native and Worker evidence. Offline success is not an end-to-end speedup claim.

## Limits and exit behavior

- Contract, evidence, policy, config and CLI inputs are regular files without a
  fixed byte cap. Symlink file inputs are rejected; directory aliases are canonicalized.
  Both stdout and stderr of each native/Git subprocess are drained incrementally
  without a byte cap. On timeout, only that child is killed
  and reaped; output is never exported into the receipt.
  Large JSON inputs/output still require memory, and all existing time deadlines apply.
- Each policy/config/baseline list contains 1–32 entries.
- `max_parallel` is 1–8 and per-check timeout is 500–30000 ms. V1 evidence age
  is 1–900 seconds; v2 TTLs are positive seconds (up to signed 32-bit range for
  input safety), with null allowed only for file-tool proof. These parsing bounds
  are not a recommendation to choose long session validity.
- V2 has 1–37 explicit probe roots and `1 <= attempt <= max_attempts <= 32`.
  This validates the supplied preparation budget, not a persistent global counter.
- Checks share a cancellation signal: after failure no further checks are
  submitted, and already-running checks cannot start their next subprocess.
  Each check has one deadline; all sequential commands in a baseline share its
  decreasing budget. Already-running subprocesses are drained within that budget.
  File reads and child cleanup cannot bound uninterruptible kernel/filesystem
  I/O in wall time; the timeout is not a hard whole-program deadline.
- Exit status is `0` only for `ok: true`; a rejected contract or failed check
  emits a sanitized receipt and exits `2`.
- The helper only reads files and runs allowlisted read-only native/Git queries.
  It has no generic command field, output-file option, mutation, retry, launch,
  service, provider, trust or configuration-changing path.

Run focused regressions with:

```bash
python3 -m unittest discover -s tests -p 'test_*preflight*.py' -v
python3 -m unittest discover -s tests -p test_coordinator_launch.py -v
```

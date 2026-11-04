# Independent read-only RSI progress watcher

`progress_watch.py` is separate from the fixed-DAG Supervisor and the Coordinator.
It queries the explicitly configured native runtime/Run/workspace every ~60 seconds
and saves a private summary every ~5 minutes. It does not call Inbox/check, consume
messages, execute nextAction, send prompts, create/stop/release Workers, restart a
Coordinator, or submit training. It never invokes Merlin or reads its credentials.

Set the native CLI explicitly with `ORCA_SERVER_CLI`. Only status, run-show,
fully paginated worker-list, task-list and terminal-list are called. Runtime ID,
Run scope and inventory completeness are checked; failure produces unknown,
never a fresh-looking copy of old counts. A timeout cancels only the query client,
not the server or a native terminal. Each query retains its 12-second timeout,
without a fixed output-byte cap. Worker inventory follows all pages until the
native end marker; repeated cursors or inconsistent inventory still fail closed.
Native refusals, client/connection failures, timeouts and runtime identity mismatches
write a durable `query-stop.json` latch. Later ticks (including after service restart)
write unknown/stop alerts without making any native query. There is no auto-reset.
An operator must investigate, obtain any required authorization, stop only the monitor,
preserve the latch as evidence and explicitly move it aside before a verified resume.
Ordinary malformed inventory shapes degrade to unknown; changing pagination can be
retried at the next cadence. Raw native error messages are not copied into reports.

## Configuration

Required fields are `runtime`, `run`, `workspace`, expected `terminal` and
`incarnation`, `expected_generation`, positive `max_workers`, `progress_file`, and
`driver_binding`. Only the driver-bound path is supported. IDs, integer types,
canonical paths and file pins are validated; missing or extra config fields fail
validation. `authority_binding` is the sole optional field, described below.

### Driver binding

Pin the reviewed schema-5 [Coordinator driver](coordinator-driver.md) config, which
requires a named `outer_operator` and schema-3 Journal (including background Job cursors):

```json
{
  "driver_binding": {
    "path": "/absolute/private/driver.json",
    "sha256": "REVIEWED_RAW_CONFIG_SHA256"
  }
}
```

This is an addition to the other required fields, not a complete config.
Top-level `plan_sha256`, `process_intent`, `process_receipt` and `launch_started_at`
are rejected: launch identity comes only from the pinned driver.
The native runtime/Run/generation/terminal/incarnation/workspace must match the driver.
Only `phase=run` with the driver's exact nonempty `resume_session` is accepted.
Receipts must contain and exactly match intent plan hash, start, phase and session.
Owner/generation/incarnation changes require operator verification, never an automatic
rebind. The watcher cannot restart a Coordinator or grant permissions.

`coordinator_state.follow_launch()` reuses the driver's Journal validation. It reads
the exact archive/state selected by the pinned config and prefers `pending` over
`current`. Attempt zero refers to the original plan; later attempts require the
exact `turn-NNNNNN/launch-plan.json`, unchanged launch policy, matching action/settlement
and capture intent. It never scans for "latest", consumes Inbox, runs a checker,
executes a plan, or takes the driver's write lock. A state change while reading,
partial `state.next.json`, missing state or invalid pin produces
`driver_launch_evidence_unavailable_agent_exit_unknown`, not a fallback to an old exit.
A selected pending launch without an intent emits
`launch_intent_not_observed_agent_exit_unknown`.

The watcher persists a monotonic `driver_cursor` (attempt, plan hash, start): a
rollback or rewriting the same launch is unknown. If an identity-valid report postdates
a matched exit, `launch_binding_stale_agent_exit_unknown` persists across report loss
and restart; it means neither running nor exited. A pending attempt without its
matching intent cannot clear a prior stale-exit conflict. A verified later attempt
with a matching intent and unchanged native identity can supersede that conflict;
its own receipt and newer-progress checks still apply. The native `query-stop.json`
latch is independent and is **never** cleared by driver following or a later attempt.

`configured_launch.scope` is `driver_selected_launch_only`. Its small `driver`
projection shows cursor, phase (`between_turns`, `launch_pending`, `operator_handoff`,
`stopped`), no-progress count and any exact Operator request reference. These are
durable file observations, not proof the loop is alive: `loop_liveness` is explicitly
`not_inferred_from_files`. No handoff body or external job contents are exported.
A valid receipt proves only that selected child exited; neither a live shell nor
the existence of driver files proves the next turn, platform job or research is running.
Launches outside this driver still require operator reconciliation/rebinding.

### Deployment and rebinding

The watcher and its support modules are one required bundle: matching
`coordinator_state.py`, `coordinator_handoff.py`, `coordinator_io.py` and
`trae_exec_capture.py` must be available beside `progress_watch.py`. Missing support
code is a deployment/startup error, not an alternate observation mode.

The private output is pinned to the whole config hash in `binding.json`; a config
change cannot silently reuse it. Previous config/Journal formats are rejected, not
automatically migrated. For an authorized upgrade or deliberate new binding, preserve
the scripts, config, state, pending work and observations; inspect and resolve any
`query-stop.json` before proceeding. Verify the bundle, driver state and live native
identity, then use a separately reviewed private config/output binding and switch
**only the monitor service**. A new directory must never bypass an unresolved stop.
Verify repeated live samples before declaring monitoring restored. Do not restart
or message the Coordinator, rewrite its progress report, or delete evidence to fix
monitoring. This source update does not deploy code or change a running service.

Run in a newly created private local POSIX state directory:

```bash
python3 -B /absolute/deployed/progress_watch.py --config /absolute/config.json --output /absolute/private-state --once
# Omit --once for the supervised independent process.
```

`status.json`/`status.md` are atomically replaced. `snapshots.jsonl`,
`summaries.jsonl` and deduplicated `alerts.jsonl` are append-only operator-private
observations. `state.json` and advisory `watch.lock` prevent overlapping instances
using the same output. Use one dedicated runit service running as tiger; do not
modify/restart the Orca Server or install the fixed-DAG Supervisor for monitoring.
Stop the dedicated service before rotating closed log files; there is no automatic
deletion. Monitor disk space for long runs. A separate deployment is task-specific,
not an installed global automation. The current chat need not stay open for the
process to run; actual remote/offline reliability needs its own evidence.
Atomic updates use unique temporary files, file/directory fsync and replace, so a
crash's stale `.new`/temporary file cannot block later writes. Only the current
write's own temporary is cleaned up; historical residue is not automatically deleted.
The report files are each atomic, not one cross-file transaction. Append-only records
may have an interrupted final line after a crash; downstream readers must handle that
and use the per-file `observed_at`, not assume every file reflects the same tick.
The last summary time persists on every tick, including non-summary samples and
unknown/recovery transitions. A clean restart reuses that clock; it does not emit
an extra summary before 300 seconds. A long gap emits one current summary without
backfilling missed intervals. A crash between the summary append and state commit
can still duplicate a summary; cross-file exactly-once crash recovery is not promised.

## Evidence, not heartbeat

- The shell being present says nothing about the Agent still running. Positive
  exit is reported only from a direct-parent process receipt matching the exact
  driver-selected launch-plan hash/start/session/phase, with unchanged native
  Run/generation/terminal/incarnation/workspace, ordered nonfuture timestamps,
  and no observed newer progress conflict; this is not cryptographic attestation.
- Native task/Worker transitions and Coordinator-reported milestone changes are
  tracked separately. Report timestamps/heartbeat alone do not reset inactivity.
- The Coordinator progress contract is schema1, exact `run_id`/`consumer_generation`/`coordinator_handle`,
  timezone-aware `updated_at`, `phase`, stable `milestone_id`, optional
  `expected_wait_until`/`wait_reason`, optional `blocker`, and `training` fields
  active_count/observed_at/scope/evidence/step. Reports are claims, not independent
  scientific acceptance. Free text and arbitrary evidence contents are not copied.
- After15minutes without development progress, report a diagnostic alert, not death.
  Explicit expected waits suppress inactivity until the deadline, not stale-report
  warnings. Training/evaluation use a separate phase diagnostic; this watcher has
  no independent job/step adapter and cannot verify training progress itself.
- A training count is shown only with a Coordinator-reported audit timestamp within
  5minutes, scope and evidence reference; otherwise null. It is NOT sufficient
  submission authorization or an independent single-trial interlock.
- Owned unknown resources conservatively reserve slots. Absent completed projections
  are not invented running Agents. Peak is only this watcher's observed peak;
  whole-Run cumulative attempts are separate. Usage/billing is not measured here;
  use the separate ledger with truthful partial/unknown coverage.
  Native `live` resources reserve a slot even after dispatch settlement until the
  resource is actually released; `live` is not mislabeled as unknown.

The watcher stores selected native identity/state fields, not terminal previews,
task specs/results, raw stdout, request bodies or secrets. This is data minimization,
not a general-purpose content sanitizer or security boundary against the same user.

## Coordinator progress identity contract

Reports must use these exact canonical field names (monitor config names
are different). Example, with illustrative identities and timestamp to replace:

```json
{
  "schema_version": 1,
  "run_id": "run_db5d14ca5304",
  "consumer_generation": 6,
  "coordinator_handle": "term_d69cb866-5814-47dc-851f-8499d46b1cb0",
  "updated_at": "2026-10-19T10:00:00+00:00",
  "phase": "development",
  "milestone_id": "wave-1-review-complete",
  "training": {}
}
```

All three canonical identity fields are required. The aliases `run` / `generation` /
`terminal` are rejected even when supplied alongside matching canonical fields.
Schema version and generation must be JSON integers, not booleans, floats or strings;
Run/terminal must be strings. Generation/owner are compared with the native Run;
changes from the pinned launch still produce their existing alerts, never a rebind.
The watcher never edits the producer's progress file. Whole-file report rewrites and
timestamp-only changes do not count as milestone progress. Empty `training` means
unknown, not zero active trials; a valid report is not scientific acceptance.

## Validation

### Optional authority-check diagnostics

For new RSI handoffs, follow the verified fin_verl worktree's `rsi/authority.md`.
The producer runs `check-authorized-progress` and copies the returned `authority_check`
object (from success stdout or failure stderr) into its identity-bound progress report.
Also set top-level `checkpoint_sha256` to that checkpoint's canonical JSON digest.
Do not handwrite a pass or reinterpret `execution_authorized=false` as user denial.

Opt in with an operator-verified monitor config field:

```json
{
  "authority_binding": {
    "scope_id": "REVIEWED_SCOPE_ID",
    "authority_sha256": "64_LOWERCASE_HEX_CHARACTERS",
    "context_sha256": "64_LOWERCASE_HEX_CHARACTERS"
  }
}
```

These are independently fixed pins, not values accepted from the current report.
Config changes require the existing explicit binding procedure and retained history;
this documentation/code update does not change a running service or config.
The receipt must match the configured Run/scope/pins and the reported checkpoint,
and its `checked_at` must be within five minutes of observation and report update
(at most 60 seconds of future clock skew). A failed read before checkpoint parsing
may report a null checkpoint hash, but can never become a successful check.

The observer emits `reported_authority_conflict` for handoff/user-authority/technical/platform
classification contradictions, `reported_authority_check_failed` for other checker
failures, and `authority_check_unavailable` for missing, stale, malformed or mismatched
receipts. Existing blocked/stale/lifecycle alerts are unaffected. No configuration
means `not_configured`, not passed or denied.

These diagnostics are **producer-reported, not independently verified**: the watcher
does not execute repository code, follow arbitrary source paths, authenticate a user,
check live training admission, or infer authority from a boolean. A copied
or forged producer receipt is not an approval. Free-form errors are not exported.
No retry, resume, dispatch, submission, or chat push is added.

### Offline tests

From `swarm/`:

```bash
python3 -B -m unittest discover -s tests -p test_progress_watch.py -v
python3 -B -m unittest discover -s tests -p test_coordinator_state.py -v
```

Tests use synthetic native responses and do not prove live service reliability.
Deployment acceptance must include live snapshots, exact identities, monitoring-only
commands, service ownership, log freshness and explicitly labeled coverage gaps.

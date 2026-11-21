import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../shared/execution-host'
import {
  isAgentJournalTurnOutcome,
  type AgentJournalTurnOutcome
} from '../../shared/agent-turn-outcome'
import {
  TASK_RECORDS_MAX_RUNS_PER_BINDING,
  TASK_RECORDS_MAX_SESSIONS_PER_BINDING,
  taskRecordRunClaimKey,
  type TaskRecordGap,
  type TaskRecordRun,
  type TaskRecordSession,
  type TaskRecordsState,
  type TaskUsageSettlement,
  type TaskWorkspaceBinding
} from '../../shared/task-records-types'
import {
  mergeTaskRecordBindingSessions,
  mergeTaskRecordRuns,
  setTaskRecordBindingSettlement
} from '../../shared/task-records-updates'
import type { TaskRecordsSessionIndexLookup } from './task-records-session-index-lookup'
import type { TranscriptCheckProbe } from './task-records-transcript-check'
import type {
  TaskRecordsArchiveSnapshot,
  TaskRecordsUsageSource
} from './task-records-worktree-usage'

/**
 * The archive snapshot (issue #53 A): the one write that freezes "what ran in this
 * workspace" at the moment it becomes irreversible — an archive is not a delete,
 * so nothing is torn down and the live sources are still readable right then.
 *
 * Why this lives outside the metadata hook: the hook is synchronous and the only
 * degraded source (`listAiVaultSessions`) is asynchronous, so the snapshot is two
 * writes around that seam.
 *
 * 1. **Synchronous**, in the same state transition as the `isArchived` flag: the
 *    sessions the hook server still attributes to this worktree, one run per
 *    claim, and the usage settlement computed exactly as the removal path does. An
 *    empty attribution is *still not an empty authoritative list*: it stores
 *    `runs: []` plus an explicit gap, because zero rows with no gap renders as
 *    "never ran" (T2).
 * 2. **Asynchronous enrichment**, fired after the transition and never awaited by
 *    the metadata write: one follow-up task with two independent jobs. The reverse
 *    lookup by absolute path + time window runs only when this write attributed
 *    nothing, and its unique hit completes the snapshot while its 0 / 2+ / failure
 *    outcomes write a gap instead of a guess (T2/T3). The transcript check runs
 *    whenever a stored row of the binding names a path without carrying a check —
 *    the pane-attributed rows, which the synchronous write can copy a check onto
 *    but has no way to take one of — so a frozen path also states whether this
 *    host can still see the file (A3). Both writes go through the seat-A
 *    transitions (`mergeTaskRecordBindingSessions` / `mergeTaskRecordRuns`), so the
 *    cap and idempotency rules are the shared ones instead of a second copy.
 *
 * Nothing here throws into a metadata write: a refusal or a failure is reported and
 * the stored state is left alone.
 */

/** The async inputs of step 2. Bound at main startup (`main-process-observers`),
 *  because both reach the filesystem / the scanner; a test supplies fixtures. */
export type TaskRecordsArchiveSnapshotDeps = {
  sessionIndexLookup: TaskRecordsSessionIndexLookup
  transcriptCheck: TranscriptCheckProbe
}

/** What can happen to the degraded source after the synchronous write. */
export type ArchiveSnapshotLookupPlan =
  /** A lookup can follow up, because nothing was attributed; the synchronous gap
   *  names it as the remaining source rather than pretending the absence is final
   *  (it states nothing about the lookup's progress — see
   *  `UNATTRIBUTABLE_DETAIL`). */
  | 'pending'
  /** No lookup is bound, or no scheduling to persist its result. */
  | 'no_lookup'
  /** The workspace belongs to another host: its transcripts are not on this
   *  host's disk, so no local scan can answer for it. */
  | 'other_host'

export type ArchiveSnapshotRequest = {
  state: TaskRecordsState
  taskId: string
  /** The binding as the metadata write just stored it (archived). */
  binding: TaskWorkspaceBinding
  /** Absent before startup binds it; then nothing can be observed at all. */
  usageSource: TaskRecordsUsageSource | null
  lookup: ArchiveSnapshotLookupPlan
  /** The transition instant: the snapshot's `recordedAt` and the settlement's
   *  `collectedAt` are both this one moment. */
  now: number
}

/** What the synchronous write leaves for the asynchronous half, decided there
 *  because only it knows whether either job has anything to do.
 *
 *  One task, two independent guards: `lookup` is set only when the synchronous
 *  write attributed nothing (a pane-attributed archive already holds rows a scan
 *  could only guess at), and `check` only when a stored row of the binding names a
 *  transcript without carrying a check of it. Both may be false in one follow-up
 *  (a pane-attributed row plus nothing to look up) and both may be true (an
 *  attributed-nothing archive that also stores an unchecked path from an earlier
 *  observation). */
export type ArchiveSnapshotFollowUp = {
  taskId: string
  worktreeId: string
  hostId: ExecutionHostId
  /** The binding's absolute checkout path, which the record keeps after the
   *  checkout is gone. */
  path: string
  /** The transition instant, so the enrichment's rows carry the same provenance as
   *  the synchronous write: they are the same observation, completed. */
  recordedAt: number
  /** Lower edge of the window: the binding's own `boundAt`. That value is the
   *  record's *claim* about when this workspace became the task's workspace, not a
   *  fact about when agents could have run — a `reconciled` bind can postdate the
   *  run — so a session older than it is simply not a candidate, and an absence
   *  below the edge is a bounded-scan absence, not evidence that nothing ran. */
  windowStart: number
  /** Job A: the reverse lookup by path + window. */
  lookup: boolean
  /** Job B: one `stat` per stored row that names a transcript and carries no
   *  check. */
  check: boolean
}

export type ArchiveSnapshotOutcome =
  /** No source is bound yet (startup order): nothing was observed, so nothing is
   *  claimed — writing `unattributable` here would blame the workspace for a gap
   *  in this process's wiring. */
  | { kind: 'skipped'; reason: 'no_source' }
  /** Refused as a whole; no partial write (A4). `missing_binding` is the state
   *  answering "nothing written" (`skipped` on the transition result): the record
   *  or the binding this snapshot addressed is not there any more, so there is no
   *  state to store and nothing to call a completed snapshot. */
  | { kind: 'refused'; reason: 'limit' | 'source_failed' | 'conflict' | 'missing_binding' }
  | { kind: 'applied'; state: TaskRecordsState; followUp: ArchiveSnapshotFollowUp | null }

/** The transition this module exists for: the stored binding was not archived and
 *  the incoming row is. Three cases, decided once here so every caller agrees:
 *
 * - **No prior binding** (`before === undefined`): the metadata write binds the
 *  workspace and this snapshot belongs to that same write — "bind, then snapshot"
 *  in one state transition.
 * - **Re-archive after an unarchive**: the transition happens again, so a snapshot
 *  is taken again — as a new *observation*, not a new row. Identity is the claim
 *  (`provider|key:id`), so the second snapshot upserts into the same rows, and
 *  provenance is first-writer-wins, so `source`/`recordedAt` keep saying "frozen at
 *  the first archive". That is deliberate: a second archive of the same workspace
 *  does not make the first frozen fact less true, and the observation window moves
 *  (`lastSeenAt`) without duplicating anything.
 * - **Archive of an already-archived row**: no state change happened, so there is
 *  no irreversible moment to freeze and no snapshot. */
export function isArchiveTransition(
  before: Pick<TaskWorkspaceBinding, 'isArchived'> | undefined,
  after: Pick<TaskWorkspaceBinding, 'isArchived'>
): boolean {
  return before?.isArchived !== true && after.isArchived
}

export function applyArchiveSnapshot(request: ArchiveSnapshotRequest): ArchiveSnapshotOutcome {
  const { state, taskId, binding, usageSource, now } = request
  if (!usageSource) {
    return { kind: 'skipped', reason: 'no_source' }
  }
  let sessions: readonly TaskRecordSession[]
  let settlement: TaskUsageSettlement
  let outcomes: ReadonlyMap<string, AgentJournalTurnOutcome> | undefined
  try {
    // The removal path's own computation: same four stores, same host rule
    // (`remote_usage_unavailable` off-local), same session collector. An archive
    // tears nothing down, so there is no capture step to consume. Typed as the
    // archive snapshot so the pre-#53 fallback (sessions only, no verdicts) is the
    // ordinary "this source states no outcome" case rather than a special one.
    const snapshot: TaskRecordsArchiveSnapshot = usageSource.snapshotForArchive
      ? usageSource.snapshotForArchive({
          worktreeId: binding.worktreeId,
          hostId: binding.hostId,
          now
        })
      : usageSource.snapshotForRemoval({
          worktreeId: binding.worktreeId,
          hostId: binding.hostId,
          now
        })
    sessions = snapshot.sessions
    settlement = snapshot.settlement
    outcomes = snapshot.outcomes
  } catch (error) {
    console.error('[task-records] archive snapshot source failed', binding.worktreeId, error)
    return { kind: 'refused', reason: 'source_failed' }
  }
  const rows: TaskRecordSession[] = sessions.map((session) => ({
    ...session,
    source: 'archive-snapshot',
    recordedAt: now
  }))
  // The verdict comes from the hook status row that named this session's pane, so it
  // is looked up under the same claim the run row is keyed by; a claim the source
  // said nothing about stays unknown (never success).
  const runs = rows.map((session) =>
    runRowForSession(session, now, outcomes?.get(taskRecordRunClaimKey(session)))
  )
  // Over either cap the whole snapshot is refused, never truncated (A4): a dropped
  // run row would be read as "this workspace did not run that agent". Sessions keep
  // issue #36's count-and-drop only when they meet an *existing* list (the merge
  // reports `dropped`); a snapshot that is itself over the cap is a refusal.
  if (
    rows.length > TASK_RECORDS_MAX_SESSIONS_PER_BINDING ||
    runs.length > TASK_RECORDS_MAX_RUNS_PER_BINDING
  ) {
    console.error(
      `[task-records] archive snapshot refused for ${binding.worktreeId}: over the per-binding cap`
    )
    return { kind: 'refused', reason: 'limit' }
  }
  let current = state
  if (rows.length > 0) {
    const withSessions = mergeTaskRecordBindingSessions(current, {
      taskId,
      worktreeId: binding.worktreeId,
      hostId: binding.hostId,
      sessions: rows,
      now
    })
    if (!withSessions.ok) {
      return refuse(binding.worktreeId, 'record sessions', withSessions.reason)
    }
    if (withSessions.skipped !== undefined) {
      return refuseMissing(binding.worktreeId, 'record sessions')
    }
    current = withSessions.state
    if (withSessions.dropped) {
      console.error(
        `[task-records] ${withSessions.dropped} sessions over the per-binding cap for ${binding.worktreeId}`
      )
    }
  }
  // Always written, even with no rows: `runs: []` plus a gap is the honest "the
  // writer looked and could not attribute", while an absent `runs` would say "no
  // build recorded runs here" and lose the fact that this one tried.
  const withRuns = mergeTaskRecordRuns(current, {
    taskId,
    worktreeId: binding.worktreeId,
    hostId: binding.hostId,
    runs,
    gaps: rows.length > 0 ? [] : [unattributableGap(now, request.lookup)],
    now
  })
  if (!withRuns.ok) {
    return refuse(binding.worktreeId, 'record runs', withRuns.reason)
  }
  if (withRuns.skipped !== undefined) {
    return refuseMissing(binding.worktreeId, 'record runs')
  }
  current = withRuns.state
  const withSettlement = setTaskRecordBindingSettlement(current, {
    taskId,
    worktreeId: binding.worktreeId,
    hostId: binding.hostId,
    settlement
  })
  if (!withSettlement.ok) {
    return refuse(binding.worktreeId, 'record settlement', withSettlement.reason)
  }
  if (withSettlement.skipped !== undefined) {
    // The snapshot itself is applied: sessions, runs and gap above were written, and
    // only this figure was kept as stored (`settlement_downgrade` — an `unavailable`
    // snapshot never replaces a measured one). Reported rather than swallowed, so no
    // caller reads "settled" as "the figure I just measured is on the record"; the
    // state is still handed back, because dropping the rows to announce one skipped
    // figure would lose the snapshot this write exists for.
    console.error(
      `[task-records] archive snapshot wrote no settlement for ${binding.worktreeId}: ${withSettlement.skipped}`
    )
  }
  current = withSettlement.state
  // The follow-up is decided against the state this write just produced: a
  // `pending` lookup plan additionally means the async inputs and a save target
  // are bound, so `no_lookup` is exactly "this build cannot follow up at all".
  const needsLookup = rows.length === 0 && request.lookup === 'pending'
  const needsCheck =
    request.lookup !== 'no_lookup' &&
    hasUncheckedTranscript(current, {
      taskId,
      worktreeId: binding.worktreeId,
      hostId: binding.hostId
    })
  return {
    kind: 'applied',
    state: current,
    followUp:
      needsLookup || needsCheck
        ? {
            taskId,
            worktreeId: binding.worktreeId,
            hostId: binding.hostId,
            path: binding.path,
            recordedAt: now,
            windowStart: binding.boundAt,
            lookup: needsLookup,
            check: needsCheck
          }
        : null
  }
}

/** Whether a row this binding stores names a transcript the record has no check
 *  of. `runs` is the archived reader's row kind and `sessions` the removed one's,
 *  so both are scanned: a check written for one and not the other would print two
 *  verdicts for one file. Bounded by the per-binding caps (a handful). */
function hasUncheckedTranscript(
  state: TaskRecordsState,
  args: { taskId: string; worktreeId: string; hostId: ExecutionHostId }
): boolean {
  const binding = state.byId[args.taskId]?.bindings.find(
    (entry) => entry.worktreeId === args.worktreeId && entry.hostId === args.hostId
  )
  if (!binding) {
    return false
  }
  const unchecked = (row: Pick<TaskRecordSession, 'transcriptPath' | 'transcriptCheck'>): boolean =>
    row.transcriptPath !== undefined && row.transcriptCheck === undefined
  return binding.sessions.some(unchecked) || (binding.runs ?? []).some(unchecked)
}

/** One run row per session claim: the same facts under the same claim identity, so
 *  a reader can pair the two row kinds without a second opinion about who ran.
 *
 *  `outcome` is passed in, never derived here: only the hook status row for this
 *  session's pane states a turn verdict, and the caller looks it up by claim. The
 *  index/backfill path reads a transcript, which records what was said and when but
 *  no verdict, so it passes nothing and the field stays absent. Absent means
 *  unknown — a plain Stop is not a success, and this row refuses to make it one. */
export function runRowForSession(
  session: TaskRecordSession,
  recordedAt: number,
  outcome?: AgentJournalTurnOutcome
): TaskRecordRun {
  const providerSession = {
    ...(session.provider ? { provider: session.provider } : {}),
    key: session.key,
    id: session.id
  }
  return {
    key: taskRecordRunClaimKey(providerSession),
    providerSession,
    ...(session.title === undefined ? {} : { title: session.title }),
    ...(session.agentType === undefined ? {} : { agentType: session.agentType }),
    ...(session.startedAt === undefined ? {} : { startedAt: session.startedAt }),
    ...(session.endedAt === undefined ? {} : { endedAt: session.endedAt }),
    ...(session.messageCount === undefined ? {} : { messageCount: session.messageCount }),
    // A value outside the shared vocabulary is not a verdict this build can store:
    // dropping it keeps "unknown" honest instead of persisting a word nobody
    // defined (the hook payload crosses a JSON boundary before it gets here).
    ...(outcome !== undefined && isAgentJournalTurnOutcome(outcome) ? { outcome } : {}),
    ...(session.transcriptPath === undefined ? {} : { transcriptPath: session.transcriptPath }),
    ...(session.transcriptCheck === undefined ? {} : { transcriptCheck: session.transcriptCheck }),
    // The resume command is a measured fact like the rest, so it travels with the
    // claim. The hook path has none (it observes a pane, not a session index row),
    // so absent stays absent instead of this build composing a command.
    ...(session.resumeCommand === undefined ? {} : { resumeCommand: session.resumeCommand }),
    // Provenance is always known for a row this writer produces; a session row that
    // does not state one is the index/backfill path's, which stamps its own source.
    source: session.source ?? 'archive-snapshot',
    recordedAt: session.recordedAt ?? recordedAt,
    firstSeenAt: session.firstSeenAt,
    lastSeenAt: session.lastSeenAt
  }
}

/** The gap that makes an unattributed archive distinguishable from "never ran".
 *
 *  Every text below states only what the **synchronous** write observed at the
 *  archive moment; none of them reports the progress of a lookup that has not
 *  answered. That is deliberate: the merge unions gaps by `kind|detail`
 *  (`task-records-runs-merge.ts`), so a row reading "the lookup started" could
 *  never be retired by the outcome it describes — a resolved lookup writes no gap
 *  at all, and each failed / 0-hit / ambiguous answer carries its own text. The
 *  `pending` sentence therefore names the remaining source and stops there; the
 *  lookup's answer arrives as a second, separately identified row, so a reader
 *  never sees a stale "started" claim standing in for the truth. */
export function unattributableGap(
  observedAt: number,
  plan: ArchiveSnapshotLookupPlan
): TaskRecordGap {
  return { kind: 'session_unattributable', observedAt, detail: UNATTRIBUTABLE_DETAIL[plan] }
}

const UNATTRIBUTABLE_DETAIL: Record<ArchiveSnapshotLookupPlan, string> = {
  pending:
    'no pane attribution from the hook server at the archive moment; the session index lookup by path is the remaining source',
  no_lookup: 'no pane attribution and no session index lookup is available in this build',
  other_host:
    'no pane attribution; the workspace belongs to another host, whose transcripts this host cannot look up'
}

/** The lookup plan the metadata write passes in: only a local owner's transcripts
 *  are on this host's disk, and only a bound lookup can be followed up. */
export function archiveLookupPlan(args: {
  hostId: ExecutionHostId
  hasLookup: boolean
  hasScheduling: boolean
}): ArchiveSnapshotLookupPlan {
  if (!args.hasLookup || !args.hasScheduling) {
    return 'no_lookup'
  }
  return args.hostId === LOCAL_EXECUTION_HOST_ID ? 'pending' : 'other_host'
}

/** Only what this module reads: a structural subset of the Store's runtime state,
 *  so a test can pass a plain object. */
export type ArchiveSnapshotRuntime = { state: { taskRecords?: TaskRecordsState } }

function refuse(
  worktreeId: string,
  action: string,
  reason: 'limit' | 'external_index_conflict'
): ArchiveSnapshotOutcome {
  console.error(`[task-records] archive snapshot refused to ${action} for ${worktreeId}: ${reason}`)
  // The three row writers cannot fail on the external index (they never create a
  // record); the arm exists because their result type carries it, and reporting
  // `limit` for it would blame the cap for something else.
  return { kind: 'refused', reason: reason === 'limit' ? 'limit' : 'conflict' }
}

/** A `skipped` transition result is a success arm that wrote nothing: the record or
 *  the `(worktreeId, hostId)` binding this snapshot addressed is gone from `state`.
 *  The snapshot cannot be reported as applied on top of a write that happened
 *  nowhere, so it is a refusal with its own reason and no state to store. */
function refuseMissing(worktreeId: string, action: string): ArchiveSnapshotOutcome {
  console.error(
    `[task-records] archive snapshot wrote nothing for ${worktreeId} when it tried to ${action}: missing_binding`
  )
  return { kind: 'refused', reason: 'missing_binding' }
}

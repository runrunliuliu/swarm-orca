import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../shared/execution-host'
import {
  HistoryBackfillCommandError,
  type HistoryBackfillBinding
} from '../../shared/history-backfill-command'
import {
  isAiVaultScanUnavailableError,
  type AiVaultScanUnavailableError
} from '../../shared/ai-vault-scan-unavailable'
import {
  resolveTaskRecordByNumber as resolveBackfillTaskRecord,
  resolveTaskRecordRepoId as resolveBackfillRepoId,
  type RegisteredRepo
} from '../../shared/task-records-lookup'
import type {
  TaskRecord,
  TaskRecordGap,
  TaskRecordSession,
  TaskRecordsState,
  TaskWorkspaceBinding
} from '../../shared/task-records-types'
import {
  mergeTaskRecordBindingSessions,
  mergeTaskRecordRuns
} from '../../shared/task-records-updates'
import { runRowForSession, unattributableGap } from './task-records-archive-snapshot'
import {
  boundedScanNote,
  selectSessionIndexCandidate,
  sessionIndexGap,
  sessionRowFromIndexSession,
  type SessionIndexSelection,
  type TaskRecordsSessionIndexLookup
} from './task-records-session-index-lookup'
import type { TranscriptCheckProbe } from './task-records-transcript-check'

/**
 * The backfill (issue #53 B): the explicit, repeatable command that reconstructs a
 * run for an archived workspace whose record has no sessions.
 *
 * Three rules shape it, and each one is a refusal to invent a fact:
 *
 * - **Same resolver as the archive snapshot.** The candidate set, the exact-cwd
 *   comparison, the time window, the unique-hit rule, the row builder and the gap
 *   vocabulary are the ones `task-records-session-index-lookup.ts` already owns.
 *   A second resolver with slightly different rules would make the same evidence
 *   produce two answers depending on which writer ran first.
 * - **The same writer as the snapshot.** Rows go through the seat-A transitions
 *   (`mergeTaskRecordBindingSessions` / `mergeTaskRecordRuns`), so identity is the
 *   claim `provider|key:id`, the window is the union (`firstSeenAt` min /
 *   `lastSeenAt` max), provenance is first-writer-wins and the caps refuse instead
 *   of truncating. A backfill therefore cannot relabel an archive snapshot row, and
 *   a second identical run writes nothing at all (A6).
 * - **Offline only, one fenced write.** The preflight process opens the profile
 *   state database itself, reads `taskRecords` and `repos` with the revision,
 *   applies the transitions, and writes the domain once with that revision. A
 *   running Orca fences its own writes on an in-memory revision, so a write
 *   underneath it would make the app's next save fail; the launch therefore refuses
 *   while a runtime is reachable and holds the profile-state maintenance lock, and
 *   this module never retries a revision conflict.
 *
 * Why this lives behind a preflight rather than in the CLI process: the only
 * degraded source is the AI-Vault session index, and the CLI build project
 * (`config/tsconfig.cli.json`) deliberately does not compile that graph. The
 * preflight runs in the Orca executable before Electron starts, which is where the
 * scanner already is (`profile-state-recovery-preflight.ts` is the precedent).
 *
 * What it does not do: no RPC, no automatic run, no live write, no usage figure.
 * The four usage stores belong to the running app and are not readable offline, so
 * the settlement is left untouched — absent is "not measured", which the read side
 * states as unavailable with its own reason, never `0 tokens`.
 */

export { resolveBackfillRepoId, resolveBackfillTaskRecord }
export type { RegisteredRepo }

export type TaskRecordBackfillPlan = {
  state: TaskRecordsState
  changed: boolean
  bindings: HistoryBackfillBinding[]
  /** Bindings that met the issue's condition (`isArchived` + empty `sessions`). */
  examined: number
  resolved: number
  rowsWritten: { sessions: number; runs: number }
}

/** The issue's exact selection: an archived workspace whose record has no sessions.
 *  A binding that already has sessions is not re-derived (the snapshot or an earlier
 *  backfill answered it), and a live workspace keeps its live evidence. */
function needsBackfill(binding: TaskWorkspaceBinding): boolean {
  return binding.isArchived && binding.sessions.length === 0
}

/**
 * Resolve every selected binding and apply the transitions in memory. Pure apart
 * from the two injected observations, so a test can drive the exact rules without a
 * database in the way.
 *
 * The window is `boundAt → now`, not `boundAt → archive instant` as the snapshot
 * uses: the run is being reconstructed later than the moment it was archived, so a
 * session whose transcript was last written after the archive is still this
 * workspace's session. `boundAt` is the record's *claim* about when this workspace
 * became the task's workspace, not a fact about when agents could have run — a
 * `reconciled` bind can postdate the run — so the window cannot prove that nothing
 * ran before its lower edge: a session below it is simply not a candidate, and that
 * absence is a bounded-scan absence, never evidence of no agent run. It likewise
 * cannot separate two sessions of the same cwd inside the window — that is the
 * ambiguity gap, never a pick.
 */
export async function planTaskRecordBackfill(args: {
  state: TaskRecordsState
  record: TaskRecord
  now: number
  sessionIndexLookup: TaskRecordsSessionIndexLookup
  transcriptCheck: TranscriptCheckProbe
}): Promise<TaskRecordBackfillPlan> {
  let state = args.state
  const bindings: HistoryBackfillBinding[] = []
  const rowsWritten = { sessions: 0, runs: 0 }
  let examined = 0
  let resolved = 0
  for (const binding of args.record.bindings) {
    if (!needsBackfill(binding)) {
      continue
    }
    examined += 1
    const applied = await applyBackfillToBinding({ ...args, state, binding })
    state = applied.state
    bindings.push(applied.report)
    rowsWritten.sessions += applied.report.sessionRows
    rowsWritten.runs += applied.report.runRows
    if (applied.report.outcome === 'resolved') {
      resolved += 1
    }
  }
  return { state, changed: state !== args.state, bindings, examined, resolved, rowsWritten }
}

async function applyBackfillToBinding(args: {
  state: TaskRecordsState
  record: TaskRecord
  binding: TaskWorkspaceBinding
  now: number
  sessionIndexLookup: TaskRecordsSessionIndexLookup
  transcriptCheck: TranscriptCheckProbe
}): Promise<{ state: TaskRecordsState; report: HistoryBackfillBinding }> {
  const { binding, record, now } = args
  const observation = await observeBinding(args)
  const runs = observation.sessions.map((session) =>
    // The index hit's own command, carried onto the run as the same claim: a reader
    // offering `[resume]` must not have to re-scan the index to find it.
    withRowResumeCommand(runRowForSession(session, now), session.resumeCommand)
  )
  // Both row kinds are applied to a draft first: a refusal of one half must not
  // leave a session without its run (or the reverse) in the stored state.
  let draft = args.state
  let sessionRows = 0
  if (observation.sessions.length > 0) {
    const withSessions = mergeTaskRecordBindingSessions(draft, {
      taskId: record.taskId,
      worktreeId: binding.worktreeId,
      hostId: binding.hostId,
      sessions: observation.sessions,
      now
    })
    if (!withSessions.ok) {
      return { state: args.state, report: refusedReport(binding, withSessions.reason) }
    }
    if (withSessions.skipped !== undefined) {
      return { state: args.state, report: refusedReport(binding, withSessions.skipped) }
    }
    draft = withSessions.state
    sessionRows = withSessions.changed ? observation.sessions.length : 0
  }
  const withRuns = mergeTaskRecordRuns(draft, {
    taskId: record.taskId,
    worktreeId: binding.worktreeId,
    hostId: binding.hostId,
    runs,
    gaps: observation.gaps,
    now
  })
  if (!withRuns.ok) {
    return { state: args.state, report: refusedReport(binding, withRuns.reason) }
  }
  if (withRuns.skipped !== undefined) {
    return { state: args.state, report: refusedReport(binding, withRuns.skipped) }
  }
  return {
    state: withRuns.state,
    report: {
      worktreeId: binding.worktreeId,
      hostId: binding.hostId,
      path: binding.path,
      outcome: observation.outcome,
      sessionRows,
      runRows: withRuns.changed ? runs.length : 0,
      ...(observation.candidateCount === undefined
        ? {}
        : { candidateCount: observation.candidateCount }),
      ...(observation.detail === undefined ? {} : { detail: observation.detail })
    }
  }
}

function refusedReport(
  binding: TaskWorkspaceBinding,
  reason: NonNullable<HistoryBackfillBinding['refusedReason']>
): HistoryBackfillBinding {
  console.error(`[task-records] backfill refused for ${binding.worktreeId}: ${reason}`)
  return {
    worktreeId: binding.worktreeId,
    hostId: binding.hostId,
    path: binding.path,
    outcome: 'refused',
    sessionRows: 0,
    runRows: 0,
    refusedReason: reason
  }
}

type BindingObservation = {
  sessions: readonly TaskRecordSession[]
  gaps: readonly TaskRecordGap[]
  outcome: HistoryBackfillBinding['outcome']
  candidateCount?: number
  detail?: string
}

async function observeBinding(args: {
  binding: TaskWorkspaceBinding
  now: number
  sessionIndexLookup: TaskRecordsSessionIndexLookup
  transcriptCheck: TranscriptCheckProbe
}): Promise<BindingObservation> {
  const { binding, now } = args
  // A workspace on another host keeps its transcripts there; a local scan of that
  // path would either miss or hit an unrelated local file (same rule as the
  // snapshot's `other_host` arm, whose gap text this reuses).
  if (binding.hostId !== LOCAL_EXECUTION_HOST_ID) {
    const gap = unattributableGap(now, 'other_host')
    return { sessions: [], gaps: [gap], outcome: 'other_host', detail: gap.detail }
  }
  let selection: SessionIndexSelection | { kind: 'failed' }
  try {
    const found = await args.sessionIndexLookup({ path: binding.path })
    selection = selectSessionIndexCandidate(found, {
      path: binding.path,
      windowStart: binding.boundAt,
      windowEnd: now
    })
  } catch (error) {
    // A scan this host cannot run is not evidence about this workspace, and it is not
    // transient: every selected binding would get the same unproven gap while the run
    // reported success over a scan that never happened. Refuse instead, before any
    // write (the plan is in memory until every binding is resolved).
    if (isAiVaultScanUnavailableError(error)) {
      throw scanUnavailableRefusal(error)
    }
    // A failure to look is not a proof of absence, and it must not abort the other
    // bindings of the same task.
    console.error('[task-records] backfill session index lookup failed', binding.worktreeId, error)
    selection = { kind: 'failed' }
  }
  if (selection.kind === 'unique') {
    const row = withRowResumeCommand(
      sessionRowFromIndexSession(selection.session, { source: 'backfill', recordedAt: now }),
      selection.session.resumeCommand
    )
    return {
      sessions: [await withTranscriptCheck(args.transcriptCheck, row, binding.hostId)],
      gaps: [],
      outcome: 'resolved'
    }
  }
  const gap = selection.kind === 'failed' ? lookupFailedGap(now) : sessionIndexGap(selection, now)
  return {
    sessions: [],
    gaps: [gap],
    outcome: selection.kind === 'ambiguous' ? 'ambiguous_match' : 'session_unattributable',
    ...(selection.kind === 'ambiguous' ? { candidateCount: selection.candidateCount } : {}),
    ...(gap.detail === undefined ? {} : { detail: gap.detail })
  }
}

/**
 * The index's own resume command, which the issue lists among the resume facts.
 * It is an absence-tolerant copy, not a second rule: the shared row builders own
 * every other field, so this fills only the field they left empty (and never
 * overrides a value they did state), and a source with no command stores none rather
 * than a synthesized one.
 */
function withRowResumeCommand<T extends { resumeCommand?: string }>(
  row: T,
  resumeCommand: string | undefined
): T {
  const command = resumeCommand?.trim()
  if (row.resumeCommand !== undefined || command === undefined || command.length === 0) {
    return row
  }
  return { ...row, resumeCommand: command }
}

/** The one case with no selection to describe: the scan itself did not answer. */
function lookupFailedGap(observedAt: number): TaskRecordGap {
  return {
    kind: 'session_unattributable',
    observedAt,
    detail: `the session index lookup failed${boundedScanNote()}`
  }
}

/**
 * The refusal for a scan the host cannot perform. It reuses the command's existing
 * `runtime_error` vocabulary rather than minting a wire code: the response schema is a
 * three-process contract (`history-backfill-command.ts`) and a new enum value would
 * change it for one condition. The sentence carries the specificity the code cannot —
 * which entry is missing, and that this run wrote nothing.
 */
function scanUnavailableRefusal(error: AiVaultScanUnavailableError): HistoryBackfillCommandError {
  return new HistoryBackfillCommandError(
    'runtime_error',
    `Nothing was written: this host cannot scan the agent session index (${error.message}). A backfill must not record "no session" from a scan that never ran. Install a build that ships the AI Vault scan service, or run the command on the host where the Orca app is installed, then retry.`
  )
}

/** The check values travel with the path they were taken on. A probe that throws
 *  leaves the row without a check rather than voiding it (the path is still a fact). */
async function withTranscriptCheck(
  probe: TranscriptCheckProbe,
  session: TaskRecordSession,
  hostId: ExecutionHostId
): Promise<TaskRecordSession> {
  if (session.transcriptPath === undefined) {
    return session
  }
  try {
    return { ...session, transcriptCheck: await probe({ path: session.transcriptPath, hostId }) }
  } catch (error) {
    console.error('[task-records] backfill transcript check failed', error)
    return session
  }
}

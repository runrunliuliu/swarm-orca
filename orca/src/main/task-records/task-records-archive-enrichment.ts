import type { ExecutionHostId } from '../../shared/execution-host'
import type {
  TaskRecordGap,
  TaskRecordRun,
  TaskRecordSession,
  TaskRecordsState,
  TaskRecordTranscriptCheck
} from '../../shared/task-records-types'
import {
  mergeTaskRecordBindingSessions,
  mergeTaskRecordRuns,
  type TaskRecordsWriteResult
} from '../../shared/task-records-updates'
import type { WriteSchedulingOperations } from '../persistence/loading-store/write-scheduling'
import { scheduleSave } from '../persistence/loading-store/write-scheduling'
import type { ArchiveSnapshotFollowUp } from './task-records-archive-snapshot'
import type {
  ArchiveSnapshotRuntime,
  TaskRecordsArchiveSnapshotDeps
} from './task-records-archive-snapshot'
import { runRowForSession } from './task-records-archive-snapshot'
import type { SessionIndexSelection } from './task-records-session-index-lookup'
import {
  boundedScanNote,
  selectSessionIndexCandidate,
  sessionIndexGap,
  sessionRowFromIndexSession
} from './task-records-session-index-lookup'
import type { TranscriptCheckProbe } from './task-records-transcript-check'

/**
 * Step 2 of the archive snapshot (issue #53 A): the work that must not run inside
 * the synchronous metadata write. One task, two jobs, each with its own guard:
 *
 * - **The reverse lookup** by absolute path + time window, only when the
 *   synchronous write attributed nothing. A pane-attributed archive already holds
 *   the rows a scan could only guess at, so asking anyway would add an absence
 *   ("no pane attribution …") that is not true.
 * - **The transcript check**: one `stat` of every stored row of this binding that
 *   names a transcript without carrying a check. Those are exactly the
 *   pane-attributed rows — the hook status feed states a path but cannot measure
 *   the file, and the metadata write is synchronous, so the check is a measurement
 *   this process can only take afterwards. A failure leaves the row without a
 *   check (the reader then offers `locate trace`); it never fabricates `missing`.
 *
 * Both jobs write through the seat-A transitions only
 * (`mergeTaskRecordBindingSessions` / `mergeTaskRecordRuns`), so the per-binding cap
 * and the idempotency rules are shared with every other writer instead of being
 * re-implemented here. Those transitions are applied to the state read **after**
 * the last `await` of this function and synchronously, so a `taskRecords` write
 * that lands while the lookup or a transcript `stat` is in flight survives instead
 * of being overwritten by a stale capture.
 *
 * Cost is bounded by construction: one scan at most (job A), one `stat` per
 * distinct path at most (job B, a handful of rows), no per-row retry loop, and no
 * save when neither job changed anything.
 *
 * Split from `task-records-archive-snapshot.ts` to stay inside the `max-lines`
 * budget; the type definitions live there and are imported, so there is still one
 * description of what the snapshot is.
 */
export async function completeArchiveSnapshot(args: {
  followUp: ArchiveSnapshotFollowUp
  runtime: ArchiveSnapshotRuntime
  scheduling: WriteSchedulingOperations | null
  deps: TaskRecordsArchiveSnapshotDeps | null
}): Promise<void> {
  const { followUp, runtime, scheduling, deps } = args
  if (!deps || !scheduling) {
    return
  }
  let found: TaskRecordSession[] = []
  let gaps: TaskRecordGap[] = []
  if (followUp.lookup) {
    let selection: SessionIndexSelection | { kind: 'failed' }
    try {
      const sessions = await deps.sessionIndexLookup({ path: followUp.path })
      selection = selectSessionIndexCandidate(sessions, {
        path: followUp.path,
        windowStart: followUp.windowStart,
        windowEnd: followUp.recordedAt
      })
    } catch (error) {
      // A lookup failure is a failure to look, not a proof of absence, and it must
      // never escape into the metadata write that fired this.
      console.error('[task-records] archive snapshot lookup failed', followUp.worktreeId, error)
      selection = { kind: 'failed' }
    }
    found =
      selection.kind === 'unique'
        ? [
            sessionRowFromIndexSession(selection.session, {
              source: 'archive-snapshot',
              recordedAt: followUp.recordedAt
            })
          ]
        : []
    gaps =
      selection.kind === 'unique'
        ? []
        : [
            selection.kind === 'failed'
              ? lookupFailedGap(followUp.recordedAt)
              : sessionIndexGap(selection, followUp.recordedAt)
          ]
  }
  // The check values travel with the path they were taken on: one observation, one
  // `stat`, shared by every row that names that file (a session and the run derived
  // from it are one file, not two measurements). This read only chooses *what to
  // stat*; every write below is applied to the state read after the last `await`.
  // A path this host cannot see becomes `unverifiable`, never `missing`, and a probe
  // that throws leaves the row without a check rather than void.
  const targets = followUp.check
    ? uncheckedTranscriptPaths(runtime.state.taskRecords, followUp)
    : []
  const checks = await probeTranscriptPaths(
    deps.transcriptCheck,
    [...foundPaths(found), ...targets],
    followUp.hostId
  )
  const checked = found.map((session) => withProbedCheck(session, checks))
  // No verdict on an index path, by construction: a transcript records what was
  // said and when, not the provider's ruling on the turn. `runRowForSession` is
  // called without one, so `outcome` stays absent (unknown) rather than being
  // inferred from the transcript's shape or from the fact that the file exists.
  const runs = checked.map((session) => runRowForSession(session, followUp.recordedAt))
  // The state is read only here, **after the last `await`**, and every merge below
  // then runs in one synchronous block against that one read. Capturing it earlier
  // (the shape this module had first) meant every `taskRecords` write that landed
  // while the lookup or a transcript `stat` was in flight — a second archive, a
  // settlement, a metadata refresh — was overwritten by a state derived from the
  // stale capture and then persisted by the save below. That is silent data loss at
  // a real interleaving, not a theoretical race: the snapshot is a single in-memory
  // object and the metadata path writes it synchronously.
  let current = runtime.state.taskRecords
  if (current === undefined) {
    return
  }
  let changed = false
  if (checked.length > 0) {
    const step = applyStep(
      mergeTaskRecordBindingSessions(current, {
        taskId: followUp.taskId,
        worktreeId: followUp.worktreeId,
        hostId: followUp.hostId,
        sessions: checked,
        now: Date.now()
      }),
      followUp.worktreeId,
      'sessions'
    )
    if (!step.ok) {
      return
    }
    current = step.state
    changed = step.changed
  }
  if (found.length > 0 || gaps.length > 0) {
    const step = applyStep(
      mergeTaskRecordRuns(current, {
        taskId: followUp.taskId,
        worktreeId: followUp.worktreeId,
        hostId: followUp.hostId,
        runs,
        gaps,
        now: Date.now()
      }),
      followUp.worktreeId,
      'runs'
    )
    if (!step.ok) {
      return
    }
    current = step.state
    changed = changed || step.changed
  }
  // Job B against what the binding stores *now*: a row another writer added or
  // replaced while the `stat` was in flight is checked with the value just taken,
  // and a row this pass did not target is never touched.
  const stored = rowsNeedingCheck(current, followUp, checks)
  if (stored.sessions.length > 0) {
    const step = applyStep(
      mergeTaskRecordBindingSessions(current, {
        taskId: followUp.taskId,
        worktreeId: followUp.worktreeId,
        hostId: followUp.hostId,
        sessions: stored.sessions,
        now: Date.now()
      }),
      followUp.worktreeId,
      'sessions'
    )
    if (!step.ok) {
      return
    }
    current = step.state
    changed = changed || step.changed
  }
  if (stored.runs.length > 0) {
    const step = applyStep(
      mergeTaskRecordRuns(current, {
        taskId: followUp.taskId,
        worktreeId: followUp.worktreeId,
        hostId: followUp.hostId,
        runs: stored.runs,
        now: Date.now()
      }),
      followUp.worktreeId,
      'runs'
    )
    if (!step.ok) {
      return
    }
    current = step.state
    changed = changed || step.changed
  }
  if (!changed) {
    // Already holds exactly this observation: no save, so a repeated enrichment
    // cannot manufacture a second write of one fact.
    return
  }
  runtime.state.taskRecords = current
  scheduleSave(scheduling, ['taskRecords'])
}

/** One transition result, or the reason it wrote nothing. A refusal and a `skipped`
 *  both mean "nothing written"; neither may escape into the metadata caller that
 *  fired this task, so both are reported and end the pass. */
function applyStep(
  result: TaskRecordsWriteResult,
  worktreeId: string,
  action: 'sessions' | 'runs'
): { ok: true; state: TaskRecordsState; changed: boolean } | { ok: false } {
  if (!result.ok) {
    refuseEnrichment(worktreeId, action, result.reason)
    return { ok: false }
  }
  if (result.skipped !== undefined) {
    reportNothingWritten(worktreeId, action, result.skipped)
    return { ok: false }
  }
  return { ok: true, state: result.state, changed: result.changed }
}

/** Distinct transcripts the binding stores without a check of them: the targets of
 *  job B. Read before the probes only to choose the work; the check is attached to
 *  the rows the binding stores after the last `await`. */
function uncheckedTranscriptPaths(
  state: TaskRecordsState | undefined,
  followUp: ArchiveSnapshotFollowUp
): string[] {
  const binding = storedBinding(state, followUp)
  if (!binding) {
    return []
  }
  const paths = new Set<string>()
  for (const row of [...binding.sessions, ...(binding.runs ?? [])]) {
    if (row.transcriptPath !== undefined && row.transcriptCheck === undefined) {
      paths.add(row.transcriptPath)
    }
  }
  return [...paths]
}

/** The stored rows this pass can complete: they still name a transcript, they still
 *  carry no check, and one was taken. Rows already holding a check stay out — an
 *  identical merge would be a no-op, and the stored measurement is a fact a second
 *  archive must not spend another `stat` on. */
function rowsNeedingCheck(
  state: TaskRecordsState,
  followUp: ArchiveSnapshotFollowUp,
  checks: ReadonlyMap<string, TaskRecordTranscriptCheck>
): { sessions: TaskRecordSession[]; runs: TaskRecordRun[] } {
  const binding = storedBinding(state, followUp)
  if (!binding) {
    return { sessions: [], runs: [] }
  }
  const completed = <
    T extends { transcriptPath?: string; transcriptCheck?: TaskRecordTranscriptCheck }
  >(
    row: T
  ): T | null => {
    const next = withProbedCheck(row, checks)
    return next === row ? null : next
  }
  const sessions = binding.sessions
    .map(completed)
    .filter((row): row is TaskRecordSession => row !== null)
  const runs = (binding.runs ?? [])
    .map(completed)
    .filter((row): row is TaskRecordRun => row !== null)
  return { sessions, runs }
}

function storedBinding(state: TaskRecordsState | undefined, followUp: ArchiveSnapshotFollowUp) {
  return state?.byId[followUp.taskId]?.bindings.find(
    (entry) => entry.worktreeId === followUp.worktreeId && entry.hostId === followUp.hostId
  )
}

/** One `stat` per distinct path, and no retry. A probe that throws is reported and
 *  leaves that path without a check: the path is still a fact, and an absence of
 *  evidence is not evidence that the file is gone. */
async function probeTranscriptPaths(
  probe: TranscriptCheckProbe,
  paths: readonly string[],
  hostId: ExecutionHostId
): Promise<ReadonlyMap<string, TaskRecordTranscriptCheck>> {
  const byPath = new Map<string, TaskRecordTranscriptCheck>()
  await Promise.all(
    [...new Set(paths)].map(async (path) => {
      try {
        byPath.set(path, await probe({ path, hostId }))
      } catch (error) {
        console.error('[task-records] transcript check failed', error)
      }
    })
  )
  return byPath
}

/** The check a `stat` of this row's path produced, or the row unchanged. Identity
 *  is preserved when there is nothing to attach, so a caller can tell "completed"
 *  from "left alone" without re-validating the row. */
function withProbedCheck<
  T extends { transcriptPath?: string; transcriptCheck?: TaskRecordTranscriptCheck }
>(row: T, checks: ReadonlyMap<string, TaskRecordTranscriptCheck>): T {
  if (row.transcriptPath === undefined || row.transcriptCheck !== undefined) {
    return row
  }
  const check = checks.get(row.transcriptPath)
  return check === undefined ? row : { ...row, transcriptCheck: check }
}

function foundPaths(sessions: readonly TaskRecordSession[]): string[] {
  const paths: string[] = []
  for (const session of sessions) {
    if (session.transcriptPath !== undefined) {
      paths.push(session.transcriptPath)
    }
  }
  return paths
}

/** The one case with no selection to describe: the scan itself did not answer. */
function lookupFailedGap(observedAt: number): TaskRecordGap {
  return {
    kind: 'session_unattributable',
    observedAt,
    detail: `no pane attribution and the session index lookup failed${boundedScanNote()}`
  }
}

function refuseEnrichment(
  worktreeId: string,
  action: string,
  reason: 'limit' | 'external_index_conflict'
): void {
  console.error(
    `[task-records] archive snapshot enrichment refused to write ${action} for ${worktreeId}: ${reason}`
  )
}

/** A `skipped` answer is a write that happened nowhere: the record or the
 *  `(worktreeId, hostId)` binding this observation was told to complete is no
 *  longer in the state (a profile load, a reset, another writer that dropped it).
 *  Saying so is the honest report — the alternative is logging nothing and leaving
 *  a reader to believe the archive was enriched. */
function reportNothingWritten(
  worktreeId: string,
  action: string,
  skipped: 'missing_binding' | 'settlement_downgrade'
): void {
  console.error(
    `[task-records] archive snapshot enrichment wrote nothing for ${worktreeId} (${action}): ${skipped}`
  )
}

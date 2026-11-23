import { existsSync, readFileSync } from 'node:fs'
import { normalizeTaskRecords } from '../../shared/task-records-normalize'
import {
  HistoryBackfillCommandError,
  type HistoryBackfillResult,
  type HistoryBackfillTask
} from '../../shared/history-backfill-command'
import {
  isReadableTaskRecords,
  type TaskRecord,
  type TaskRecordsState
} from '../../shared/task-records-types'
import {
  openProfileStateDatabase,
  openProfileStateDatabaseReadOnly
} from '../persistence/profile-state/profile-state-database'
import { profileStateJsonMatchesAcceptance } from '../persistence/profile-state/profile-state-documents'
import { readProfileStateDomainsWithRevisionFromDatabase } from '../persistence/profile-state/profile-state-domain-reader'
import {
  ProfileStateRevisionConflictError,
  writeProfileStateDomain
} from '../persistence/profile-state/profile-state-domain-writes'
import type { ProfileStateOfflineLocation } from '../persistence/profile-state/profile-state-offline-settings'
import { classifyProfileStateStorage } from '../persistence/profile-state/profile-state-storage-classification'
import {
  registeredRepos,
  resolveTaskRecordByNumber as resolveBackfillTaskRecord,
  resolveTaskRecordRepoId as resolveBackfillRepoId
} from '../../shared/task-records-lookup'
import { planTaskRecordBackfill } from './task-records-backfill'
import type { TaskRecordsSessionIndexLookup } from './task-records-session-index-lookup'
import type { TranscriptCheckProbe } from './task-records-transcript-check'

const TASK_RECORDS_DOMAIN = 'taskRecords'
const REPOS_DOMAIN = 'repos'

/**
 * The database half of the history backfill (issue #53 B), split from
 * `task-records-backfill.ts` to stay inside the `max-lines` budget: that module owns
 * the rules (which bindings, which session, which gap), this one owns one read and at
 * most one write of the `taskRecords` domain.
 *
 * The caller owns two preconditions this module cannot check: Orca is stopped and the
 * calling process holds the profile-state maintenance owner
 * (`src/main/startup/history-backfill-preflight.ts` takes it before calling, so no
 * racing app can publish its in-memory revision over this write). It does verify that
 * the profile is stored in SQLite and that the domain is one this build can read,
 * because writing a domain it only partly understood would drop another build's rows.
 *
 * One profile-state write per run, against the revision read at the start; a
 * revision conflict is reported as a conflict and never retried into an overwrite.
 *
 * The write is skipped when the load boundary dropped **valid** run rows
 * (`normalizeTaskRecords(...).discarded.runs > 0`). Two different losses hide in
 * that counter: rows this build cannot read (dropped by design, and dropping them
 * in memory is the load path's normal tolerance) and rows that are perfectly
 * readable but over `TASK_RECORDS_MAX_RUNS_PER_BINDING`, which the load path trims
 * to the first 16 in file order. The second kind is a valid row that only a
 * **write** makes impossible to recover, so persisting that trimmed form would let
 * an unrelated `history backfill` shorten a hand-edited or over-cap record. The
 * command therefore reports the counters and writes nothing rather than storing a
 * shortened domain it cannot restore. Nothing is scanned in that case either: a
 * report that names rows it did not write would be the same silence in a new place.
 */
export async function backfillTaskRecords(args: {
  location: ProfileStateOfflineLocation
  task: HistoryBackfillTask
  now: number
  sessionIndexLookup: TaskRecordsSessionIndexLookup
  transcriptCheck: TranscriptCheckProbe
}): Promise<HistoryBackfillResult> {
  const { location, task } = args
  const classification = classifyProfileStateStorage(location.dataFile, location.databaseFile)
  if (classification === 'json-only' || classification === 'neither') {
    throw new HistoryBackfillCommandError(
      'runtime_error',
      'This profile has no SQLite profile state yet. Start Orca once so it writes one, stop Orca, then retry.'
    )
  }
  // Two storage-shape cases where a write here would be pointless or unsafe, taken
  // from the offline settings writer's rules: an orphaned sidecar (no primary file)
  // and a legacy JSON that SQLite has not accepted (the next start imports it and
  // discards this write).
  if (classification === 'sqlite-only' && !existsSync(location.databaseFile)) {
    throw new HistoryBackfillCommandError(
      'runtime_error',
      'Profile state has an orphaned SQLite sidecar without its database. Start Orca once to recover it, stop Orca, then retry.'
    )
  }
  if (classification === 'both') {
    assertLegacyJsonAccepted(location)
  }
  const opened = openProfileStateDatabase(location.databaseFile, location.profileId)
  try {
    if (opened.readOnly) {
      throw new HistoryBackfillCommandError(
        'runtime_error',
        'This profile was written by a newer Orca and is read-only here. Update Orca, then retry.'
      )
    }
    const domains = readProfileStateDomainsWithRevisionFromDatabase(opened.db, [
      TASK_RECORDS_DOMAIN,
      REPOS_DOMAIN
    ])
    if (domains.kind === 'unreadable') {
      throw new HistoryBackfillCommandError(
        'runtime_error',
        `Could not read the task records domain: ${messageOf(domains.error)}. Nothing was written.`
      )
    }
    const stored = domains.values.get(TASK_RECORDS_DOMAIN)
    if (!isReadableTaskRecords(stored)) {
      throw new HistoryBackfillCommandError(
        'runtime_error',
        'The stored task records were written by a newer Orca, so this build cannot read them. Nothing was written.'
      )
    }
    const normalization = normalizeTaskRecords(stored)
    const discarded = normalization.discarded
    const repoId = resolveBackfillRepoId(
      registeredRepos(domains.values.get(REPOS_DOMAIN)),
      task.repo
    )
    const record = resolveBackfillTaskRecord(normalization.state, { repoId, task })
    const origin = externalOriginOf(record)
    const report: HistoryBackfillResult = {
      taskId: record.taskId,
      repoId,
      number: task.number,
      provider: origin.provider,
      itemType: origin.itemType,
      bindings: record.bindings.length,
      examined: 0,
      resolved: 0,
      rowsWritten: { sessions: 0, runs: 0 },
      changed: false,
      revision: null,
      discarded,
      writeRefusedReason: null,
      outcomes: []
    }
    // The stop-check: see the module comment. Reported instead of trimmed, and
    // before any scan, so no half-known report can be mistaken for a done run.
    if (discarded.runs > 0) {
      return { ...report, writeRefusedReason: 'load_discarded_runs' }
    }
    const plan = await planTaskRecordBackfill({
      state: normalization.state,
      record,
      now: args.now,
      sessionIndexLookup: args.sessionIndexLookup,
      transcriptCheck: args.transcriptCheck
    })
    const applied: HistoryBackfillResult = {
      ...report,
      examined: plan.examined,
      resolved: plan.resolved,
      rowsWritten: plan.rowsWritten,
      changed: plan.changed,
      outcomes: plan.bindings
    }
    if (!plan.changed) {
      return applied
    }
    return { ...applied, revision: writeBackfillState(opened.db, plan.state, domains.revision) }
  } finally {
    opened.db.close()
  }
}

function assertLegacyJsonAccepted(location: ProfileStateOfflineLocation): void {
  const rawJson = readFileSync(location.dataFile, 'utf8')
  const opened = openProfileStateDatabaseReadOnly(location.databaseFile, location.profileId)
  try {
    if (!profileStateJsonMatchesAcceptance(opened.db, rawJson)) {
      throw new HistoryBackfillCommandError(
        'runtime_error',
        'Profile state has both JSON and SQLite storage without a matching acceptance marker, so the next start could replace this backfill with that JSON. Start Orca once to reconcile them, stop Orca, then retry.'
      )
    }
  } finally {
    opened.db.close()
  }
}

/** One domain write against the revision read at the start. A conflict is reported
 *  as a conflict and never retried into an overwrite: the winner of the race is an
 *  app that knows more about the state than this snapshot does. */
function writeBackfillState(
  db: Parameters<typeof writeProfileStateDomain>[0],
  state: TaskRecordsState,
  expectedRevision: number
): number {
  try {
    return writeProfileStateDomain(db, {
      domain: TASK_RECORDS_DOMAIN,
      payload: JSON.stringify(state),
      expectedRevision
    }).revision
  } catch (error) {
    if (error instanceof ProfileStateRevisionConflictError) {
      throw new HistoryBackfillCommandError(
        'runtime_error',
        `Profile state changed while the backfill was reading it (expected revision ${error.expectedRevision}, found ${error.actualRevision}); nothing was written. Stop Orca and retry.`
      )
    }
    throw error
  }
}

function externalOriginOf(record: TaskRecord): Extract<TaskRecord['origin'], { kind: 'external' }> {
  const origin = record.origin
  if (origin.kind !== 'external') {
    // Unreachable: `resolveBackfillTaskRecord` only returns external records.
    throw new HistoryBackfillCommandError(
      'invalid_argument',
      `${record.taskId} is a workspace record, not a tracker task.`
    )
  }
  return origin
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

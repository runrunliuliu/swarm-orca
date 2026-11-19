import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { taskRecordTaskId } from '../../../shared/task-records'
import { EMPTY_TASK_RECORDS } from '../../../shared/task-records-types'
import { upsertTaskRecordBinding } from '../../../shared/task-records-updates'
import type { TaskRecordsState } from '../../../shared/task-records-types'
import type { TaskRunHistoryState } from '../../../shared/task-run-history'

/**
 * One-way seed from issue #31 S2's ledger into `taskRecords` (issue #36).
 *
 * The ledger was the interim mapping the issue asked for; `taskRecords` is the
 * phase that replaces it, so this build stops writing `taskRunHistory` and reads
 * it exactly once, when no `taskRecords` domain exists yet. The legacy key is
 * left in place rather than deleted: an older build still reads its own rows,
 * and a downgrade must not turn history into "never ran".
 *
 * Why not keep writing both: two domains would be two answers to "which task did
 * this workspace run", and the design's §8.4 rule is that only the runtime facts
 * stay derived — a second durable copy is a drift bug waiting for its first
 * partial write.
 */
export function migrateTaskRecordsFromRunHistory(
  ledger: TaskRunHistoryState | undefined
): TaskRecordsState | undefined {
  if (!ledger || !Array.isArray(ledger.records) || ledger.records.length === 0) {
    return undefined
  }
  let state = EMPTY_TASK_RECORDS
  for (const record of ledger.records) {
    const result = upsertTaskRecordBinding(state, {
      taskId: taskRecordTaskId({
        provider: 'github',
        repoId: record.repoId,
        itemType: record.itemType,
        number: record.number
      }),
      hostId: LOCAL_EXECUTION_HOST_ID,
      repoId: record.repoId,
      worktreeId: record.worktreeId,
      path: record.path,
      isArchived: record.state === 'archived',
      origin: {
        kind: 'external',
        provider: 'github',
        itemType: record.itemType,
        number: record.number
      },
      // The ledger is a historical claim, not a live verification: a deleted row
      // is migrated with `lastVerifiedAt: null` so the panel says "unresolved"
      // instead of presenting the migration moment as evidence.
      verifiedAt: record.state === 'deleted' ? null : record.updatedAt,
      boundBy: 'created',
      now: record.firstSeenAt
    })
    if (!result.ok) {
      continue
    }
    state = result.state
    if (record.state === 'deleted') {
      state = withLastActivityBaseline(state, record)
    }
  }
  return Object.keys(state.byId).length === 0 ? undefined : state
}

/** Keep the ledger's own timestamps as the record's history baseline, so a
 *  migrated record does not claim it was created when the migration ran. */
function withLastActivityBaseline(
  state: TaskRecordsState,
  record: TaskRunHistoryState['records'][number]
): TaskRecordsState {
  const taskId = taskRecordTaskId({
    provider: 'github',
    repoId: record.repoId,
    itemType: record.itemType,
    number: record.number
  })
  const existing = state.byId[taskId]
  if (!existing) {
    return state
  }
  return {
    ...state,
    byId: {
      ...state.byId,
      [taskId]: {
        ...existing,
        createdAt: Math.min(existing.createdAt, record.firstSeenAt),
        updatedAt: Math.max(existing.updatedAt, record.updatedAt)
      }
    }
  }
}

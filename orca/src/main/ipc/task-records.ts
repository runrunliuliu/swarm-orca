import { ipcMain } from 'electron'
import type { Store } from '../persistence/loading-store/store'
import type { TaskProvider } from '../../shared/task-providers'
import type { TaskRecord, TaskRecordItemType } from '../../shared/task-records-types'

const CHANNEL = 'taskRecords:get'

export type TaskRecordQuery = {
  repoId: string
  itemType: TaskRecordItemType
  number: number
  /** Optional: a page that knows its tracker sends it; otherwise the store
   *  answers only when exactly one provider claims the number. */
  provider?: TaskProvider
}

/**
 * Read-only view of the task ledger (issue #36). The records are written where
 * worktree metadata is written and settled before a removal; this channel only
 * answers "what did this task run, and what is still readable about it".
 *
 * A malformed query returns `null` rather than throwing: the panel already
 * renders "no recorded history" for `null`, and a rejected IPC would replace
 * that with an error state the user cannot act on.
 */
export function registerTaskRecordHandlers(store: Pick<Store, 'getTaskRecordForTask'>): void {
  ipcMain.removeHandler(CHANNEL)
  ipcMain.handle(CHANNEL, (_event, args: TaskRecordQuery | null): { record: TaskRecord | null } => {
    if (!isTaskRecordQuery(args)) {
      return { record: null }
    }
    return { record: store.getTaskRecordForTask(args) }
  })
}

export function isTaskRecordQuery(value: unknown): value is TaskRecordQuery {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  return (
    'repoId' in value &&
    typeof value.repoId === 'string' &&
    value.repoId.length > 0 &&
    'itemType' in value &&
    (value.itemType === 'issue' || value.itemType === 'pr') &&
    'number' in value &&
    typeof value.number === 'number' &&
    Number.isInteger(value.number) &&
    (!('provider' in value) ||
      value.provider === undefined ||
      value.provider === 'github' ||
      value.provider === 'gitlab' ||
      value.provider === 'linear' ||
      value.provider === 'jira')
  )
}

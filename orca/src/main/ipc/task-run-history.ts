import { ipcMain } from 'electron'
import type { Store } from '../persistence/loading-store/store'
import type {
  TaskRunHistoryTaskQuery,
  TaskRunHistoryTaskView
} from '../../shared/task-run-history'

const CHANNEL = 'taskRunHistory:get'

/**
 * Read-only task-history ledger for the Orca tab (issue #31 S2). The records are
 * written where worktree metadata is written; this channel only answers "what
 * worktrees did this task run, and which of them are gone".
 */
export function registerTaskRunHistoryHandlers(store: Store): void {
  ipcMain.removeHandler(CHANNEL)
  ipcMain.handle(CHANNEL, (_event, args: TaskRunHistoryTaskQuery): TaskRunHistoryTaskView => {
    const valid =
      typeof args?.repoId === 'string' &&
      (args.itemType === 'issue' || args.itemType === 'pr') &&
      Number.isInteger(args.number)
    return valid ? { records: store.getTaskRunHistoryForTask(args).records } : { records: [] }
  })
}

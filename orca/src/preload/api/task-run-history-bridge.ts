import { ipcRenderer } from 'electron'
import type { TaskRunHistoryTaskQuery } from '../../shared/task-run-history'
import type { TaskRunHistoryApi } from './task-run-history-api'

export const taskRunHistoryApi: TaskRunHistoryApi = {
  get: (args: TaskRunHistoryTaskQuery) => ipcRenderer.invoke('taskRunHistory:get', args)
}

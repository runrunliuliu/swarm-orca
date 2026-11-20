import { ipcRenderer } from 'electron'
import type { TaskRecordQuery, TaskRecordView, TaskRecordsApi } from './task-records-api'

export const taskRecordsApi: TaskRecordsApi = {
  get: (args: TaskRecordQuery): Promise<TaskRecordView> =>
    ipcRenderer.invoke('taskRecords:get', args)
}

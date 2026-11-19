import type { TaskRecord, TaskRecordItemType } from '../../shared/task-records-types'

export type TaskRecordQuery = {
  repoId: string
  itemType: TaskRecordItemType
  number: number
}

export type TaskRecordView = { record: TaskRecord | null }

export type TaskRecordsApi = {
  get: (args: TaskRecordQuery) => Promise<TaskRecordView>
}

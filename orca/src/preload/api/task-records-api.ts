import type { TaskProvider } from '../../shared/task-providers'
import type { TaskRecord, TaskRecordItemType } from '../../shared/task-records-types'

export type TaskRecordQuery = {
  repoId: string
  itemType: TaskRecordItemType
  number: number
  /** Optional: a page that knows its tracker sends it; otherwise the store
   *  answers only when exactly one provider claims the number. */
  provider?: TaskProvider
}

export type TaskRecordView = { record: TaskRecord | null }

export type TaskRecordsApi = {
  get: (args: TaskRecordQuery) => Promise<TaskRecordView>
}

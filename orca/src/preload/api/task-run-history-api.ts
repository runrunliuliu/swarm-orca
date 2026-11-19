import type {
  TaskRunHistoryTaskQuery,
  TaskRunHistoryTaskView
} from '../../shared/task-run-history'

export type TaskRunHistoryApi = {
  get: (args: TaskRunHistoryTaskQuery) => Promise<TaskRunHistoryTaskView>
}

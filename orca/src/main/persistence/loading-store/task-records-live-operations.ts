import type { StoreRuntimeState } from './store-runtime-state'
import { scheduleSave, type WriteSchedulingOperations } from './write-scheduling'
import {
  recordLiveRunObservation,
  type LiveRunObservation
} from '../../task-records/task-records-live-runs'
import { isReadableTaskRecords } from '../../../shared/task-records'

/**
 * The `taskRecords` write the live run observer needs, as a Store domain
 * operation rather than another method on `Store` itself: that class is at its
 * `max-lines` budget, and this domain-only transition belongs beside the other
 * persistence mixins.
 *
 * Only what the producer reads: `state.taskRecords`. The scheduling handle is the
 * Store's, so the caller (a hook-status listener in the composition root) cannot
 * save the profile by accident.
 */
type TaskRecordsLiveOperationsRuntime = Pick<StoreRuntimeState, 'state'>

const taskRecordsLiveOperationsContext = Symbol('TaskRecordsLiveOperations')
type TaskRecordsLiveOperationsContext = {
  runtime: TaskRecordsLiveOperationsRuntime
  scheduling: WriteSchedulingOperations
}

export class TaskRecordsLiveOperations {
  readonly [taskRecordsLiveOperationsContext]: TaskRecordsLiveOperationsContext

  constructor(runtime: TaskRecordsLiveOperationsRuntime, scheduling: WriteSchedulingOperations) {
    this[taskRecordsLiveOperationsContext] = { runtime, scheduling }
  }

  /** Observe one agent run while it is still running, so closing its TUI (or
   *  killing its process) does not erase it from the task's history (issue #53
   *  follow-up). The row is the same fact shape the archive snapshot stores and
   *  is keyed by the same claim, so the later snapshot upserts over it instead of
   *  duplicating it.
   *
   *  Best-effort by design: an absent or unreadable domain is the "this profile
   *  never recorded tasks" state, not an error for a status ping. A refusal
   *  (the per-binding run cap) is reported by the transition and leaves the
   *  stored state alone. */
  recordTaskRecordLiveRun(observation: LiveRunObservation): boolean {
    const { runtime, scheduling } = this[taskRecordsLiveOperationsContext]
    const stored = runtime.state.taskRecords
    if (stored === undefined || !isReadableTaskRecords(stored)) {
      return false
    }
    const result = recordLiveRunObservation(stored, observation, Date.now())
    if (!result.changed) {
      return false
    }
    runtime.state.taskRecords = result.state
    scheduleSave(scheduling, ['taskRecords'])
    return true
  }
}

export function installTaskRecordsLiveOperationsContext(
  target: TaskRecordsLiveOperations,
  source: TaskRecordsLiveOperations
): void {
  Object.defineProperty(target, taskRecordsLiveOperationsContext, {
    value: source[taskRecordsLiveOperationsContext]
  })
}

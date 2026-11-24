import { defineMethod } from '../core'
import {
  TASK_RECORDS_GET_RPC,
  TaskRecordsRemoteQuerySchema,
  type TaskRecordsRemoteResult
} from '../../../../shared/task-records-remote'

/**
 * `taskRecords.get` — the runtime's read-only half of the task page's history
 * (issue #31). See `shared/task-records-remote.ts` for why this is a lookup by
 * identity and why `repoKnown` travels with the record.
 *
 * Why no write path here: the record is written where worktree metadata is
 * written and settled before a removal. A runtime RPC that wrote one would be a
 * second producer of the binding set, which is exactly the second truth the
 * domain is built to avoid.
 *
 * Why it is not in the mobile allowlist: the caller is the desktop/paired Orca
 * client reading a task page. A mobile scope is denied by default rather than
 * inheriting a read it never asked for, and widening that is a separate decision
 * with its own surface.
 *
 * A malformed or unknown repo answers `{ record: null, repoKnown: false }`
 * instead of throwing: the panel already renders "this host could not be asked",
 * and a rejected RPC would replace a degradable state with an error the user
 * cannot act on.
 */
export const TASK_RECORD_METHODS = [
  defineMethod({
    name: TASK_RECORDS_GET_RPC,
    params: TaskRecordsRemoteQuerySchema,
    handler: (params, { runtime }): TaskRecordsRemoteResult => runtime.getTaskRecordForTask(params)
  })
]

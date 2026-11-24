import { z } from 'zod'
import { TASK_PROVIDERS } from './task-providers'
import type { TaskRecord } from './task-records-types'

/**
 * The read-only runtime RPC that answers "what did this task run" from the
 * profile of the runtime that holds the workspace (issue #31 cross-profile gap).
 *
 * Why this exists at all: `taskRecords:get` reads the *client's* profile-state,
 * but a record is written where the workspace lives — on the runtime, into the
 * runtime's own profile. A user who runs agents on a remote environment and reads
 * the task page on a desktop client therefore looked in the wrong database, and
 * the Orca tab said "nothing recorded" about a task that ran. This method is the
 * runtime's half of the answer: the same record shape, read from the profile that
 * actually holds it.
 *
 * Shape, and why it is a lookup by identity rather than a listing:
 * - **bounded**: one record per call (`repoId` + `itemType` + `number`, plus the
 *   optional provider), instead of the domain's 8 MiB. A `list` would have to
 *   send every task this runtime ever recorded to answer about one page, on every
 *   page open, over a relay.
 * - **the same identity the write side uses**: `taskRecordExternalIndexKey` is
 *   the `externalIndex` key the writer maintains, so this is an index hit and not
 *   a scan, and the answer cannot drift from the stored record's own key.
 * - **scoped by construction**: the query names no environment. The runtime
 *   answers from its own profile and can only answer about a repo it has
 *   registered, which is what keeps this from becoming a cross-environment read
 *   channel (see `repoKnown` below).
 *
 * Read-only: the handler calls the store's read accessor and nothing else. It
 * neither writes a record nor triggers a scan, an archive snapshot or a backfill;
 * a profile with no record is answered with `null`, which the client renders as
 * "this runtime recorded nothing", never as `0 tokens` / `$0`.
 */
export const TASK_RECORDS_GET_RPC = 'taskRecords.get'

/** The capabilities a runtime advertises when it can answer `TASK_RECORDS_GET_RPC`.
 *  Named in `protocol-version.ts` beside the other wire capabilities (that file
 *  owns the advertised list); re-exported here so a client can gate the call
 *  without importing the whole protocol module. A host that predates the method
 *  answers `method_not_found`, which the client maps to the same "unsupported"
 *  verdict — the version string in that message is what tells the user the host
 *  is older, not a claim that the task has no history. */
export const TASK_RECORD_ITEM_TYPES = ['issue', 'pr'] as const

export const TaskRecordsRemoteQuerySchema = z.object({
  /** A repo registration on the answering runtime. The renderer passes the id it
   *  stored for that environment, which is the runtime's own id: the catalog is
   *  published by the runtime and the client keeps it verbatim. */
  repoId: z.string().min(1),
  itemType: z.enum(TASK_RECORD_ITEM_TYPES),
  number: z.number().int().finite(),
  /** Omitted when the page cannot say which tracker it belongs to; the store then
   *  answers only when exactly one provider claims the number (the same rule the
   *  IPC lookup follows), so an ambiguous page stays unanswered rather than
   *  guessed. */
  provider: z.enum(TASK_PROVIDERS).optional()
})

export type TaskRecordsRemoteQuery = z.infer<typeof TaskRecordsRemoteQuerySchema>

/**
 * The answer, with the one distinction a bare `TaskRecord | null` cannot carry:
 * "this runtime knows the repo and has no record for that task" versus "this
 * runtime does not know the repo at all".
 *
 * `repoKnown: false` is the scope refusal made observable. Asking environment A
 * about a repo registered on environment B returns no data and says why, instead
 * of an empty answer a client would print as "no history". It is not an error:
 * the client's own recipe for a repo it holds for another host is to keep what it
 * has and state that this environment could not be asked.
 */
export type TaskRecordsRemoteResult = {
  record: TaskRecord | null
  repoKnown: boolean
}

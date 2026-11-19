import type { TaskProvider } from './task-providers'
import {
  EMPTY_TASK_RECORDS,
  type TaskRecord,
  type TaskRecordItemType,
  type TaskRecordSession,
  type TaskRecordsState,
  type TaskUsageSettlement
} from './task-records-types'

/** The parts that name one tracker task. `repoId` names a repo registration on
 *  one host, so the key cannot be ambiguous across hosts; `provider` is part of
 *  it because GitHub issue #31 and Linear issue #31 in one repository are two
 *  different tasks that a provider-less key would silently merge. */
export type TaskRecordIdentity = {
  provider: TaskProvider
  repoId: string
  itemType: TaskRecordItemType
  number: number
}

/** The one place that spells a task id. */
export function taskRecordTaskId(identity: TaskRecordIdentity): string {
  return `task:${taskRecordExternalIndexKey(identity)}`
}

export function taskRecordExternalIndexKey(identity: TaskRecordIdentity): string {
  return `${identity.provider}:${identity.repoId}:${identity.itemType}:${identity.number}`
}

export function taskRecordExternalIndexKeyOfRecord(record: TaskRecord): string | null {
  if (record.origin.kind !== 'external') {
    return null
  }
  const repoId = record.bindings[0]?.repoId
  if (!repoId) {
    return null
  }
  return taskRecordExternalIndexKey({
    provider: record.origin.provider,
    repoId,
    itemType: record.origin.itemType,
    number: record.origin.number
  })
}

export type TaskRecordLookup = Omit<TaskRecordIdentity, 'provider'> & {
  /** Omitted when the caller cannot say which tracker the page belongs to (an
   *  older page, or a workspace entry). The lookup then answers only when exactly
   *  one provider claims the number. */
  provider?: TaskProvider
}

/** The record of one task page, or null.
 *
 *  A provider-qualified lookup is exact. An unqualified one scans for the
 *  `*:<repoId>:<itemType>:<number>` suffix and answers only on a single match:
 *  two providers claiming one number is not a task this reader may pick, so it
 *  returns null rather than the first or the "best" candidate. */
export function taskRecordForTask(
  state: TaskRecordsState | undefined,
  query: TaskRecordLookup
): TaskRecord | null {
  const readable = state === undefined ? EMPTY_TASK_RECORDS : state
  if (query.provider !== undefined) {
    const taskId =
      readable.externalIndex[taskRecordExternalIndexKey({ ...query, provider: query.provider })]
    return taskId === undefined ? null : (readable.byId[taskId] ?? null)
  }
  const suffix = `:${query.repoId}:${query.itemType}:${query.number}`
  const matches = Object.entries(readable.externalIndex).filter(([key]) => key.endsWith(suffix))
  if (matches.length !== 1) {
    return null
  }
  return readable.byId[matches[0][1]] ?? null
}

function utf8Bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length
}

export function recordBytes(record: TaskRecord): number {
  return utf8Bytes(record)
}

export function taskRecordsDomainBytes(state: TaskRecordsState): number {
  return utf8Bytes(state)
}

/** The task-level token total of one settlement, or null when the figure is
 *  unavailable. Not a stored field: a stored total is a second number that can
 *  disagree with the provider rows it came from. */
export function taskUsageSettlementTokens(settlement: TaskUsageSettlement): number | null {
  return settlement.kind === 'unavailable'
    ? null
    : settlement.providers.reduce((total, provider) => total + provider.tokens, 0)
}

/** `key:id` is one session as the provider names it. The provider is not part of
 *  the identity: two providers that report one id each reported *their own*
 *  session, so the ambiguity rule lives where a token figure is attributed to a
 *  claim (see the renderer's session-total helper), not here. */
export function taskRecordSessionClaimKey(session: TaskRecordSession): string {
  return `${session.key}:${session.id}`
}

// Re-exported so a caller that needs both identity and loading imports one
// module, while the normalization rules stay in their own file.
export { normalizeTaskRecords, type TaskRecordsNormalization } from './task-records-normalize'
export { isReadableTaskRecords } from './task-records-types'

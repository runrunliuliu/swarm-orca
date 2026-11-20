import {
  TASK_RECORD_SCHEMA_VERSION,
  TASK_RECORDS_MAX_RECORD_BYTES,
  TASK_RECORDS_VERSION,
  EMPTY_TASK_RECORDS,
  isReadableTaskRecords,
  isTaskRecordItemType,
  isTaskRecordResolvedVia,
  isTaskRecordUsageProvider,
  isTaskRecordUsageUnavailableReason,
  type TaskRecord,
  type TaskRecordSession,
  type TaskRecordUsageProvider,
  type TaskRecordsState,
  type TaskUsageSettlement,
  type TaskWorkspaceBinding
} from './task-records-types'
import { recordBytes, taskRecordExternalIndexKeyOfRecord } from './task-records'
import {
  KNOWN_BINDING_FIELDS,
  KNOWN_DOMAIN_FIELDS,
  KNOWN_RECORD_FIELDS,
  withPreservedFields
} from './task-records-preserved-fields'
import { normalizeExecutionHostId } from './execution-host'
import { normalizeTaskProviderIdentity } from './task-provider-identity'

/**
 * Load-boundary normalization for the `taskRecords` domain.
 *
 * Split from `task-records.ts` because the two answer different questions: that
 * module owns identity and reading, this one owns "what may be loaded at all".
 * The precedence matters — a malformed *record* is dropped and counted, while a
 * malformed *domain* is left untouched, because rebuilding it would delete
 * records this build simply does not understand yet.
 */
export type TaskRecordsNormalization = {
  state: TaskRecordsState
  /** Records dropped for a malformed or out-of-range shape (reported, not hidden). */
  dropped: number
  /** False means "keep the stored payload untouched" (see `isReadableTaskRecords`). */
  readable: boolean
}

/**
 * Load-boundary normalization. A malformed *record* is dropped and counted; a
 * malformed *domain* is not — it is left alone, because rebuilding it would
 * delete records this build simply does not understand yet.
 */
export function normalizeTaskRecords(value: unknown): TaskRecordsNormalization {
  if (!isReadableTaskRecords(value)) {
    return { state: EMPTY_TASK_RECORDS, dropped: 0, readable: false }
  }
  if (value === undefined) {
    return { state: EMPTY_TASK_RECORDS, dropped: 0, readable: true }
  }
  const byId: Record<string, TaskRecord> = {}
  const externalIndex: Record<string, string> = {}
  let dropped = 0
  for (const [key, candidate] of Object.entries(value.byId)) {
    const record = normalizeTaskRecord(key, candidate)
    if (!record) {
      dropped += 1
      continue
    }
    byId[record.taskId] = record
    const indexKey = taskRecordExternalIndexKeyOfRecord(record)
    // Two records claiming one tracker item is a conflict this build cannot
    // resolve: keep the first (deterministic, insertion-ordered) and count it.
    if (indexKey !== null) {
      if (externalIndex[indexKey] === undefined) {
        externalIndex[indexKey] = record.taskId
      } else {
        dropped += 1
      }
    }
  }
  return {
    // Extras on the domain itself ride along too: a newer build's top-level field
    // would otherwise disappear on this build's next save.
    state: withPreservedFields(
      { recordsVersion: TASK_RECORDS_VERSION, byId, externalIndex },
      value,
      KNOWN_DOMAIN_FIELDS
    ),
    dropped,
    readable: true
  }
}

function normalizeTaskRecord(key: string, value: unknown): TaskRecord | null {
  if (!isRecord(value)) {
    return null
  }
  const bindings = normalizeBindings(value.bindings)
  if (bindings === null) {
    return null
  }
  const origin = normalizeOrigin(value.origin)
  if (!origin) {
    return null
  }
  const taskId = nonEmptyString(value.taskId)
  if (!taskId || taskId !== key) {
    return null
  }
  const hostId = normalizeExecutionHostId(nonEmptyString(value.hostId))
  if (!hostId) {
    return null
  }
  const createdAt = finiteNumber(value.createdAt)
  const updatedAt = finiteNumber(value.updatedAt)
  if (createdAt === null || updatedAt === null) {
    return null
  }
  const primaryWorktreeId = nonEmptyString(value.primaryWorktreeId) ?? undefined
  if (
    primaryWorktreeId !== undefined &&
    !bindings.some((binding) => binding.worktreeId === primaryWorktreeId)
  ) {
    return null
  }
  const record: TaskRecord = {
    taskId,
    hostId,
    origin,
    bindings,
    ...(primaryWorktreeId ? { primaryWorktreeId } : {}),
    intent: normalizeIntent(value.intent),
    createdAt,
    updatedAt,
    schemaVersion: finiteNumber(value.schemaVersion) ?? TASK_RECORD_SCHEMA_VERSION
  }
  // A newer record schema never reaches here: `isReadableTaskRecords` rejects the
  // whole domain so the payload is preserved verbatim instead of being rewritten
  // without the record this build cannot read.
  return recordBytes(record) > TASK_RECORDS_MAX_RECORD_BYTES
    ? null
    : withPreservedFields(record, value, KNOWN_RECORD_FIELDS)
}

function normalizeBindings(value: unknown): TaskWorkspaceBinding[] | null {
  if (!Array.isArray(value)) {
    return null
  }
  const bindings: TaskWorkspaceBinding[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (!isRecord(entry)) {
      return null
    }
    const worktreeId = nonEmptyString(entry.worktreeId)
    const repoId = nonEmptyString(entry.repoId)
    const hostId = normalizeExecutionHostId(nonEmptyString(entry.hostId))
    const path = typeof entry.path === 'string' ? entry.path : null
    const boundAt = finiteNumber(entry.boundAt)
    if (!worktreeId || !repoId || !hostId || path === null || boundAt === null) {
      return null
    }
    // One worktree appears once per task *per owner* (plan §M2b A): `repoId::path`
    // repeats across hosts, so the same bare id under two hosts is two bindings,
    // not a duplicate. The same id under one host is malformed, not two rows to
    // merge.
    const ownerKey = `${worktreeId}\u0000${hostId}`
    if (seen.has(ownerKey)) {
      return null
    }
    seen.add(ownerKey)
    const resolvedVia = isTaskRecordResolvedVia(entry.resolvedVia) ? entry.resolvedVia : undefined
    const settlement = normalizeSettlement(entry.usageSettlement)
    const binding: TaskWorkspaceBinding = {
      worktreeId,
      repoId,
      hostId,
      path,
      isArchived: entry.isArchived === true,
      boundAt,
      boundBy:
        entry.boundBy === 'created' || entry.boundBy === 'user' || entry.boundBy === 'reconciled'
          ? entry.boundBy
          : 'created',
      lastVerifiedAt: finiteNumber(entry.lastVerifiedAt),
      ...(resolvedVia ? { resolvedVia } : {}),
      sessions: normalizeSessions(entry.sessions),
      ...(settlement ? { usageSettlement: settlement } : {})
    }
    bindings.push(withPreservedFields(binding, entry, KNOWN_BINDING_FIELDS))
  }
  return bindings
}

function normalizeSessions(value: unknown): TaskRecordSession[] {
  if (!Array.isArray(value)) {
    return []
  }
  const sessions: TaskRecordSession[] = []
  for (const entry of value) {
    if (!isRecord(entry)) {
      continue
    }
    const key = nonEmptyString(entry.key)
    const id = nonEmptyString(entry.id)
    const firstSeenAt = finiteNumber(entry.firstSeenAt)
    const lastSeenAt = finiteNumber(entry.lastSeenAt)
    if (!key || !id || firstSeenAt === null || lastSeenAt === null) {
      continue
    }
    const transcriptPath = nonEmptyString(entry.transcriptPath)
    sessions.push({
      ...(isTaskRecordUsageProvider(entry.provider) ? { provider: entry.provider } : {}),
      key,
      id,
      ...(transcriptPath ? { transcriptPath } : {}),
      firstSeenAt,
      lastSeenAt
    })
  }
  return sessions
}

function normalizeSettlement(value: unknown): TaskUsageSettlement | null {
  if (!isRecord(value) || value.scope !== 'worktree-rollup') {
    return null
  }
  const collectedAt = finiteNumber(value.collectedAt)
  const worktreeId = nonEmptyString(value.worktreeId)
  if (collectedAt === null || !worktreeId) {
    return null
  }
  if (value.kind === 'unavailable') {
    return isTaskRecordUsageUnavailableReason(value.reason)
      ? {
          kind: 'unavailable',
          collectedAt,
          scope: 'worktree-rollup',
          worktreeId,
          reason: value.reason
        }
      : null
  }
  if (value.kind !== 'known' || !Array.isArray(value.providers)) {
    return null
  }
  const providers: { provider: TaskRecordUsageProvider; tokens: number; costUsd: number | null }[] =
    []
  for (const entry of value.providers) {
    if (!isRecord(entry) || !isTaskRecordUsageProvider(entry.provider)) {
      return null
    }
    const tokens = finiteNumber(entry.tokens)
    if (tokens === null) {
      return null
    }
    providers.push({
      provider: entry.provider,
      tokens,
      costUsd: finiteNumber(entry.costUsd)
    })
  }
  return {
    kind: 'known',
    collectedAt,
    scope: 'worktree-rollup',
    worktreeId,
    providers,
    estimatedCostUsd: finiteNumber(value.estimatedCostUsd)
  }
}

function normalizeOrigin(value: unknown): TaskRecord['origin'] | null {
  if (!isRecord(value)) {
    return null
  }
  if (value.kind === 'workspace') {
    const primaryWorktreeId = nonEmptyString(value.primaryWorktreeId)
    return primaryWorktreeId ? { kind: 'workspace', primaryWorktreeId } : null
  }
  if (value.kind !== 'external' || !isTaskRecordItemType(value.itemType)) {
    return null
  }
  const number = finiteNumber(value.number)
  if (number === null) {
    return null
  }
  const provider = value.provider
  if (
    provider !== 'github' &&
    provider !== 'gitlab' &&
    provider !== 'linear' &&
    provider !== 'jira'
  ) {
    return null
  }
  // Carried through the round-trip: the workbench names a task by this identity,
  // so dropping it would turn a named tracker task into an anonymous one.
  const providerIdentity = normalizeTaskProviderIdentity(provider, value.providerIdentity)
  const url = nonEmptyString(value.url)
  const titleSnapshot = nonEmptyString(value.titleSnapshot)
  const titleSnapshotAt = finiteNumber(value.titleSnapshotAt)
  return {
    kind: 'external',
    provider,
    ...(providerIdentity ? { providerIdentity } : {}),
    itemType: value.itemType,
    number,
    ...(url ? { url } : {}),
    ...(titleSnapshot ? { titleSnapshot } : {}),
    ...(titleSnapshotAt === null ? {} : { titleSnapshotAt })
  }
}

function normalizeIntent(value: unknown): TaskRecord['intent'] {
  if (!isRecord(value)) {
    return {}
  }
  const acceptance = nonEmptyString(value.acceptance)
  return {
    ...(value.archived === true ? { archived: true } : {}),
    ...(acceptance ? { acceptance } : {})
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

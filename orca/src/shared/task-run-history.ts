import { splitWorktreeIdForFilesystem } from './worktree/id'

/**
 * The tiny worktree → task ledger behind issue #31's "ran before, but is not
 * here now" state (S2). It records only what a deleted worktree would otherwise
 * take with it: which task it belonged to, where its checkout was, and whether
 * it is active, archived or deleted.
 *
 * Why not `WorktreeMeta`: that row is deleted with the worktree (and its 30-day
 * GC), which is exactly the loss this ledger exists to prevent. Why not the full
 * `taskRecords` domain from the design doc: that is the M2b storage phase; this
 * is the one-line mapping the issue asks for, and it stores no runtime state or
 * user intent.
 *
 * Absence is not zero: a record that never saw a branch leaves it undefined, and
 * a missing ledger is `undefined`, never an empty "never ran" claim.
 */
export const TASK_RUN_HISTORY_VERSION = 1

/** One task link of one worktree. A worktree can be linked to an issue and a PR;
 *  each task page gets its own record, because they are separate tasks. */
export type TaskRunHistoryItemType = 'issue' | 'pr'

export type TaskRunHistoryRecord = {
  repoId: string
  itemType: TaskRunHistoryItemType
  number: number
  worktreeId: string
  /** The checkout path, kept after deletion so a trace can still be located. */
  path: string
  /** Git branch at the time the record was written; absent when unknown. */
  branch?: string
  state: 'active' | 'archived' | 'deleted'
  firstSeenAt: number
  updatedAt: number
  activeAt?: number
  archivedAt?: number
  deletedAt?: number
  lastActivityAt?: number
}

export type TaskRunHistoryState = {
  version: number
  records: TaskRunHistoryRecord[]
}

export type TaskRunHistoryTaskQuery = {
  repoId: string
  itemType: TaskRunHistoryItemType
  number: number
}

export type TaskRunHistoryTaskView = {
  records: TaskRunHistoryRecord[]
}

export const EMPTY_TASK_RUN_HISTORY: TaskRunHistoryState = {
  version: TASK_RUN_HISTORY_VERSION,
  records: []
}

/** Bounds. The ledger is a convenience, not an audit log: only deleted rows are
 *  capped (oldest activity first). Active/archived rows are bounded by the real
 *  worktree count and are never pruned while their workspace exists. */
export const TASK_RUN_HISTORY_MAX_DELETED_RECORDS = 1500

type UpsertInput = {
  repoId: string
  itemType: TaskRunHistoryItemType
  number: number
  worktreeId: string
  path?: string
  branch?: string
  state: TaskRunHistoryRecord['state']
  lastActivityAt?: number
  now: number
}

/** Falls back to the locator's own path when the caller did not pass one. */
export function worktreePathFromId(worktreeId: string): string {
  return splitWorktreeIdForFilesystem(worktreeId)?.worktreePath ?? worktreeId
}

export function taskRunHistoryKey(record: {
  repoId: string
  itemType: TaskRunHistoryItemType
  number: number
  worktreeId: string
}): string {
  return `${record.repoId}:${record.itemType}:${record.number}:${record.worktreeId}`
}

/** Insert or update one record. Returns the next state and whether anything
 *  changed, so a comment/pin write does not schedule a ledger write. */
export function upsertTaskRunHistoryRecord(
  state: TaskRunHistoryState | undefined,
  input: UpsertInput
): { state: TaskRunHistoryState; changed: boolean } {
  const current = state ?? EMPTY_TASK_RUN_HISTORY
  const key = taskRunHistoryKey(input)
  const index = current.records.findIndex((record) => taskRunHistoryKey(record) === key)
  const existing = index === -1 ? undefined : current.records[index]
  const path = input.path ?? existing?.path ?? worktreePathFromId(input.worktreeId)
  const branch = input.branch ?? existing?.branch
  const lastActivityAt = input.lastActivityAt ?? existing?.lastActivityAt
  const isFirst = existing === undefined
  const stateChanged = existing?.state !== input.state

  if (
    !isFirst &&
    !stateChanged &&
    existing.path === path &&
    existing.branch === branch &&
    existing.lastActivityAt === lastActivityAt
  ) {
    return { state: current, changed: false }
  }

  const now = input.now
  const next: TaskRunHistoryRecord = {
    repoId: input.repoId,
    itemType: input.itemType,
    number: input.number,
    worktreeId: input.worktreeId,
    path,
    ...(branch ? { branch } : {}),
    state: input.state,
    firstSeenAt: existing?.firstSeenAt ?? now,
    updatedAt: now,
    ...(input.state === 'active' ? { activeAt: existing?.activeAt ?? now } : {}),
    ...(existing?.activeAt !== undefined && input.state !== 'active'
      ? { activeAt: existing.activeAt }
      : {}),
    ...(input.state === 'archived' ? { archivedAt: existing?.archivedAt ?? now } : {}),
    ...(existing?.archivedAt !== undefined && input.state !== 'archived'
      ? { archivedAt: existing.archivedAt }
      : {}),
    ...(input.state === 'deleted' ? { deletedAt: existing?.deletedAt ?? now } : {}),
    ...(lastActivityAt === undefined ? {} : { lastActivityAt })
  }
  const records = [...current.records]
  if (index === -1) {
    records.push(next)
  } else {
    records[index] = next
  }
  return { state: { version: TASK_RUN_HISTORY_VERSION, records: prune(records) }, changed: true }
}

/** Mark every record of a worktree deleted; keeps the identity for the task page. */
export function markTaskRunHistoryDeleted(
  state: TaskRunHistoryState | undefined,
  worktreeId: string,
  now: number
): { state: TaskRunHistoryState; changed: boolean } {
  const current = state ?? EMPTY_TASK_RUN_HISTORY
  let changed = false
  const records = current.records.map((record) => {
    if (record.worktreeId !== worktreeId || record.state === 'deleted') {
      return record
    }
    changed = true
    return { ...record, state: 'deleted' as const, updatedAt: now, deletedAt: now }
  })
  return changed
    ? { state: { version: TASK_RUN_HISTORY_VERSION, records }, changed }
    : { state: current, changed: false }
}

/** Records of one task, newest activity first (the page's own order is decided
 *  by the caller; this only makes the input deterministic). */
export function taskRunHistoryForTask(
  state: TaskRunHistoryState | undefined,
  args: { repoId: string; itemType: TaskRunHistoryItemType; number: number }
): TaskRunHistoryRecord[] {
  return (state?.records ?? [])
    .filter(
      (record) =>
        record.repoId === args.repoId &&
        record.itemType === args.itemType &&
        record.number === args.number
    )
    .sort((left, right) => (right.lastActivityAt ?? right.updatedAt) - (left.lastActivityAt ?? left.updatedAt))
}

function prune(records: TaskRunHistoryRecord[]): TaskRunHistoryRecord[] {
  const live = records.filter((record) => record.state !== 'deleted')
  const deleted = records
    .filter((record) => record.state === 'deleted')
    .sort(
      (left, right) =>
        (right.lastActivityAt ?? right.updatedAt) - (left.lastActivityAt ?? left.updatedAt)
    )
    .slice(0, TASK_RUN_HISTORY_MAX_DELETED_RECORDS)
  return [...live, ...deleted]
}

/** Load-boundary normalization: malformed rows are dropped, never guessed. */
export function normalizeTaskRunHistory(value: unknown): TaskRunHistoryState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return EMPTY_TASK_RUN_HISTORY
  }
  const raw = (value as { records?: unknown }).records
  if (!Array.isArray(raw)) {
    return EMPTY_TASK_RUN_HISTORY
  }
  const records: TaskRunHistoryRecord[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      continue
    }
    const record = entry as Record<string, unknown>
    if (
      typeof record.repoId !== 'string' ||
      (record.itemType !== 'issue' && record.itemType !== 'pr') ||
      typeof record.number !== 'number' ||
      !Number.isFinite(record.number) ||
      typeof record.worktreeId !== 'string' ||
      typeof record.path !== 'string' ||
      (record.state !== 'active' &&
        record.state !== 'archived' &&
        record.state !== 'deleted') ||
      typeof record.firstSeenAt !== 'number' ||
      typeof record.updatedAt !== 'number'
    ) {
      continue
    }
    records.push({
      repoId: record.repoId,
      itemType: record.itemType,
      number: record.number,
      worktreeId: record.worktreeId,
      path: record.path,
      ...(typeof record.branch === 'string' ? { branch: record.branch } : {}),
      state: record.state,
      firstSeenAt: record.firstSeenAt,
      updatedAt: record.updatedAt,
      ...(typeof record.activeAt === 'number' ? { activeAt: record.activeAt } : {}),
      ...(typeof record.archivedAt === 'number' ? { archivedAt: record.archivedAt } : {}),
      ...(typeof record.deletedAt === 'number' ? { deletedAt: record.deletedAt } : {}),
      ...(typeof record.lastActivityAt === 'number'
        ? { lastActivityAt: record.lastActivityAt }
        : {})
    })
  }
  return { version: TASK_RUN_HISTORY_VERSION, records: prune(records) }
}

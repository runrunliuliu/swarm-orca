/**
 * The issue #31 S2 worktree → task ledger, kept as a **read-only legacy input**.
 *
 * Issue #36 replaced it with the `taskRecords` domain: the ledger stored one
 * line per (task, worktree) and nothing about sessions or settled usage, and two
 * durable answers to "which task did this workspace run" is exactly the drift the
 * design forbids. This build therefore never writes the ledger; it reads it once
 * at load to seed `taskRecords` (`task-records-legacy-migration.ts`), and leaves
 * the stored key untouched so an older build can still read its own rows.
 *
 * Only the load-boundary normalization survives here, because that is all the
 * migration needs.
 */
export const TASK_RUN_HISTORY_VERSION = 1

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

export const EMPTY_TASK_RUN_HISTORY: TaskRunHistoryState = {
  version: TASK_RUN_HISTORY_VERSION,
  records: []
}

/** Kept identical to the writing build's cap so a migrated profile cannot grow
 *  past what the previous release would have stored. */
export const TASK_RUN_HISTORY_MAX_DELETED_RECORDS = 1500

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
      (record.state !== 'active' && record.state !== 'archived' && record.state !== 'deleted') ||
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

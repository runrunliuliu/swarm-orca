import type { ExecutionHostId } from './execution-host'
import {
  recordBytes,
  taskRecordExternalIndexKey,
  taskRecordSessionClaimKey,
  taskRecordsDomainBytes
} from './task-records'
import {
  TASK_RECORDS_MAX_BINDINGS_PER_RECORD,
  TASK_RECORDS_MAX_DOMAIN_BYTES,
  TASK_RECORDS_MAX_RECORD_BYTES,
  TASK_RECORDS_MAX_SESSIONS_PER_BINDING,
  type TaskRecord,
  type TaskRecordOrigin,
  type TaskRecordSession,
  type TaskRecordsState,
  type TaskUsageSettlement,
  type TaskWorkspaceBinding
} from './task-records-types'

/**
 * The pure state transitions of the `taskRecords` domain. Every writer goes
 * through one of these: the Store only picks the record, applies the transition
 * and schedules a save, so a rule (bound, conflict, idempotency) cannot be
 * re-implemented differently at a second call site.
 *
 * A refusal is a value, not an exception: the caller reports it and leaves the
 * stored state alone, which is what "reject and report a conflict, never
 * overwrite" (development plan §M2b A) has to mean for a durable record.
 */
export type TaskRecordsWriteResult =
  | {
      ok: true
      state: TaskRecordsState
      changed: boolean
      /** Sessions that did not fit the per-binding cap. Reported by the caller;
       *  never a silent truncation the reader cannot see. */
      dropped?: number
    }
  | { ok: false; reason: 'limit' | 'external_index_conflict' }

export type UpsertBindingInput = {
  taskId: string
  hostId: ExecutionHostId
  repoId: string
  worktreeId: string
  path: string
  isArchived: boolean
  origin: TaskRecordOrigin
  now: number
  boundBy?: TaskWorkspaceBinding['boundBy']
  /** Evidence for the locator. Defaults to `now` (the caller just resolved it);
   *  a migration from the legacy ledger passes `null` because it resolved nothing. */
  verifiedAt?: number | null
}

/** Insert or refresh the task → worktree binding. Creating a record is the only
 *  path that can be refused for an external-index conflict; refreshing one it
 *  already owns is not a conflict. */
export function upsertTaskRecordBinding(
  state: TaskRecordsState,
  input: UpsertBindingInput
): TaskRecordsWriteResult {
  const existing = state.byId[input.taskId]
  const indexKey = taskRecordIndexKeyOf(input)
  const indexOwner = indexKey === null ? undefined : state.externalIndex[indexKey]
  if (indexOwner !== undefined && indexOwner !== input.taskId) {
    return { ok: false, reason: 'external_index_conflict' }
  }

  if (!existing) {
    if (input.origin.kind !== 'external' && input.origin.kind !== 'workspace') {
      return { ok: false, reason: 'external_index_conflict' }
    }
    const binding = newBinding(input, input.now)
    const record: TaskRecord = {
      taskId: input.taskId,
      hostId: input.hostId,
      origin: input.origin,
      bindings: [binding],
      ...(input.origin.kind === 'workspace'
        ? { primaryWorktreeId: input.origin.primaryWorktreeId }
        : {}),
      intent: {},
      createdAt: input.now,
      updatedAt: input.now,
      schemaVersion: 1
    }
    return grown(state, record, indexKey, input.taskId)
  }

  // Host-qualified: `repoId::path` repeats across hosts, so a bare worktree id
  // would let one host's metadata write overwrite the other owner's binding.
  const bindingIndex = existing.bindings.findIndex(
    (binding) => binding.worktreeId === input.worktreeId && binding.hostId === input.hostId
  )
  if (bindingIndex === -1 && existing.bindings.length >= TASK_RECORDS_MAX_BINDINGS_PER_RECORD) {
    return { ok: false, reason: 'limit' }
  }
  const previous = bindingIndex === -1 ? null : existing.bindings[bindingIndex]
  if (
    previous &&
    previous.path === input.path &&
    previous.isArchived === input.isArchived &&
    previous.lastVerifiedAt !== null
  ) {
    return { ok: true, state, changed: false }
  }
  const bindings =
    bindingIndex === -1
      ? [...existing.bindings, newBinding(input, input.now)]
      : existing.bindings.map((binding, index) =>
          index === bindingIndex
            ? {
                ...binding,
                path: input.path,
                isArchived: input.isArchived,
                // Only ever upgraded to a real verification: a failed probe is
                // projected at read time, never written back as a rolled-back claim.
                lastVerifiedAt: input.now,
                resolvedVia: 'locator' as const
              }
            : binding
        )
  return grown(state, { ...existing, bindings, updatedAt: input.now }, indexKey, input.taskId)
}

/** The only growth paths go through here, so both bounds are checked exactly
 *  where the domain can grow — not on every unrelated update.
 *
 * Why the record bound matters as much as the domain bound: the load path drops
 * a record larger than `TASK_RECORDS_MAX_RECORD_BYTES`. A writer that accepted
 * one would report success and lose that task's history on the next start, which
 * is the exact failure this domain exists to prevent. */
function grown(
  state: TaskRecordsState,
  record: TaskRecord,
  indexKey: string | null,
  taskId: string,
  dropped?: number
): TaskRecordsWriteResult {
  if (recordBytes(record) > TASK_RECORDS_MAX_RECORD_BYTES) {
    return { ok: false, reason: 'limit' }
  }
  const next: TaskRecordsState = {
    ...state,
    byId: { ...state.byId, [record.taskId]: record },
    externalIndex:
      indexKey === null ? state.externalIndex : { ...state.externalIndex, [indexKey]: taskId }
  }
  if (taskRecordsDomainBytes(next) > TASK_RECORDS_MAX_DOMAIN_BYTES) {
    return { ok: false, reason: 'limit' }
  }
  return { ok: true, changed: true, state: next, ...(dropped === undefined ? {} : { dropped }) }
}

function newBinding(input: UpsertBindingInput, now: number): TaskWorkspaceBinding {
  return {
    worktreeId: input.worktreeId,
    repoId: input.repoId,
    hostId: input.hostId,
    path: input.path,
    isArchived: input.isArchived,
    boundAt: now,
    boundBy: input.boundBy ?? 'created',
    lastVerifiedAt: input.verifiedAt === undefined ? now : input.verifiedAt,
    ...(input.verifiedAt === null ? {} : { resolvedVia: 'locator' as const }),
    sessions: []
  }
}

function taskRecordIndexKeyOf(input: UpsertBindingInput): string | null {
  if (input.origin.kind !== 'external') {
    return null
  }
  return taskRecordExternalIndexKey({
    provider: input.origin.provider,
    repoId: input.repoId,
    itemType: input.origin.itemType,
    number: input.origin.number
  })
}

/** Merge what the workspace reported: one entry per provider claim, newest
 *  observation wins. A claim seen under two providers stays two entries — that is
 *  the ambiguity the reader must be able to see, not a duplicate to collapse. */
export function mergeTaskRecordBindingSessions(
  state: TaskRecordsState,
  args: {
    taskId: string
    worktreeId: string
    /** The owner whose workspace reported these sessions. Same-id owners on two
     *  hosts are two bindings and must not share one session list. */
    hostId: ExecutionHostId
    sessions: readonly TaskRecordSession[]
    now: number
  }
): TaskRecordsWriteResult {
  const record = state.byId[args.taskId]
  const binding = record?.bindings.find(
    (entry) => entry.worktreeId === args.worktreeId && entry.hostId === args.hostId
  )
  if (!record || !binding || args.sessions.length === 0) {
    return { ok: true, state, changed: false }
  }
  let changed = false
  let dropped = 0
  const sessions = [...binding.sessions]
  for (const incoming of args.sessions) {
    const claim = `${incoming.provider ?? 'unknown'}|${taskRecordSessionClaimKey(incoming)}`
    const index = sessions.findIndex(
      (existing) =>
        `${existing.provider ?? 'unknown'}|${taskRecordSessionClaimKey(existing)}` === claim
    )
    if (index === -1) {
      if (sessions.length >= TASK_RECORDS_MAX_SESSIONS_PER_BINDING) {
        // Counted, not silently skipped: the caller reports it, and the cap stays
        // a bound rather than a lie about what was stored.
        dropped += 1
        continue
      }
      sessions.push(incoming)
      changed = true
      continue
    }
    const existing = sessions[index]
    const transcriptPath = incoming.transcriptPath ?? existing.transcriptPath
    if (existing.lastSeenAt >= incoming.lastSeenAt && existing.transcriptPath === transcriptPath) {
      continue
    }
    sessions[index] = {
      ...existing,
      ...(transcriptPath ? { transcriptPath } : {}),
      lastSeenAt: Math.max(existing.lastSeenAt, incoming.lastSeenAt)
    }
    changed = true
  }
  if (!changed) {
    return { ok: true, state, changed: false, ...(dropped > 0 ? { dropped } : {}) }
  }
  return replaceBinding(state, record, { ...binding, sessions }, args.now, dropped)
}

/** Write the settled usage figure. Idempotent on `(worktreeId, collectedAt)`: a
 *  replay keeps the first snapshot instead of appending a second one. */
export function setTaskRecordBindingSettlement(
  state: TaskRecordsState,
  args: {
    taskId: string
    worktreeId: string
    hostId: ExecutionHostId
    settlement: TaskUsageSettlement
  }
): TaskRecordsWriteResult {
  const record = state.byId[args.taskId]
  const binding = record?.bindings.find(
    (entry) => entry.worktreeId === args.worktreeId && entry.hostId === args.hostId
  )
  if (!record || !binding) {
    return { ok: true, state, changed: false }
  }
  const previous = binding.usageSettlement
  if (
    previous?.worktreeId === args.settlement.worktreeId &&
    previous.collectedAt === args.settlement.collectedAt
  ) {
    return { ok: true, state, changed: false }
  }
  return replaceBinding(
    state,
    record,
    { ...binding, usageSettlement: args.settlement },
    args.settlement.collectedAt
  )
}

/** Every in-place growth of one binding goes through here, so a session or
 *  settlement write cannot slip past the bounds `grown()` enforces. */
function replaceBinding(
  state: TaskRecordsState,
  record: TaskRecord,
  binding: TaskWorkspaceBinding,
  now: number,
  dropped?: number
): TaskRecordsWriteResult {
  return grown(
    state,
    {
      ...record,
      bindings: record.bindings.map((entry) =>
        entry.worktreeId === binding.worktreeId && entry.hostId === binding.hostId
          ? binding
          : entry
      ),
      updatedAt: Math.max(record.updatedAt, now)
    },
    null,
    record.taskId,
    dropped
  )
}

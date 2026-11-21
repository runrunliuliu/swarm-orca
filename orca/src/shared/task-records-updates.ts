import type { ExecutionHostId } from './execution-host'
import { recordBytes, taskRecordExternalIndexKey, taskRecordsDomainBytes } from './task-records'
import { mergeRunRows, mergeSessionRows } from './task-records-runs-merge'
import {
  TASK_RECORDS_MAX_BINDINGS_PER_RECORD,
  TASK_RECORDS_MAX_DOMAIN_BYTES,
  TASK_RECORDS_MAX_RECORD_BYTES,
  TASK_RECORD_SCHEMA_VERSION,
  type TaskRecord,
  type TaskRecordGap,
  type TaskRecordOrigin,
  type TaskRecordRun,
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
      /** Present with `changed: false` when the call could not write anything for
       *  a reason the caller must not read as "already correct" (N3/N4):
       *  `missing_binding` — the record, or the `(worktreeId, hostId)` binding that
       *  was addressed, is not in `state` (a selection made against an older
       *  state); `settlement_downgrade` — the write would replace a measured
       *  (`known`) settlement with `unavailable`, so the stored figure stands.
       *  It lives on the success arm on purpose: `Extract<TaskRecordsWriteResult,
       *  { ok: false }>` call sites exist in seats B/C, and a new failure reason
       *  would break them for a signal that is not an error. */
      skipped?: 'missing_binding' | 'settlement_downgrade'
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
      // A record this build creates is a v2 record: it may hold runs, and a
      // build that only knows v1 must reject the domain rather than rebuild the
      // record without them.
      schemaVersion: TASK_RECORD_SCHEMA_VERSION
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

/** Merge what the workspace reported: one entry per provider claim. See
 *  `task-records-runs-merge.ts` for the precedence rule (newest fact wins, an
 *  absent fact never erases, provenance is first-writer-wins, the observation
 *  window is the union), which is also what makes a replayed call a no-op. A
 *  claim seen under two providers stays two entries — that is the ambiguity the
 *  reader must be able to see, not a duplicate to collapse. A record or binding
 *  that is not in `state` answers `{ ok: true, changed: false, skipped:
 *  'missing_binding' }`: nothing written, and the caller can tell that apart from
 *  "already holds this". */
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
  if (!record || !binding) {
    return { ok: true, state, changed: false, skipped: 'missing_binding' }
  }
  if (args.sessions.length === 0) {
    return { ok: true, state, changed: false }
  }
  const merged = mergeSessionRows(binding.sessions, args.sessions)
  if (!merged.changed) {
    return {
      ok: true,
      state,
      changed: false,
      ...(merged.dropped > 0 ? { dropped: merged.dropped } : {})
    }
  }
  return replaceBinding(
    state,
    record,
    { ...binding, sessions: merged.sessions },
    args.now,
    merged.dropped
  )
}

/** Merge the runs (and the binding-level gaps) one observation produced, keyed
 *  by the provider claim `provider|key:id`.
 *
 *  Over `TASK_RECORDS_MAX_RUNS_PER_BINDING` the whole call is refused
 *  (`{ ok: false, reason: 'limit' }`) and the stored state is left alone: a run
 *  row is used to conclude "this workspace did not run that agent", so dropping
 *  one quietly would be a false negative. Growth still goes through
 *  `replaceBinding`, so the record and domain byte bounds apply exactly as they
 *  do for every other write. A missing record/binding answers `{ ok: true,
 *  changed: false, skipped: 'missing_binding' }` (nothing written) rather than a
 *  bare "no change". */
export function mergeTaskRecordRuns(
  state: TaskRecordsState,
  args: {
    taskId: string
    worktreeId: string
    hostId: ExecutionHostId
    runs: readonly TaskRecordRun[]
    /** Absences that belong to the binding, not to one run
     *  (`session_unattributable`, `ambiguous_match`). */
    gaps?: readonly TaskRecordGap[]
    now: number
  }
): TaskRecordsWriteResult {
  const record = state.byId[args.taskId]
  const binding = record?.bindings.find(
    (entry) => entry.worktreeId === args.worktreeId && entry.hostId === args.hostId
  )
  if (!record || !binding) {
    return { ok: true, state, changed: false, skipped: 'missing_binding' }
  }
  const merged = mergeRunRows({
    existing: binding.runs ?? [],
    existingGaps: binding.gaps,
    runs: args.runs,
    gaps: args.gaps
  })
  if (merged.kind === 'limit') {
    return { ok: false, reason: 'limit' }
  }
  if (merged.kind === 'unchanged') {
    return { ok: true, state, changed: false }
  }
  return replaceBinding(
    state,
    record,
    {
      ...binding,
      runs: merged.runs,
      ...(merged.gaps === undefined ? {} : { gaps: merged.gaps })
    },
    args.now
  )
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
    return { ok: true, state, changed: false, skipped: 'missing_binding' }
  }
  const previous = binding.usageSettlement
  if (
    previous?.worktreeId === args.settlement.worktreeId &&
    previous.collectedAt === args.settlement.collectedAt
  ) {
    return { ok: true, state, changed: false }
  }
  // An `unavailable` snapshot never replaces a measured one: the same archive
  // workspace re-snapshotted (or snapshotted from a host that can see less) only
  // knows less, and "an absent fact never erases a stored one" is the rule
  // everywhere else in this domain. The stored figure keeps its own
  // `collectedAt`, so the row stays internally coherent, and `skipped` tells the
  // caller that nothing was written rather than that it was already settled.
  if (previous?.kind === 'known' && args.settlement.kind === 'unavailable') {
    return { ok: true, state, changed: false, skipped: 'settlement_downgrade' }
  }
  return replaceBinding(
    state,
    record,
    { ...binding, usageSettlement: args.settlement },
    args.settlement.collectedAt
  )
}

/** Every in-place growth of one binding goes through here, so a session, run or
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
        entry.worktreeId === binding.worktreeId && entry.hostId === binding.hostId ? binding : entry
      ),
      updatedAt: Math.max(record.updatedAt, now),
      // A v1 record stays v1 until a write actually stores a v2 fact: raising the
      // version on every unrelated refresh would make a downgrade lose the whole
      // domain for nothing.
      schemaVersion: carriesV2Facts(binding)
        ? Math.max(record.schemaVersion, TASK_RECORD_SCHEMA_VERSION)
        : record.schemaVersion
    },
    null,
    record.taskId,
    dropped
  )
}

/** True when the binding now holds something a build that only knows v1 could
 *  not read back. That is what `schemaVersion: 2` asserts, and it is why the
 *  version is raised by the content of the write rather than by the call site.
 *
 *  Every v2 channel counts, and `runs !== undefined` counts **including `runs: []`**:
 *  an empty array is the T2 statement "the snapshot writer looked and stored no
 *  run, here is the gap that says why", which a v1 build cannot read as anything
 *  but "unknown". Missing it let a T2 backfill store `runs`/`gaps` on a record
 *  still labelled v1. */
function carriesV2Facts(binding: TaskWorkspaceBinding): boolean {
  if (binding.runs !== undefined) {
    return true
  }
  if ((binding.gaps?.length ?? 0) > 0) {
    return true
  }
  return binding.sessions.some(
    (session) =>
      session.agentType !== undefined ||
      session.title !== undefined ||
      session.resumeCommand !== undefined ||
      session.startedAt !== undefined ||
      session.endedAt !== undefined ||
      session.messageCount !== undefined ||
      session.source !== undefined ||
      session.recordedAt !== undefined ||
      session.transcriptCheck !== undefined
  )
}

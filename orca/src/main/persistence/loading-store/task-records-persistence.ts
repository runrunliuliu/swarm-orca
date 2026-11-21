import type { ExecutionHostId } from '../../../shared/execution-host'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import type { TaskRunHistoryState } from '../../../shared/task-run-history'
import {
  isReadableTaskRecords,
  taskRecordForTask as lookupRecord,
  taskRecordTaskId,
  type TaskRecordLookup
} from '../../../shared/task-records'
import { EMPTY_TASK_RECORDS } from '../../../shared/task-records-types'
import {
  mergeTaskRecordBindingSessions,
  setTaskRecordBindingSettlement,
  upsertTaskRecordBinding,
  type TaskRecordsWriteResult
} from '../../../shared/task-records-updates'
import type {
  TaskRecord,
  TaskRecordsRemovalSnapshot,
  TaskRecordsState,
  TaskWorkspaceBinding
} from '../../../shared/task-records-types'
import {
  taskRecordLinksForWorktree,
  type TaskRecordLink
} from '../../../shared/task-records-worktree-links'
import type { TaskRecordsUsageSource } from '../../task-records/task-records-worktree-usage'
import {
  applyArchiveSnapshot,
  archiveLookupPlan,
  isArchiveTransition,
  type ArchiveSnapshotFollowUp
} from '../../task-records/task-records-archive-snapshot'
import { completeArchiveSnapshot } from '../../task-records/task-records-archive-enrichment'
import { migrateTaskRecordsFromRunHistory } from './task-records-legacy-migration'
import { scheduleSave } from './write-scheduling'
import type { WriteSchedulingOperations } from './write-scheduling'

/**
 * The single write point of the `taskRecords` domain (issue #36). Task metadata
 * is written in exactly one place (the worktree metadata operations), so the
 * binding set is derived there too; a second producer would be a second truth
 * about which task a workspace belongs to.
 *
 * Two rules this module owns:
 * - **fail closed**: a payload this build cannot read is never rewritten. The
 *   load path keeps it verbatim, and every function here returns early.
 * - **no blocked workspace work**: nothing here throws into a metadata write or
 *   a removal. A refusal is reported and the stored state is left alone, because
 *   a task ledger must not be able to break the workspace list.
 */

/** Only what these functions need, so a test can supply a plain state object
 *  instead of a whole Store. `StoreRuntimeState` satisfies it structurally. */
export type TaskRecordsRuntime = {
  state: {
    taskRecords?: TaskRecordsState
    /** The read-only legacy ledger; the lazy seed below is the only consumer. */
    taskRunHistory?: TaskRunHistoryState
    /** Only the metadata hook reads this; kept optional so a test can omit it. */
    worktreeMeta?: Record<string, WorktreeMeta>
  }
  taskRecordsUsageSource?: TaskRecordsUsageSource | null
}

/** A state whose legacy seed deferred once: the ledger is read-only in this
 *  build, so retrying inside the same process cannot succeed and would only
 *  repeat the warning on every metadata write. */
const legacySeedDeferredStates = new WeakSet<object>()

export function recordTaskRecordsForWorktreeMeta(
  runtime: TaskRecordsRuntime,
  worktreeId: string,
  meta: Pick<WorktreeMeta, 'isArchived'> & Parameters<typeof taskRecordLinksForWorktree>[1],
  /** Needed only to persist the asynchronous half of the archive snapshot; a
   *  caller that passes none still records the synchronous snapshot, it just cannot
   *  follow it up (see `archiveLookupPlan`). */
  scheduling?: WriteSchedulingOperations | null
): boolean {
  const stored = runtime.state.taskRecords
  if (!isReadableTaskRecords(stored)) {
    return false
  }
  const links = taskRecordLinksForWorktree(worktreeId, meta)
  // One metadata write is one instant: the transition's `recordedAt` and the
  // settlement's `collectedAt` must be the same moment as the flag they explain.
  const now = Date.now()
  const followUps: ArchiveSnapshotFollowUp[] = []
  let current = stored
  let changed = false
  if (current === undefined) {
    // The first metadata write must not create the domain before the legacy seed
    // has run: a deferred migration leaves it absent on purpose, and an empty
    // domain would be saved as "migrated" so the next start never retries
    // (issue #36 review B4). Refuse the write until a start can seed the ledger.
    if (legacySeedDeferredStates.has(runtime.state)) {
      return false
    }
    const migration = migrateTaskRecordsFromRunHistory(runtime.state.taskRunHistory)
    if (migration.kind === 'deferred') {
      legacySeedDeferredStates.add(runtime.state)
      return false
    }
    if (migration.kind === 'migrated') {
      current = migration.state
      changed = true
    } else {
      current = EMPTY_TASK_RECORDS
    }
  }
  for (const link of links) {
    const taskId = taskIdForLink(link)
    // Read the stored binding *before* the upsert: the archive snapshot happens
    // exactly when this write flips `isArchived` false → true (issue #53 A).
    const previous = bindingOf(current, taskId, worktreeId, link.hostId)
    const result = upsertTaskRecordBinding(current, {
      taskId,
      hostId: link.hostId,
      repoId: link.repoId,
      worktreeId,
      path: link.path,
      isArchived: meta.isArchived,
      origin: link.origin,
      now
    })
    if (!result.ok) {
      reportRefusal('record binding', worktreeId, result)
      continue
    }
    const beforeSnapshot = result.state
    current = result.state
    changed = changed || result.changed
    // A no-op refresh (`changed: false`) is an archive of an already-archived row:
    // no state change happened, so there is no irreversible moment to freeze.
    const archived = result.changed
      ? bindingOf(current, taskId, worktreeId, link.hostId)
      : undefined
    if (!archived || !isArchiveTransition(previous, archived)) {
      continue
    }
    const snapshot = applyArchiveSnapshot({
      state: current,
      taskId,
      binding: archived,
      usageSource: runtime.taskRecordsUsageSource ?? null,
      lookup: archiveLookupPlan({
        hostId: archived.hostId,
        hasLookup: Boolean(runtime.taskRecordsUsageSource?.archiveSnapshot),
        hasScheduling: scheduling != null
      }),
      now
    })
    if (snapshot.kind !== 'applied') {
      continue
    }
    current = snapshot.state
    changed = changed || current !== beforeSnapshot
    if (snapshot.followUp) {
      followUps.push(snapshot.followUp)
    }
  }
  if (changed) {
    runtime.state.taskRecords = current
  }
  // Fire-and-forget, and only after the synchronous write is in memory: the
  // degraded source is asynchronous, and awaiting it here would make every
  // metadata caller (`worktree.set`, `worktrees:updateMeta`) wait on a scan.
  for (const followUp of followUps) {
    void completeArchiveSnapshot({
      followUp,
      runtime,
      scheduling: scheduling ?? null,
      deps: runtime.taskRecordsUsageSource?.archiveSnapshot ?? null
    })
  }
  return changed
}

/** The owner-qualified binding of one task, if this domain already holds it. */
function bindingOf(
  state: TaskRecordsState,
  taskId: string,
  worktreeId: string,
  hostId: ExecutionHostId
): TaskWorkspaceBinding | undefined {
  return state.byId[taskId]?.bindings.find(
    (binding) => binding.worktreeId === worktreeId && binding.hostId === hostId
  )
}

/**
 * Settlement and session capture, run *before* the worktree row is dropped
 * (development plan §M2b C/E). The figures are read from the usage stores'
 * in-process snapshot; a failure here is reported and never thrown, so a broken
 * usage store cannot turn "delete this workspace" into an error the user cannot
 * get past.
 */
export function settleTaskRecordsBeforeRemoval(
  runtime: TaskRecordsRuntime,
  scheduling: WriteSchedulingOperations | null,
  worktreeId: string,
  now = Date.now(),
  /** The owner being removed. A host-qualified removal settles only that owner's
   *  binding; a full removal (`undefined`) settles every owner of the locator. */
  hostId?: ExecutionHostId
): boolean {
  const stored = runtime.state.taskRecords
  if (!isReadableTaskRecords(stored) || stored === undefined) {
    return false
  }
  const matchesOwner = (binding: TaskWorkspaceBinding): boolean =>
    binding.worktreeId === worktreeId && (hostId === undefined || binding.hostId === hostId)
  // Pair each record with every binding being removed: the same bare id can be
  // two owners, and a full removal (`hostId` absent) must settle all of them,
  // not only the first same-locator binding the record happens to carry.
  const affected: { record: TaskRecord; binding: TaskWorkspaceBinding }[] = []
  for (const record of Object.values(stored.byId)) {
    for (const binding of record.bindings.filter(matchesOwner)) {
      affected.push({ record, binding })
    }
  }
  if (affected.length === 0) {
    return false
  }
  const source = runtime.taskRecordsUsageSource
  if (!source) {
    return false
  }
  let current = stored
  try {
    // One snapshot per owner: the settlement is host-dependent (`remote_usage_
    // unavailable` off-local), and the sessions are shared by the locator.
    const snapshots = new Map<ExecutionHostId, TaskRecordsRemovalSnapshot>()
    for (const { record, binding } of affected) {
      let snapshot = snapshots.get(binding.hostId)
      if (!snapshot) {
        snapshot = source.snapshotForRemoval({ worktreeId, hostId: binding.hostId, now })
        snapshots.set(binding.hostId, snapshot)
      }
      // Sessions first, then the settlement: a refused session merge (the
      // per-binding cap) must not cost the figure that can never be read again.
      const withSessions = mergeTaskRecordBindingSessions(current, {
        taskId: record.taskId,
        worktreeId,
        hostId: binding.hostId,
        sessions: snapshot.sessions,
        now
      })
      if (withSessions.ok) {
        current = withSessions.state
        if (withSessions.dropped) {
          console.error(
            `[task-records] ${withSessions.dropped} sessions over the per-binding cap for ${worktreeId}`
          )
        }
      } else {
        reportRefusal('record sessions', worktreeId, withSessions)
      }
      const withSettlement = setTaskRecordBindingSettlement(current, {
        taskId: record.taskId,
        worktreeId,
        hostId: binding.hostId,
        settlement: snapshot.settlement
      })
      if (withSettlement.ok) {
        current = withSettlement.state
      } else {
        reportRefusal('record settlement', worktreeId, withSettlement)
      }
    }
  } catch (error) {
    // Never block the removal: the record simply keeps its previous state.
    console.error('[task-records] usage settlement failed', worktreeId, error)
    return false
  }
  if (current === stored) {
    return false
  }
  runtime.state.taskRecords = current
  if (scheduling) {
    scheduleSave(scheduling, ['taskRecords'])
  }
  return true
}

export function persistTaskRecords(scheduling: WriteSchedulingOperations, changed: boolean): void {
  if (changed) {
    scheduleSave(scheduling, ['taskRecords'])
  }
}

/** The one record of a task page; the lookup rules (provider-qualified or
 *  single-claim suffix match) live in the shared module, so the renderer's view
 *  of "which task is this" cannot differ from the writer's. */
export function taskRecordForTask(
  state: TaskRecordsState | undefined,
  query: TaskRecordLookup
): TaskRecord | null {
  return isReadableTaskRecords(state) ? lookupRecord(state, query) : null
}

function taskIdForLink(link: TaskRecordLink): string {
  if (link.origin.kind === 'workspace') {
    return `task:workspace:${link.origin.primaryWorktreeId}`
  }
  // The link already carries the repo registration this worktree belongs to, so
  // the id stays stable after the checkout is gone.
  return taskRecordTaskId({
    provider: link.origin.provider,
    repoId: link.repoId,
    itemType: link.origin.itemType,
    number: link.origin.number
  })
}

function reportRefusal(
  action: string,
  worktreeId: string,
  result: Extract<TaskRecordsWriteResult, { ok: false }>
): void {
  console.error(`[task-records] ${action} refused for ${worktreeId}: ${result.reason}`)
}

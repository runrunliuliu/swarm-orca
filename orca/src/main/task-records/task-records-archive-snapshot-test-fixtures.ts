import type { AiVaultSession } from '../../shared/ai-vault-types'
import type {
  TaskRecord,
  TaskRecordsState,
  TaskRecordSession,
  TaskRecordTranscriptCheck,
  TaskWorkspaceBinding
} from '../../shared/task-records-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import { recordTaskRecordsForWorktreeMeta } from '../persistence/loading-store/task-records-persistence'
import type { WriteSchedulingOperations } from '../persistence/loading-store/write-scheduling'
import type { ArchiveSnapshotFollowUp } from './task-records-archive-snapshot'
import { applyArchiveSnapshot } from './task-records-archive-snapshot'
import type { TaskRecordsUsageSource } from './task-records-worktree-usage'

/**
 * Fixtures shared by the two test files of this writer: the archive transition
 * itself (`task-records-archive-snapshot.test.ts`) and its asynchronous enrichment
 * (`task-records-archive-enrichment.test.ts`). Both drive the real write path, so a
 * fixture cannot state a binding shape the production code would not produce.
 */

export const ID = 'repo-1::/repo/feature'
export const TASK_ID = 'task:github:repo-1:issue:31'
export const SCHEDULING = {} as WriteSchedulingOperations

export function meta(overrides: Partial<WorktreeMeta> = {}): WorktreeMeta {
  return {
    displayName: 'Feature',
    comment: '',
    linkedIssue: 31,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 10,
    ...overrides
  }
}

export function claudeSession(id = 'session-1') {
  return {
    provider: 'claude' as const,
    key: 'session_id',
    id,
    transcriptPath: `/home/u/${id}.jsonl`,
    firstSeenAt: 500,
    lastSeenAt: 500
  }
}

/** One `stat` of that path, as the synchronous snapshot can only copy it from a
 *  source that already stated it. The pane path states a path and no check, which
 *  is the shape the follow-up exists for. */
export const TRANSCRIPT_CHECK: TaskRecordTranscriptCheck = {
  checkedAt: 400,
  presence: 'present',
  dev: 2_049,
  ino: 7,
  mtimeMs: 300,
  size: 4_096
}

export function checkedSession(id = 'session-1') {
  return { ...claudeSession(id), transcriptCheck: TRANSCRIPT_CHECK }
}

export function settlement(collectedAt: number) {
  return {
    kind: 'known' as const,
    collectedAt,
    scope: 'worktree-rollup' as const,
    worktreeId: ID,
    providers: [{ provider: 'claude' as const, tokens: 900, costUsd: 0.1 }],
    estimatedCostUsd: 0.1
  }
}

/** A usage source whose archive snapshot is the given rows. Both entry points are
 *  provided so the fallback (a source predating issue #53) is reached as well. */
export function source(
  rows: readonly TaskRecordSession[],
  collectedAt = 500
): TaskRecordsUsageSource {
  return {
    captureSessionsForRemoval: () => {},
    snapshotForRemoval: () => ({ settlement: settlement(collectedAt), sessions: [...rows] }),
    snapshotForArchive: () => ({ settlement: settlement(collectedAt), sessions: [...rows] })
  }
}

/** A runtime with room for the non-`taskRecords` keys the A5 projection compares. */
export function runtime(extra: Record<string, unknown> = {}): {
  state: { taskRecords?: TaskRecordsState } & Record<string, unknown>
  taskRecordsUsageSource: TaskRecordsUsageSource | null
} {
  return { state: { taskRecords: undefined, ...extra }, taskRecordsUsageSource: null }
}

export type FixtureRuntime = ReturnType<typeof runtime>

export function recordOf(state: TaskRecordsState | undefined): TaskRecord {
  const record = state?.byId[TASK_ID]
  if (!record) {
    throw new Error('the fixture expects a bound record')
  }
  return record
}

export function bindingOf(record: TaskRecord): TaskWorkspaceBinding {
  const binding = record.bindings[0]
  if (!binding) {
    throw new Error('the fixture expects one binding')
  }
  return binding
}

/** Bind the workspace through the real write path, then hand back what the archive
 *  transition receives: the stored binding. */
export function bind(rt: FixtureRuntime): TaskWorkspaceBinding {
  recordTaskRecordsForWorktreeMeta(rt, ID, meta())
  return bindingOf(recordOf(rt.state.taskRecords))
}

export function archive(
  rt: FixtureRuntime,
  binding: TaskWorkspaceBinding,
  options: {
    lookup?: 'pending' | 'no_lookup' | 'other_host'
    now?: number
    usage?: TaskRecordsUsageSource | null
  } = {}
) {
  return applyArchiveSnapshot({
    state: rt.state.taskRecords as TaskRecordsState,
    taskId: TASK_ID,
    binding,
    usageSource: options.usage === undefined ? source([claudeSession()]) : options.usage,
    lookup: options.lookup ?? 'no_lookup',
    now: options.now ?? 600
  })
}

export function applied(outcome: ReturnType<typeof archive>): {
  state: TaskRecordsState
  followUp: ArchiveSnapshotFollowUp | null
} {
  if (outcome.kind !== 'applied') {
    throw new Error(`expected an applied snapshot, got ${outcome.kind}`)
  }
  return { state: outcome.state, followUp: outcome.followUp }
}

// Relative to now: the binding's window starts at its real `boundAt` (a
// `Date.now()`), so a fixture with a fixed calendar date would fall outside it.
const SESSION_STARTED_AT = Date.now() - 3_600_000
const SESSION_ENDED_AT = Date.now() - 1_800_000

export function indexSession(overrides: Partial<AiVaultSession> = {}): AiVaultSession {
  return {
    id: 'local:claude:abc:/home/u/abc.jsonl',
    executionHostId: 'local',
    agent: 'claude',
    sessionId: 'abc',
    title: 'Fix the archive snapshot',
    cwd: '/repo/feature',
    branch: 'feature',
    model: 'claude-opus-4',
    filePath: '/home/u/abc.jsonl',
    codexHome: null,
    createdAt: new Date(SESSION_STARTED_AT).toISOString(),
    updatedAt: new Date(SESSION_ENDED_AT).toISOString(),
    modifiedAt: new Date(SESSION_ENDED_AT).toISOString(),
    messageCount: 12,
    totalTokens: 4321,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: 'claude --resume abc',
    subagent: null,
    ...overrides
  }
}

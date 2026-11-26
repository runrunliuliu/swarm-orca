import type {
  TaskRecord,
  TaskRecordRun,
  TaskRecordSession,
  TaskUsageSettlement,
  TaskWorkspaceBinding
} from '../../../../shared/task-records-types'
import type { TaskWorkbenchHistory } from '@/components/task-workbench/task-workbench-view'

export const HISTORY: TaskWorkbenchHistory = {
  agents: 2,
  wall: { kind: 'measured', startedAt: 1_000, endedAt: 2_000 },
  tokens: { kind: 'available', tokens: 1_320_000 },
  lastActivityAt: 2_000,
  archivedWorkspaces: 0,
  deletedWorkspaces: 0,
  tokensSource: 'live',
  workspaces: [],
  sessions: [],
  trace: 'none',
  runs: []
}

/**
 * One recorded run, as the snapshot writer stores it (issue #53): written out
 * field by field so a reader can check it against `task-records-types.ts`
 * without following a helper call.
 */
export const RUN: TaskRecordRun = {
  key: 'claude|session_id:run-1',
  providerSession: { provider: 'claude', key: 'session_id', id: 'run-1' },
  title: 'Wire the history fold',
  agentType: 'claude',
  startedAt: 5_000,
  endedAt: 8_000,
  messageCount: 12,
  outcome: 'success',
  transcriptPath: '/tmp/transcripts/run-1.jsonl',
  transcriptCheck: { checkedAt: 9_000, presence: 'present' },
  source: 'archive-snapshot',
  recordedAt: 9_000,
  firstSeenAt: 5_000,
  lastSeenAt: 8_000
}

export const SESSION: TaskRecordSession = {
  provider: 'claude',
  key: 'session_id',
  id: 's-1',
  agentType: 'claude',
  transcriptPath: '/tmp/transcripts/s-1.jsonl',
  transcriptCheck: { checkedAt: 9_000, presence: 'unverifiable' },
  source: 'backfill',
  recordedAt: 9_000,
  firstSeenAt: 5_000,
  lastSeenAt: 8_000
}

export const EMPTY_HISTORY: TaskWorkbenchHistory = {
  ...HISTORY,
  agents: null,
  wall: { kind: 'unknown' },
  tokens: { kind: 'unavailable', reason: 'unattributed' },
  runs: []
}

export function binding(
  worktreeId: string,
  overrides: Partial<TaskWorkspaceBinding> = {}
): TaskWorkspaceBinding {
  return {
    worktreeId,
    repoId: 'repo-1',
    hostId: 'local',
    path: `/repo/${worktreeId}`,
    isArchived: false,
    boundAt: 1_000,
    boundBy: 'created',
    lastVerifiedAt: 2_000,
    resolvedVia: 'locator',
    sessions: [],
    ...overrides
  }
}

export function record(bindings: TaskWorkspaceBinding[]): TaskRecord {
  return {
    taskId: 'task:repo-1:issue:31',
    hostId: 'local',
    origin: { kind: 'external', provider: 'github', itemType: 'issue', number: 31 },
    bindings,
    intent: {},
    createdAt: 1_000,
    updatedAt: 2_000,
    schemaVersion: 1
  }
}

export function settlement(
  worktreeId: string,
  value: TaskUsageSettlement = {
    kind: 'known',
    collectedAt: 3_000,
    scope: 'worktree-rollup',
    worktreeId,
    providers: [{ provider: 'claude', tokens: 420_000, costUsd: 0.7 }],
    estimatedCostUsd: 0.7
  }
): TaskUsageSettlement {
  return value
}

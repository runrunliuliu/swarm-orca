import type { TaskProviderIdentity } from './task-provider-identity'
import type {
  TaskRecordGap,
  TaskRecordItemType,
  TaskRecordRun,
  TaskRecordSession,
  TaskRecordTranscriptCheck,
  TaskWorkspaceBinding
} from './task-records-types'

export const HISTORY_TASK_EXPORT_SCHEMA_VERSION = 1

/** One stable, read-only view of a persisted task record. Every unknown fact is
 *  `null` (or a typed absent arm), never `0`: a missing settlement must not be
 *  printable as `0 tokens`, and a deleted workspace must not be printable as
 *  "never ran". The transcript is a path plus the stored `stat`; its content is
 *  never read or emitted. */
export type HistoryTaskExport = {
  schemaVersion: 1
  task: HistoryTaskIdentity
  bindings: HistoryTaskBinding[]
  agents: HistoryTaskAgents
  wall: HistoryTaskWall
  tokens: HistoryTaskTokens
  trace: 'archived' | 'deleted' | 'none'
  historySource: 'record'
  gaps: HistoryTaskGap[]
}

export type HistoryTaskIdentity = {
  taskId: string
  repoId: string
  hostId: string
  provider: string | null
  owner: string | null
  repo: string | null
  itemType: TaskRecordItemType | null
  number: number
  url: string | null
  title: string | null
  providerIdentity: TaskProviderIdentity | null
  createdAt: number
  updatedAt: number
  schemaVersion: number
}

export type HistoryTaskBindingState = 'live' | 'archived' | 'removed'

export type HistoryTaskBinding = {
  worktreeId: string
  repoId: string
  hostId: string
  path: string
  state: HistoryTaskBindingState
  isArchived: boolean
  boundAt: number
  boundBy: TaskWorkspaceBinding['boundBy']
  lastVerifiedAt: number | null
  resolvedVia: TaskWorkspaceBinding['resolvedVia'] | null
  sessions: HistoryTaskSession[]
  runs: HistoryTaskRun[]
  gaps: HistoryTaskGap[]
  usage: HistoryTaskUsage
}

export type HistoryTaskSession = {
  key: string
  provider: string | null
  providerKey: string
  id: string
  agentType: string | null
  title: string | null
  resumeCommand: string | null
  startedAt: number | null
  endedAt: number | null
  messageCount: number | null
  firstSeenAt: number
  lastSeenAt: number
  source: TaskRecordSession['source'] | null
  recordedAt: number | null
  transcriptPath: string | null
  transcriptCheck: HistoryTaskTranscriptCheck | null
}

export type HistoryTaskRun = {
  key: string
  provider: string | null
  providerKey: string
  sessionId: string
  title: string | null
  agentType: string | null
  resumeCommand: string | null
  startedAt: number | null
  endedAt: number | null
  messageCount: number | null
  outcome: Exclude<TaskRecordRun['outcome'], undefined> | null
  source: TaskRecordRun['source']
  recordedAt: number
  firstSeenAt: number
  lastSeenAt: number
  transcriptPath: string | null
  transcriptCheck: HistoryTaskTranscriptCheck | null
  gaps: HistoryTaskGap[]
}

/** One `stat`, never file content. Absent fields stay `null` instead of `0`. */
export type HistoryTaskTranscriptCheck = {
  presence: TaskRecordTranscriptCheck['presence']
  checkedAt: number
  dev: number | null
  ino: number | null
  mtimeMs: number | null
  size: number | null
}

export type HistoryTaskGap = {
  scope: 'binding' | 'run'
  runKey: string | null
  kind: TaskRecordGap['kind']
  candidateCount: number | null
  observedAt: number
  detail: string | null
  /** True when this gap is the whole state of a workspace with no row. */
  standalone: boolean
}

export type HistoryTaskAgents =
  | { kind: 'known'; count: number }
  | { kind: 'unknown'; reason: 'no_run_recorded' }

export type HistoryTaskWall =
  | { kind: 'measured'; startedAt: number; endedAt: number }
  | { kind: 'partial'; startedAt: number | null; endedAt: number | null; reason: 'edge_unmeasured' }
  | { kind: 'unknown'; reason: 'no_run_recorded' }

export type HistoryTaskTokens =
  | { kind: 'available'; tokens: number; estimatedCostUsd: number | null }
  | { kind: 'unavailable'; reason: string }

export type HistoryTaskUsage =
  | {
      kind: 'known'
      tokens: number
      costUsd: number | null
      collectedAt: number
      worktreeId: string
      providers: { provider: string; tokens: number; costUsd: number | null }[]
    }
  | { kind: 'unavailable'; reason: string; collectedAt: number; worktreeId: string }
  | { kind: 'unknown'; reason: 'unattributed' }

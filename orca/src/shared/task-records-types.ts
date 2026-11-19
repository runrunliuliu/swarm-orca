import type { AutomationRunUsageUnavailableReason } from './automations-types'
import type { ExecutionHostId } from './execution-host'
import type { TaskProviderIdentity } from './task-provider-identity'
import type { TaskProvider } from './task-providers'

/**
 * The `taskRecords` profile-state domain (design doc §8.3, development plan
 * §M2b). It stores the task entity and what a deleted workspace would otherwise
 * take with it: which worktrees ran it, the agent sessions those worktrees
 * reported, and the usage figure that was settled before the workspace stopped
 * being readable.
 *
 * What is deliberately absent: runtime state (needs you / working / done), agent
 * rows, message content and live token figures. Those stay derived from the one
 * authoritative store that owns them (design doc §8.4), so this domain can never
 * drift into a second opinion.
 *
 * The key shape is `task:<repoId>:<itemType>:<number>`. It carries no host id
 * because an Orca repo id already names one registration on one host, so two
 * hosts cannot collide (`externalKey` in §8.3 spells the host out for the same
 * reason; the repo id subsumes it). It does carry `itemType`, because issue #31
 * and PR #31 in one repository are two different tasks.
 */
export const TASK_RECORDS_VERSION = 1
export const TASK_RECORD_SCHEMA_VERSION = 1

/** Bounds (development plan §M2b A). A refusal is an error, never a truncation. */
export const TASK_RECORDS_MAX_BINDINGS_PER_RECORD = 64
export const TASK_RECORDS_MAX_SESSIONS_PER_BINDING = 32
/** 32 KiB, not the 8 KiB in the plan's table: that number cannot hold the same
 *  table's 64-binding limit, because one binding (worktree id, repo id, host,
 *  path, timestamps) is 150–250 bytes before any session. 32 KiB keeps both rules
 *  reachable and still bounds one record; the domain bound below is what caps the
 *  whole payload. */
export const TASK_RECORDS_MAX_RECORD_BYTES = 32 * 1024
export const TASK_RECORDS_MAX_DOMAIN_BYTES = 8 * 1024 * 1024

export const TASK_RECORD_USAGE_PROVIDERS = ['claude', 'codex', 'opencode', 'muse'] as const
export type TaskRecordUsageProvider = (typeof TASK_RECORD_USAGE_PROVIDERS)[number]

/** Same two values as the workbench page and the old ledger: a GitLab MR is a
 *  `pr` here, because the task page it opens is the same shape. */
export type TaskRecordItemType = 'issue' | 'pr'

export type TaskRecordOrigin =
  | {
      kind: 'external'
      provider: TaskProvider
      /** Provider-side identity when the workspace carried one; display only. */
      providerIdentity?: TaskProviderIdentity | null
      itemType: TaskRecordItemType
      number: number
      url?: string
      titleSnapshot?: string
      titleSnapshotAt?: number
    }
  | { kind: 'workspace'; primaryWorktreeId: string }

/** Which evidence resolved a binding's locator (§M2b D). */
export type TaskRecordResolvedVia = 'locator' | 'identity' | 'alias'

/**
 * One agent session a workspace reported. `key` is the provider's own field name
 * (`session_id`, `conversation_id`, …) rather than a union, so a provider this
 * build does not know yet still round-trips instead of being dropped.
 *
 * `provider` is absent when the pane's agent could not be identified (an agent
 * the user started by hand in a plain tab). Absent is "unknown", which is what
 * the ambiguity rule below needs: two providers claiming one `key:id` is not a
 * duplicate to merge, it is a claim this record may not resolve.
 */
export type TaskRecordSession = {
  provider?: TaskRecordUsageProvider
  key: string
  id: string
  transcriptPath?: string
  firstSeenAt: number
  lastSeenAt: number
}

export type TaskRecordUsageUnavailableReason = Extract<
  AutomationRunUsageUnavailableReason,
  | 'usage_not_enabled'
  | 'remote_usage_unavailable'
  | 'scan_failed'
  | 'no_matching_session'
  | 'ambiguous_session'
>

export type TaskUsageSettlementProvider = {
  provider: TaskRecordUsageProvider
  tokens: number
  /** Null means unpriced for this provider (Muse publishes no cost), never `$0`. */
  costUsd: number | null
}

/**
 * The usage figure written before the workspace stopped being readable
 * (development plan §M2b C). A union rather than `{ totalTokens, reason? }`
 * because a missing figure must not have a number field to print as `0`: the
 * unavailable arm has no `tokens`/`costUsd` member at all.
 *
 * It lives on the binding, not on the record, because the plan settles the
 * *removed binding's* workspace rollup; two removed workspaces of one task are
 * two snapshots, and a single record-level field would silently keep only the
 * last one.
 */
export type TaskUsageSettlement =
  | {
      kind: 'known'
      collectedAt: number
      scope: 'worktree-rollup'
      worktreeId: string
      providers: TaskUsageSettlementProvider[]
      /** Null when any contributing provider is unpriced: unknown, never 0. */
      estimatedCostUsd: number | null
    }
  | {
      kind: 'unavailable'
      collectedAt: number
      scope: 'worktree-rollup'
      worktreeId: string
      reason: TaskRecordUsageUnavailableReason
    }

export type TaskWorkspaceBinding = {
  worktreeId: string
  repoId: string
  hostId: ExecutionHostId
  /** Checkout path kept after deletion so a removed workspace can still be named. */
  path: string
  isArchived: boolean
  boundAt: number
  boundBy: 'created' | 'user' | 'reconciled'
  /** Null until evidence confirms the locator; never overwritten back to null. */
  lastVerifiedAt: number | null
  resolvedVia?: TaskRecordResolvedVia
  sessions: TaskRecordSession[]
  usageSettlement?: TaskUsageSettlement
}

export type TaskRecordIntent = {
  /** Set by the task-archive action; absent means "not archived", never "unknown". */
  archived?: boolean
  acceptance?: string
}

export type TaskRecordsRemovalSnapshot = {
  settlement: TaskUsageSettlement
  /** Provider sessions the workspace reported before it stopped being readable. */
  sessions: TaskRecordSession[]
}

export type TaskRecord = {
  taskId: string
  hostId: ExecutionHostId
  origin: TaskRecordOrigin
  /** 0..N. Order is bind order, which is what the panel renders. */
  bindings: TaskWorkspaceBinding[]
  primaryWorktreeId?: string
  intent: TaskRecordIntent
  createdAt: number
  updatedAt: number
  schemaVersion: number
}

export type TaskRecordsState = {
  recordsVersion: number
  byId: Record<string, TaskRecord>
  /** `<repoId>:<itemType>:<number>` → taskId; 0..1 per key (plan §M2b A). */
  externalIndex: Record<string, string>
}

export const EMPTY_TASK_RECORDS: TaskRecordsState = {
  recordsVersion: TASK_RECORDS_VERSION,
  byId: {},
  externalIndex: {}
}

export function isTaskRecordUsageProvider(value: unknown): value is TaskRecordUsageProvider {
  return TASK_RECORD_USAGE_PROVIDERS.some((provider) => provider === value)
}

export function isTaskRecordItemType(value: unknown): value is TaskRecordItemType {
  return value === 'issue' || value === 'pr'
}

export function isTaskRecordUsageUnavailableReason(
  value: unknown
): value is TaskRecordUsageUnavailableReason {
  return (
    value === 'usage_not_enabled' ||
    value === 'remote_usage_unavailable' ||
    value === 'scan_failed' ||
    value === 'no_matching_session' ||
    value === 'ambiguous_session'
  )
}

export function isTaskRecordResolvedVia(value: unknown): value is TaskRecordResolvedVia {
  return value === 'locator' || value === 'identity' || value === 'alias'
}

/**
 * False for a payload this build cannot interpret (an unknown `recordsVersion`
 * or a non-object `byId`). The load path keeps such a payload verbatim — it is
 * never replaced by an empty domain — and every writer refuses to run, which is
 * the fail-closed arm of development plan §M2b F.
 */
export function isReadableTaskRecords(value: unknown): value is TaskRecordsState {
  if (value === undefined) {
    return true
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  if (!('recordsVersion' in value) || value.recordsVersion !== TASK_RECORDS_VERSION) {
    return false
  }
  if (!('byId' in value)) {
    return false
  }
  const byId = value.byId
  if (typeof byId !== 'object' || byId === null || Array.isArray(byId)) {
    return false
  }
  if ('externalIndex' in value) {
    const externalIndex = value.externalIndex
    if (typeof externalIndex !== 'object' || externalIndex === null) {
      return false
    }
  }
  return true
}

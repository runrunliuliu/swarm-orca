import { taskUsageSettlementTokens } from '../shared/task-records'
import {
  HISTORY_TASK_EXPORT_SCHEMA_VERSION,
  type HistoryTaskBinding,
  type HistoryTaskExport,
  type HistoryTaskGap,
  type HistoryTaskIdentity,
  type HistoryTaskRun,
  type HistoryTaskSession,
  type HistoryTaskTranscriptCheck,
  type HistoryTaskUsage
} from '../shared/history-task-export-types'
import type { TaskProviderIdentity } from '../shared/task-provider-identity'
import type {
  TaskRecord,
  TaskRecordGap as TaskRecordGapType,
  TaskRecordRun as TaskRecordRunType,
  TaskRecordSession as TaskRecordSessionType,
  TaskRecordTranscriptCheck as TaskRecordTranscriptCheckType,
  TaskUsageSettlement,
  TaskWorkspaceBinding
} from '../shared/task-records-types'
import type { HistoryBackfillTask } from '../shared/history-backfill-command'
import { agentsOf, bindingState, tokensOf, traceOf, wallOf } from './history-task-export-facts'

export type * from '../shared/history-task-export-types'

/** The row source is the record itself: this command reads the persisted
 *  `taskRecords` domain and has no live pane projection to merge with. */
const HISTORY_SOURCE = 'record' as const

export function buildHistoryTaskExport(args: {
  record: TaskRecord
  repoId: string
  task: HistoryBackfillTask
  /** Raw worktree ids and, for host-qualified rows, `id\0hostId` keys. */
  existingWorktreeIds: Iterable<string>
}): HistoryTaskExport {
  const existing = new Set(args.existingWorktreeIds)
  const bindings = args.record.bindings.map((binding) => bindingView(binding, existing))
  const rows = historyRowsOf(args.record.bindings)
  return {
    schemaVersion: HISTORY_TASK_EXPORT_SCHEMA_VERSION,
    task: identityOf(args.record, args.repoId, args.task),
    bindings,
    agents: agentsOf(rows),
    wall: wallOf(rows),
    tokens: tokensOf(args.record.bindings),
    trace: traceOf(bindings),
    historySource: HISTORY_SOURCE,
    gaps: bindings.flatMap((binding) => binding.gaps)
  }
}

function identityOf(
  record: TaskRecord,
  repoId: string,
  task: HistoryBackfillTask
): HistoryTaskIdentity {
  const origin = record.origin
  const external = origin.kind === 'external' ? origin : null
  const names = ownerRepoOf(external?.providerIdentity)
  return {
    taskId: record.taskId,
    repoId,
    hostId: record.hostId,
    provider: external?.provider ?? null,
    owner: names.owner,
    repo: names.repo,
    itemType: external?.itemType ?? null,
    number: external?.number ?? task.number,
    url: external?.url ?? null,
    title: external?.titleSnapshot ?? null,
    providerIdentity: external?.providerIdentity ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    schemaVersion: record.schemaVersion
  }
}

function ownerRepoOf(identity: TaskProviderIdentity | null | undefined): {
  owner: string | null
  repo: string | null
} {
  if (!identity) {
    return { owner: null, repo: null }
  }
  switch (identity.provider) {
    case 'github':
      return { owner: identity.owner, repo: identity.repo }
    case 'gitlab':
      return { owner: identity.namespace ?? null, repo: identity.project ?? null }
    case 'linear':
      return { owner: identity.teamKey ?? identity.workspaceName ?? null, repo: null }
    case 'jira':
      return { owner: identity.projectKey ?? null, repo: null }
  }
}

/** The same row choice the workbench fold makes: a binding's runs when a build
 *  recorded them, otherwise the sessions it does have. A v1 record still ran
 *  agents, so its facts line must not read as "never ran". */
function historyRowsOf(
  bindings: readonly TaskWorkspaceBinding[]
): { startedAt: number | null; endedAt: number | null }[] {
  return bindings.flatMap((binding) =>
    (binding.runs ?? binding.sessions).map((row) => ({
      startedAt: row.startedAt ?? null,
      endedAt: row.endedAt ?? null
    }))
  )
}

function bindingView(
  binding: TaskWorkspaceBinding,
  existing: ReadonlySet<string>
): HistoryTaskBinding {
  const state = bindingState(binding, existing)
  const runs = (binding.runs ?? []).map((run) => runView(run))
  const bindingGaps = gapsOf(binding.gaps, 'binding', null, bindingRowCount(binding))
  const runGaps = (binding.runs ?? []).flatMap((run) => gapsOf(run.gaps, 'run', run.key, 1))
  return {
    worktreeId: binding.worktreeId,
    repoId: binding.repoId,
    hostId: binding.hostId,
    path: binding.path,
    state,
    isArchived: binding.isArchived,
    boundAt: binding.boundAt,
    boundBy: binding.boundBy,
    lastVerifiedAt: binding.lastVerifiedAt,
    resolvedVia: binding.resolvedVia ?? null,
    sessions: binding.sessions.map((session) => sessionView(session)),
    runs,
    gaps: [...bindingGaps, ...runGaps],
    usage: usageOf(binding.usageSettlement)
  }
}

function bindingRowCount(binding: TaskWorkspaceBinding): number {
  return (binding.runs ?? binding.sessions).length
}

function sessionView(session: TaskRecordSessionType): HistoryTaskSession {
  return {
    key: `${session.provider ?? 'unknown'}|${session.key}:${session.id}`,
    provider: session.provider ?? null,
    providerKey: session.key,
    id: session.id,
    agentType: session.agentType ?? null,
    title: session.title ?? null,
    resumeCommand: session.resumeCommand ?? null,
    startedAt: session.startedAt ?? null,
    endedAt: session.endedAt ?? null,
    messageCount: session.messageCount ?? null,
    firstSeenAt: session.firstSeenAt,
    lastSeenAt: session.lastSeenAt,
    source: session.source ?? null,
    recordedAt: session.recordedAt ?? null,
    transcriptPath: session.transcriptPath ?? null,
    transcriptCheck: checkOf(session.transcriptCheck)
  }
}

function runView(run: TaskRecordRunType): HistoryTaskRun {
  return {
    key: run.key,
    provider: run.providerSession.provider ?? null,
    providerKey: run.providerSession.key,
    sessionId: run.providerSession.id,
    title: run.title ?? null,
    agentType: run.agentType ?? null,
    resumeCommand: run.resumeCommand ?? null,
    startedAt: run.startedAt ?? null,
    endedAt: run.endedAt ?? null,
    messageCount: run.messageCount ?? null,
    outcome: run.outcome ?? null,
    source: run.source,
    recordedAt: run.recordedAt,
    firstSeenAt: run.firstSeenAt,
    lastSeenAt: run.lastSeenAt,
    transcriptPath: run.transcriptPath ?? null,
    transcriptCheck: checkOf(run.transcriptCheck),
    gaps: gapsOf(run.gaps, 'run', run.key, 1)
  }
}

function checkOf(
  check: TaskRecordTranscriptCheckType | undefined
): HistoryTaskTranscriptCheck | null {
  if (!check) {
    return null
  }
  return {
    presence: check.presence,
    checkedAt: check.checkedAt,
    dev: check.dev ?? null,
    ino: check.ino ?? null,
    mtimeMs: check.mtimeMs ?? null,
    size: check.size ?? null
  }
}

function usageOf(settlement: TaskUsageSettlement | undefined): HistoryTaskUsage {
  if (!settlement) {
    return { kind: 'unknown', reason: 'unattributed' }
  }
  if (settlement.kind === 'unavailable') {
    return {
      kind: 'unavailable',
      reason: settlement.reason,
      collectedAt: settlement.collectedAt,
      worktreeId: settlement.worktreeId
    }
  }
  const tokens = taskUsageSettlementTokens(settlement)
  if (tokens === null) {
    return { kind: 'unknown', reason: 'unattributed' }
  }
  return {
    kind: 'known',
    tokens,
    costUsd: settlement.estimatedCostUsd,
    collectedAt: settlement.collectedAt,
    worktreeId: settlement.worktreeId,
    providers: settlement.providers.map((provider) => ({
      provider: provider.provider,
      tokens: provider.tokens,
      costUsd: provider.costUsd
    }))
  }
}

function gapsOf(
  gaps: readonly TaskRecordGapType[] | undefined,
  scope: 'binding' | 'run',
  runKey: string | null,
  rowCount: number
): HistoryTaskGap[] {
  return (gaps ?? []).map((gap) => ({
    scope,
    runKey,
    kind: gap.kind,
    candidateCount: gap.candidateCount ?? null,
    observedAt: gap.observedAt,
    detail: gap.detail ?? null,
    standalone: scope === 'binding' && rowCount === 0
  }))
}

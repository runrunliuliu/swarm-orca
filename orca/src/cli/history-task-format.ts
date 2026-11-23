import { terminalSafe } from './agent-session-search-format'
import type {
  HistoryTaskAgents,
  HistoryTaskExport,
  HistoryTaskGap,
  HistoryTaskRun,
  HistoryTaskSession,
  HistoryTaskTokens,
  HistoryTaskUsage,
  HistoryTaskWall
} from './history-task-export'

/** Every free-form value a human reads is clipped after `terminalSafe`, so a
 *  provider title cannot move the cursor or run an OSC 52 payload. */
export const HISTORY_TASK_HUMAN_FIELD_LIMIT = 120

export function terminalSafeField(
  value: string,
  max: number = HISTORY_TASK_HUMAN_FIELD_LIMIT
): string {
  const oneLine = terminalSafe(value)
    .replaceAll(/[\r\n]+/g, ' ')
    .trim()
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, Math.max(0, max - 3))}...`
}

export function formatHistoryTaskExport(result: HistoryTaskExport): string {
  const live = result.bindings.filter((binding) => binding.state === 'live').length
  const archived = result.bindings.filter((binding) => binding.state === 'archived').length
  const removed = result.bindings.filter((binding) => binding.state === 'removed').length
  return [
    `task: ${taskLabel(result)}`,
    `host: ${terminalSafeField(result.task.hostId)}`,
    `bindings: ${result.bindings.length} (live ${countLabel(live)}, archived ${countLabel(archived)}, removed ${countLabel(removed)})`,
    `agents: ${formatAgents(result.agents)}`,
    `wall: ${formatWall(result.wall)}`,
    `tokens: ${formatTokens(result.tokens)}`,
    `trace: ${formatTrace(result.trace)}`,
    `historySource: ${result.historySource}`,
    `gaps: ${result.gaps.length === 0 ? 'none' : result.gaps.length}`,
    '',
    result.bindings.length === 0 ? 'workspaces: none' : 'workspaces:',
    ...result.bindings.flatMap(formatBinding),
    '',
    'runs:',
    ...(result.bindings.flatMap((binding) => binding.runs).length === 0
      ? ['none recorded (unknown, not zero)']
      : result.bindings.flatMap((binding) => binding.runs.flatMap(formatRun)))
  ].join('\n')
}

function taskLabel(result: HistoryTaskExport): string {
  const task = result.task
  const provider = task.provider ?? 'unknown-provider'
  const identity = [task.owner, task.repo].filter((part): part is string => part !== null)
  const repo = identity.length > 0 ? identity.join('/') : result.task.repoId
  return `${terminalSafeField(provider)} ${terminalSafeField(repo)}#${task.number} (${terminalSafeField(task.taskId)})`
}

function formatBinding(binding: HistoryTaskExport['bindings'][number]): string[] {
  const lines = [
    `- ${terminalSafeField(binding.worktreeId)} [${binding.state}] ${terminalSafeField(binding.path) || '(path not recorded)'}`,
    `  sessions: ${countLabel(binding.sessions.length)}, runs: ${countLabel(binding.runs.length)}`,
    `  usage: ${formatUsage(binding.usage)}`
  ]
  for (const session of binding.sessions) {
    lines.push(`  session: ${formatSession(session)}`)
  }
  for (const gap of binding.gaps) {
    lines.push(`  gap: ${formatGap(gap)}`)
  }
  return lines
}

function countLabel(value: number): string {
  return value === 0 ? 'none' : String(value)
}

function formatSession(session: HistoryTaskSession): string {
  const parts = [
    terminalSafeField(session.key),
    terminalSafeField(session.agentType ?? 'agent unknown'),
    ...(session.title === null ? [] : [terminalSafeField(session.title)]),
    `transcript: ${formatTranscript(session.transcriptPath, session.transcriptCheck)}`
  ]
  return parts.join(' · ')
}

function formatRun(run: HistoryTaskRun): string[] {
  const lines = [
    `- ${terminalSafeField(run.key)} ${terminalSafeField(run.agentType ?? 'agent unknown')}` +
      `${run.title === null ? '' : ` · ${terminalSafeField(run.title)}`}`,
    `  wall: ${formatEdges(run.startedAt, run.endedAt)}` +
      `${run.messageCount === null ? '' : ` · messages ${run.messageCount}`}` +
      `${run.outcome === null ? '' : ` · outcome ${terminalSafeField(run.outcome)}`}`,
    `  source: ${run.source}`,
    `  transcript: ${formatTranscript(run.transcriptPath, run.transcriptCheck)}`
  ]
  for (const gap of run.gaps) {
    lines.push(`  gap: ${formatGap(gap)}`)
  }
  return lines
}

function formatTranscript(path: string | null, check: HistoryTaskRun['transcriptCheck']): string {
  if (path === null) {
    return 'none recorded'
  }
  return `${terminalSafeField(path)} ${check === null ? '[never checked]' : `[${check.presence}]`}`
}

function formatAgents(agents: HistoryTaskAgents): string {
  return agents.kind === 'known' ? `${agents.count} recorded` : `unknown (${agents.reason})`
}

function formatWall(wall: HistoryTaskWall): string {
  if (wall.kind === 'measured') {
    return `${formatTime(wall.startedAt)} -> ${formatTime(wall.endedAt)} (measured)`
  }
  if (wall.kind === 'partial') {
    return `${formatMaybeTime(wall.startedAt)} -> ${formatMaybeTime(wall.endedAt)} (partial: ${wall.reason})`
  }
  return `unknown (${wall.reason})`
}

function formatTokens(tokens: HistoryTaskTokens): string {
  if (tokens.kind === 'unknown') {
    // Not `unknown (no_matching_session)` and not `0`: the record holds no
    // measurement at all, so the line names that absence instead of a scan.
    return 'not captured (this record holds no workspace settlement)'
  }
  if (tokens.kind === 'unavailable') {
    return `unavailable (${tokens.reason})`
  }
  const cost =
    tokens.estimatedCostUsd === null
      ? 'cost unknown'
      : `est. $${tokens.estimatedCostUsd.toFixed(2)}`
  const partial =
    tokens.kind === 'partial' ? ' (partial: at least one workspace was not captured)' : ''
  return `${tokens.tokens} tokens settled${partial} · ${cost}`
}

function formatUsage(usage: HistoryTaskUsage): string {
  if (usage.kind === 'unknown') {
    return `unknown (${usage.reason})`
  }
  if (usage.kind === 'unavailable') {
    return `unavailable (${usage.reason})`
  }
  return (
    `${usage.tokens} tokens settled at ${formatTime(usage.collectedAt)}` +
    `${usage.costUsd === null ? ' · cost unknown' : ` · est. $${usage.costUsd.toFixed(2)}`}`
  )
}

function formatGap(gap: HistoryTaskGap): string {
  const run = gap.runKey === null ? '' : ` run=${terminalSafeField(gap.runKey)}`
  const candidates = gap.candidateCount === null ? '' : ` candidates=${gap.candidateCount}`
  const detail = gap.detail === null ? '' : ` detail=${terminalSafeField(gap.detail)}`
  const standalone = gap.standalone ? ' (whole workspace)' : ''
  return `${gap.scope}${run} ${gap.kind}${candidates}${detail}${standalone}`
}

function formatTrace(trace: HistoryTaskExport['trace']): string {
  if (trace === 'archived') {
    return 'archived (the workspace content is still on this machine)'
  }
  if (trace === 'deleted') {
    return 'deleted (the recorded trace is out of reach)'
  }
  return 'none (no archived or removed workspace is recorded)'
}

function formatEdges(startedAt: number | null, endedAt: number | null): string {
  return `${formatMaybeTime(startedAt)} -> ${formatMaybeTime(endedAt)}`
}

function formatMaybeTime(value: number | null): string {
  return value === null ? 'unknown' : formatTime(value)
}

function formatTime(value: number): string {
  return new Date(value).toISOString()
}

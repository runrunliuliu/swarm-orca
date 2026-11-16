// Render one incident as markdown (issue-sedimentation.md v2.2 §9).
//
// This is a *derived view*: nothing is stored here and everything is rebuildable from the row plus
// its decisions. M1 renders exactly one incident on demand (`orca incident show <id> --md`); the
// long-lived "one file per fingerprint" view needs stable clustering and is explicitly out of scope.
//
// Two rules the renderer must not break:
//   * it only states facts it can point at — mechanism analysis and guardrails are review-stage
//     output, so an unattended render says "未填写" rather than guessing;
//   * unknowns are a required section, not a footnote. An incident with no recorded unknown is more
//     suspicious than one that lists them.

import { describeTerminalExitCause, type TerminalExitCause } from '../../shared/terminal-exit-cause'
import type { IncidentArchiveDetail } from './incident-archive'
import type { EvidenceArchiveState } from './incident-archive'
import type { IncidentEvidence, IncidentView } from './incident-types'

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

function describeExitCause(cause: unknown): string {
  if (typeof cause === 'object' && cause !== null && 'kind' in cause) {
    const typed = cause as TerminalExitCause
    if (['operator_close', 'signaled', 'exited', 'unknown'].includes(typed.kind)) {
      const detail =
        typed.kind === 'signaled'
          ? `kind=signaled, signal=${typed.signal}`
          : typed.kind === 'exited'
            ? `kind=exited, exitCode=${typed.exitCode}`
            : typed.kind === 'unknown'
              ? `kind=unknown, reason=${typed.reason}`
              : 'kind=operator_close'
      return `${describeTerminalExitCause(typed)} (${detail})`
    }
  }
  return '未记录（exit_cause 缺失）'
}

function archiveStateLabel(state: EvidenceArchiveState | undefined): string {
  if (state === undefined) {
    return 'not staged'
  }
  if (state === 'archive_pending') {
    return 'pending'
  }
  if (state === 'archive_incomplete') {
    return 'incomplete'
  }
  return state
}

/**
 * What the renderer may say about durability.
 *
 * Why this is computed and not asserted: M8-4 gave a pointer a state machine, so "durable=false" written
 * as a constant became a false statement the moment a drain archived the excerpt. When the caller
 * supplies no archive detail (a view built without the store) the renderer says the state is unknown
 * rather than claiming either answer.
 */
function archiveVerdict(
  pointerCount: number,
  archive: IncidentArchiveDetail | undefined
): string[] {
  if (pointerCount === 0) {
    return ['本记录没有证据指针：`durable=false` 表示“未提供证据”，不是“归档失败”（§16）。']
  }
  if (archive === undefined) {
    return ['未读取归档状态：`durable` 未知，不得作为已归档证据使用（§16）。']
  }
  const { summary } = archive
  if (summary.durable) {
    return [`全部 ${summary.pointers} 个证据指针已归档且回读 sha256 相符：\`durable=true\`。`]
  }
  return [
    `证据未全部归档：archived=${summary.archived}/${summary.pointers}、pending=${summary.pending}、` +
      `staged=${summary.staged}、incomplete=${summary.incomplete} → \`durable=false\`，` +
      '不得作为已归档证据使用（§16）。'
  ]
}

function evidenceRows(
  evidence: IncidentEvidence,
  archive: IncidentArchiveDetail | undefined
): string[] {
  const statesByIndex = new Map<number, EvidenceArchiveState>(
    (archive?.states ?? []).map((state) => [state.pointerIndex, state.state])
  )
  const lines: string[] = []
  if (evidence.pointers.length === 0) {
    lines.push('- 未记录证据指针（M1 崩溃路径只收集运行时可得且仍在的指针）。')
  } else {
    lines.push(
      '| kind | path | bytes | sha256 | offsets | archived |',
      '| --- | --- | --- | --- | --- | --- |'
    )
    for (const [index, pointer] of evidence.pointers.entries()) {
      const offsets =
        pointer.startOffset === undefined
          ? '—'
          : `${pointer.startOffset}..${pointer.endOffset ?? '?'}${
              pointer.truncated === true ? ' (truncated)' : ''
            }`
      lines.push(
        `| ${pointer.kind} | \`${pointer.path}\` | ${pointer.bytes ?? '—'} | ` +
          `${pointer.sha256 ?? '—'} | ${offsets} | ${archiveStateLabel(statesByIndex.get(index))} |`
      )
    }
  }
  lines.push('', ...archiveVerdict(evidence.pointers.length, archive))
  return lines
}

function unknownSection(evidence: IncidentEvidence): string[] {
  if (evidence.unknownBoundaries.length === 0) {
    return ['- 未记录未知边界（这本身是一个缺口：M1 未逐项枚举）。']
  }
  return evidence.unknownBoundaries.map((boundary) => `- ${boundary}`)
}

function decisionRows(view: IncidentView): string[] {
  if (view.decisions.length === 0) {
    return [`无 triage 决策：状态仍为入口状态 \`${view.status}\`。`]
  }
  const lines = ['| time | from → to | actor | reason |', '| --- | --- | --- | --- |']
  for (const decision of view.decisions) {
    lines.push(
      `| ${iso(decision.createdAt)} | ${decision.fromStatus} → ${decision.toStatus} | ` +
        `${decision.actor} | ${decision.reason.replaceAll('|', '\\|')} |`
    )
  }
  return lines
}

/**
 * Render a single incident. Deterministic: same row + same decisions produce the same markdown, so
 * `--md` output can be diffed across runs.
 */
export function renderIncidentMarkdown(
  view: IncidentView,
  options: { archive?: IncidentArchiveDetail } = {}
): string {
  const lines: string[] = []
  lines.push(`# Incident \`${view.id}\``, '')
  lines.push(`- class: \`${view.class}\``)
  lines.push(
    `- status: \`${view.status}\` (entry) → \`${view.effectiveStatus}\` (effective, ` +
      `${view.decisionCount} decision${view.decisionCount === 1 ? '' : 's'})`
  )
  lines.push(`- created: ${iso(view.createdAt)} (${view.createdAt})`)
  lines.push(`- host: \`${view.hostId}\``)
  lines.push(`- source: \`${view.sourceKind}/${view.sourceId}\` facet \`${view.facet}\``)
  lines.push(`- fingerprint: \`${view.fingerprint}\``)
  lines.push(`- worktree: ${view.worktreeId ?? '—'}`)
  lines.push(`- run / task / dispatch: ${view.runId ?? '—'} / ${view.taskId ?? '—'} / ${view.dispatchId ?? '—'}`)
  lines.push(`- agent session: ${view.agentSessionId ?? '—'}`)
  lines.push(`- pty incarnation: ${view.ptyIncarnationId ?? '—'}`)
  lines.push('')

  lines.push('## 1. 摘要', '')
  lines.push(view.summary.length > 0 ? view.summary : '未记录摘要。')
  lines.push('')

  lines.push('## 2. 背景与预期', '')
  lines.push('- 派发契约原文: 未记录（M1 只保存指针，不保存正文）。')
  lines.push('- 期望行为: 未记录。')
  lines.push(`- 实际: ${describeExitCause(view.exitCause)}`)
  lines.push('')

  lines.push('## 3. 时间线', '')
  lines.push('| time | fact | source |', '| --- | --- | --- |')
  lines.push(`| ${iso(view.createdAt)} | incident 写入（class \`${view.class}\`） | 本记录 |`)
  for (const decision of view.decisions) {
    lines.push(
      `| ${iso(decision.createdAt)} | triage: ${decision.fromStatus} → ${decision.toStatus} | decision \`${decision.id}\` |`
    )
  }
  lines.push(
    '',
    '未记录事件流水：M1 不重放 journal/transcript，`begin/end` 成对时间线需要事件源接入（M2+）。'
  )
  lines.push('')

  lines.push('## 4. 机制分析', '')
  lines.push('未填写：自动渲染只写事实；根因与"哪一层本该拦住"由审查阶段填写（§9）。')
  lines.push('')

  lines.push('## 5. 未知边界', '')
  lines.push(...unknownSection(view.evidence))
  lines.push('')

  lines.push('## 6. 证据与 pin', '')
  lines.push(...evidenceRows(view.evidence, options.archive))
  lines.push('')

  lines.push('## 7. 防复发项', '')
  lines.push('未填写：guardrail / 处置在 triage 阶段产出，关闭门见 §8。')
  lines.push('')

  lines.push('## 决策记录', '')
  lines.push(...decisionRows(view))
  lines.push('')
  return lines.join('\n')
}

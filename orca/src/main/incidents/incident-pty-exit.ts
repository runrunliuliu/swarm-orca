// Turning one PTY exit into an incident (issue-sedimentation.md v2.2 §7.1).
//
// The write point is `onPtyExit`, which is the only place that holds the exit cause, and this file
// is the part of it that is pure: given the facts collected *before* cleanup, decide whether this is
// an incident and, if so, describe it.
//
// What is deliberately NOT here: any judgement that the software is buggy. A fatal exit is a fact;
// whether it is a defect is R1's call (§5). This is why every record starts `untriaged` and why an
// unknown cause is recorded as `unknown` instead of being folded into `failed`.

import type { TerminalExitCause } from '../../shared/terminal-exit-cause'
import { describeTerminalExitCause } from '../../shared/terminal-exit-cause'
import { buildIncidentKey, incidentFingerprint } from './incident-key'
import type { IncidentEvidence, IncidentRecord } from './incident-types'

/** Which side of the product the PTY belonged to. The surface is worth keeping: an SSH relay's
 *  missing exit confirmation is the canonical "unknown" case (§7.1). */
export type PtyExitSurface = 'local' | 'ssh'

export type PtyExitIncidentFacts = {
  ptyId: string
  /** Null when the runtime never admitted an incarnation; the key cannot be built then. */
  incarnationId: string | null
  /** Resolved from launch authority *before* `retirePtyAgentLaunchAuthority` deletes the receipt. */
  paneKey: string | null
  worktreeId: string | null
  agentSessionId: string | null
  /** A digest, never a raw session id (see incidents-types evidence body). */
  agentIdentityDigest?: string | null
  exitCode: number
  exitCause: TerminalExitCause
  hostExitConfirmed: boolean
  providerExitObserved: boolean
  surface: PtyExitSurface
  /** Whether any agent binding survived up to the exit (launch authority, status row, foreground,
   *  or an agent-session owner claim). */
  hasAgentBinding: boolean
  /** The incarnation id was synthesized from runtime+PTY identity because none was ever observed. */
  incarnationIdIsFallback?: boolean
}

export type PtyExitAssessment =
  | { write: true }
  | {
      write: false
      reason:
        | 'operator_close'
        | 'clean_exit'
        | 'unknown_without_agent_binding'
        | 'missing_incarnation'
    }

/**
 * §7.1's predicate, in one place.
 *
 * `unknown` is the subtle branch. It means "the process ended and nothing here can say why" — that
 * is exactly the case a post-mortem needs, so it is recorded *when there was an agent in the pane*.
 * A bare shell exiting with an ambiguous zero is indistinguishable from `exit` typed by the user,
 * and recording every one of those would bury the real crashes (§11.4 noise rule). `operator_close`
 * is never an incident: Orca asked for that teardown.
 */
export function assessPtyExit(facts: PtyExitIncidentFacts): PtyExitAssessment {
  if (facts.exitCause.kind === 'operator_close') {
    return { write: false, reason: 'operator_close' }
  }
  if (facts.incarnationId === null || facts.incarnationId.trim().length === 0) {
    return { write: false, reason: 'missing_incarnation' }
  }
  if (facts.exitCause.kind === 'exited' && facts.exitCause.exitCode === 0) {
    return { write: false, reason: 'clean_exit' }
  }
  if (facts.exitCause.kind === 'unknown' && !facts.hasAgentBinding) {
    return { write: false, reason: 'unknown_without_agent_binding' }
  }
  return { write: true }
}

function exitSignature(cause: TerminalExitCause): string[] {
  switch (cause.kind) {
    case 'operator_close':
      return ['operator_close']
    case 'signaled':
      return ['signaled', `signal:${cause.signal}`]
    case 'exited':
      return ['exited', `code:${cause.exitCode}`]
    case 'unknown':
      return ['unknown', `reason:${cause.reason}`]
  }
}

function unknownBoundaries(facts: PtyExitIncidentFacts): string[] {
  const boundaries: string[] = [
    'transcript 指针未收集：M1 在退出路径只做一次快照，不读、不复制 transcript 正文。',
    'run/task/dispatch 指针未解析：M1 的退出写点不查询编排表，避免把生命周期查询带进清理路径。'
  ]
  if (facts.incarnationIdIsFallback === true) {
    boundaries.push(
      '没有观测到 PTY incarnation id：幂等键由 runtime+pty 身份派生，因此同一 ptyId 的重生' +
        '无法与重复回调区分（会被并入同一行）。'
    )
  }
  if (facts.paneKey === null) {
    boundaries.push('paneKey 未解析：该 pane 的状态行可能未被清理，事后无法按 pane 关联。')
  }
  if (facts.exitCause.kind === 'unknown') {
    boundaries.push(
      `退出原因不可知（${facts.exitCause.reason}）：进程可能仍在运行，也可能是干净结束；不得按失败处理。`
    )
  }
  if (facts.surface === 'ssh' && !facts.hostExitConfirmed) {
    boundaries.push('SSH 宿主未确认退出：relay 断开与进程死亡无法区分。')
  }
  if (!facts.agentIdentityDigest) {
    boundaries.push('agent session 身份摘要未取得：退出时 PTY 记录不再持有 claim。')
  }
  return boundaries
}

function summaryFor(facts: PtyExitIncidentFacts): string {
  const parts = [
    describeTerminalExitCause(facts.exitCause),
    facts.surface === 'ssh' ? 'over ssh' : 'locally',
    facts.worktreeId ? `in worktree ${facts.worktreeId}` : 'without a worktree binding',
    facts.paneKey ? `pane ${facts.paneKey}` : 'pane key unresolved'
  ]
  // Long enough to identify, short enough to scan in a list; the store redacts it again on insert.
  return parts.join('; ').slice(0, 300)
}

export type PtyExitRecordContext = {
  id: string
  hostId: string
  createdAt: number
  /** Carried into `evidence.pointers`; empty in M1, non-empty once a transcript path is collected. */
  evidencePointers?: IncidentEvidence['pointers']
}

/**
 * Build the immutable row. Only called when `assessPtyExit` said `write: true`.
 *
 * The key is built here, not by the store: §6.2.1 puts epoch construction on the writer, and a key
 * that cannot be built is a *skip*, never a fallback to the bare entity id.
 */
export function buildPtyExitIncidentRecord(
  facts: PtyExitIncidentFacts,
  context: PtyExitRecordContext
): { ok: true; record: IncidentRecord } | { ok: false; reason: string } {
  const key = buildIncidentKey({ kind: 'pty_exit', ptyIncarnationId: facts.incarnationId })
  if (!key.ok) {
    return { ok: false, reason: `incident_key_${key.reason}` }
  }
  const evidence: IncidentEvidence = {
    pointers: context.evidencePointers ?? [],
    unknownBoundaries: unknownBoundaries(facts),
    ...(facts.agentIdentityDigest ? { agentIdentityDigest: facts.agentIdentityDigest } : {})
  }
  return {
    ok: true,
    record: {
      id: context.id,
      sourceKind: key.sourceKind,
      sourceId: key.sourceId,
      facet: key.facet,
      hostId: context.hostId,
      worktreeId: facts.worktreeId,
      runId: null,
      taskId: null,
      dispatchId: null,
      agentSessionId: facts.agentSessionId,
      ptyIncarnationId: facts.incarnationId,
      class: 'crash',
      status: 'untriaged',
      exitCause: facts.exitCause,
      fingerprint: incidentFingerprint({
        class: 'crash',
        sourceKind: key.sourceKind,
        facet: key.facet,
        signature: [...exitSignature(facts.exitCause), `surface:${facts.surface}`]
      }),
      evidence,
      summary: summaryFor(facts),
      createdAt: context.createdAt
    }
  }
}

/**
 * §7.1's predicate and record shape. The cases that matter are the quiet ones: a clean exit and an
 * operator close must not create incidents, and an unknown cause must stay `unknown` — never
 * `failed` — while still being recorded when an agent was in the pane.
 */
import { describe, expect, it } from 'vitest'
import { assessPtyExit, buildPtyExitIncidentRecord, type PtyExitIncidentFacts } from './incident-pty-exit'

function facts(overrides: Partial<PtyExitIncidentFacts> = {}): PtyExitIncidentFacts {
  return {
    ptyId: 'wt-1__pty-1',
    incarnationId: 'ptyinc-1',
    paneKey: 'tab-1:leaf-1',
    worktreeId: 'wt-1',
    agentSessionId: null,
    agentIdentityDigest: null,
    exitCode: 137,
    exitCause: { kind: 'signaled', signal: 9 },
    hostExitConfirmed: true,
    providerExitObserved: true,
    surface: 'local',
    hasAgentBinding: true,
    ...overrides
  }
}

describe('assessPtyExit', () => {
  it('writes for a signalled death', () => {
    expect(assessPtyExit(facts())).toEqual({ write: true })
  })

  it('writes for a non-zero exit status', () => {
    expect(
      assessPtyExit(facts({ exitCode: 1, exitCause: { kind: 'exited', exitCode: 1 } }))
    ).toEqual({ write: true })
  })

  it('never writes for an operator close', () => {
    expect(assessPtyExit(facts({ exitCause: { kind: 'operator_close' } }))).toEqual({
      write: false,
      reason: 'operator_close'
    })
  })

  it('never writes for a clean zero exit', () => {
    expect(assessPtyExit(facts({ exitCode: 0, exitCause: { kind: 'exited', exitCode: 0 } }))).toEqual(
      { write: false, reason: 'clean_exit' }
    )
  })

  it('writes an unknown cause when an agent was in the pane, and skips a bare shell', () => {
    const unknown = facts({ exitCause: { kind: 'unknown', reason: 'stop_unverified' } })
    expect(assessPtyExit(unknown)).toEqual({ write: true })
    expect(assessPtyExit({ ...unknown, hasAgentBinding: false })).toEqual({
      write: false,
      reason: 'unknown_without_agent_binding'
    })
  })

  it('skips when no incarnation exists, because the key cannot carry an epoch', () => {
    expect(assessPtyExit(facts({ incarnationId: null }))).toEqual({
      write: false,
      reason: 'missing_incarnation'
    })
  })
})

describe('buildPtyExitIncidentRecord', () => {
  const context = { id: 'inc_1', hostId: 'host-a', createdAt: 1_700_000_000_000 }

  it('records a crash with the exit cause verbatim and an untriaged status', () => {
    const built = buildPtyExitIncidentRecord(facts(), context)
    expect(built.ok).toBe(true)
    if (!built.ok) {
      return
    }
    expect(built.record).toMatchObject({
      id: 'inc_1',
      class: 'crash',
      status: 'untriaged',
      sourceKind: 'pty_exit',
      sourceId: 'ptyinc-1',
      facet: 'exit',
      ptyIncarnationId: 'ptyinc-1',
      exitCause: { kind: 'signaled', signal: 9 }
    })
    expect(built.record.fingerprint).toMatch(/^[0-9a-f]{64}$/)
  })

  it('keeps unknown unknown and says why in the unknown boundaries', () => {
    const built = buildPtyExitIncidentRecord(
      facts({
        exitCode: -1,
        exitCause: { kind: 'unknown', reason: 'stop_unverified' },
        hostExitConfirmed: false
      }),
      context
    )
    expect(built.ok).toBe(true)
    if (!built.ok) {
      return
    }
    expect(built.record.exitCause).toEqual({ kind: 'unknown', reason: 'stop_unverified' })
    expect(built.record.status).toBe('untriaged')
    expect(built.record.evidence.unknownBoundaries.join(' ')).toMatch(/不得按失败处理/)
  })

  it('records the SSH-unconfirmed boundary without escalating the class', () => {
    const built = buildPtyExitIncidentRecord(
      facts({
        surface: 'ssh',
        hostExitConfirmed: false,
        exitCode: -1,
        exitCause: { kind: 'unknown', reason: 'stop_unverified' }
      }),
      context
    )
    expect(built.ok).toBe(true)
    if (!built.ok) {
      return
    }
    expect(built.record.class).toBe('crash')
    expect(built.record.evidence.unknownBoundaries.join(' ')).toMatch(/SSH 宿主未确认退出/)
  })

  it('surfaces the missing pane key as an unknown boundary instead of dropping it', () => {
    const built = buildPtyExitIncidentRecord(facts({ paneKey: null }), context)
    expect(built.ok).toBe(true)
    if (!built.ok) {
      return
    }
    expect(built.record.evidence.unknownBoundaries.join(' ')).toMatch(/paneKey 未解析/)
  })

  it('refuses to build a record when the key has no epoch', () => {
    const built = buildPtyExitIncidentRecord(facts({ incarnationId: null }), context)
    expect(built).toEqual({ ok: false, reason: 'incident_key_missing_epoch' })
  })

  it('records that a synthesized incarnation id cannot distinguish a respawn', () => {
    const built = buildPtyExitIncidentRecord(
      facts({ incarnationId: 'runtime-0123456789abcdef0123456789abcdef', incarnationIdIsFallback: true }),
      context
    )
    expect(built.ok).toBe(true)
    if (!built.ok) {
      return
    }
    expect(built.record.evidence.unknownBoundaries.join(' ')).toMatch(/incarnation id/)
    expect(built.record.evidence.unknownBoundaries.join(' ')).toMatch(/同一 ptyId/)
  })

  it('never copies transcript bodies — pointers only', () => {
    const built = buildPtyExitIncidentRecord(
      facts(),
      {
        ...context,
        evidencePointers: [{ kind: 'transcript', path: '/tmp/t.jsonl', startOffset: 0, endOffset: 10 }]
      }
    )
    expect(built.ok).toBe(true)
    if (!built.ok) {
      return
    }
    expect(built.record.evidence.pointers).toEqual([
      { kind: 'transcript', path: '/tmp/t.jsonl', startOffset: 0, endOffset: 10 }
    ])
    expect(JSON.stringify(built.record.evidence)).not.toMatch(/user|assistant/)
  })
})

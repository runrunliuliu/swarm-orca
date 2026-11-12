/**
 * The four duplicate-key failures §6.2.1 names, each as its own case. These are not style tests:
 * a bare-entity key silently *loses* a real failure, and nothing later can tell that it happened.
 */
import { describe, expect, it } from 'vitest'
import { buildIncidentKey, fallbackPtyIncarnationId, incidentFingerprint } from './incident-key'

function key(input: Parameters<typeof buildIncidentKey>[0]) {
  const result = buildIncidentKey(input)
  if (!result.ok) {
    throw new Error(`expected an ok key, got ${result.reason}`)
  }
  return result
}

describe('status_stall epoch (paneKey + stateStartedAt)', () => {
  it('treats a second stall of the same pane as a different incident', () => {
    const first = key({
      kind: 'status_stall',
      paneKey: 'tab-1:leaf-1',
      stateStartedAt: 1_700_000_000_000
    })
    const second = key({
      kind: 'status_stall',
      paneKey: 'tab-1:leaf-1',
      stateStartedAt: 1_700_000_600_000
    })
    expect(second.sourceId).not.toBe(first.sourceId)
    expect(first.sourceId).toBe('tab-1:leaf-1:1700000000000')
    expect(second.sourceId).toBe('tab-1:leaf-1:1700000600000')
  })

  it('is stable for the same epoch, and numeric/string spellings agree', () => {
    const numeric = key({ kind: 'status_stall', paneKey: 'tab-1:leaf-1', stateStartedAt: 1_700_000_000_000 })
    const asString = key({ kind: 'status_stall', paneKey: 'tab-1:leaf-1', stateStartedAt: '1700000000000' })
    expect(asString).toEqual(numeric)
  })

  it('rejects a stall with no epoch instead of falling back to the bare pane key', () => {
    expect(buildIncidentKey({ kind: 'status_stall', paneKey: 'tab-1:leaf-1', stateStartedAt: undefined })).toEqual({
      ok: false,
      reason: 'missing_epoch'
    })
    expect(buildIncidentKey({ kind: 'status_stall', paneKey: 'tab-1:leaf-1', stateStartedAt: null })).toEqual({
      ok: false,
      reason: 'missing_epoch'
    })
  })

  it('rejects a malformed pane key', () => {
    expect(buildIncidentKey({ kind: 'status_stall', paneKey: 'leaf-only', stateStartedAt: 1 })).toEqual({
      ok: false,
      reason: 'missing_entity'
    })
  })
})

describe('acceptance epoch (dispatchId + attempt, facet per rule)', () => {
  it('keeps two rules on one dispatch apart', () => {
    const tests = key({ kind: 'acceptance', dispatchId: 'disp-1', attempt: 2, ruleId: 'tests' })
    const archive = key({ kind: 'acceptance', dispatchId: 'disp-1', attempt: 2, ruleId: 'archive_hash' })
    expect(tests.facet).toBe('rule:tests')
    expect(archive.facet).toBe('rule:archive_hash')
    expect(tests.sourceId).toBe(archive.sourceId)
    expect([tests.facet, archive.facet]).toHaveLength(2)
  })

  it('keeps a retry of the same rule apart from the original attempt', () => {
    const attempt2 = key({ kind: 'acceptance', dispatchId: 'disp-1', attempt: 2, ruleId: 'tests' })
    const attempt3 = key({ kind: 'acceptance', dispatchId: 'disp-1', attempt: 3, ruleId: 'tests' })
    expect(attempt3.sourceId).not.toBe(attempt2.sourceId)
  })

  it('rejects an acceptance verdict with no attempt or no rule', () => {
    expect(buildIncidentKey({ kind: 'acceptance', dispatchId: 'disp-1', attempt: null, ruleId: 'tests' })).toEqual({
      ok: false,
      reason: 'missing_epoch'
    })
    expect(buildIncidentKey({ kind: 'acceptance', dispatchId: 'disp-1', attempt: 2, ruleId: null })).toEqual({
      ok: false,
      reason: 'missing_entity'
    })
  })
})

describe('tool_error epoch (session + turn + code + window)', () => {
  it('keeps the same tool error in two turns apart', () => {
    const turn7 = key({ kind: 'tool_error', sessionId: 's-1', turn: 7, code: 'rate_limited', windowStart: 1_700_000_000_000 })
    const turn8 = key({ kind: 'tool_error', sessionId: 's-1', turn: 8, code: 'rate_limited', windowStart: 1_700_000_000_000 })
    expect(turn8.sourceId).not.toBe(turn7.sourceId)
    expect(turn7.sourceId).toBe('s-1:7:rate_limited:1700000000000')
  })

  it('is stable inside one burst window', () => {
    const first = key({ kind: 'tool_error', sessionId: 's-1', turn: 7, code: 'rate_limited', windowStart: 1_000 })
    const second = key({ kind: 'tool_error', sessionId: 's-1', turn: 7, code: 'rate_limited', windowStart: 1_000 })
    expect(second).toEqual(first)
  })

  it('rejects a burst with no turn rather than merging turns', () => {
    expect(
      buildIncidentKey({ kind: 'tool_error', sessionId: 's-1', turn: undefined, code: 'c', windowStart: 1 })
    ).toEqual({ ok: false, reason: 'missing_epoch' })
  })
})

describe('pty_exit epoch (incarnation id)', () => {
  it('is stable per incarnation', () => {
    const first = key({ kind: 'pty_exit', ptyIncarnationId: 'inc-abc' })
    const second = key({ kind: 'pty_exit', ptyIncarnationId: 'inc-abc' })
    expect(second).toEqual(first)
    expect(first).toMatchObject({ sourceKind: 'pty_exit', sourceId: 'inc-abc', facet: 'exit' })
  })

  it('keeps a respawned PTY apart', () => {
    const first = key({ kind: 'pty_exit', ptyIncarnationId: 'inc-abc' })
    const second = key({ kind: 'pty_exit', ptyIncarnationId: 'inc-def' })
    expect(second.sourceId).not.toBe(first.sourceId)
  })

  it('rejects a missing incarnation instead of writing a bare-id row', () => {
    expect(buildIncidentKey({ kind: 'pty_exit', ptyIncarnationId: null })).toEqual({
      ok: false,
      reason: 'missing_epoch'
    })
    expect(buildIncidentKey({ kind: 'pty_exit', ptyIncarnationId: '   ' })).toEqual({
      ok: false,
      reason: 'invalid_epoch'
    })
  })
})

describe('fallback incarnation id (no epoch was ever observed)', () => {
  it('produces a key the store will accept: no field separator, fixed width', () => {
    const fallback = fallbackPtyIncarnationId('runtime-1', 'wt-1__pty-1')
    expect(fallback).not.toContain(':')
    expect(fallback).toMatch(/^runtime-[0-9a-f]{32}$/)
    expect(buildIncidentKey({ kind: 'pty_exit', ptyIncarnationId: fallback })).toMatchObject({
      ok: true,
      sourceId: fallback,
      facet: 'exit'
    })
  })

  it('is stable for the same runtime and pty, and distinct across them', () => {
    const first = fallbackPtyIncarnationId('runtime-1', 'wt-1__pty-1')
    expect(fallbackPtyIncarnationId('runtime-1', 'wt-1__pty-1')).toBe(first)
    expect(fallbackPtyIncarnationId('runtime-1', 'wt-1__pty-2')).not.toBe(first)
    expect(fallbackPtyIncarnationId('runtime-2', 'wt-1__pty-1')).not.toBe(first)
  })

  it('does not depend on a moving counter: the previous template was unstorable', () => {
    // The old fallback was `runtime:<id>:<generation>`, which the separator rule rejects outright.
    expect(
      buildIncidentKey({ kind: 'pty_exit', ptyIncarnationId: 'runtime:rt:7' })
    ).toEqual({ ok: false, reason: 'invalid_epoch' })
    // The replacement must therefore not be shaped like it.
    expect(fallbackPtyIncarnationId('rt', 'pty')).not.toMatch(/^runtime:/)
  })
})

describe('fingerprint', () => {
  it('is stable for the same failure shape and ignores the epoch', () => {
    const a = incidentFingerprint({
      class: 'crash',
      sourceKind: 'pty_exit',
      facet: 'exit',
      signature: ['signaled', 'signal:9', 'surface:local']
    })
    const b = incidentFingerprint({
      class: 'crash',
      sourceKind: 'pty_exit',
      facet: 'exit',
      signature: ['signaled', 'signal:9', 'surface:local']
    })
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })

  it('separates different exit shapes', () => {
    const killed = incidentFingerprint({
      class: 'crash',
      sourceKind: 'pty_exit',
      facet: 'exit',
      signature: ['signaled', 'signal:9']
    })
    const unknown = incidentFingerprint({
      class: 'crash',
      sourceKind: 'pty_exit',
      facet: 'exit',
      signature: ['unknown', 'reason:stop_unverified']
    })
    expect(killed).not.toBe(unknown)
  })
})

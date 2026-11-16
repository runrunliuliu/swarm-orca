/**
 * One line → two facts, JSON parsed once (§11.2; A7).
 *
 * The merge that matters is the validation split: replay reads `seq` first and only rebuilds the
 * record for a line above the watermark, so the merged parser must keep both rejection subsets and
 * their order. These tests pin the reasons, not the messages, because the reasons are what the replay
 * stop and the mirror cursor report.
 */
import { describe, expect, it } from 'vitest'
import { INCIDENT_SHADOW_VERSION } from './incident-shadow'
import {
  ShadowRecordError,
  incidentRecordFromShadowLine,
  parseShadowLine,
  shadowLineSeq
} from './incident-shadow-line'

type LineOverrides = Record<string, unknown>

function line(overrides: LineOverrides = {}): string {
  return JSON.stringify({
    v: INCIDENT_SHADOW_VERSION,
    seq: 7,
    id: 'inc_1',
    source_kind: 'pty_exit',
    source_id: 'ptyinc-1',
    facet: 'exit',
    host_id: 'host-a',
    worktree_id: 'wt-1',
    run_id: null,
    task_id: null,
    dispatch_id: null,
    agent_session_id: null,
    pty_incarnation_id: 'ptyinc-1',
    class: 'crash',
    status: 'untriaged',
    exit_cause: { kind: 'signaled', signal: 9 },
    fingerprint: 'f'.repeat(64),
    evidence: { pointers: [], unknownBoundaries: [] },
    summary: 'agent killed',
    created_at: 1_700_000_000_000,
    ...overrides
  })
}

/** The typed reason a parse threw; fails loudly on a non-typed throw or no throw at all. */
function reasonOf(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    if (error instanceof ShadowRecordError) {
      return error.reason
    }
    throw error
  }
  throw new Error('expected a ShadowRecordError')
}

describe('parseShadowLine: one parse, two facts', () => {
  it('returns the seq and the rebuilt record', () => {
    const parsed = parseShadowLine(line())
    expect(parsed.seq).toBe(7)
    expect(parsed.record).toMatchObject({
      id: 'inc_1',
      sourceKind: 'pty_exit',
      sourceId: 'ptyinc-1',
      facet: 'exit',
      hostId: 'host-a',
      class: 'crash',
      status: 'untriaged',
      createdAt: 1_700_000_000_000
    })
  })
})

describe('parseShadowLine: the seq subset is judged first', () => {
  it('keeps unparsable_json for a line that is not JSON', () => {
    expect(reasonOf(() => parseShadowLine('not-json'))).toBe('unparsable_json')
  })

  it('keeps invalid_record for a JSON value that is not an object', () => {
    expect(reasonOf(() => parseShadowLine('42'))).toBe('invalid_record')
    expect(reasonOf(() => parseShadowLine('null'))).toBe('invalid_record')
  })

  it('keeps unsupported_version for a body version this build does not know', () => {
    expect(reasonOf(() => parseShadowLine(line({ v: 1 })))).toBe('unsupported_version')
    expect(reasonOf(() => parseShadowLine(line({ v: undefined })))).toBe('unsupported_version')
  })

  it('keeps invalid_record for a line with no usable seq', () => {
    expect(reasonOf(() => parseShadowLine(line({ seq: 0 })))).toBe('invalid_record')
    expect(reasonOf(() => parseShadowLine(line({ seq: '7' })))).toBe('invalid_record')
    expect(reasonOf(() => parseShadowLine(line({ seq: 1.5 })))).toBe('invalid_record')
    expect(reasonOf(() => parseShadowLine(line({ seq: undefined })))).toBe('invalid_record')
  })

  it('never looks at the body while judging the seq', () => {
    // A line replay would skip on seq alone: the seq is readable even though the body is not.
    const parsed = parseShadowLine(line({ id: undefined, source_kind: 'nope' }))
    expect(parsed.seq).toBe(7)
    expect(reasonOf(() => parsed.record)).toBe('invalid_record')
  })
})

describe('parseShadowLine: the record subset is judged on read', () => {
  it('keeps the key check before source_kind', () => {
    expect(reasonOf(() => parseShadowLine(line({ id: undefined })).record)).toBe('invalid_record')
    expect(() => parseShadowLine(line({ id: undefined })).record).toThrow(/missing its key/)
  })

  it('keeps the source_kind check before class/status and created_at', () => {
    expect(() =>
      parseShadowLine(line({ source_kind: 'nope', class: 'nope', created_at: undefined })).record
    ).toThrow(/source_kind/)
    expect(() =>
      parseShadowLine(line({ class: 'nope', status: 'nope', created_at: undefined })).record
    ).toThrow(/class\/status/)
    expect(() => parseShadowLine(line({ created_at: undefined })).record).toThrow(/created_at/)
  })

  it('reports the same typed reason on a repeated read', () => {
    const parsed = parseShadowLine(line({ fingerprint: undefined }))
    expect(reasonOf(() => parsed.record)).toBe('invalid_record')
    expect(reasonOf(() => parsed.record)).toBe('invalid_record')
  })
})

describe('shadowLineSeq / incidentRecordFromShadowLine keep their own subsets', () => {
  it('both share the version check, so neither drifts', () => {
    expect(reasonOf(() => shadowLineSeq(line({ v: 1 })))).toBe('unsupported_version')
    expect(reasonOf(() => incidentRecordFromShadowLine(line({ v: 1 })))).toBe('unsupported_version')
  })

  it('the seq reader does not judge the body', () => {
    expect(shadowLineSeq(line({ id: undefined }))).toBe(7)
  })

  it('the record reader reports unparsable_json as a typed reason too', () => {
    // It used to let JSON.parse's SyntaxError escape; the typed reason is what every caller maps.
    expect(reasonOf(() => incidentRecordFromShadowLine('not-json'))).toBe('unparsable_json')
  })
})

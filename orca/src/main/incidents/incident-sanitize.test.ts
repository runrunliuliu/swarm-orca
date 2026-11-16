/**
 * One sanitize layer, three consumers (M2-C2): a report write, a store insert, and a shadow replay.
 * The shadow is a plain file anyone can append to, so replay has to assume hostile input.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { buildSelfReportRecord } from './incident-report'
import { sanitizeEvidence, sanitizeIncidentRecord, sanitizeText } from './incident-sanitize'
import { incidentRecordFromShadowLine } from './incident-shadow-line'
import { closeStorePairs, openStorePair, record } from './incident-test-fixture'

const SECRETS = [
  'sk-ant-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH',
  'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
  'Authorization: Bearer abcdef1234567890'
]

afterEach(() => {
  closeStorePairs()
})

describe('sanitizeEvidence', () => {
  it('redacts repro, boundary strings and pointer paths', () => {
    const evidence = sanitizeEvidence({
      pointers: [{ kind: 'transcript', path: `/tmp/${SECRETS[0]}.jsonl` }],
      unknownBoundaries: [`blocked by ${SECRETS[2]}`],
      code: 'tool_schema_mismatch',
      repro: `run with ${SECRETS[1]}`
    })
    const serialized = JSON.stringify(evidence)
    for (const secret of SECRETS) {
      expect(serialized).not.toContain(secret)
    }
    expect(evidence.code).toBe('tool_schema_mismatch')
    expect(evidence.pointers).toHaveLength(1)
  })

  it('keeps only well-formed pointers and bounded text', () => {
    const evidence = sanitizeEvidence({
      pointers: [
        { kind: 'transcript', path: '' },
        { kind: 'nonsense', path: '/tmp/a.log', sha256: 'nothex' },
        { kind: 'events', path: '/tmp/b.log', bytes: -1 }
      ],
      unknownBoundaries: ['ok', 42]
    })
    // Empty path dropped; unknown kind becomes `other`; an invalid digest/size is dropped, not kept
    // as a claim. The pointer itself survives because its path is usable.
    expect(evidence.pointers).toEqual([
      { kind: 'other', path: '/tmp/a.log' },
      { kind: 'events', path: '/tmp/b.log' }
    ])
    expect(evidence.unknownBoundaries).toEqual(['ok'])
  })
})

describe('sanitizeText', () => {
  it('redacts and truncates', () => {
    expect(sanitizeText(`key ${SECRETS[0]}`)).not.toContain(SECRETS[0])
    expect(sanitizeText('x'.repeat(50), 10)).toHaveLength(10)
    expect(sanitizeText(undefined)).toBe('')
  })
})

describe('the three write paths', () => {
  it('normal write: a report with a secret repro never reaches the row', () => {
    const { store } = openStorePair()
    const built = buildSelfReportRecord({
      class: 'tool_error',
      code: 'tool_schema_mismatch',
      sourceId: 'req-secret',
      repro: `run with ${SECRETS[1]}`,
      summary: `token ${SECRETS[0]}`
    })
    store.insertIncident(built)
    const view = store.getIncident(store.listIncidents().incidents[0].id)!
    const serialized = JSON.stringify(view)
    for (const secret of SECRETS) {
      expect(serialized).not.toContain(secret)
    }
  })

  it('DB insert: an unsanitized record is cleaned before it lands', () => {
    const { store } = openStorePair()
    store.insertIncident(
      record({
        // This suite's row is a bare self-report keyed by `req-1` outside any Run or worktree.
        id: 'inc_secret',
        sourceId: 'req-1',
        runId: null,
        worktreeId: null,
        summary: `oops ${SECRETS[0]}`,
        evidence: {
          pointers: [{ kind: 'transcript', path: `/tmp/${SECRETS[2]}.log` }],
          unknownBoundaries: [`note ${SECRETS[1]}`],
          repro: `repro ${SECRETS[1]}`
        }
      })
    )
    const serialized = JSON.stringify(store.getIncident('inc_secret'))
    for (const secret of SECRETS) {
      expect(serialized).not.toContain(secret)
    }
  })

  it('shadow replay: a hostile line is sanitized on the way in', () => {
    const { store } = openStorePair()
    const hostile = JSON.stringify({
      v: 2,
      seq: 1,
      id: 'inc_hostile',
      source_kind: 'self_report',
      source_id: 'req-hostile',
      facet: 'report',
      host_id: 'host-a',
      worktree_id: null,
      run_id: null,
      task_id: null,
      dispatch_id: null,
      agent_session_id: null,
      pty_incarnation_id: null,
      class: 'tool_error',
      status: 'untriaged',
      exit_cause: null,
      fingerprint: 'f'.repeat(64),
      evidence: {
        pointers: [{ kind: 'transcript', path: `/tmp/${SECRETS[0]}` }],
        unknownBoundaries: [`x ${SECRETS[2]}`],
        repro: `y ${SECRETS[1]}`
      },
      summary: `z ${SECRETS[0]}`,
      created_at: 1_700_000_000_000
    })
    const rebuilt = incidentRecordFromShadowLine(hostile)
    store.insertIncident(rebuilt)
    const serialized = JSON.stringify(store.getIncident('inc_hostile'))
    for (const secret of SECRETS) {
      expect(serialized).not.toContain(secret)
    }
  })

  it('is idempotent: sanitizing twice changes nothing', () => {
    const once = sanitizeIncidentRecord(
      record({ summary: `x ${SECRETS[0]}`, evidence: { pointers: [], unknownBoundaries: [`y ${SECRETS[1]}`] } })
    )
    expect(sanitizeIncidentRecord(once)).toEqual(once)
  })
})

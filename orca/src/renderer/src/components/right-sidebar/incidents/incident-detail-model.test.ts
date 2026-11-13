// The detail projections (§9, §12; M7-B): exit cause, evidence pointers, timeline, decision outcomes.
//
// These are the rules the drawer must not soften: `unknown` stays unknown, a missing pointer is a gap,
// a byte offset is not a line, and no decision is ever collapsed or reordered.
import { describe, expect, it } from 'vitest'
import {
  incidentDecisionOutcomeView,
  incidentDecisionTimeline,
  incidentEvidenceDisplayPath,
  incidentEvidenceRows,
  incidentExitCauseView
} from './incident-detail-model'
import type { IncidentDecisionDto } from '../../../../../shared/incident-api-types'

describe('incidentExitCauseView', () => {
  it('keeps unknown as unknown with its reason', () => {
    expect(incidentExitCauseView({ kind: 'unknown', reason: 'stop_unverified' })).toEqual({
      kind: 'unknown',
      reason: 'stop_unverified'
    })
  })

  it('reads signalled and exited without inventing a cause for a zero code', () => {
    expect(incidentExitCauseView({ kind: 'signaled', signal: 9 })).toEqual({
      kind: 'signaled',
      signal: 9
    })
    expect(incidentExitCauseView({ kind: 'exited', exitCode: 0 })).toEqual({
      kind: 'exited',
      exitCode: 0
    })
  })

  it('reports a missing cause as not_recorded rather than a clean exit', () => {
    expect(incidentExitCauseView(null)).toEqual({ kind: 'not_recorded' })
    expect(incidentExitCauseView(undefined)).toEqual({ kind: 'not_recorded' })
    expect(incidentExitCauseView('signaled')).toEqual({ kind: 'not_recorded' })
  })

  it('shows an unrecognised shape raw instead of guessing', () => {
    expect(incidentExitCauseView({ kind: 'mystery' })).toEqual({
      kind: 'unrecognised',
      raw: '{"kind":"mystery"}'
    })
  })
})

describe('incidentEvidenceRows', () => {
  it('renders path, offsets, a shortened digest and the truncation flag', () => {
    const rows = incidentEvidenceRows({
      pointers: [
        {
          kind: 'transcript',
          path: '/tmp/transcript.jsonl',
          sha256: 'b'.repeat(64),
          bytes: 4096,
          startOffset: 10,
          endOffset: 20,
          truncated: true
        }
      ],
      unknownBoundaries: []
    })
    expect(rows).toEqual([
      {
        kind: 'transcript',
        path: '/tmp/transcript.jsonl',
        displayPath: 'tmp/transcript.jsonl',
        sha256Short: 'b'.repeat(12),
        sha256: 'b'.repeat(64),
        bytes: 4096,
        offsetRange: '10..20',
        truncated: true
      }
    ])
  })

  it('derives a display path that keeps the basename and one parent', () => {
    // The real path is absolute and can carry a user name or a host mount; display text must not.
    expect(incidentEvidenceDisplayPath('/home/alice/project/transcripts/run.jsonl')).toBe(
      '…/transcripts/run.jsonl'
    )
    expect(incidentEvidenceDisplayPath('/tmp/file.jsonl')).toBe('tmp/file.jsonl')
    expect(incidentEvidenceDisplayPath('file.jsonl')).toBe('file.jsonl')
    expect(incidentEvidenceDisplayPath('C:\\Users\\alice\\log.txt')).toBe(
      '…/alice/log.txt'
    )
    expect(incidentEvidenceDisplayPath('')).toBe('—')
  })

  it('does not fabricate an offset range when the pointer has none', () => {
    const rows = incidentEvidenceRows({
      pointers: [{ kind: 'other', path: '/tmp/x' }],
      unknownBoundaries: []
    })
    expect(rows[0].offsetRange).toBeNull()
    expect(rows[0].sha256Short).toBeNull()
    expect(rows[0].bytes).toBeNull()
  })

  it('has no rows when evidence is absent (the drawer renders that as a gap)', () => {
    expect(incidentEvidenceRows(null)).toEqual([])
    expect(incidentEvidenceRows(undefined)).toEqual([])
  })
})

describe('incidentDecisionTimeline', () => {
  const decision = (id: string, createdAt: number): IncidentDecisionDto => ({
    id,
    incidentId: 'inc_1',
    fromStatus: 'untriaged',
    toStatus: 'watch',
    actor: 'alice',
    reason: id,
    createdAt
  })

  it('is chronological and keeps every decision, including repeats of the same transition', () => {
    const timeline = incidentDecisionTimeline([
      decision('late', 300),
      decision('early', 100),
      decision('same-ms-b', 200),
      decision('same-ms-a', 200)
    ])
    expect(timeline.map((entry) => entry.id)).toEqual(['early', 'same-ms-a', 'same-ms-b', 'late'])
  })
})

describe('incidentDecisionOutcomeView', () => {
  it('maps the store outcomes the drawer must state', () => {
    expect(incidentDecisionOutcomeView('appended').kind).toBe('appended')
    expect(incidentDecisionOutcomeView('actor_required', 'x').kind).toBe('actor_required')
    expect(incidentDecisionOutcomeView('reason_required', 'x').kind).toBe('reason_required')
    expect(incidentDecisionOutcomeView('invalid_transition', 'x').kind).toBe('invalid_transition')
    expect(incidentDecisionOutcomeView('status_changed', 'x').kind).toBe('status_changed')
    expect(incidentDecisionOutcomeView('status_unchanged', 'x').kind).toBe('status_unchanged')
    expect(incidentDecisionOutcomeView('not_found', 'x').kind).toBe('not_found')
  })

  it('treats an unavailable store as a refusal with its detail, not as an unknown error', () => {
    expect(incidentDecisionOutcomeView('incident_store_unavailable', 'no store')).toEqual({
      kind: 'unavailable',
      detail: 'no store'
    })
  })

  it('keeps an unexpected outcome visible with its detail', () => {
    expect(incidentDecisionOutcomeView('something_new', 'server said so')).toEqual({
      kind: 'other',
      detail: 'server said so'
    })
  })
})

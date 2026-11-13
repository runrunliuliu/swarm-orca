/**
 * Formatter behaviour the CLI tests would otherwise assert inline: coverage is always printed, a
 * capacity stop is never silent, and prune never reads as "deleted" on a dry run.
 */
import { describe, expect, it } from 'vitest'
import type { IncidentView } from '../main/incidents/incident-types'
import type { IncidentListResult, PruneResult } from '../main/incidents/incident-store'
import {
  formatIncidentCapacityWarning,
  formatIncidentCoverage,
  formatIncidentDecision,
  formatIncidentList,
  formatIncidentPrune,
  formatIncidentShow,
  formatIncidentStalls
} from './incident-format'

const coverage = {
  remoteIncidentCapture: 'unsupported' as const,
  capacityLatchSet: false,
  currentlyLimited: false,
  capacity: { rows: 1, bytes: 2048, maxRows: 50_000, maxBytes: 500 * 1024 * 1024 },
  shadowReplay: {
    lastSeq: 42,
    incomplete: false,
    lastStopReason: null,
    failures: 0,
    lastError: null,
    dropped: 0,
    lastDroppedReason: null,
    lastRun: null
  },
  stallSample: {
    sampledAt: 1_700_000_000_000,
    panes: 1,
    wouldWrite: 0,
    noEvent: 0,
    declaredWaits: 0,
    writeEnabled: false,
    writes: 0,
    lastWriteAt: null,
    errors: 0,
    lastError: null,
    keyRejected: 0
  }
}

function view(overrides: Partial<IncidentView> = {}): IncidentView {
  return {
    id: 'inc_1',
    sourceKind: 'pty_exit',
    sourceId: 'ptyinc-1',
    facet: 'exit',
    hostId: 'host-a',
    worktreeId: 'wt-1',
    runId: null,
    taskId: null,
    dispatchId: null,
    agentSessionId: null,
    ptyIncarnationId: 'ptyinc-1',
    class: 'crash',
    status: 'untriaged',
    exitCause: { kind: 'signaled', signal: 9 },
    fingerprint: 'f'.repeat(64),
    evidence: { pointers: [], unknownBoundaries: ['transcript pointer not collected'] },
    summary: 'Agent process killed by signal 9',
    createdAt: 1_700_000_000_000,
    effectiveStatus: 'watch',
    decisionCount: 1,
    lastDecisionAt: 1_700_000_100_000,
    decisions: [
      {
        id: 'dec_1',
        incidentId: 'inc_1',
        fromStatus: 'untriaged',
        toStatus: 'watch',
        actor: 'alice',
        reason: 'waiting',
        createdAt: 1_700_000_100_000
      }
    ],
    ...overrides
  }
}

describe('formatIncidentCoverage', () => {
  it('names the remote gap and both capacity facts on one line', () => {
    const line = formatIncidentCoverage(coverage)
    expect(line).toContain('remote_incident_capture=unsupported')
    expect(line).toContain('capacity_latch_set=false')
    expect(line).toContain('currently_limited=false')
    expect(line).toContain('rows=1/50000')
  })
})

describe('formatIncidentList', () => {
  it('prints an explicit empty answer plus coverage', () => {
    const result: IncidentListResult = { incidents: [], total: 0, coverage }
    const text = formatIncidentList(result)
    expect(text).toContain('No incidents recorded on this host')
    expect(text).toContain('remote_incident_capture=unsupported')
  })

  it('prints a present-tense warning only while the store is refusing writes', () => {
    const result: IncidentListResult = {
      incidents: [],
      total: 0,
      coverage: { ...coverage, capacityLatchSet: true, currentlyLimited: true }
    }
    const text = formatIncidentList(result)
    expect(text).toContain('currently_limited=true')
    expect(text).toContain('are being refused right now')
  })

  it('does not claim writes are being refused once a prune cleared the limit (C3)', () => {
    const latched = { ...coverage, capacityLatchSet: true, currentlyLimited: false }
    const text = formatIncidentList({ incidents: [], total: 0, coverage: latched })
    expect(text).toContain('capacity_latch_set=true')
    expect(text).toContain('currently_limited=false')
    expect(text).toContain('has refused writes before')
    expect(text).not.toContain('are being refused right now')
    expect(text).not.toContain('Capacity limit reached')
    expect(formatIncidentCapacityWarning(latched)).not.toMatch(/being refused/)
  })

  it('prints no capacity warning at all when neither fact holds', () => {
    expect(formatIncidentCapacityWarning(coverage)).toBeNull()
  })

  it('shows an unfinished replay as a warning, never as an empty answer (M2-C4)', () => {
    const incomplete = {
      ...coverage,
      shadowReplay: {
        ...coverage.shadowReplay,
        incomplete: true,
        lastStopReason: 'budget',
        failures: 2,
        lastError: 'disk gone',
        dropped: 3,
        lastRun: { lines: 120, bytes: 4096, ms: 12 }
      }
    }
    const text = formatIncidentList({ incidents: [], total: 0, coverage: incomplete })
    expect(text).toContain('No incidents recorded on this host')
    expect(text).toContain('Shadow replay: INCOMPLETE (budget)')
    expect(text).toContain('did not finish')
    expect(text).toContain('last replay error: disk gone')
    expect(text).toContain('3 replayed line(s) were dropped')
    expect(text).toContain('last_run=120lines/4096B/12ms')
  })

  it('renders class, effective status, cause and worktree per row', () => {
    const result: IncidentListResult = {
      incidents: [
        {
          id: 'inc_1',
          class: 'crash',
          sourceKind: 'pty_exit',
          facet: 'exit',
          hostId: 'host-a',
          worktreeId: 'wt-1',
          agentSessionId: null,
          status: 'untriaged',
          effectiveStatus: 'watch',
          exitCause: { kind: 'unknown', reason: 'stop_unverified' },
          fingerprint: 'f',
          summary: 'stop never confirmed',
          createdAt: 1_700_000_000_000,
          decisionCount: 1
        }
      ],
      total: 1,
      coverage
    }
    const text = formatIncidentList(result)
    expect(text).toContain('crash')
    expect(text).toContain('watch')
    expect(text).toContain('unknown(stop_unverified)')
    expect(text).toContain('wt-1')
  })
})

describe('formatIncidentShow', () => {
  it('shows the entry status beside the effective one, the unknowns and the pointers gap', () => {
    const text = formatIncidentShow(view(), { coverage })
    expect(text).toContain('crash  watch')
    expect(text).toContain('entry status: untriaged')
    expect(text).toContain('Unknown boundaries:')
    expect(text).toContain('transcript pointer not collected')
    expect(text).toContain('(none collected)')
    expect(text).toContain('untriaged → watch')
    expect(text).toContain('remote_incident_capture=unsupported')
  })

  it('marks an absent unknown list as a gap rather than printing an empty heading', () => {
    const text = formatIncidentShow(
      view({ evidence: { pointers: [], unknownBoundaries: [] } })
    )
    expect(text).toContain('(none recorded — itself a gap)')
  })
})

describe('formatIncidentPrune', () => {
  it('never claims deletion on a dry run', () => {
    const result: PruneResult = {
      dryRun: true,
      olderThanDays: 90,
      cutoff: 0,
      candidates: 3,
      deleted: 0,
      byStatus: { invalid: 2, duplicate: 1 },
      candidateIds: ['inc_a', 'inc_b'],
      candidateIdsTruncated: true,
      deletedIds: [],
      deletedIdsTruncated: false
    }
    const text = formatIncidentPrune(result)
    expect(text).toContain('dry run')
    expect(text).toContain('Nothing was deleted')
    expect(text).toContain('invalid=2')
    expect(text).toContain('2 id(s) (truncated) in --json')
  })

  it('reports retained decisions on an apply run', () => {
    const result: PruneResult = {
      dryRun: false,
      olderThanDays: 90,
      cutoff: 0,
      candidates: 2,
      deleted: 2,
      byStatus: { invalid: 2 },
      candidateIds: ['inc_a', 'inc_b'],
      candidateIdsTruncated: false,
      deletedIds: ['inc_a', 'inc_b'],
      deletedIdsTruncated: false
    }
    const text = formatIncidentPrune(result)
    expect(text).toContain('deleted 2 of 2')
    expect(text).toContain('Decision rows were retained')
  })
})

describe('formatIncidentStalls (M3-3)', () => {
  it('prints one row per pane with age, threshold, verdict and declaration', () => {
    const text = formatIncidentStalls(
      [
        {
          paneKey: 'tab-1:leaf-1',
          terminalHandle: 'term-1',
          state: 'working',
          ageMs: 46 * 60_000,
          ageBasis: 'event' as const,
          thresholdMs: 45 * 60_000,
          wouldWriteIfEnabled: true,
          reason: 'no_event_for_threshold',
          declaredWait: 'long build'
        }
      ],
      coverage
    )
    expect(text).toContain('tab-1:leaf-1')
    expect(text).toContain('46m')
    expect(text).toContain('45m')
    expect(text).toContain('no_event_for_threshold')
    expect(text).toContain('event')
    expect(text).toContain('wouldWriteIfEnabled=yes means')
    expect(text).toContain('long build')
    expect(text).toContain('Stall sampler:')
    expect(text).toContain('Writing incidents: off')
    expect(text).toContain('this command never writes')
  })

  it('says so when no sample exists yet', () => {
    const text = formatIncidentStalls([], {
      ...coverage,
      stallSample: { ...coverage.stallSample, sampledAt: null, panes: 0 }
    })
    expect(text).toContain('none yet')
    expect(text).toContain('No panes sampled')
  })
})

describe('formatIncidentDecision', () => {
  it('names the transition, the self-reported actor and the decision id', () => {
    expect(
      formatIncidentDecision({
        incidentId: 'inc_1',
        decisionId: 'dec_1',
        fromStatus: 'untriaged',
        toStatus: 'watch',
        actor: 'unspecified'
      })
    ).toBe('inc_1: untriaged → watch (actor=unspecified, decision=dec_1)')
  })
})

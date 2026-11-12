/**
 * Formatter behaviour the CLI tests would otherwise assert inline: coverage is always printed, a
 * capacity stop is never silent, and prune never reads as "deleted" on a dry run.
 */
import { describe, expect, it } from 'vitest'
import type { IncidentView } from '../main/incidents/incident-types'
import type { IncidentListResult, PruneResult } from '../main/incidents/incident-store'
import {
  formatIncidentCoverage,
  formatIncidentDecision,
  formatIncidentList,
  formatIncidentPrune,
  formatIncidentShow
} from './incident-format'

const coverage = {
  remoteIncidentCapture: 'unsupported' as const,
  storeCapacityLimited: false,
  capacity: { rows: 1, bytes: 2048, maxRows: 50_000, maxBytes: 500 * 1024 * 1024 }
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
  it('names the remote gap and the capacity state on one line', () => {
    expect(formatIncidentCoverage(coverage)).toContain('remote_incident_capture=unsupported')
    expect(formatIncidentCoverage(coverage)).toContain('store_capacity_limited=false')
    expect(formatIncidentCoverage(coverage)).toContain('rows=1/50000')
  })
})

describe('formatIncidentList', () => {
  it('prints an explicit empty answer plus coverage', () => {
    const result: IncidentListResult = { incidents: [], total: 0, coverage }
    const text = formatIncidentList(result)
    expect(text).toContain('No incidents recorded on this host')
    expect(text).toContain('remote_incident_capture=unsupported')
  })

  it('prints a capacity warning when the store refused writes', () => {
    const result: IncidentListResult = {
      incidents: [],
      total: 0,
      coverage: { ...coverage, storeCapacityLimited: true }
    }
    const text = formatIncidentList(result)
    expect(text).toContain('store_capacity_limited=true')
    expect(text).toContain('Capacity limit reached')
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
      byStatus: { invalid: 2, duplicate: 1 }
    }
    const text = formatIncidentPrune(result)
    expect(text).toContain('dry run')
    expect(text).toContain('Nothing was deleted')
    expect(text).toContain('invalid=2')
  })

  it('reports retained decisions on an apply run', () => {
    const result: PruneResult = {
      dryRun: false,
      olderThanDays: 90,
      cutoff: 0,
      candidates: 2,
      deleted: 2,
      byStatus: { invalid: 2 }
    }
    const text = formatIncidentPrune(result)
    expect(text).toContain('deleted 2 of 2')
    expect(text).toContain('Decision rows were retained')
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

/**
 * Wording for a pane that never reported a status.
 *
 * Why a separate file: `worktree-card-agent-summary.test.ts` also renders `CompactAgentRow`, whose
 * icon chain imports `resources/*.svg`, so it cannot run in a sparse checkout. These assertions
 * need only the summary module — the card's own words for "this agent has not reported".
 *
 * The case: a hook-less agent pane used to read `idle` ("nothing happening") in the row and
 * `Active` ("a terminal is open") on the card. Both asserted more than Orca knew. The negative
 * control matters as much: a report that went quiet is still called a stale report, not a
 * never-reported one.
 */
import { describe, expect, it } from 'vitest'
import type { DashboardAgentRow as DashboardAgentRowData } from '@/components/dashboard/useDashboardData'
import {
  buildSummaryAgentGroups,
  formatSummaryStateLabel,
  getAgentDotState,
  summarizeAgentIdentities,
  summarizeAgents
} from './worktree-card-agent-summary'

function agentRow(overrides: Partial<DashboardAgentRowData> = {}): DashboardAgentRowData {
  return {
    paneKey: 'tab-1:leaf-1',
    state: 'no-evidence',
    agentType: 'codex',
    startedAt: 0,
    tab: {
      id: 'tab-1',
      ptyId: null,
      worktreeId: 'wt-1',
      title: 'demo-repo',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 1
    },
    entry: {
      state: 'working',
      prompt: 'Codex',
      updatedAt: 1,
      stateStartedAt: 1,
      stateHistory: [],
      paneKey: 'tab-1:leaf-1',
      agentType: 'codex'
    },
    ...overrides
  }
}

describe('no-status-evidence wording', () => {
  it('names the missing status in the card summary', () => {
    const agent = agentRow()

    expect(summarizeAgents([agent], 'agent')).toBe('agent no status reported')
    expect(summarizeAgentIdentities([agent])).toBe('Codex no status reported')
    expect(formatSummaryStateLabel('no-evidence')).toBe('no status reported')
  })

  it('shares the dashed ring with a stale report but not its wording', () => {
    const stale = agentRow({ state: 'unverifiable' })

    expect(getAgentDotState(agentRow())).toBe('unverifiable')
    expect(getAgentDotState(stale)).toBe('unverifiable')
    expect(summarizeAgents([stale], 'agent')).toBe('agent not reporting')
    // One visual group, so the card does not grow a second dashed pill for the same glyph.
    expect(buildSummaryAgentGroups([agentRow(), stale])).toHaveLength(1)
  })

  it('keeps a reporting agent ranked above both', () => {
    const working = agentRow({ state: 'working', entry: { ...agentRow().entry, state: 'working' } })

    expect(summarizeAgents([agentRow(), working], 'agent')).toBe(
      'agent: 1 working, 1 no status reported'
    )
  })
})

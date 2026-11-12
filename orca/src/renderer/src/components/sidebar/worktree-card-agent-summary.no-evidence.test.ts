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
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AgentStateDot } from '@/components/AgentStateDot'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { DashboardAgentRow as DashboardAgentRowData } from '@/components/dashboard/useDashboardData'
import {
  buildSummaryAgentGroups,
  formatSummaryStateLabel,
  getAgentDotState,
  summarizeAgentIdentities,
  summarizeAgents,
  summaryGroupTitle,
  summaryStateDotState
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
    expect(summaryStateDotState('no-evidence')).toBe('unverifiable')
    expect(summarizeAgents([stale], 'agent')).toBe('agent not reporting')
  })

  // Why this exists (#review F1): the collapsed pill's dot carried `unverifiable`'s default
  // tooltip, "No recent update" — the stale-report wording this change exists to stop using for
  // a pane that never reported. The row was fixed; the group has to say it too.
  it('splits the two dashed ambers into one pill each, so each pill can say its own fact', () => {
    const stale = agentRow({ state: 'unverifiable', paneKey: 'tab-1:leaf-2' })
    const groups = buildSummaryAgentGroups([agentRow(), stale])

    expect(groups.map((group) => group.state)).toEqual(['unverifiable', 'no-evidence'])
    expect(groups.map((group) => group.agents.length)).toEqual([1, 1])
    expect(groups.map((group) => summaryStateDotState(group.state))).toEqual([
      'unverifiable',
      'unverifiable'
    ])
    expect(groups.map((group) => summaryGroupTitle(group.state))).toEqual([
      undefined,
      'No status reported'
    ])
  })

  it('renders the never-reported wording on the pill dot, not the stale-report one', () => {
    const markup = renderToStaticMarkup(
      createElement(
        TooltipProvider,
        null,
        createElement(AgentStateDot, {
          state: summaryStateDotState('no-evidence'),
          title: summaryGroupTitle('no-evidence'),
          ariaLabel: summaryGroupTitle('no-evidence')
        })
      )
    )

    // Both surfaces the user can perceive: the hover tooltip and the accessible name.
    expect(markup).toContain('No status reported')
    expect(markup).not.toContain('No recent update')
  })

  it('keeps a reporting agent ranked above both', () => {
    const working = agentRow({ state: 'working', entry: { ...agentRow().entry, state: 'working' } })

    expect(summarizeAgents([agentRow(), working], 'agent')).toBe(
      'agent: 1 working, 1 no status reported'
    )
  })
})

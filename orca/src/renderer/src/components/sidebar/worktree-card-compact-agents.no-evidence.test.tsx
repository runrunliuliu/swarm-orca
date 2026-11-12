/**
 * The collapsed summary pill, rendered for real (#review F1).
 *
 * Why the `agent-catalog` mock: the real module imports `resources/*.svg|webp`, which a sparse
 * checkout cannot resolve, so the production icon chain would fail to load before any assertion
 * runs. The pill under test only uses it to draw the identity badges, so a stand-in keeps the
 * tooltip/accessible-name wiring — the actual subject — exercised end to end.
 *
 * The defect this pins: a pill whose members never reported used to hover as "No recent update",
 * which is the stale-report wording, because the group's dot fell back to the shared state label.
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { DashboardAgentRow as DashboardAgentRowData } from '@/components/dashboard/useDashboardData'
import { CompactAgentSummaryButton } from './worktree-card-compact-agents'

vi.mock('@/lib/agent-catalog', () => ({
  AgentIcon: () => null,
  agentTypeToIconAgent: (agentType: string) => agentType
}))

function agentRow(state: DashboardAgentRowData['state'], paneKey: string): DashboardAgentRowData {
  return {
    paneKey,
    state,
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
      paneKey,
      agentType: 'codex'
    }
  }
}

function renderPills(agents: DashboardAgentRowData[]): string {
  return renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(CompactAgentSummaryButton, {
        agents,
        subjectLabel: 'agent',
        expanded: false,
        onToggle: () => {}
      })
    )
  )
}

describe('compact agent summary pill wording', () => {
  it('names a never-reported group in its own words, not the stale-report ones', () => {
    const markup = renderPills([agentRow('no-evidence', 'tab-1:leaf-1')])

    // The accessible name of the pill's dot, plus the collapsed button's own label.
    expect(markup).toContain('aria-label="No status reported"')
    expect(markup).toContain('no status reported')
    expect(markup).not.toContain('No recent update')
  })

  it('keeps the stale-report wording for a group that did report and went quiet', () => {
    const markup = renderPills([agentRow('unverifiable', 'tab-1:leaf-1')])

    expect(markup).toContain('No recent update')
    expect(markup).not.toContain('No status reported')
  })

  it('renders one pill per fact when both dashed-amber groups are present', () => {
    const markup = renderPills([
      agentRow('no-evidence', 'tab-1:leaf-1'),
      agentRow('unverifiable', 'tab-1:leaf-2')
    ])

    expect(markup).toContain('No status reported')
    expect(markup).toContain('No recent update')
    // One dashed ring per fact: the two groups no longer collapse into one pill.
    expect([...markup.matchAll(/lucide-circle-dashed/g)]).toHaveLength(2)
  })
})

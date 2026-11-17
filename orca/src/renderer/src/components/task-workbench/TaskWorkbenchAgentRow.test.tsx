// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { AgentRowView, DashboardCard } from './task-workbench-view'
import { projectAgentRow } from './task-workbench-row-projection'
import { TaskWorkbenchAgentRowDot } from './task-workbench-agent-row-dot'

/**
 * F8's failure / boundary presentation.
 *
 * Why this test mounts the overlay dot and the projection rather than the whole
 * row: mounting `TaskWorkbenchAgentRow` pulls `AgentKanbanCard` →
 * `lib/agent-catalog.tsx`, which imports `resources/openclaude-logo.png`; the
 * sparse task checkout does not carry `orca/resources`, so that graph cannot be
 * loaded here at all (the rendered harness has a plugin for exactly this, the
 * unit-test config does not). The composition of dot + badge inside the row, and
 * the badge's literal copy, are asserted by the rendered harness on the
 * `f8_failure_outcome` fixture instead; this file owns the mapping and the
 * projection hop, which are the facts a reviewer can disagree with.
 *
 * Every expectation below is a literal, not a value derived from the code.
 */

afterEach(cleanup)

const BASE_CARD = {
  paneKey: 'pane-f8',
  ptyId: 'pty-f8',
  agentType: 'claude',
  bucket: 'done',
  dotState: 'done',
  task: 'Fix flaky checkout',
  repoId: 'repo-web-app',
  worktreeId: 'wt-fix-checkout',
  tabId: 'tab-f8',
  leafId: 'leaf-f8',
  repoName: 'web-app',
  worktreeName: 'fix/flaky-checkout',
  startedAt: 1_700_000_000_000,
  finishedAt: 1_700_000_300_000,
  stateChangedAt: 1_700_000_300_000,
  unseen: true
} satisfies DashboardCard

function renderDot(row: Parameters<typeof TaskWorkbenchAgentRowDot>[0]['row']): void {
  render(
    <TooltipProvider>
      <TaskWorkbenchAgentRowDot row={row} />
    </TooltipProvider>
  )
}

function expectSingleDot(state: 'failed' | 'interrupted' | 'unverifiable'): void {
  const dots = screen.getAllByTestId('task-workbench-agent-row-dot')
  expect(dots).toHaveLength(1)
  expect(dots[0]).toHaveAttribute('data-dot-state', state)
}

describe('task workbench F8 state-dot overlay', () => {
  it('renders a failed dot for a failed outcome and never reads as delivered', () => {
    renderDot({ outcome: 'failure' })

    expectSingleDot('failed')
    expect(
      projectAgentRow(
        { base: BASE_CARD, tokens: { kind: 'rollup', tokens: 88_000 }, outcome: 'failure' },
        { showWorkspaceLabel: false }
      ).showsDelivered
    ).toBe(false)
  })

  it('renders an interrupted dot for a cancelled outcome and never reads as delivered', () => {
    renderDot({ outcome: 'cancellation' })

    expectSingleDot('interrupted')
    expect(
      projectAgentRow(
        { base: BASE_CARD, tokens: { kind: 'rollup', tokens: 88_000 }, outcome: 'cancellation' },
        { showWorkspaceLabel: false }
      ).showsDelivered
    ).toBe(false)
  })

  it('leaves a successful outcome to the truthful base-card done dot', () => {
    renderDot({ outcome: 'success' })

    expect(screen.queryByTestId('task-workbench-agent-row-dot')).not.toBeInTheDocument()
    expect(
      projectAgentRow(
        { base: BASE_CARD, tokens: { kind: 'rollup', tokens: 88_000 }, outcome: 'success' },
        { showWorkspaceLabel: false }
      ).showsDelivered
    ).toBe(true)
  })

  it('preserves a boundary through projection and renders it as unverifiable', () => {
    const boundaryRow = {
      base: BASE_CARD,
      tokens: { kind: 'rollup', tokens: 88_000 },
      sessionBoundary: true
    } satisfies AgentRowView

    const projected = projectAgentRow(boundaryRow, { showWorkspaceLabel: false })
    expect(projected.sessionBoundary).toBe(true)
    expect(projected.showsDelivered).toBe(false)

    renderDot(projected)
    expectSingleDot('unverifiable')
  })

  it('renders no overlay dot without an outcome or a boundary', () => {
    renderDot({})

    expect(screen.queryByTestId('task-workbench-agent-row-dot')).not.toBeInTheDocument()
  })

  it('lets failure outrank a simultaneous session boundary', () => {
    renderDot({ outcome: 'failure', sessionBoundary: true })

    expectSingleDot('failed')
  })
})

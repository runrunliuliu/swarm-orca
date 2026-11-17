import React from 'react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { AgentKanbanCard } from '../dashboard-popout/AgentKanbanCard'
import { TaskWorkbenchAgentRowDot } from './task-workbench-agent-row-dot'
import type { AgentOutcome } from './task-workbench-view'
import type { TaskWorkbenchRowView } from './task-workbench-row-projection'

/**
 * One workbench agent row: the snapshot card plus the workbench-only overlay
 * (workspace pill, token chip, outcome mark).
 *
 * Decision A (Coordinator ruling 2026-11-16): the plan named `DashboardAgentRow`,
 * but that component takes the store-shaped `DashboardAgentRowData` (entry/tab/
 * state) and reads `useAppStore` through `useAgentRowConversationName`, so it
 * cannot render a `DashboardCard` without inventing store data. `AgentKanbanCard`
 * is the only existing renderer that accepts `DashboardCard` and whose checked
 * dependency graph has no `@/store` edge, so it is the base here and this file is
 * the only place that names it.
 *
 * What that does NOT buy, per the read-only review (`archive/reports/r-codex-ark-base.md`):
 * no store import is not the same as no resource loading — `AgentIcon` can fall
 * back to a remote favicon `<img>` (`lib/agent-catalog.tsx`), so the shell is not
 * a zero-network claim; and a `DashboardCard` carries no model, tool preview or
 * rich agent state, so this base is an explicit interim visual deviation from
 * R18 rather than fidelity. The later switch to a dashboard-shaped base is a
 * one-file edit only once an approved store-free row renderer exists and the
 * overlay can adapt from the unchanged row input; it is not proven today.
 */

function rowKeys(key: string): string {
  return `auto.components.TaskWorkbenchAgentRow.${key}`
}

/** P1a is a static shell: the base card's action stays focusable but does
 *  nothing. P1b wires it to the terminal. Module-level so the memoized card
 *  does not re-render on a fresh callback each pass. */
const noop = (): void => {}

const OUTCOME_COPY: Record<AgentOutcome, string> = {
  success: 'Delivered',
  failure: 'Failed',
  cancellation: 'Cancelled'
}

/** `success` is the only outcome that may read as Delivered (F8); failure and
 *  cancellation get their own words and a tinted badge. */
const OUTCOME_VARIANT: Record<AgentOutcome, 'secondary' | 'destructive' | 'outline'> = {
  success: 'secondary',
  failure: 'destructive',
  cancellation: 'outline'
}

export function TaskWorkbenchAgentRow({ row }: { row: TaskWorkbenchRowView }): React.JSX.Element {
  useTranslation()
  // Why: the view carries no clock and P1a renders fixed-size fixtures. Anchoring
  // "ago" to the row's own timestamp keeps output deterministic; P1b injects one.
  const now = row.base.finishedAt ?? row.base.startedAt
  const tokenLabel = row.tokenText.unavailable
    ? translate(rowKeys('tokensUnavailable'), '—')
    : translate(rowKeys('tokens'), '{{value0}} tok', { value0: row.tokenText.text })

  return (
    <div data-testid="task-workbench-agent-row" className="flex min-w-0 items-start gap-2">
      <div className="min-w-0 flex-1">
        <AgentKanbanCard card={row.base} now={now} onOpenTerminal={noop} />
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1 pt-1">
        {row.workspaceLabel ? (
          <Badge
            data-testid="task-workbench-agent-row-workspace-pill"
            variant="outline"
            className="max-w-40"
          >
            <span aria-hidden="true">▦</span>
            <span className="min-w-0 truncate">{row.workspaceLabel}</span>
          </Badge>
        ) : null}
        <span
          data-testid="task-workbench-agent-row-tokens"
          className={cn(
            'text-xs tabular-nums',
            row.tokenText.unavailable ? 'text-muted-foreground' : 'text-foreground'
          )}
        >
          {tokenLabel}
        </span>
        {row.outcome || row.sessionBoundary ? (
          <div className="flex items-center gap-1">
            <TaskWorkbenchAgentRowDot row={row} />
            {row.outcome ? (
              <Badge
                data-testid="task-workbench-agent-row-outcome"
                variant={OUTCOME_VARIANT[row.outcome]}
              >
                {translate(rowKeys(`outcome.${row.outcome}`), OUTCOME_COPY[row.outcome])}
              </Badge>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}

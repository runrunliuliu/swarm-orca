import React from 'react'
import { useTranslation } from 'react-i18next'
import { AgentIcon } from '@/lib/agent-catalog'
import { agentTypeToIconAgent, formatAgentTypeLabel } from '@/lib/agent-status'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { dashboardCardDisplayState } from '../../../../shared/dashboard-snapshot'
import { formatStartedAgo } from '../dashboard-popout/agent-card-time'
import { agentStateWord, type TaskWorkbenchRowView } from './task-workbench-row-projection'
import {
  TaskWorkbenchAgentRowDot,
  taskWorkbenchOverlayDotState
} from './task-workbench-agent-row-dot'
import type { AgentOutcome } from './task-workbench-view'

/**
 * One workbench agent row, flat: icon · conversation name · (workspace) · state ·
 * time · tokens · action (README §7.4.2).
 *
 * Why not `AgentKanbanCard` any more: that card is a body + footer two-layer
 * surface, and nesting it inside this section produced a card-in-a-card plus a
 * fixed 80px column that held nothing but an em dash when a row had no token
 * figure. The workbench has one surface per section, so the row draws itself.
 * What the card still owns upstream is its memoization and view-transition
 * plumbing — a board concern this list does not have.
 *
 * Two rules this row must not break:
 * - `outcome` is the only source of a verdict word: `success` reads Delivered,
 *   `failure` Failed, `cancellation` Cancelled (F8). A failed turn never reads as
 *   delivered, and a missing outcome is not evidence of success.
 * - an unknown token count renders nothing. The em dash the old overlay printed
 *   reserved a column for a figure that does not exist; `0` would read as a
 *   measured zero (README §7.5).
 */

function rowKeys(key: string): string {
  return `auto.components.TaskWorkbenchAgentRow.${key}`
}

/** P1b owns the terminal hop. Until it is wired the action is rendered disabled
 *  instead of looking live (README §7.4.2 取舍 3), and this is the title that says
 *  so — the English copy of record, translated from the catalog. */
const NOT_WIRED = 'Not wired in this build yet'

const OUTCOME_COPY: Record<AgentOutcome, string> = {
  success: 'Delivered',
  failure: 'Failed',
  cancellation: 'Cancelled'
}

/** `success` is the only outcome that may read as delivered (F8); the other two
 *  keep their own word and tint. */
const OUTCOME_CLASS: Record<AgentOutcome, string> = {
  success: 'text-emerald-500',
  failure: 'text-destructive',
  cancellation: 'text-muted-foreground'
}

export function TaskWorkbenchAgentRow({ row }: { row: TaskWorkbenchRowView }): React.JSX.Element {
  useTranslation()
  // Why: the view carries no clock and P1a renders fixed-size fixtures. Anchoring
  // "ago" to the row's own timestamp keeps output deterministic; P1b injects one.
  const now = row.base.finishedAt ?? row.base.startedAt
  const displayState = dashboardCardDisplayState(row.base)
  const overlay = taskWorkbenchOverlayDotState(row)
  // Why the outcome wins: a finished turn's verdict is the row's state, and the
  // overlay dot already agrees with it (failed / interrupted / done).
  const statusWord =
    row.outcome === undefined
      ? agentStateWord(overlay ?? displayState)
      : {
          key: rowKeys(`outcome.${row.outcome}`),
          fallback: OUTCOME_COPY[row.outcome]
        }
  // Why the session name first: a card without one falls back to the task text,
  // and only then to the worktree — the same precedence the board card uses, so
  // one agent does not acquire two names on two surfaces.
  const heading = row.base.conversationName ?? row.base.task ?? row.base.worktreeName

  return (
    <div data-testid="task-workbench-agent-row" className="flex min-w-0 flex-col gap-1 px-3 py-1.5">
      <div className="flex min-w-0 items-center gap-2">
        <span
          className="inline-flex shrink-0"
          title={formatAgentTypeLabel(row.base.agentType)}
          data-testid="task-workbench-agent-row-icon"
        >
          <AgentIcon agent={agentTypeToIconAgent(row.base.agentType)} size={14} />
        </span>

        <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">{heading}</span>

        {/* Contract §4.3: with more than one live workspace a row must say which
            one it belongs to. Inline instead of a line of its own — the branch
            name is short and the row already owns this line. */}
        {row.workspaceLabel ? (
          <Badge
            data-testid="task-workbench-agent-row-workspace-pill"
            variant="hostContext"
            className="max-w-[45%] min-w-0"
          >
            <span aria-hidden="true">▦</span>
            <span className="truncate">{row.workspaceLabel}</span>
          </Badge>
        ) : null}

        <span className="flex shrink-0 items-center gap-1.5 text-[12px] text-muted-foreground">
          <TaskWorkbenchAgentRowDot row={row} fallbackState={displayState} />
          <span
            data-testid={row.outcome === undefined ? undefined : 'task-workbench-agent-row-outcome'}
            className={cn(
              'tabular-nums',
              row.outcome === undefined ? 'text-muted-foreground' : OUTCOME_CLASS[row.outcome]
            )}
          >
            {translate(statusWord.key, statusWord.fallback)}
          </span>
          <span aria-hidden="true">·</span>
          <span className="tabular-nums">{formatStartedAgo(now, now)}</span>
          {row.tokenText.unavailable ? null : (
            <>
              <span aria-hidden="true">·</span>
              {/* Glyph only: the unit is repeated on every row and adds nothing a
                  reader cannot infer from the column position. */}
              <span data-testid="task-workbench-agent-row-tokens" className="tabular-nums">
                {translate(rowKeys('tokens'), '{{value0}}', { value0: row.tokenText.text })}
              </span>
            </>
          )}
        </span>

        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled
          title={translate(rowKeys('notWired'), NOT_WIRED)}
          data-testid="task-workbench-agent-row-action"
          className="shrink-0"
        >
          {translate(rowKeys('openTerminal'), 'Open terminal')}
        </Button>
      </div>

      {/* A needs-you row owes the reader the question, not just the state. */}
      {row.base.askSummary ? (
        <div className="flex min-w-0 items-start gap-2 pl-6 text-[12px] text-muted-foreground">
          <span className="min-w-0 flex-1 line-clamp-2">{row.base.askSummary}</span>
        </div>
      ) : null}
    </div>
  )
}

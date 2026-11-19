import React from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { formatTokens } from '@/components/stats/usage-formatters'
import { TaskWorkbenchPendingAction } from './task-workbench-pending-action'
import { USAGE_STATUS_WORD } from './task-workbench-usage-status'
import type {
  AgentOutcome,
  TaskWorkbenchHistory as HistoryFacts,
  TaskWorkbenchLayout,
  TaskWorkbenchView,
  TaskWorkbenchWallClock
} from './task-workbench-view'

/**
 * The run-history strip (issue #31): what a task can still say about work it
 * already ran after its workspace stopped being an active one.
 *
 * Why it exists instead of the 0-workspace empty state: that state made two
 * claims at once — "never started" and "you may create a workspace now" — and
 * both were wrong for a closed task whose workspace was archived or deleted.
 * The strip states only facts, and the absences stay absent: an unknown agent
 * count is `agents unknown`, an unavailable token figure is `tokens unknown`,
 * and the wall clock says whether it was measured.
 *
 * Why the archived form still shows the normal sections while the deleted form
 * does not: an archived worktree is still on this machine, so its agent rows and
 * workspace row exist. A deleted one has no row left to read, so the strip
 * carries its own run list and says the trace is out of reach.
 */

function historyKeys(key: string): string {
  return `auto.components.TaskWorkbenchHistory.${key}`
}

const NOT_WIRED = 'Not available in this version'

const OUTCOME_COPY: Record<AgentOutcome, string> = {
  success: 'delivered',
  failure: 'failed',
  cancellation: 'cancelled'
}

/** Wall-clock copy is unit-only, so it stays untranslated: `3h 14m` reads the
 *  same in every locale this build ships. The *source* of the number is the part
 *  a reader must not misread, and that is what the parenthetical says. */
function formatWallClock(wall: TaskWorkbenchWallClock): string {
  if (wall.kind === 'unknown' || wall.startedAt === undefined || wall.endedAt === undefined) {
    return ''
  }
  const minutes = Math.max(0, Math.round((wall.endedAt - wall.startedAt) / 60_000))
  if (minutes < 1) {
    return '<1m'
  }
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return hours > 0 ? `${hours}h${rest > 0 ? ` ${rest}m` : ''}` : `${rest}m`
}

function formatClock(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

function FactsLine({ history }: { history: HistoryFacts }): React.JSX.Element {
  const wall = formatWallClock(history.wall)
  const wallText =
    history.wall.kind === 'measured'
      ? translate(historyKeys('wallMeasured'), '{{value0}} wall', { value0: wall })
      : history.wall.kind === 'partial' && wall !== ''
        ? translate(historyKeys('wallPartial'), '{{value0}} wall (partial)', { value0: wall })
        : translate(historyKeys('wallUnknown'), 'wall unknown')
  const agentsText =
    history.agents === null
      ? translate(historyKeys('agentsUnknown'), 'agents unknown')
      : translate(historyKeys('agentsKnown'), '{{value0}} agents', {
          value0: String(history.agents)
        })
  const tokensText =
    history.tokens.kind === 'available'
      ? translate(historyKeys('tokensKnown'), '{{value0}} tokens', {
          value0: formatTokens(history.tokens.tokens)
        })
      : translate(historyKeys('tokensUnknown'), 'tokens unknown')

  return (
    <div
      data-testid="task-workbench-history-facts"
      className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[12.5px]"
    >
      <span className="tabular-nums">{agentsText}</span>
      <span aria-hidden="true" className="text-muted-foreground/60">
        ·
      </span>
      <span className="tabular-nums">{wallText}</span>
      <span aria-hidden="true" className="text-muted-foreground/60">
        ·
      </span>
      {/* An absent figure keeps its reason as the tooltip, never as a `0`. */}
      <span
        className="tabular-nums"
        title={
          history.tokens.kind === 'unavailable'
            ? USAGE_STATUS_WORD[history.tokens.reason]
            : undefined
        }
      >
        {tokensText}
      </span>
      {history.lastActivityAt === undefined ? null : (
        <>
          <span aria-hidden="true" className="text-muted-foreground/60">
            ·
          </span>
          <span className="tabular-nums text-muted-foreground">
            {translate(historyKeys('lastActivity'), 'last {{value0}}', {
              value0: formatClock(history.lastActivityAt)
            })}
          </span>
        </>
      )}
    </div>
  )
}

function RunList({ history }: { history: HistoryFacts }): React.JSX.Element {
  return (
    <ul
      data-testid="task-workbench-history-runs"
      className="flex flex-col divide-y divide-border/50 overflow-hidden rounded-lg ring-1 ring-inset ring-border/60"
    >
      {history.runs.map((run) => (
        <li
          key={run.key}
          data-testid="task-workbench-history-run"
          className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 px-3 py-1.5 text-[12.5px]"
        >
          <span className="min-w-32 flex-1 truncate">{run.title}</span>
          <span className="tabular-nums text-muted-foreground">
            {run.startedAt === undefined ? '—' : formatClock(run.startedAt)}
            <span aria-hidden="true" className="mx-1">
              →
            </span>
            {run.endedAt === undefined ? '—' : formatClock(run.endedAt)}
          </span>
          <span className="tabular-nums text-muted-foreground">
            {run.outcome === undefined
              ? translate(historyKeys('runDone'), 'done')
              : translate(historyKeys(`run.${run.outcome}`), OUTCOME_COPY[run.outcome])}
          </span>
        </li>
      ))}
    </ul>
  )
}

export function TaskWorkbenchHistory({
  view,
  layout
}: {
  view: TaskWorkbenchView
  layout: TaskWorkbenchLayout
}): React.JSX.Element | null {
  useTranslation()
  const [expanded, setExpanded] = React.useState(false)
  const history = view.history
  if (!history) {
    return null
  }

  // Narrow or short windows sacrifice history detail first (README §7.3.1).
  const compact = layout.columns === 'single' || layout.agentHistory === 'collapsed'
  const detailsOpen = !compact || expanded

  return (
    <section
      data-testid="task-workbench-history"
      data-compact={compact ? 'true' : undefined}
      data-trace={history.trace}
      className="flex min-w-0 flex-col gap-2 rounded-lg bg-card/40 px-4 py-3 ring-1 ring-inset ring-border/60"
    >
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
          {translate(historyKeys('newBadge'), 'NEW')}
        </span>
        <h2 className="text-[13px] font-medium">
          {translate(historyKeys('heading'), 'Run history')}
        </h2>
        <span className="ml-auto shrink-0 text-[12px] text-muted-foreground">
          {translate(historyKeys('totalScope'), 'Total: every run')}
        </span>
        {compact ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            data-testid="task-workbench-history-details"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
            className="shrink-0"
          >
            <span className="text-muted-foreground">
              {expanded
                ? translate(historyKeys('collapse'), 'Collapse')
                : translate(historyKeys('details'), 'Details')}
            </span>
            <ChevronDown
              aria-hidden="true"
              className={cn('size-3.5 transition-transform', expanded && 'rotate-180')}
            />
          </Button>
        ) : null}
      </div>

      <FactsLine history={history} />

      {detailsOpen && history.trace === 'archived' ? (
        <>
          <p
            data-testid="task-workbench-history-archived-note"
            className="min-w-0 text-[12px] text-muted-foreground"
          >
            {history.archivedWorkspaces === 1
              ? translate(
                  historyKeys('archivedOne'),
                  '1 workspace archived; its content is still on this machine.'
                )
              : translate(
                  historyKeys('archivedMany'),
                  '{{value0}} archived workspaces; their content is still on this machine.',
                  { value0: String(history.archivedWorkspaces) }
                )}
          </p>
          <div data-testid="task-workbench-history-trace" className="flex flex-wrap items-center gap-1">
            <TaskWorkbenchPendingAction
              label={translate(historyKeys('locateTrace'), 'Locate trace')}
              hint={translate(historyKeys('notWired'), NOT_WIRED)}
              testId="task-workbench-history-trace-locate"
            />
            <TaskWorkbenchPendingAction
              label={translate(historyKeys('copyResume'), 'Copy resume command')}
              hint={translate(historyKeys('notWired'), NOT_WIRED)}
              testId="task-workbench-history-trace-resume"
            />
          </div>
        </>
      ) : null}

      {detailsOpen && history.trace === 'deleted' ? (
        <>
          <p
            data-testid="task-workbench-history-trace-lost"
            className="min-w-0 text-[12px] text-muted-foreground"
          >
            {translate(
              historyKeys('traceLost'),
              'Workspace deleted; the recorded trace is out of reach.'
            )}
          </p>
          <RunList history={history} />
        </>
      ) : null}
    </section>
  )
}

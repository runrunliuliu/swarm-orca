import React from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { TaskWorkbenchAgentRow } from './TaskWorkbenchAgentRow'
import { TaskWorkbenchSectionHeading } from './task-workbench-section-heading'
import {
  countRowBuckets,
  projectAgentRow,
  projectRowSections,
  type TaskWorkbenchRowBucket
} from './task-workbench-row-projection'
import type { AgentRowView, TaskWorkbenchLayout, TaskWorkbenchView } from './task-workbench-view'

/**
 * The agents section: one surface per group, Active and Needs you always visible,
 * History folded behind the section heading's own control.
 *
 * Bucket counts and section membership come from `task-workbench-row-projection`,
 * the same functions the harness asserts with, so the component cannot grow a
 * second mapping. This component never calls `useAgentBucketCounts` — that reads
 * the store, and P1b is where the view is filled.
 *
 * README §7.4.2 shapes it:
 * - the History fold is a control on the heading line, not a button that starts a
 *   new line, and the heading is one shape across sections;
 * - a group is one `8px` surface with `inset` row separators, never a card per
 *   row;
 * - an empty section states the fact without a dashed warning box.
 */

const HISTORY_BODY_ID = 'task-workbench-agents-history-records'

function agentsKeys(key: string): string {
  return `auto.components.TaskWorkbenchAgents.${key}`
}

function RowList({
  rows,
  showWorkspaceLabel
}: {
  rows: AgentRowView[]
  showWorkspaceLabel: boolean
}): React.JSX.Element {
  return (
    <ul className="flex flex-col divide-y divide-border/50">
      {rows.map((row) => (
        <li key={row.base.paneKey} className="min-w-0">
          <TaskWorkbenchAgentRow row={projectAgentRow(row, { showWorkspaceLabel })} />
        </li>
      ))}
    </ul>
  )
}

/** One group: its label line and the one surface its rows share. A group with no
 *  label (the History fold, whose name already sits on the heading line) renders
 *  the surface alone. */
function RowGroup({
  label,
  count,
  rows,
  showWorkspaceLabel,
  tone,
  testId
}: {
  label?: string
  /** `null` hides the count: the History fold's count already sits in the heading
   *  control, and printing it twice on one screen is what §7.4.2 removed. */
  count?: number | null
  rows: AgentRowView[]
  showWorkspaceLabel: boolean
  tone: 'neutral' | 'attention'
  testId?: string
}): React.JSX.Element {
  return (
    <div data-testid={testId} className="flex flex-col gap-1.5">
      {label === undefined ? null : (
        <div className="flex min-w-0 items-baseline gap-2 text-[12px]">
          <span
            className={cn(
              'shrink-0 font-medium',
              tone === 'attention' ? 'text-agent-question-text' : 'text-muted-foreground'
            )}
          >
            {label}
          </span>
          {count === null ? null : (
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {String(count ?? rows.length)}
            </span>
          )}
        </div>
      )}
      <div
        className={cn(
          'overflow-hidden rounded-lg ring-1 ring-inset',
          tone === 'attention'
            ? 'bg-agent-question/[0.06] ring-agent-question/40'
            : 'bg-card/40 ring-border/60'
        )}
      >
        <RowList rows={rows} showWorkspaceLabel={showWorkspaceLabel} />
      </div>
    </div>
  )
}

export function TaskWorkbenchAgents({
  view,
  layout
}: {
  view: TaskWorkbenchView
  layout: TaskWorkbenchLayout
}): React.JSX.Element {
  useTranslation()
  // The layout picks the initial state; a click overrides it until the panel
  // remounts (P1a renders one fixed size per fixture).
  const [override, setOverride] = React.useState<boolean | null>(null)

  const counts = countRowBuckets(view.agents)
  const sections = projectRowSections(view.agents)
  const rowsIn = (bucket: TaskWorkbenchRowBucket): AgentRowView[] =>
    sections.find((section) => section.bucket === bucket)?.rows ?? []
  const activeRows = rowsIn('active')
  const attentionRows = rowsIn('attention')
  const historyRows = rowsIn('history')

  // Contract §4.3: with more than one live workspace every row must name its own.
  const showWorkspaceLabel = view.workspaces.length > 1
  const historyExpanded = override ?? layout.agentHistory === 'expanded'
  const hasLiveRows = counts.activeAgents + counts.attentionAgents > 0

  // One control for the whole section, on the heading line (README §7.4.2):
  // `History · collapse` when there is history to fold, the bare count when the
  // answer is zero, so the line always says the same thing in the same place.
  const historyControl =
    counts.historyAgents > 0 ? (
      <Button
        type="button"
        variant="ghost"
        size="xs"
        data-testid="task-workbench-agents-history-toggle"
        aria-expanded={historyExpanded}
        aria-controls={HISTORY_BODY_ID}
        onClick={() => setOverride(!historyExpanded)}
        className="shrink-0"
      >
        <span className="text-muted-foreground">
          {translate(agentsKeys('historyHeading'), 'History')}
        </span>
        <span
          data-testid="task-workbench-agents-history-count"
          className="tabular-nums text-muted-foreground"
        >
          {translate(agentsKeys('historyCount'), '{{value0}}', {
            value0: String(counts.historyAgents)
          })}
        </span>
        <span className="text-muted-foreground">
          {historyExpanded
            ? translate(agentsKeys('collapse'), 'Collapse')
            : translate(agentsKeys('expand'), 'Expand')}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn('size-3.5 transition-transform', historyExpanded && 'rotate-180')}
        />
      </Button>
    ) : (
      <span className="flex shrink-0 items-center gap-1 text-[12px] text-muted-foreground">
        <span>{translate(agentsKeys('historyHeading'), 'History')}</span>
        <span
          data-testid="task-workbench-agents-history-empty"
          className="tabular-nums"
          title={translate(agentsKeys('historyEmpty'), 'No history yet.')}
        >
          {translate(agentsKeys('historyCount'), '{{value0}}', { value0: '0' })}
        </span>
      </span>
    )

  return (
    <section data-testid="task-workbench-agents" className="flex flex-col gap-2">
      <TaskWorkbenchSectionHeading
        label={translate(agentsKeys('heading'), 'Agents')}
        count={translate(agentsKeys('agentCount'), '{{value0}}', {
          value0: String(counts.agents)
        })}
        action={historyControl}
      />

      {/* A fact, not an alert: no dashed box, no warning tone. */}
      {counts.agents === 0 ? (
        <p data-testid="task-workbench-agents-empty" className="text-[12px] text-muted-foreground">
          {translate(agentsKeys('empty'), 'No agents on this task yet.')}
        </p>
      ) : null}

      {hasLiveRows ? (
        <div data-testid="task-workbench-agents-active" className="flex flex-col gap-2">
          {activeRows.length > 0 ? (
            <RowGroup
              label={translate(agentsKeys('activeHeading'), 'Working')}
              rows={activeRows}
              showWorkspaceLabel={showWorkspaceLabel}
              tone="neutral"
            />
          ) : null}

          {attentionRows.length > 0 ? (
            <RowGroup
              label={translate(agentsKeys('attentionHeading'), 'Needs you')}
              rows={attentionRows}
              showWorkspaceLabel={showWorkspaceLabel}
              tone="attention"
              testId="task-workbench-agents-attention"
            />
          ) : null}
        </div>
      ) : null}

      <Collapsible open={historyExpanded} onOpenChange={setOverride}>
        {/* Radix keeps this node mounted while collapsed; the records testid sits
            on the inner element so its presence still means rows on screen. */}
        {counts.historyAgents > 0 ? (
          <CollapsibleContent id={HISTORY_BODY_ID}>
            <div data-testid="task-workbench-agents-history-records" className="pt-0.5">
              <RowGroup
                label={translate(agentsKeys('historyHeading'), 'History')}
                count={null}
                rows={historyRows}
                showWorkspaceLabel={showWorkspaceLabel}
                tone="neutral"
              />
            </div>
          </CollapsibleContent>
        ) : null}
      </Collapsible>
    </section>
  )
}

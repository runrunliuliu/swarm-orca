import React from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { TaskWorkbenchAgentRow } from './TaskWorkbenchAgentRow'
import {
  countRowBuckets,
  projectAgentRow,
  projectRowSections,
  type TaskWorkbenchRowBucket
} from './task-workbench-row-projection'
import type { AgentRowView, TaskWorkbenchLayout, TaskWorkbenchView } from './task-workbench-view'

/**
 * The agents column: Active and Needs you always visible, History collapsible.
 *
 * Bucket counts and section membership come from `task-workbench-row-projection`,
 * the same functions the harness asserts with, so the component cannot grow a
 * second mapping. This component never calls `useAgentBucketCounts` — that reads
 * the store, and P1b is where the view is filled.
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
    <ul className="flex flex-col gap-1.5">
      {rows.map((row) => (
        <li key={row.base.paneKey} className="min-w-0">
          <TaskWorkbenchAgentRow row={projectAgentRow(row, { showWorkspaceLabel })} />
        </li>
      ))}
    </ul>
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

  const showWorkspaceLabel = view.workspaces.length > 1
  const historyExpanded = override ?? layout.agentHistory === 'expanded'
  const hasLiveRows = counts.activeAgents + counts.attentionAgents > 0

  return (
    <section data-testid="task-workbench-agents" className="flex flex-col gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {translate(agentsKeys('heading'), 'Agents')}
        </span>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {translate(agentsKeys('agentCount'), '{{value0}}', {
            value0: String(counts.agents)
          })}
        </span>
      </div>

      {counts.agents === 0 ? (
        <p
          data-testid="task-workbench-agents-empty"
          className="rounded-lg border border-dashed border-border/60 px-3 py-2 text-xs text-muted-foreground"
        >
          {translate(agentsKeys('empty'), 'No agents on this task yet.')}
        </p>
      ) : null}

      {hasLiveRows ? (
        <div data-testid="task-workbench-agents-active" className="flex flex-col gap-2">
          {activeRows.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              <span className="text-[11px] font-medium text-muted-foreground">
                {translate(agentsKeys('activeHeading'), 'Active')}
              </span>
              <RowList rows={activeRows} showWorkspaceLabel={showWorkspaceLabel} />
            </div>
          ) : null}

          {attentionRows.length > 0 ? (
            <div
              data-testid="task-workbench-agents-attention"
              className="flex flex-col gap-1.5"
            >
              <span className="text-[11px] font-medium text-agent-question-text">
                {translate(agentsKeys('attentionHeading'), 'Needs you')}
              </span>
              <RowList rows={attentionRows} showWorkspaceLabel={showWorkspaceLabel} />
            </div>
          ) : null}
        </div>
      ) : null}

      <Collapsible open={historyExpanded} onOpenChange={setOverride}>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {translate(agentsKeys('historyHeading'), 'History')}
          </span>

          {counts.historyAgents > 0 ? (
            <>
              <span
                data-testid="task-workbench-agents-history-count"
                className="shrink-0 text-xs tabular-nums text-muted-foreground"
              >
                {translate(agentsKeys('historyCount'), '{{value0}}', {
                  value0: String(counts.historyAgents)
                })}
              </span>
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
                {historyExpanded
                  ? translate(agentsKeys('collapse'), 'Collapse')
                  : translate(agentsKeys('expand'), 'Expand')}
                <ChevronDown
                  aria-hidden="true"
                  className={cn('size-3.5 transition-transform', historyExpanded && 'rotate-180')}
                />
              </Button>
            </>
          ) : (
            <span
              data-testid="task-workbench-agents-history-empty"
              className="text-xs text-muted-foreground"
            >
              {translate(agentsKeys('historyEmpty'), 'No history yet.')}
            </span>
          )}
        </div>

        {/* Why conditional: the records testid must not exist when there is no
            history, even if a tall layout expanded the group. */}
        {counts.historyAgents > 0 ? (
          <CollapsibleContent
            id={HISTORY_BODY_ID}
            data-testid="task-workbench-agents-history-records"
          >
            {/* Why the wrapper: the collapsible primitive owns its own spacing, so
                the gap above the rows is set on a plain element, not on it. */}
            <div className="flex flex-col gap-1.5 pt-2">
              <RowList rows={historyRows} showWorkspaceLabel={showWorkspaceLabel} />
            </div>
          </CollapsibleContent>
        ) : null}
      </Collapsible>
    </section>
  )
}

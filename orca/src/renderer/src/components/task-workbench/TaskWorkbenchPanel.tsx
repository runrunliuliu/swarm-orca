import React from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { TaskWorkbenchAgents } from './TaskWorkbenchAgents'
import { TaskWorkbenchDelivery } from './TaskWorkbenchDelivery'
import { TaskWorkbenchHeader } from './TaskWorkbenchHeader'
import { TaskWorkbenchSpend } from './TaskWorkbenchSpend'
import { TaskWorkbenchWorkspaces } from './TaskWorkbenchWorkspaces'
import type { TaskWorkbenchLayout, TaskWorkbenchView } from './task-workbench-view'

/**
 * The workbench shell. Orchestration only: it decides which sections exist and
 * how they stack for the given layout, and owns the single top-level empty state.
 * Business judgement (what a bucket means, what an absent figure says) lives in
 * the sections and the projection modules, never here (p1a-ui-shell-plan.md §2).
 */

export type TaskWorkbenchPanelProps = {
  view: TaskWorkbenchView
  layout: TaskWorkbenchLayout
}

function panelKeys(key: string): string {
  return `auto.components.TaskWorkbenchPanel.${key}`
}

/** The 0-workspace state. It owns the primary action for that screen; the Header
 *  deliberately renders none there, so this is the only Create CTA (amendment
 *  2026-11-16). */
function EmptyState(): React.JSX.Element {
  return (
    <section
      data-testid="task-workbench-empty-state"
      className="flex flex-col items-start gap-2 rounded-lg border border-dashed border-border/60 px-4 py-6"
    >
      <span className="text-sm font-medium">
        {translate(panelKeys('emptyTitle'), 'No workspace is linked to this task yet')}
      </span>
      <p className="text-xs text-muted-foreground">
        {translate(
          panelKeys('emptyBody'),
          'Create a workspace to start an agent on this task.'
        )}
      </p>
      <Button type="button" size="sm" data-testid="task-workbench-workspaces-create">
        {translate(panelKeys('createWorkspace'), 'Create workspace')}
      </Button>
    </section>
  )
}

export function TaskWorkbenchPanel({
  view,
  layout
}: TaskWorkbenchPanelProps): React.JSX.Element {
  useTranslation()
  const isEmpty = view.workspaces.length === 0

  return (
    <section
      data-testid="task-workbench-panel"
      className="flex flex-col gap-3 rounded-xl border border-border/60 bg-card/30 p-4"
    >
      <TaskWorkbenchHeader view={view} />

      <div
        data-testid="task-workbench-panel-layout"
        data-wb-columns={layout.columns}
        data-wb-layout-json={JSON.stringify(layout)}
        className="flex flex-col gap-3"
      >
        {isEmpty ? <EmptyState /> : null}

        {layout.columns === 'double' ? (
          <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] items-start gap-3">
            <TaskWorkbenchAgents view={view} layout={layout} />
            <div className="flex flex-col gap-3">
              {isEmpty ? null : <TaskWorkbenchWorkspaces view={view} layout={layout} />}
              <TaskWorkbenchSpend view={view} layout={layout} />
            </div>
          </div>
        ) : (
          // Narrow windows stack in the sacrifice order of README §7.3.1:
          // Workspaces (never sacrificed) → Agents → Spend summary.
          <div className="flex flex-col gap-3">
            {isEmpty ? null : <TaskWorkbenchWorkspaces view={view} layout={layout} />}
            <TaskWorkbenchAgents view={view} layout={layout} />
            <TaskWorkbenchSpend view={view} layout={layout} />
          </div>
        )}
      </div>

      <TaskWorkbenchDelivery view={view} layout={layout} />
    </section>
  )
}

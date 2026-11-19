import React from 'react'
import { useTranslation } from 'react-i18next'
import { translate } from '@/i18n/i18n'
import { TaskWorkbenchAgents } from './TaskWorkbenchAgents'
import { TaskWorkbenchFacts } from './TaskWorkbenchFacts'
import { TaskWorkbenchHistory } from './TaskWorkbenchHistory'
import { TaskWorkbenchPendingAction } from './task-workbench-pending-action'
import { TaskWorkbenchWorkspaces } from './TaskWorkbenchWorkspaces'
import type { TaskWorkbenchLayout, TaskWorkbenchView } from './task-workbench-view'

/**
 * The workbench shell. Orchestration only: it decides which sections exist and
 * how they stack for the given layout, and owns the single top-level empty state.
 * Business judgement (what a bucket means, what an absent figure says) lives in
 * the sections and the projection modules, never here (p1a-ui-shell-plan.md §2).
 *
 * README §7.4.2 removed the workbench header outright: this panel is embedded in
 * the item detail, so the page's h1, its topbar and its meta line already said who
 * the task is. The second h1, the second identity line and the second
 * `Open workspace` button were pure repetition — and the button had no handler,
 * while the page header's same-shaped one does. What is left is four faces: the
 * (optional) empty state, the (optional) run-history strip, Workspaces, Agents
 * and the facts strip, 20px apart, each one surface. The screen's only filled
 * primary button is therefore the page header's.
 */

export type TaskWorkbenchPanelProps = {
  view: TaskWorkbenchView
  layout: TaskWorkbenchLayout
}

function panelKeys(key: string): string {
  return `auto.components.TaskWorkbenchPanel.${key}`
}

/** P1b owns workspace creation; until then this is the disabled form of it
 *  (README §7.4.2 取舍 3), so it no longer looks like the page header's live
 *  primary action. */
const NOT_WIRED = 'Not wired in this build yet'

/** The 0-workspace state. It owns the primary action for that screen; the page
 *  header may still carry its own, so this is the only Create CTA *inside* the
 *  panel (amendment 2026-11-16).
 *
 * Why not a dashed box: §7.4.2 says an empty state is a fact, not a warning. A
 * dashed outline read as "something is wrong" on a task that simply has no
 * workspace yet. */
function EmptyState(): React.JSX.Element {
  return (
    <section
      data-testid="task-workbench-empty-state"
      className="flex flex-col items-start gap-3 rounded-lg bg-card/40 px-4 py-4 ring-1 ring-inset ring-border/60"
    >
      <div className="flex flex-col gap-1">
        <span className="text-[13px] font-medium">
          {translate(panelKeys('emptyTitle'), 'No workspace is linked to this task yet')}
        </span>
        <p className="text-[12px] text-muted-foreground">
          {translate(panelKeys('emptyBody'), 'Create a workspace to start an agent on this task.')}
        </p>
      </div>
      <TaskWorkbenchPendingAction
        variant="outline"
        label={translate(panelKeys('createWorkspace'), 'Create workspace')}
        hint={translate(panelKeys('notWired'), NOT_WIRED)}
        testId="task-workbench-workspaces-create"
      />
    </section>
  )
}

export function TaskWorkbenchPanel({
  view,
  layout
}: TaskWorkbenchPanelProps): React.JSX.Element {
  useTranslation()
  const history = view.history
  // The strip is the "ran before, but is not here now" face (issue #31): an
  // archived or deleted workspace. A task whose workspace is still live already
  // shows its runs in Agents, and a repeated strip there would be noise.
  const hasHistory = history !== undefined && history.trace !== 'none'
  // The deleted form has no workspace and no row left: the strip is the whole
  // record, so an Agents section would claim "no agents" about work that ran.
  const deletedTrace = history?.trace === 'deleted'
  const showEmptyState =
    view.workspaces.length === 0 && !hasHistory && view.historyPending !== true

  return (
    <section data-testid="task-workbench-panel" className="flex flex-col gap-5">
      <div
        data-testid="task-workbench-panel-layout"
        data-wb-columns={layout.columns}
        data-wb-layout-json={JSON.stringify(layout)}
        className="flex flex-col gap-5"
      >
        {showEmptyState ? <EmptyState /> : null}

        {hasHistory ? <TaskWorkbenchHistory view={view} layout={layout} /> : null}

        {deletedTrace ? (
          <TaskWorkbenchFacts view={view} layout={layout} />
        ) : layout.columns === 'double' ? (
          <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] items-start gap-5">
            <TaskWorkbenchAgents view={view} layout={layout} />
            <div className="flex flex-col gap-5">
              {view.workspaces.length === 0 ? null : (
                <TaskWorkbenchWorkspaces view={view} layout={layout} />
              )}
              <TaskWorkbenchFacts view={view} layout={layout} />
            </div>
          </div>
        ) : (
          // Narrow windows stack in the sacrifice order of README §7.3.1:
          // Workspaces (never sacrificed) → Agents → the facts strip.
          <div className="flex flex-col gap-5">
            {view.workspaces.length === 0 ? null : (
              <TaskWorkbenchWorkspaces view={view} layout={layout} />
            )}
            <TaskWorkbenchAgents view={view} layout={layout} />
            <TaskWorkbenchFacts view={view} layout={layout} />
          </div>
        )}
      </div>
    </section>
  )
}

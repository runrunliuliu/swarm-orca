import type { TaskPageDockActionsModel } from '@/hooks/use-task-page-dock-actions'
import { TaskDock } from './TaskDock'
import { TaskPageListChrome } from './ListChrome'
import { TaskPageContent } from './Content'

/** The padded column the list card and the bottom dock share. The rendered
 *  harness imports this constant so a fixture cannot drift from the page. */
export const TASK_PAGE_COLUMN_CLASS =
  'mx-auto flex min-h-0 min-w-0 w-full flex-1 flex-col px-5 pt-1.5 pb-4 md:px-8 md:pt-1.5 md:pb-5'

export function TaskPageFrame({
  model
}: {
  // Why required: a wiring regression in TaskPage must fail the type check instead of
  // silently dropping the dock from the list page.
  model: TaskPageDockActionsModel
}): React.JSX.Element | null {
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      {/* Why: pt-1.5 (6px) aligns this 32px icon cluster's center with the sidebar Tasks row, 22px below the titlebar. */}
      <div className={TASK_PAGE_COLUMN_CLASS}>
        <TaskPageListChrome model={model} />

        <TaskPageContent model={model} />

        <TaskDock model={model.taskDock} />
      </div>
    </div>
  )
}

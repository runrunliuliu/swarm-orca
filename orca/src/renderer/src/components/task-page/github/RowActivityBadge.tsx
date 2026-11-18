import { AgentStateDot } from '@/components/AgentStateDot'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type { TaskWorkbenchRowActivity } from '@/lib/task-workbench/task-workbench-row-activity'

/**
 * The Orca activity mark a GitHub task row wears beside its provider state
 * (issue #27). It never replaces or restates the tracker pill: `Open` / `Closed`
 * is the provider's fact and the popover in `StatusCell.tsx` keeps editing it.
 *
 * The glyph is `AgentStateDot`, so the spinner / question / red / check / gray
 * vocabulary is the one the sidebar and the dashboard already use; only the
 * wording is new, and it comes from the locale catalog. The dot itself is
 * marked decorative — the visible label already names the state, and the
 * tooltip carries the sentence — so assistive tech reads one fact, not two.
 */

type ActivityCopy = { label: string; detail: string }

export function getTaskPageGitHubRowActivityCopy(
  activity: TaskWorkbenchRowActivity
): ActivityCopy {
  switch (activity.kind) {
    case 'needs-you':
      return {
        label: translate('auto.components.TaskPage.rowActivity.needsYou', 'Needs you'),
        detail: needsYouDetail(activity.dotState)
      }
    case 'working':
      return {
        label: translate('auto.components.TaskPage.rowActivity.working', 'Working'),
        detail: translate(
          'auto.components.TaskPage.rowActivity.workingDetail',
          'An agent is working in this task'
        )
      }
    case 'delivered':
      return {
        // README §7.2 D12: Delivered is "the agent said this turn is done", so
        // the copy may not read as "approved" or "completed work".
        label: translate('auto.components.TaskPage.rowActivity.delivered', 'Delivered'),
        detail: translate(
          'auto.components.TaskPage.rowActivity.deliveredDetail',
          'Delivered · agent done'
        )
      }
    case 'workspace':
      return {
        label: translate('auto.components.TaskPage.rowActivity.workspace', 'Workspace'),
        detail: translate(
          'auto.components.TaskPage.rowActivity.workspaceDetail',
          'A workspace is bound; no agent is working'
        )
      }
  }
}

function needsYouDetail(
  dotState: Extract<TaskWorkbenchRowActivity, { kind: 'needs-you' }>['dotState']
): string {
  switch (dotState) {
    case 'failed':
      return translate(
        'auto.components.TaskPage.rowActivity.failedDetail',
        'An agent failed; the turn did not finish'
      )
    case 'blocked':
      return translate(
        'auto.components.TaskPage.rowActivity.blockedDetail',
        'An agent is blocked'
      )
    case 'waiting':
      return translate(
        'auto.components.TaskPage.rowActivity.waitingDetail',
        'An agent is waiting for your input'
      )
    case 'interrupted':
      return translate(
        'auto.components.TaskPage.rowActivity.interruptedDetail',
        'An agent’s turn was interrupted'
      )
  }
}

export function TaskPageGitHubRowActivityBadge({
  activity
}: {
  activity: TaskWorkbenchRowActivity
}): React.JSX.Element {
  const { label, detail } = getTaskPageGitHubRowActivityCopy(activity)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-row-activity={activity.kind}
          // Why: no fill — a muted wash would stack on the row's hover:bg-accent
          // and read as a second hover tint (same reason as the ID pill). The
          // dot carries the state color, so the pill stays neutral in both themes
          // and needs no new token.
          className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border/40 px-1.5 py-0 text-[10px] leading-none font-medium text-muted-foreground"
        >
          <span aria-hidden="true" className="inline-flex">
            {/* Why title={null}: the pill's own tooltip is the localized
                sentence; a second nested tooltip would fight it. */}
            <AgentStateDot state={activity.dotState} size="sm" title={null} />
          </span>
          <span>{label}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {detail}
      </TooltipContent>
    </Tooltip>
  )
}

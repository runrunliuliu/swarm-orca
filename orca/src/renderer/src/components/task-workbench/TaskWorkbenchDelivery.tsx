import React from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { TaskWorkbenchPendingAction } from './task-workbench-pending-action'
import type { DeliveryEvidence, TaskWorkbenchLayout, TaskWorkbenchView } from './task-workbench-view'

/**
 * Delivery, as the second fact row of the facts strip (README §7.4.2):
 * `交付 [未读取] 此视图不运行 git / PR 查询 [读取]`, or
 * `交付 3 个提交 · PR #431 草稿 · 检查 5/6 · 评审待处理 [展开]`.
 *
 * What it must never claim (README §7.3.1, §7.5):
 * - `view.delivery === undefined` is "no evidence read yet", not "nothing was
 *   delivered" — it degrades to a labelled fact, not a dashed warning box.
 * - An empty commit count and a missing `checks` entry are absences, so each
 *   count is rendered only when it exists.
 * - The word "Delivered" never appears: a merged PR says `merged`, and a
 *   failure / cancellation / 0-workspace view is simply not delivery evidence.
 *
 * Why the fold is on the row: §7.4.2 moved every section action onto its own
 * heading/row line, so `[Collapse ⌃]` no longer starts a line of its own.
 */

/** Stable id so the toggle's `aria-controls` names exactly the body it unfolds.
 *  One workbench per screen, so a constant id cannot collide. */
const BODY_ID = 'task-workbench-delivery-body'

/** P1b owns reading evidence; the control renders disabled until then
 *  (README §7.4.2 取舍 3). */
const NOT_WIRED = 'Not wired in this build yet'

function deliveryKeys(key: string): string {
  return `auto.components.TaskWorkbenchDelivery.${key}`
}

const PULL_REQUEST_STATE_COPY: Record<
  NonNullable<DeliveryEvidence['pullRequest']>['state'],
  string
> = {
  draft: 'draft',
  open: 'open',
  merged: 'merged',
  closed: 'closed'
}

const REVIEW_STATE_COPY: Record<NonNullable<DeliveryEvidence['review']>, string> = {
  pending: 'Review pending',
  approved: 'Review approved',
  'changes-requested': 'Changes requested'
}

function PullRequestChip({
  pullRequest
}: {
  pullRequest: NonNullable<DeliveryEvidence['pullRequest']>
}): React.JSX.Element {
  return (
    <span className="flex shrink-0 items-center gap-1 text-[12px]">
      <span className="shrink-0 tabular-nums text-muted-foreground">
        {translate(deliveryKeys('pullRequestNumber'), 'PR #{{value0}}', {
          value0: String(pullRequest.number)
        })}
      </span>
      <span className="shrink-0 rounded-full px-1.5 py-0.5 text-[11px] ring-1 ring-inset ring-border/60">
        {translate(
          deliveryKeys(`pullRequestState.${pullRequest.state}`),
          PULL_REQUEST_STATE_COPY[pullRequest.state]
        )}
      </span>
    </span>
  )
}

export function TaskWorkbenchDelivery({
  view,
  layout
}: {
  view: TaskWorkbenchView
  layout: TaskWorkbenchLayout
}): React.JSX.Element {
  useTranslation()
  // The layout decides the default and the user's click overrides it until the
  // panel remounts (P1a renders one fixed size per fixture, so a click is the
  // only thing that changes this within a mount).
  const [override, setOverride] = React.useState<boolean | null>(null)
  const delivery = view.delivery
  const expanded = override ?? layout.delivery === 'expanded'

  const label = (
    <span className="shrink-0 text-[12px] font-semibold text-foreground">
      {translate(deliveryKeys('heading'), 'Delivery')}
    </span>
  )

  if (delivery === undefined) {
    return (
      <section
        data-testid="task-workbench-delivery"
        className="flex min-w-0 items-center gap-2 px-3 py-2"
      >
        {label}
        <span className="shrink-0 rounded-full px-1.5 py-0.5 text-[11px] text-muted-foreground ring-1 ring-inset ring-border/60">
          {translate(deliveryKeys('notRead'), 'Not loaded')}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">
          {translate(
            deliveryKeys('noEvidence'),
            'This view runs no git or PR lookup, so nothing here says the task was delivered.'
          )}
        </span>
        <TaskWorkbenchPendingAction
          label={translate(deliveryKeys('read'), 'Load evidence')}
          hint={translate(deliveryKeys('notWired'), NOT_WIRED)}
          testId="task-workbench-delivery-read"
        />
      </section>
    )
  }

  const commitCount = delivery.commits.count
  const pullRequest = delivery.pullRequest
  const checks = delivery.checks
  const review = delivery.review

  return (
    <section data-testid="task-workbench-delivery" className="px-3 py-2">
      <Collapsible open={expanded} onOpenChange={setOverride}>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          {label}

          {commitCount > 0 ? (
            <span className="text-[12px] tabular-nums" data-testid="task-workbench-delivery-commits">
              {translate(deliveryKeys('commitCount'), '{{value0}} commits', {
                value0: String(commitCount)
              })}
            </span>
          ) : null}

          {pullRequest ? <PullRequestChip pullRequest={pullRequest} /> : null}

          {checks ? (
            <span className="text-[12px] tabular-nums" data-testid="task-workbench-delivery-checks">
              {translate(deliveryKeys('checksCount'), 'checks {{value0}}/{{value1}}', {
                value0: String(checks.passing),
                value1: String(checks.total)
              })}
            </span>
          ) : null}

          {review ? (
            <span className="text-[12px] text-muted-foreground" data-testid="task-workbench-delivery-review">
              {translate(deliveryKeys(`review.${review}`), REVIEW_STATE_COPY[review])}
            </span>
          ) : null}

          <Button
            type="button"
            variant="ghost"
            size="xs"
            data-testid="task-workbench-delivery-toggle"
            aria-expanded={expanded}
            aria-controls={BODY_ID}
            onClick={() => setOverride(!expanded)}
            className="ml-auto shrink-0"
          >
            <span className="text-muted-foreground">
              {expanded
                ? translate(deliveryKeys('collapse'), 'Collapse')
                : translate(deliveryKeys('expand'), 'Expand')}
            </span>
            <ChevronDown
              aria-hidden="true"
              className={cn('size-3.5 transition-transform', expanded && 'rotate-180')}
            />
          </Button>
        </div>

        <CollapsibleContent id={BODY_ID}>
          {/* Why the testid sits on the inner element: Radix keeps an empty
              CollapsibleContent node mounted while collapsed, so an id on the
              wrapper would be "present" with no content — a DOM assertion that
              lies about what is on screen. Presence now means content. */}
          <div
            data-testid="task-workbench-delivery-body"
            className="mt-1.5 flex flex-col gap-0.5 text-[12px] text-muted-foreground"
          >
            {delivery.commits.lastSubject ? (
              <span className="min-w-0 truncate">
                {translate(deliveryKeys('lastCommit'), 'Last commit: {{value0}}', {
                  value0: delivery.commits.lastSubject
                })}
              </span>
            ) : null}

            {pullRequest ? (
              <a
                href={pullRequest.url}
                target="_blank"
                rel="noreferrer"
                className="min-w-0 truncate text-foreground underline-offset-4 hover:underline"
              >
                {pullRequest.title}
              </a>
            ) : null}

            {review ? (
              <span>
                {translate(deliveryKeys('reviewDetail'), 'Review state: {{value0}}', {
                  value0: translate(deliveryKeys(`review.${review}`), REVIEW_STATE_COPY[review])
                })}
              </span>
            ) : null}

            <span className="text-muted-foreground/80">
              {translate(
                deliveryKeys('readOnly'),
                'Read-only evidence. This view runs no git, polling or PR refresh.'
              )}
            </span>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </section>
  )
}

import React from 'react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type {
  TaskWorkbenchDeliverProjection,
  TaskWorkbenchDeliverStateKind
} from './task-workbench-deliver-state'
import type { DeliveryEvidence } from './task-workbench-view'

/**
 * The delivery row's state signature and fact items (README §7.12 §6.2).
 *
 * Why a separate file: the Delivery row is already the longest one in the facts
 * strip, and keeping these two pure renderers here is what stops the row from
 * growing past the `max-lines` budget. Nothing here reads a store or decides a
 * state — the projection owns both.
 *
 * Two rules it must not break:
 * - a state word is never invented: every label below reuses the existing
 *   vocabulary (§7.4.3), and `no-workspace` renders nothing at all;
 * - a fact needs a source: no review means no PR item (never `PR #0`), no
 *   tracker number means no issue item (never a number parsed out of a URL),
 *   and a PR item the evidence strip already prints is not repeated.
 */

function deliveryKeys(key: string): string {
  return `auto.components.TaskWorkbenchDelivery.${key}`
}

/** One state signature per projection state, using the existing vocabulary only.
 *  `no-workspace` prints nothing — the entry's absence is the whole answer — and
 *  `archived` reuses the row's own word. */
const DELIVER_STATE_COPY: Record<
  Exclude<TaskWorkbenchDeliverStateKind, 'no-workspace'>,
  { key: string; fallback: string }
> = {
  archived: { key: 'auto.components.TaskWorkbenchWorkspaces.archived', fallback: 'Archived' },
  completed: { key: 'auto.components.TaskWorkbenchDeliver.stateCompleted', fallback: 'Delivered' },
  'deliver-session': {
    key: 'auto.components.TaskWorkbenchDeliver.stateDelivering',
    fallback: 'Delivering'
  },
  'one-writer': { key: 'auto.components.TaskWorkbenchDeliver.stateDeliverable', fallback: 'Ready' },
  'zero-evidence': {
    key: 'auto.components.TaskWorkbenchDeliver.stateDeliverable',
    fallback: 'Ready'
  },
  'has-evidence': {
    key: 'auto.components.TaskWorkbenchDeliver.stateDeliverable',
    fallback: 'Ready'
  },
  'evidence-not-read': {
    key: 'auto.components.TaskWorkbenchDelivery.notRead',
    fallback: 'Not loaded'
  }
}

/** The delivered row's signature (§7.12 D4): 已交付 is accent, 交付中 carries the
 *  working dot, and the absences keep the neutral outline they already had. */
export function DeliverStateChip({
  projection
}: {
  projection: TaskWorkbenchDeliverProjection
}): React.JSX.Element | null {
  if (projection.state === 'no-workspace') {
    return null
  }
  const copy = DELIVER_STATE_COPY[projection.state]
  const accent = projection.state === 'completed'
  return (
    <span
      data-testid="task-workbench-delivery-state"
      data-state={projection.state}
      className={cn(
        'shrink-0 rounded-full px-1.5 py-0.5 text-[11px]',
        accent
          ? 'bg-primary/10 text-primary ring-1 ring-inset ring-primary/30'
          : 'text-muted-foreground ring-1 ring-inset ring-border/60'
      )}
    >
      {projection.state === 'deliver-session' ? (
        <span aria-hidden="true" className="mr-1 inline-block size-1.5 rounded-full bg-primary" />
      ) : null}
      {translate(copy.key, copy.fallback)}
    </span>
  )
}

/** The facts a row may state (§7.12 A6–A8). */
export function DeliverFacts({
  projection,
  delivery
}: {
  projection: TaskWorkbenchDeliverProjection
  delivery: DeliveryEvidence | undefined
}): React.JSX.Element | null {
  // Suppress the row's PR only when the evidence strip already prints that same
  // PR. The strip's evidence is task-level and may name another workspace, so
  // existence alone is not identity (§7.12 S3: each workspace's own review is
  // the only PR source for its row).
  const projectedPullRequest = projection.facts.pullRequest
  const pullRequest =
    projectedPullRequest !== undefined &&
    delivery?.pullRequest?.number === projectedPullRequest.number
      ? undefined
      : projectedPullRequest
  const issue = projection.facts.issue
  if (pullRequest === undefined && issue === undefined) {
    return null
  }
  return (
    <span
      data-testid="task-workbench-delivery-facts"
      className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[12px] text-muted-foreground"
    >
      {pullRequest ? (
        <>
          <span className="tabular-nums">
            {translate(deliveryKeys('pullRequestNumber'), 'PR #{{value0}}', {
              value0: String(pullRequest.number)
            })}
          </span>
          <span>{translate(deliveryKeys(`pullRequestState.${pullRequest.state}`), pullRequest.state)}</span>
        </>
      ) : null}
      {pullRequest && issue ? <span aria-hidden="true">·</span> : null}
      {issue ? (
        <span className="tabular-nums">
          {issue.state === 'closed'
            ? translate(deliveryKeys('issueClosed'), 'Issue #{{value0}} closed', {
                value0: String(issue.number)
              })
            : translate(deliveryKeys('issueOpen'), 'Issue #{{value0}} open', {
                value0: String(issue.number)
              })}
        </span>
      ) : null}
    </span>
  )
}

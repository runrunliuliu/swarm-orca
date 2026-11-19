import React from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import {
  TASK_WORKBENCH_DELIVER_NO_AGENT_NOTICE,
  launchTaskWorkbenchDeliver,
  revealTaskWorkbenchDeliverTab
} from '@/lib/task-workbench/task-workbench-deliver-launch'
import { TaskWorkbenchPendingAction } from './task-workbench-pending-action'
import {
  TaskWorkbenchDeliverConfirm,
  type TaskWorkbenchDeliverConfirmValue
} from './task-workbench-deliver-confirm'
import {
  projectTaskWorkbenchDeliver,
  type TaskWorkbenchDeliverAction
} from './task-workbench-deliver-state'
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
 *
 * Why the delivery entry sits at the row's right end (§7.11): the reader who
 * wants to hand the workspace off is already reading "what do we know about this
 * task from outside the agents", and "delivered" is the fact that follows. It is
 * the last thing on the row, after the fold toggle, and it never adds a second
 * filled primary — the entry and the confirmation's submit are both `outline`
 * (README §7.4.2, §7.11.3 rule 2).
 *
 * The state and the one action come from `projectTaskWorkbenchDeliver`, the same
 * projection the sidebar entry reads, so the two entries cannot disagree about
 * whether this workspace may be delivered (§7.11.3 rule 1, rule 4).
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

function deliverKeys(key: string): string {
  return `auto.components.TaskWorkbenchDeliver.${key}`
}

/**
 * The entry itself, in whichever of the four shapes the projection emitted.
 *
 * - `none` renders nothing at all: no disabled ghost, no row. A workspace that
 *   is archived or absent gets no delivery entry (`no-workspace` / `archived`).
 * - `open-terminal` reveals the `DELIVER` session that already exists and never
 *   starts a second one (rule 4 / A4). When the reveal finds nothing (a row
 *   whose name says `DELIVER` but whose marker tab is gone), it falls back to
 *   the confirmation instead of being a dead click (K4).
 * - `deliver` + `enabled: false` reuses `TaskWorkbenchPendingAction` for its
 *   reachability shape — the wrapper owns the `title` because a disabled
 *   `Button` cannot be hovered, and the reason is also `sr-only` text the button
 *   is `aria-describedby`, so a keyboard reader hears it too.
 * - `deliver` + enabled is a live `Button` that only opens the confirmation.
 */
function DeliverEntry({
  action,
  entryRef,
  onOpen,
  onReveal
}: {
  action: TaskWorkbenchDeliverAction
  entryRef: React.RefObject<HTMLSpanElement | null>
  onOpen: () => void
  onReveal: () => void
}): React.JSX.Element | null {
  if (action.kind === 'none') {
    return null
  }
  let body: React.JSX.Element
  if (action.kind === 'open-terminal') {
    body = (
      <Button
        type="button"
        variant="outline"
        size="xs"
        data-testid="task-workbench-deliver-action"
        onClick={onReveal}
      >
        {translate(deliverKeys('openTerminal'), 'Open terminal')}
      </Button>
    )
  } else if (!action.enabled) {
    body = (
      <TaskWorkbenchPendingAction
        label={translate(deliverKeys('action'), 'Deliver…')}
        hint={translate(action.disabledReason.key, action.disabledReason.fallback)}
        testId="task-workbench-deliver-action"
        variant="outline"
      />
    )
  } else {
    body = (
      <Button
        type="button"
        variant="outline"
        size="xs"
        data-testid="task-workbench-deliver-action"
        onClick={onOpen}
      >
        {translate(deliverKeys('action'), 'Deliver…')}
        <ChevronDown aria-hidden="true" className="opacity-60" />
      </Button>
    )
  }
  return (
    <span ref={entryRef} className="inline-flex shrink-0">
      {body}
    </span>
  )
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

  // §7.11's one projection, read here exactly as the sidebar entry reads it.
  const projection = projectTaskWorkbenchDeliver(view)
  const [confirmOpen, setConfirmOpen] = React.useState(false)
  // Why the guard lives for the whole panel lifetime: the launch is synchronous
  // once it starts, but a second click in the same panel must not be able to
  // start a second agent, and nothing here may clear the guard before the panel
  // closes (the launcher's own store re-check is the other half).
  const [submitting, setSubmitting] = React.useState(false)
  const entryRef = React.useRef<HTMLSpanElement | null>(null)
  const [confirmStyle, setConfirmStyle] = React.useState<React.CSSProperties | undefined>(undefined)

  // Why measured: the facts strip clips its children (`overflow-hidden` in
  // TaskWorkbenchFacts.tsx), so the panel is placed with `position: fixed`
  // against the entry's own box instead of nesting an absolute child that would
  // be cut off at the strip's edge.
  const openConfirm = React.useCallback((): void => {
    const rect = entryRef.current?.getBoundingClientRect()
    setConfirmStyle(
      rect
        ? {
            position: 'fixed',
            top: rect.bottom + 6,
            right: Math.max(8, window.innerWidth - rect.right)
          }
        : undefined
    )
    setConfirmOpen(true)
  }, [])

  const closeConfirm = React.useCallback((): void => {
    setConfirmOpen(false)
    setSubmitting(false)
  }, [])

  const revealDeliverSession = React.useCallback((): void => {
    const workspaceId = projection.workspaceId
    if (workspaceId === undefined) {
      return
    }
    // K4: a `conversationName` of DELIVER does not prove a marker tab exists
    // (a plain `customTitle` can produce the name). Reveal first; when there is
    // nothing to reveal, fall back to the confirmation, as the sidebar does.
    if (!revealTaskWorkbenchDeliverTab(workspaceId)) {
      openConfirm()
    }
  }, [projection.workspaceId, openConfirm])

  // The only launch site for this entry. The three values go to
  // `launchTaskWorkbenchDeliver` untouched: the form decides them, the launcher
  // decides whether a session may start (§7.11.3 rules 3, 4).
  const submitDeliver = (value: TaskWorkbenchDeliverConfirmValue): void => {
    const workspaceId = projection.workspaceId
    if (workspaceId === undefined || submitting) {
      return
    }
    // K1: re-project at submit time. The panel stays mounted across a view
    // change (an agent can start Working, the workspace can be archived), and
    // the launcher only re-checks the DELIVER marker — not this eligibility.
    // A target that moved, disappeared or lost its right to deliver must not
    // launch; the one-writer case states the frozen reason, the rest just close.
    const current = projectTaskWorkbenchDeliver(view)
    if (current.workspaceId !== workspaceId || current.action.kind === 'none') {
      closeConfirm()
      return
    }
    if (current.action.kind === 'deliver' && !current.action.enabled) {
      closeConfirm()
      toast.error(
        translate(current.action.disabledReason.key, current.action.disabledReason.fallback)
      )
      return
    }
    // `open-terminal` deliberately falls through: the launcher re-checks the
    // live marker, so a real session is revealed (`already-delivering`) and a
    // stale name-only row still launches (K4).
    setSubmitting(true)
    const result = launchTaskWorkbenchDeliver({
      worktreeId: workspaceId,
      targetBranch: value.targetBranch,
      integrationMode: value.integrationMode,
      archiveAfter: value.archiveAfter,
      source: 'task_page'
    })
    if (result.ok) {
      closeConfirm()
      return
    }
    if (result.reason === 'no-agent') {
      // The panel stays open with its guard still on; the shared terminal copy
      // says why, and closing it is the reader's next move (F6: one exported
      // pair, not a second copy in this host).
      toast.error(
        translate(
          TASK_WORKBENCH_DELIVER_NO_AGENT_NOTICE.key,
          TASK_WORKBENCH_DELIVER_NO_AGENT_NOTICE.fallback
        )
      )
      return
    }
    // A DELIVER session appeared between render and click (the documented
    // reopen case): point at it instead of starting another one.
    revealTaskWorkbenchDeliverTab(workspaceId)
    closeConfirm()
  }

  const targetWorkspace =
    projection.workspaceId === undefined
      ? undefined
      : view.workspaces.find((workspace) => workspace.worktreeId === projection.workspaceId)
  const confirmHeading = targetWorkspace
    ? [targetWorkspace.repoName, targetWorkspace.branchName ?? targetWorkspace.worktreeName]
        .filter((part) => part !== '')
        .join(' · ')
    : ''
  // `open-terminal` is included on purpose: a failed reveal opens this panel
  // (K4), and submit re-projects before deciding whether to launch (K1).
  const confirm =
    confirmOpen && projection.action.kind !== 'none' && projection.workspaceId !== undefined ? (
      <TaskWorkbenchDeliverConfirm
        heading={confirmHeading}
        {...(view.targetBranchDefault !== undefined
          ? { defaultTargetBranch: view.targetBranchDefault }
          : {})}
        attention={projection.attention}
        submitting={submitting}
        onCancel={closeConfirm}
        onClose={closeConfirm}
        onSubmit={submitDeliver}
        style={confirmStyle}
      />
    ) : null

  const entry = (
    <DeliverEntry
      action={projection.action}
      entryRef={entryRef}
      onOpen={openConfirm}
      onReveal={revealDeliverSession}
    />
  )

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
        {entry}
        {confirm}
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

          {/* Rule 1: one action, one row line — the entry is the row's right end,
              after the fold toggle, never a row of its own. */}
          {entry}
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
      {confirm}
    </section>
  )
}

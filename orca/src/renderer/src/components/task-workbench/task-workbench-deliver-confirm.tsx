import React from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { TaskWorkbenchDeliverIntegrationMode } from '@/lib/task-workbench/task-workbench-deliver-launch'

/**
 * The delivery confirmation every entry opens (README §7.11.3 rules 2, 3, 6,
 * §7.11.5): three required inputs — target branch, integration mode,
 * archive-after — plus the policy line, the archive-after hint and, only when
 * the projection has one, the `注意` sentence.
 *
 * Why an inline panel and not a `Dialog`: §7.4.2 keeps exactly one filled
 * primary on the screen (the page header's). A modal would both add a second
 * solid button and trap focus over a read-only page. So the submit button is
 * `variant="outline"`, the panel renders `role="dialog"` nowhere, and nothing
 * here intercepts the page behind it. The `注意` line states a fact and never
 * darkens, disables or gates anything (rule 6).
 *
 * Why the panel is positioned by the host: the facts strip it opens from is
 * `overflow-hidden` (TaskWorkbenchFacts.tsx), so an absolutely positioned child
 * would be clipped. The host measures its trigger and hands the placement down;
 * this file owns the panel's content and layout only.
 *
 * Why the three inputs are local form state: the two hosts (fact row, sidebar
 * menu) must not each re-implement the form, and nothing outside the panel reads
 * a half-typed value. Only the lifetime is controlled from outside — the host
 * decides when the panel is open and whether a launch is already pending
 * (`submitting`), and receives the three values once, on submit.
 *
 * Why no store/RPC import: the workbench import-boundary test pins it
 * (`task-workbench-import-boundary.test.ts`), and the real launch path lives in
 * `lib/task-workbench/task-workbench-deliver-launch.ts` — called by the host,
 * never here.
 */

/** One sentence the panel may state: the locale key plus its English fallback,
 *  the same shape the state projection uses. Never a bare string, so a host
 *  cannot drop the key, and never a number, so nothing is invented. */
export type TaskWorkbenchDeliverConfirmNotice = { key: string; fallback: string }

export type TaskWorkbenchDeliverConfirmValue = {
  targetBranch: string
  integrationMode: TaskWorkbenchDeliverIntegrationMode
  /** §7.12 D1: merging is a remote, irreversible write, so it is an explicit
   *  tick. Creating the PR is fixed on (rule 7) and has no field. */
  mergePullRequest: boolean
  /** Closing the issue, likewise. Only offered when the page names a number. */
  closeIssue: boolean
  archiveAfter: boolean
}

export type TaskWorkbenchDeliverConfirmProps = {
  /** What is being delivered, e.g. `acme/web-app · feat/task-431`. */
  heading: string
  /** The repo's main worktree branch, when the view knows it. Fills the field
   *  and labels it `默认值 · 需确认`; absent leaves the field empty, which blocks
   *  submit with the frozen required reason. */
  defaultTargetBranch?: string
  /** The page's own issue number, when it has one. Its presence is what offers
   *  the `关闭 issue` tick; without it the tick is not rendered as chosen and the
   *  instruction reports the close as not authorized (§7.12 A3). */
  issueNumber?: number
  /** Rows of the `注意` line. Empty today (§7.11.6): the panel then renders
   *  nothing for it — not an empty box and not a "no warnings" claim. */
  attention?: readonly TaskWorkbenchDeliverConfirmNotice[]
  /** True while a launch started from this panel is pending. Keeps the submit
   *  button disabled for the rest of the panel's lifetime, so a second click
   *  cannot start a second agent. */
  submitting?: boolean
  onCancel: () => void
  onClose: () => void
  onSubmit: (value: TaskWorkbenchDeliverConfirmValue) => void
  /** Placement/depth supplied by the host (see the module comment). */
  style?: React.CSSProperties
  className?: string
}

function confirmKeys(key: string): string {
  return `auto.components.TaskWorkbenchDeliver.${key}`
}

/** Frozen integration modes, in the design's order (README §7.11.2 D2). The
 *  default is `pr`: rule 7 integrates through the remote and never writes the
 *  primary checkout. */
const INTEGRATION_MODES: readonly TaskWorkbenchDeliverIntegrationMode[] = [
  'pr',
  'local-merge',
  'squash'
]

/** Stable empty list: a literal default would be re-created every render. */
const NO_NOTICES: readonly TaskWorkbenchDeliverConfirmNotice[] = []

const INTEGRATION_MODE_COPY: Record<TaskWorkbenchDeliverIntegrationMode, string> = {
  pr: 'PR',
  'local-merge': 'Local merge',
  squash: 'Squash'
}

const INTEGRATION_MODE_KEY: Record<TaskWorkbenchDeliverIntegrationMode, string> = {
  pr: 'integrationMode.pr',
  'local-merge': 'integrationMode.localMerge',
  squash: 'integrationMode.squash'
}

/** Constant ids: one confirmation exists at a time (the panel is a single-open
 *  popover), and the reason must be referable from the submit button. */
const REQUIRED_ID = 'task-workbench-deliver-target-branch-required'
const MODE_LABEL_ID = 'task-workbench-deliver-integration-label'
const BRANCH_LABEL_ID = 'task-workbench-deliver-target-branch-label'
const ARCHIVE_LABEL_ID = 'task-workbench-deliver-archive-after-label'
const ARCHIVE_HINT_ID = 'task-workbench-deliver-archive-after-hint'
const CREATE_PR_LABEL_ID = 'task-workbench-deliver-create-pr-label'
const MERGE_PR_LABEL_ID = 'task-workbench-deliver-merge-pr-label'
const CLOSE_ISSUE_LABEL_ID = 'task-workbench-deliver-close-issue-label'

export function TaskWorkbenchDeliverConfirm({
  heading,
  defaultTargetBranch,
  issueNumber,
  attention = NO_NOTICES,
  submitting = false,
  onCancel,
  onClose,
  onSubmit,
  style,
  className
}: TaskWorkbenchDeliverConfirmProps): React.JSX.Element {
  useTranslation()
  const [targetBranch, setTargetBranch] = React.useState(defaultTargetBranch ?? '')
  const [integrationMode, setIntegrationMode] =
    React.useState<TaskWorkbenchDeliverIntegrationMode>('pr')
  // §7.12 D1 defaults: merging and closing are on (they are what "deliver"
  // means), archiving is off (it hides the report). Closing is only on when the
  // page actually names an issue; otherwise there is nothing to authorize.
  const [mergePullRequest, setMergePullRequest] = React.useState(true)
  const [closeIssue, setCloseIssue] = React.useState(issueNumber !== undefined)
  const [archiveAfter, setArchiveAfter] = React.useState(false)
  const branchInputRef = React.useRef<HTMLInputElement | null>(null)

  // Escape closes like Cancel (README §7.11.3 rule 2 — a popover the reader can
  // dismiss without hunting for the mouse). Listening on the window keeps that
  // true once focus has moved to the panel's own controls.
  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  React.useEffect(() => {
    branchInputRef.current?.focus()
  }, [])

  // Why the label is conditional on equality: `默认值 · 需确认` says "this value
  // is a default, not your decision". Once the reader types something else it is
  // their own input, and continuing to call it a default would be a false claim.
  const showsDefaultLabel =
    defaultTargetBranch !== undefined &&
    defaultTargetBranch.trim() !== '' &&
    targetBranch === defaultTargetBranch

  const branchMissing = targetBranch.trim() === ''
  const submitBlocked = branchMissing || submitting

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (submitBlocked) {
      return
    }
    onSubmit({
      targetBranch: targetBranch.trim(),
      integrationMode,
      mergePullRequest,
      closeIssue: closeIssue && issueNumber !== undefined,
      archiveAfter
    })
  }

  return (
    <div
      data-testid="task-workbench-deliver-confirm"
      style={style}
      className={cn(
        'z-[60] flex w-[440px] max-w-[calc(100vw-16px)] flex-col overflow-hidden rounded-lg border border-black/14 bg-[rgba(255,255,255,0.94)] text-popover-foreground shadow-[0_16px_36px_rgba(0,0,0,0.24),inset_0_1px_0_rgba(255,255,255,0.14)] backdrop-blur-2xl dark:border-white/14 dark:bg-[rgba(0,0,0,0.86)] dark:shadow-[0_20px_44px_rgba(0,0,0,0.42),inset_0_1px_0_rgba(255,255,255,0.04)]',
        className
      )}
    >
      <form onSubmit={handleSubmit} className="flex flex-col">
        <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2">
          <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-foreground">
            {translate(confirmKeys('confirmHeading'), 'Deliver {{value0}}', { value0: heading })}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            data-testid="task-workbench-deliver-close"
            aria-label={translate(confirmKeys('close'), 'Close')}
            onClick={onClose}
            className="shrink-0"
          >
            <X aria-hidden="true" />
          </Button>
        </div>

        <div className="flex flex-col gap-2 px-3 py-2 text-[12px]">
          {/* Row 1: the one input that can block the launch. */}
          <div className="flex items-center gap-2">
            <span id={BRANCH_LABEL_ID} className="w-16 shrink-0 text-muted-foreground">
              {translate(confirmKeys('targetBranch'), 'Target branch')}
            </span>
            <Input
              ref={branchInputRef}
              id="task-workbench-deliver-target-branch"
              data-testid="task-workbench-deliver-target-branch"
              aria-labelledby={BRANCH_LABEL_ID}
              aria-invalid={branchMissing}
              aria-describedby={branchMissing ? REQUIRED_ID : undefined}
              value={targetBranch}
              onChange={(event) => setTargetBranch(event.target.value)}
              placeholder={translate(confirmKeys('targetBranch'), 'Target branch')}
              className="h-7 flex-1"
            />
            {showsDefaultLabel ? (
              <span
                data-testid="task-workbench-deliver-target-branch-default"
                className="shrink-0 whitespace-nowrap text-[11px] text-muted-foreground"
              >
                {translate(confirmKeys('targetBranchDefault'), 'Default · needs confirmation')}
              </span>
            ) : null}
          </div>

          {/* Where the integration writes, stated on its own line: the frozen
              vocabulary has no row label for it, and inventing one would be a
              second catalog key (SHARED-CONTEXT). */}
          <p className="text-muted-foreground">
            {translate(
              confirmKeys('policy'),
              'Delivery integrates through a pull request; nothing is written to the primary checkout.'
            )}
          </p>

          {/* Row 2: integration mode, radiogroup so the three are one choice. */}
          <div className="flex items-center gap-2">
            <span id={MODE_LABEL_ID} className="w-16 shrink-0 text-muted-foreground">
              {translate(confirmKeys('integrationMode'), 'Integration')}
            </span>
            <div
              role="radiogroup"
              aria-labelledby={MODE_LABEL_ID}
              data-testid="task-workbench-deliver-integration"
              className="flex flex-wrap items-center gap-1.5"
            >
              {INTEGRATION_MODES.map((mode) => (
                <Button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={integrationMode === mode}
                  variant={integrationMode === mode ? 'outline' : 'ghost'}
                  size="xs"
                  data-mode={mode}
                  onClick={() => setIntegrationMode(mode)}
                >
                  {translate(
                    confirmKeys(INTEGRATION_MODE_KEY[mode]),
                    INTEGRATION_MODE_COPY[mode]
                  )}
                </Button>
              ))}
            </div>
          </div>

          {/* Row 3: 交付范围 (§7.12 D1) — the three writes this delivery may
              perform, plus the archive Orca performs after observing completion.
              Creating the PR is fixed on (`disabled`) because rule 7 makes it
              unconditional; the other two are the operator's explicit consent to
              an irreversible remote write. */}
          <div className="flex flex-col gap-1 border-t border-border/50 pt-2">
            <span className="text-muted-foreground">
              {translate(confirmKeys('scope'), 'Deliver scope')}
            </span>

            <span className="flex items-center gap-1.5">
              <Checkbox
                id="task-workbench-deliver-create-pr"
                data-testid="task-workbench-deliver-create-pr"
                aria-labelledby={CREATE_PR_LABEL_ID}
                checked
                disabled
              />
              <label
                id={CREATE_PR_LABEL_ID}
                htmlFor="task-workbench-deliver-create-pr"
                className="text-muted-foreground"
              >
                {translate(confirmKeys('createPullRequest'), 'Create pull request')}
              </label>
            </span>

            <span className="flex items-center gap-1.5">
              <Checkbox
                id="task-workbench-deliver-merge-pr"
                data-testid="task-workbench-deliver-merge-pr"
                aria-labelledby={MERGE_PR_LABEL_ID}
                checked={mergePullRequest}
                onCheckedChange={(next) => setMergePullRequest(next === true)}
              />
              <label
                id={MERGE_PR_LABEL_ID}
                htmlFor="task-workbench-deliver-merge-pr"
                className="cursor-pointer text-foreground"
              >
                {translate(confirmKeys('mergePullRequest'), 'Merge the pull request')}
              </label>
            </span>

            <span className="flex items-center gap-1.5">
              <Checkbox
                id="task-workbench-deliver-close-issue"
                data-testid="task-workbench-deliver-close-issue"
                aria-labelledby={CLOSE_ISSUE_LABEL_ID}
                checked={closeIssue && issueNumber !== undefined}
                disabled={issueNumber === undefined}
                onCheckedChange={(next) => setCloseIssue(next === true)}
              />
              <label
                id={CLOSE_ISSUE_LABEL_ID}
                htmlFor="task-workbench-deliver-close-issue"
                className={
                  issueNumber === undefined ? 'text-muted-foreground' : 'cursor-pointer text-foreground'
                }
              >
                {issueNumber === undefined
                  ? translate(confirmKeys('closeIssueUnavailable'), 'Close the issue')
                  : translate(confirmKeys('closeIssue'), 'Close issue #{{value0}}', {
                      value0: String(issueNumber)
                    })}
              </label>
            </span>

            <span className="flex items-center gap-1.5">
              <Checkbox
                id="task-workbench-deliver-archive-after"
                data-testid="task-workbench-deliver-archive-after"
                aria-labelledby={ARCHIVE_LABEL_ID}
                aria-describedby={ARCHIVE_HINT_ID}
                checked={archiveAfter}
                onCheckedChange={(next) => setArchiveAfter(next === true)}
              />
              <label
                id={ARCHIVE_LABEL_ID}
                htmlFor="task-workbench-deliver-archive-after"
                className="cursor-pointer text-foreground"
              >
                {translate(confirmKeys('archiveAfter'), 'Archive this workspace after delivery')}
              </label>
            </span>
            <span id={ARCHIVE_HINT_ID} className="pl-[calc(1rem+0.375rem)] text-[11px] text-muted-foreground">
              {translate(
                confirmKeys('archiveAfterHint'),
                'The delivery agent archives this workspace after it reports; find it again under Show archived.'
              )}
            </span>
            {issueNumber === undefined ? (
              <span className="text-[11px] text-muted-foreground">
                {translate(
                  confirmKeys('closeIssueUnavailableHint'),
                  'This page names no issue, so delivery will not close one.'
                )}
              </span>
            ) : null}
          </div>

          {/* Rule 6: stated, never intercepted. Today the projection has no
              source for it, so this block does not render at all. */}
          {attention.length > 0 ? (
            <div
              data-testid="task-workbench-deliver-confirm-attention"
              className="flex flex-col gap-0.5 border-t border-border/50 pt-2 text-muted-foreground"
            >
              {attention.map((notice) => (
                <span key={notice.key}>{translate(notice.key, notice.fallback)}</span>
              ))}
            </div>
          ) : null}

          {branchMissing ? (
            <span
              id={REQUIRED_ID}
              data-testid="task-workbench-deliver-target-branch-required"
              className="text-[11px] text-muted-foreground"
            >
              {translate(
                confirmKeys('targetBranchRequired'),
                'Choose a target branch first.'
              )}
            </span>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-1.5 border-t border-border/50 px-3 py-2">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            data-testid="task-workbench-deliver-cancel"
            onClick={onCancel}
          >
            <span className="text-muted-foreground">
              {translate(confirmKeys('cancel'), 'Cancel')}
            </span>
          </Button>
          {/* Why `outline`: the screen's only filled primary is the page header's
              (README §7.4.2, §7.11.3 rule 2). */}
          <Button
            type="submit"
            variant="outline"
            size="xs"
            data-testid="task-workbench-deliver-submit"
            disabled={submitBlocked}
            aria-describedby={branchMissing ? REQUIRED_ID : undefined}
          >
            {translate(confirmKeys('start'), 'Start delivery')}
          </Button>
        </div>
      </form>
    </div>
  )
}

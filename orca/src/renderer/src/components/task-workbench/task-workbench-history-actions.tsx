import React from 'react'
import { Button } from '@/components/ui/button'
import { useClipboardTextCopyFeedback } from '@/hooks/use-clipboard-text-copy-feedback'
import { translate } from '@/i18n/i18n'
import { TaskWorkbenchPendingAction } from './task-workbench-pending-action'
import type { TaskWorkbenchGapView } from './task-workbench-view'

/**
 * The History strip's actions and its recorded absences — the two things the run
 * list itself does not draw.
 *
 * Why the resume action lives here and not on the row: it is the one History
 * control that is really wired (issue #53 A2), and the components next to it are
 * deliberately not. Keeping them in one module makes the difference explicit
 * instead of leaving one `pending()` call that looks like its neighbours.
 */

function historyKeys(key: string): string {
  return `auto.components.TaskWorkbenchHistory.${key}`
}

const NOT_WIRED = 'Not available in this version'

/** A drawn-but-unwired action, spelled once so every such control names its hint
 *  the same way. README §7.4.2 requires these to look unavailable, never live. */
export function pendingHistoryAction(
  labelKey: string,
  fallback: string,
  testId: string
): React.JSX.Element {
  return (
    <TaskWorkbenchPendingAction
      label={translate(historyKeys(labelKey), fallback)}
      hint={translate(historyKeys('notWired'), NOT_WIRED)}
      testId={testId}
    />
  )
}

/**
 * `[resume]` on a record-sourced row (issue #53 A2): the record kept the
 * provider's own resume command and the checkout it belongs to, so the minimum
 * honest wiring is to hand that exact command to the person who asked for it —
 * never a command this build composed.
 *
 * Why copy and not "launch here": launching needs a main-process action that
 * takes a checkout path and a command, and no such action exists today. What is
 * copied is the recorded text, verbatim; the checkout it must run in travels with
 * the row (`data-checkout-path`) and is shown as the button's tooltip, so the
 * command is never offered without the directory that makes it work.
 */
export function HistoryResumeAction({
  command,
  checkoutPath
}: {
  command: string
  checkoutPath?: string
}): React.JSX.Element {
  const { copyText, status } = useClipboardTextCopyFeedback(command)
  const label =
    status === 'copied'
      ? translate(historyKeys('copied'), 'Copied')
      : status === 'failed'
        ? translate(historyKeys('copyFailed'), "Couldn't copy")
        : translate(historyKeys('copyResume'), 'Copy resume command')
  return (
    <span className="inline-flex shrink-0" title={checkoutPath ?? command}>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        data-testid="task-workbench-history-run-resume"
        data-copy-status={status}
        data-checkout-path={checkoutPath}
        onClick={() => void copyText()}
      >
        {/* Why muted on the text and not on the Button: the design-system lint
            forbids restyling <Button>'s own color (docs/STYLEGUIDE.md). */}
        <span className="text-muted-foreground">{label}</span>
      </Button>
    </span>
  )
}

/**
 * The absences the record stored for a workspace (issue #53 T2/T3).
 *
 * This list is the whole point of the fold's `gaps`: without it, a workspace that
 * ran with no attributable agent renders the same empty run list as a workspace
 * that never ran. Both sentences stay in the record's vocabulary — the kind
 * decides the sentence, `candidateCount` is quoted only when the writer counted,
 * and `detail` is the writer's own reason as a tooltip (never re-worded, because
 * the panel cannot know which observation produced it).
 *
 * One stored absence has two readings, and the DOM keeps them apart
 * (`data-gap-context`), because they say different things:
 *
 * - `standalone` — the workspace has no rows, so this sentence is the whole state
 *   and it is what the page says instead of "nothing ran";
 * - `provenance` — the rows arrived later (the session index supplied them), so
 *   the gap is the archive moment's own note. Printing "no agent could be
 *   attributed" over a full list would contradict the list under it.
 */
export function HistoryGapList({
  gaps
}: {
  gaps: readonly TaskWorkbenchGapView[]
}): React.JSX.Element {
  return (
    <ul
      data-testid="task-workbench-history-record-gaps"
      className="flex flex-col gap-0.5 text-[12px] text-muted-foreground"
    >
      {gaps.map((gap) => (
        <li
          key={`${gap.kind}|${gap.detail ?? ''}|${gap.standalone}`}
          data-testid="task-workbench-history-record-gap"
          data-gap-kind={gap.kind}
          data-gap-context={gap.standalone ? 'standalone' : 'provenance'}
          title={gap.detail}
        >
          {gapSentence(gap)}
          {gap.candidateCount === undefined ? null : (
            <>
              {' '}
              {translate(historyKeys('gap.candidates'), '({{value0}} candidates)', {
                value0: String(gap.candidateCount)
              })}
            </>
          )}
        </li>
      ))}
    </ul>
  )
}

function gapSentence(gap: TaskWorkbenchGapView): string {
  const ambiguous = gap.kind === 'ambiguous_match'
  if (!gap.standalone) {
    return ambiguous
      ? translate(
          historyKeys('gap.provenance.ambiguousMatch'),
          'Recorded at archive time: the session match was ambiguous; these rows were attributed later.'
        )
      : translate(
          historyKeys('gap.provenance.sessionUnattributable'),
          'Recorded at archive time: no pane attribution; these rows were attributed later.'
        )
  }
  return ambiguous
    ? translate(
        historyKeys('gap.ambiguousMatch'),
        'The record could not decide which agent ran here.'
      )
    : translate(
        historyKeys('gap.sessionUnattributable'),
        'No agent could be attributed to this workspace.'
      )
}

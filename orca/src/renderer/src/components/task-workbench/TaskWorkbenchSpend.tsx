import React from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUpRight } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { formatTokens } from '@/components/stats/usage-formatters'
import { translate } from '@/i18n/i18n'
import { TaskWorkbenchPendingAction } from './task-workbench-pending-action'
import {
  USAGE_STATUS_WORD,
  spendStatus,
  usageStatusIsUnavailable,
  usageStatusLabelKey,
  usageStatusWordKey,
  type UsageStatus
} from './task-workbench-usage-status'
import type { SpendReason, SpendView, TaskWorkbenchLayout, TaskWorkbenchView } from './task-workbench-view'

/**
 * Task-level usage, as one fact row of the facts strip (README §7.4.2):
 * `用量 [未启用] 一句原因 [设置]`, or `用量 1.4M token · 约 $1.82` with the
 * provider breakdown on a second line when the layout keeps Spend detail.
 *
 * Purely presentational: it reads `view.spend` and `layout.spend`, never a store,
 * an RPC or a usage scan. README §7.5 is what it renders — an absent figure is a
 * reason, never `0` / `$0`.
 *
 * Two changes from the card it replaced, both from §7.4.2: the badge shows the
 * reader's word (`Not enabled`) and keeps the internal token (`unavailable ·
 * disabled`) in its tooltip; and a missing figure is stated as a fact with no
 * dashed border, because a dashed box reads as a warning.
 */

type AvailableSpend = Extract<SpendView, { kind: 'available' }>

/** An unavailable figure has no number to show, and `0` would read as a measured
 *  zero (README §7.5 "假 0"). */
const ABSENT_FIGURE = '—'

/** The verbatim state token, kept for the tooltip only (see `USAGE_STATUS_WORD`). */
const STATUS_COPY: Record<UsageStatus, string> = {
  available: 'available',
  disabled: 'unavailable · disabled',
  unpriced: 'unavailable · unpriced',
  ambiguous_session: 'unavailable · ambiguous_session',
  no_matching_session: 'unavailable · no_matching_session',
  remote_host: 'unavailable · remote_host',
  unattributed: 'unavailable · unattributed'
}

/** One sentence per absence, saying what the reader can do or why no number
 *  exists. Exhaustive by type, so a new `SpendReason` cannot render silently. */
const REASON_COPY: Record<SpendReason, string> = {
  disabled: 'Usage tracking is off. No spend is recorded for this task.',
  unpriced: 'Some models in this task have no price, so the total is unknown.',
  ambiguous_session: 'More than one session matches this task, so usage cannot be attributed.',
  no_matching_session: 'No session matches this task yet, so there is nothing to total.',
  remote_host: 'This workspace runs on a remote host, where usage is not collected yet.',
  unattributed: 'Some sessions could not be tied to this task.'
}

/** P1b owns the Settings hop; the control stays visible but disabled until then
 *  (README §7.4.2 取舍 3). */
const NOT_WIRED = 'Not wired in this build yet'

function spendKeys(key: string): string {
  return `auto.components.TaskWorkbenchSpend.${key}`
}

function tokensText(tokens: number): string {
  return translate(spendKeys('tokensValue'), '{{value0}} tokens', {
    value0: formatTokens(tokens)
  })
}

function EstimatedCost({ costUsd }: { costUsd: number | null }): React.JSX.Element {
  const costText =
    costUsd === null
      ? ABSENT_FIGURE
      : translate(spendKeys('estimatedCost'), 'est. ${{value0}}', {
          value0: costUsd.toFixed(2)
        })
  const caveat =
    costUsd === null
      ? translate(
          spendKeys('costUnknown'),
          'A model in this task has no price, so no amount is estimated.'
        )
      : translate(spendKeys('costEstimated'), 'Estimated from provider pricing.')

  return (
    <TooltipProvider delayDuration={250}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="cursor-default tabular-nums">{costText}</span>
        </TooltipTrigger>
        <TooltipContent>{caveat}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

/** The absence: the reader's word, then the sentence that explains it. The word
 *  carries the verbatim token as its tooltip, so the exact state is still one
 *  hover away without being part of the interface. */
function Absence({ status, reason }: { status: UsageStatus; reason: SpendReason | null }): React.JSX.Element {
  return (
    <>
      <span
        data-testid="task-workbench-spend-status"
        title={translate(usageStatusLabelKey(status), STATUS_COPY[status])}
        className="shrink-0 rounded-full px-1.5 py-0.5 text-[11px] text-muted-foreground ring-1 ring-inset ring-border/60"
      >
        {translate(usageStatusWordKey(status), USAGE_STATUS_WORD[status])}
      </span>
      {reason === null ? null : (
        <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">
          {translate(spendKeys(`reason.${reason}`), REASON_COPY[reason])}
        </span>
      )}
    </>
  )
}

function TotalFigure({ spend }: { spend: AvailableSpend }): React.JSX.Element {
  return (
    <span
      data-testid="task-workbench-spend-total"
      className="flex min-w-0 items-baseline gap-1.5 text-[13px]"
    >
      <span className="tabular-nums">{tokensText(spend.tokens)}</span>
      <span aria-hidden="true" className="text-muted-foreground">
        ·
      </span>
      <EstimatedCost costUsd={spend.costUsd} />
    </span>
  )
}

/** One provider's slice, inline: `claude 412k · $1.20`. Provider names are data,
 *  not copy, so they stay untranslated. */
function ProviderSlice({
  provider,
  tokens,
  costUsd
}: {
  provider: string
  tokens: number
  costUsd: number | null
}): React.JSX.Element {
  return (
    <span
      data-testid="task-workbench-spend-provider-row"
      className="flex shrink-0 items-baseline gap-1 text-[12px] text-muted-foreground"
    >
      <span className="truncate">{provider}</span>
      <span className="tabular-nums">{formatTokens(tokens)}</span>
      <span aria-hidden="true">·</span>
      <span className="tabular-nums">
        {costUsd === null
          ? ABSENT_FIGURE
          : translate(spendKeys('providerCost'), '${{value0}}', {
              value0: costUsd.toFixed(2)
            })}
      </span>
    </span>
  )
}

export function TaskWorkbenchSpend({
  view,
  layout
}: {
  view: TaskWorkbenchView
  layout: TaskWorkbenchLayout
}): React.JSX.Element {
  useTranslation()
  const spend = view.spend
  // `summary` is the row alone; the provider breakdown is Spend detail, so it is
  // sacrificed first among Spend's parts (README §7.3.1).
  const fullDetail = layout.spend === 'full'
  const status = spendStatus(spend)

  return (
    <section data-testid="task-workbench-spend" className="flex flex-col gap-1 px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 text-[12px] font-semibold text-foreground">
          {translate(spendKeys('heading'), 'Usage')}
        </span>

        {usageStatusIsUnavailable(status) || spend.kind !== 'available' ? (
          <Absence status={status} reason={spend.kind === 'unavailable' ? spend.reason : null} />
        ) : (
          <TotalFigure spend={spend} />
        )}

        {spend.kind === 'available' && spend.unattributedSessions > 0 ? (
          <span
            data-testid="task-workbench-spend-unattributed"
            className="ml-auto shrink-0 rounded-full px-2 py-0.5 text-[11px] text-muted-foreground ring-1 ring-inset ring-border/60"
          >
            {translate(spendKeys('unattributedSessions'), '{{value0}} sessions unattributed', {
              value0: String(spend.unattributedSessions)
            })}
          </span>
        ) : null}

        {/* Why a CTA rather than `$0`: tracking being off is a state to fix, not a
            measured zero (README §7.5). Disabled until P1b wires the hop. */}
        {spend.kind === 'unavailable' && spend.reason === 'disabled' ? (
          <TaskWorkbenchPendingAction
            label={translate(spendKeys('turnOnTracking'), 'Settings')}
            hint={translate(spendKeys('notWired'), NOT_WIRED)}
            testId="task-workbench-spend-cta"
            className="ml-auto"
          >
            <ArrowUpRight aria-hidden="true" className="size-3.5" />
          </TaskWorkbenchPendingAction>
        ) : null}
      </div>

      {fullDetail && spend.kind === 'available' && spend.byProvider.length > 0 ? (
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
          {spend.byProvider.map((slice) => (
            <ProviderSlice
              key={slice.provider}
              provider={slice.provider}
              tokens={slice.tokens}
              costUsd={slice.costUsd}
            />
          ))}
        </div>
      ) : null}
    </section>
  )
}

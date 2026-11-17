import React from 'react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { formatTokens } from '@/components/stats/usage-formatters'
import { translate } from '@/i18n/i18n'
import {
  spendStatus,
  usageStatusIsUnavailable,
  usageStatusLabelKey,
  type UsageStatus
} from './task-workbench-usage-status'
import type {
  SpendReason,
  SpendView,
  TaskWorkbenchLayout,
  TaskWorkbenchView
} from './task-workbench-view'

/**
 * Task-level usage: tokens, estimated amount, the reason when there is no figure,
 * the provider breakdown and the unattributed-session count.
 *
 * Purely presentational: it reads `view.spend` and `layout.spend`, never a store,
 * an RPC or a usage scan. README §7.5 is what it renders — an absent figure is a
 * reason, never `0` / `$0`.
 */

type AvailableSpend = Extract<SpendView, { kind: 'available' }>

/** An unavailable figure has no number to show, and `0` would read as a measured
 *  zero (README §7.5 "假 0"). Same glyph `tokenText()` returns for an agent row. */
const ABSENT_FIGURE = '—'

/** The status badge's English copy of record. The reason token must stay verbatim
 *  inside it (contract §4.3), so it is literal text rather than a translatable
 *  word: `unavailable · ambiguous_session` is a state a reader can search for. */
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

function StatusPill({
  status,
  reason
}: {
  status: UsageStatus
  reason: SpendReason | null
}): React.JSX.Element {
  return (
    <span data-testid="task-workbench-spend-status" className="flex min-w-0 items-center gap-2">
      <Badge variant="outline" className="shrink-0">
        {translate(usageStatusLabelKey(status), STATUS_COPY[status])}
      </Badge>
      {reason === null ? null : (
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          {translate(spendKeys(`reason.${reason}`), REASON_COPY[reason])}
        </span>
      )}
    </span>
  )
}

function TotalFigure({ spend }: { spend: AvailableSpend }): React.JSX.Element {
  return (
    <span data-testid="task-workbench-spend-total" className="flex min-w-0 items-baseline gap-2">
      <span className="font-medium tabular-nums">{tokensText(spend.tokens)}</span>
      <span className="text-muted-foreground">·</span>
      <EstimatedCost costUsd={spend.costUsd} />
    </span>
  )
}

/** `available` is the only state that may print a figure, so the vocabulary
 *  helper decides, not a second `kind === 'available'` comparison of our own. */
function SpendFigure({ spend }: { spend: SpendView }): React.JSX.Element {
  const status = spendStatus(spend)
  if (usageStatusIsUnavailable(status) || spend.kind !== 'available') {
    return (
      <StatusPill
        status={status}
        reason={spend.kind === 'unavailable' ? spend.reason : null}
      />
    )
  }
  return <TotalFigure spend={spend} />
}

function ProviderRow({
  provider,
  tokens,
  costUsd
}: {
  provider: string
  tokens: number
  costUsd: number | null
}): React.JSX.Element {
  return (
    <li
      data-testid="task-workbench-spend-provider-row"
      className="flex items-center justify-between gap-3 text-xs"
    >
      {/* Provider names are data, not copy: they stay untranslated. */}
      <span className="min-w-0 truncate text-muted-foreground">{provider}</span>
      <span className="flex shrink-0 items-baseline gap-2 tabular-nums">
        <span>{tokensText(tokens)}</span>
        <EstimatedCost costUsd={costUsd} />
      </span>
    </li>
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
  // `summary` is one line: the figure or the reason, plus the unattributed
  // count. The provider breakdown is Spend detail, so it is sacrificed first
  // among Spend's parts (README §7.3.1).
  const fullDetail = layout.spend === 'full'

  return (
    <section
      data-testid="task-workbench-spend"
      className="flex flex-col gap-2 rounded-lg border border-border/60 bg-card/40 px-3 py-2"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {translate(spendKeys('heading'), 'Spend')}
        </span>
        <SpendFigure spend={spend} />
        {spend.kind === 'available' && spend.unattributedSessions > 0 ? (
          <span
            data-testid="task-workbench-spend-unattributed"
            className="shrink-0 rounded-full border border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground"
          >
            {translate(spendKeys('unattributedSessions'), '{{value0}} sessions unattributed', {
              value0: String(spend.unattributedSessions)
            })}
          </span>
        ) : null}
      </div>

      {fullDetail && spend.kind === 'available' && spend.byProvider.length > 0 ? (
        <ul className="flex flex-col gap-1 border-t border-border/50 pt-2">
          {spend.byProvider.map((slice) => (
            <ProviderRow
              key={slice.provider}
              provider={slice.provider}
              tokens={slice.tokens}
              costUsd={slice.costUsd}
            />
          ))}
        </ul>
      ) : null}

      {/* Why a CTA rather than `$0`: tracking being off is a state to fix, not a
          measured zero (README §7.5). No handler in P1a — the shell is static. */}
      {spend.kind === 'unavailable' && spend.reason === 'disabled' ? (
        <Button
          type="button"
          variant="outline"
          size="xs"
          data-testid="task-workbench-spend-cta"
          className="self-start"
        >
          {translate(spendKeys('turnOnTracking'), 'Turn on in Settings')}
        </Button>
      ) : null}
    </section>
  )
}

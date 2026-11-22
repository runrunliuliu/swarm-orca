import React from 'react'
import { formatTokens } from '@/components/stats/usage-formatters'
import { translate } from '@/i18n/i18n'
import { USAGE_STATUS_WORD } from './task-workbench-usage-status'
import type { TaskWorkbenchHistory as HistoryFacts } from './task-workbench-view'
import { formatClock, formatWallClock } from './task-workbench-history-format'

/**
 * The history strip's facts line (issue #31, extended by #53): how many agents,
 * how much measured wall clock, how many tokens, and — since #53 — where those
 * facts came from.
 *
 * Why it is its own module: it is the one part of the strip that states a task
 * total, and the run list below it must never disagree with it. Keeping the
 * formatting rules (unit-only wall clock, translated words, an absent figure with
 * its reason as a tooltip and never a `0`) beside the element that prints them
 * leaves the section component with layout only.
 */

function historyKeys(key: string): string {
  return `auto.components.TaskWorkbenchHistory.${key}`
}

/** The separator between two facts. Hoisted because it is static JSX: one
 *  element, so its tone cannot drift between the three places it appears. */
const FACT_DOT = (
  <span aria-hidden="true" className="text-muted-foreground/60">
    ·
  </span>
)

export function HistoryFactsLine({ history }: { history: HistoryFacts }): React.JSX.Element {
  const wall = formatWallClock(history.wall)
  const wallText =
    history.wall.kind === 'measured'
      ? translate(historyKeys('wallMeasured'), '{{value0}} wall', { value0: wall })
      : history.wall.kind === 'partial' && wall !== ''
        ? translate(historyKeys('wallPartial'), '{{value0}} wall (partial)', { value0: wall })
        : translate(historyKeys('wallUnknown'), 'wall unknown')
  const agentsText =
    history.agents === null
      ? translate(historyKeys('agentsUnknown'), 'agents unknown')
      : translate(historyKeys('agentsKnown'), '{{value0}} agents', {
          value0: String(history.agents)
        })
  const tokensText =
    history.tokens.kind === 'available'
      ? translate(historyKeys('tokensKnown'), '{{value0}} tokens', {
          value0: formatTokens(history.tokens.tokens)
        })
      : translate(historyKeys('tokensUnknown'), 'tokens unknown')

  return (
    <div
      data-testid="task-workbench-history-facts"
      className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[12.5px]"
    >
      <span className="tabular-nums">{agentsText}</span>
      {FACT_DOT}
      <span className="tabular-nums">{wallText}</span>
      {FACT_DOT}
      {/* An absent figure keeps its reason as the tooltip, never as a `0`. */}
      <span
        className="tabular-nums"
        title={
          history.tokens.kind === 'unavailable'
            ? USAGE_STATUS_WORD[history.tokens.reason]
            : undefined
        }
      >
        {tokensText}
      </span>
      {history.tokensSource === 'settled' ? (
        // A settled figure is a snapshot taken before a workspace became
        // unreadable; calling it live would be a claim about a scan that no
        // longer covers it.
        <span
          data-testid="task-workbench-history-tokens-settled"
          className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
        >
          {translate(historyKeys('settled'), 'settled')}
        </span>
      ) : null}
      {history.historySource !== 'record' && history.historySource !== 'mixed' ? null : (
        // Where these facts came from (issue #53 A1): a frozen observation the
        // record kept, not a live reading of a pane that may be long gone. A list
        // holding both kinds says so — one badge over live rows would claim they
        // are record facts (S7).
        <span
          data-testid="task-workbench-history-record-source"
          className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
        >
          {history.historySource === 'mixed'
            ? translate(historyKeys('factsFromRecordMixed'), 'Some facts from the record')
            : translate(historyKeys('factsFromRecord'), 'Facts from the record')}
        </span>
      )}
      {history.lastActivityAt === undefined ? null : (
        <>
          {FACT_DOT}
          <span className="tabular-nums text-muted-foreground">
            {translate(historyKeys('lastActivity'), 'last {{value0}}', {
              value0: formatClock(history.lastActivityAt)
            })}
          </span>
        </>
      )}
    </div>
  )
}

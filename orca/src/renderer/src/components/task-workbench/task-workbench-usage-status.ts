import type { AgentTokenView, SpendView } from './task-workbench-view'

/**
 * Usage vocabulary, no React and no data access.
 *
 * The reason tokens are copied from `shared/automations-types.ts`
 * (`AutomationRunUsageUnavailableReason`) and README §7.5 rather than imported:
 * importing them would drag an automation data path into a pure presentation
 * module, and the workbench needs two states that source does not have
 * (`disabled` for tracking switched off, `unpriced` for a model with no price).
 * The strings themselves are the copy of record — the Spend status text prints
 * them verbatim — so they must never be reworded here.
 */
export type UsageStatus =
  | 'available'
  | 'disabled'
  | 'unpriced'
  | 'ambiguous_session'
  | 'no_matching_session'
  | 'remote_host'
  | 'unattributed'

/** Stable display order: the available state first, then absence reasons in the
 *  order a reader meets them (off, unpriced, unattributable, remote, unassigned). */
export const USAGE_STATUS_ORDER: readonly UsageStatus[] = [
  'available',
  'disabled',
  'unpriced',
  'ambiguous_session',
  'no_matching_session',
  'remote_host',
  'unattributed'
]

/** Locale key of the status badge. The English copy lives in the catalog that the
 *  locale worker derives from the components, not here. */
export function usageStatusLabelKey(status: UsageStatus): string {
  return `auto.components.TaskWorkbenchSpend.status.${status}`
}

/** `available` is the only status that carries a figure; every other status is an
 *  absence and must render as an em dash or a reason, never as `0` / `$0`. */
export function usageStatusIsUnavailable(status: UsageStatus): boolean {
  return status !== 'available'
}

/** Maps a spend view onto the same vocabulary. A reason token is used verbatim so
 *  `SpendReason` and `UsageStatus` can never drift apart. */
export function spendStatus(view: SpendView): UsageStatus {
  return view.kind === 'available' ? 'available' : view.reason
}

/**
 * The text of an agent row's token chip.
 *
 * Why an em dash: an unavailable figure has no number to show, and `0` would
 * read as a measured zero (README §7.5 "假 0"). A `rollup` or `ai-vault` count of
 * `0` is a real zero and stays `"0"`.
 *
 * Why plain digits: the compact suffix and the `tok` unit are localized copy, so
 * they belong to the component and its catalog; this module stays free of
 * formatting policy that a screenshot could have to re-calibrate.
 */
export function tokenText(view: AgentTokenView): { text: string; unavailable: boolean } {
  if (view.kind === 'unavailable') {
    return { text: '—', unavailable: true }
  }
  return { text: String(view.tokens), unavailable: false }
}

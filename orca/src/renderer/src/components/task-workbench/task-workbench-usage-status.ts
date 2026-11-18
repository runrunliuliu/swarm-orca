import type { AgentTokenView, SpendView } from './task-workbench-view'

/**
 * Usage vocabulary, no React and no data access.
 *
 * The reason tokens are copied from `shared/automations-types.ts`
 * (`AutomationRunUsageUnavailableReason`) and README §7.5 rather than imported:
 * importing them would drag an automation data path into a pure presentation
 * module, and the workbench needs two states that source does not have
 * (`disabled` for tracking switched off, `unpriced` for a model with no price).
 * They stay verbatim (never reworded) because tests and bug reports quote them;
 * what changed in README §7.4.2 is only where they are shown — the badge prints
 * `USAGE_STATUS_WORD` and the token became its tooltip.
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

/** Locale key of the visible status word. */
export function usageStatusWordKey(status: UsageStatus): string {
  return `auto.components.TaskWorkbenchSpend.statusWord.${status}`
}

/**
 * The word a reader sees, and the reason the verbatim token is only a tooltip.
 *
 * README §7.4.2 removed the internal state token from the interface: a Chinese
 * panel that printed `不可用 · disabled` was showing the implementation's
 * vocabulary as if it were the reader's. The word below is the reader's
 * vocabulary; `usageStatusLabelKey` still renders the token in the tooltip, so a
 * reader who needs the exact state (and a bug report) can still find it.
 *
 * Every member is present, so a new `UsageStatus` cannot ship with no word.
 */
export const USAGE_STATUS_WORD: Record<UsageStatus, string> = {
  available: 'Available',
  disabled: 'Not enabled',
  unpriced: 'Unpriced',
  // "Ambiguous" alone reads like a property of the number; naming the many
  // matches says what the reader has to resolve (README §7.5).
  ambiguous_session: 'Multiple matches',
  // Not "No session": a session may exist and simply not match this task.
  no_matching_session: 'No matching session',
  remote_host: 'Remote host',
  unattributed: 'Unattributed'
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

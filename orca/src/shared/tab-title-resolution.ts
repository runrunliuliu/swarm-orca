import type { Tab } from './tab-types'
import type { TerminalTab } from './terminal-tab-types'
import { isMeaningfulOpenCodeTerminalTitle } from './opencode-terminal-title'
import { composeTerminalTitleWithActivity } from './terminal-activity-summary'

/**
 * Precedence is unchanged from the pre-activity version: an explicitly chosen label wins over a
 * generated one, and a generated one already describes the work. `activitySummary` therefore only
 * gets a say when the resolved label is the raw live title (or the fallback) and names no work.
 */
export function resolveTerminalTabTitle(
  tab: Pick<
    TerminalTab,
    'customTitle' | 'quickCommandLabel' | 'aiVaultTitle' | 'generatedTitle' | 'title'
  >,
  generatedTitlesEnabled: boolean,
  fallback = '',
  /** Live "what is it doing" line from the pane status rows. */
  activitySummary = ''
): string {
  const liveTitle = tab.title?.trim() ?? ''
  const chosenTitle = tab.customTitle?.trim() || tab.quickCommandLabel?.trim() || ''
  const vaultTitle = tab.aiVaultTitle?.title.trim() || ''
  const generatedTitle = generatedTitlesEnabled ? (tab.generatedTitle?.trim() ?? '') : ''
  const resolved =
    chosenTitle ||
    (isMeaningfulOpenCodeTerminalTitle(liveTitle) ? liveTitle : '') ||
    vaultTitle ||
    generatedTitle ||
    liveTitle ||
    fallback

  if (chosenTitle || vaultTitle || generatedTitle) {
    return resolved
  }
  return composeTerminalTitleWithActivity(resolved, activitySummary)
}

export function resolveUnifiedTabLabel(
  tab:
    | Pick<Tab, 'customLabel' | 'quickCommandLabel' | 'aiVaultTitle' | 'generatedLabel' | 'label'>
    | undefined,
  generatedTitlesEnabled: boolean,
  fallback = '',
  /** See resolveTerminalTabTitle. */
  activitySummary = ''
): string {
  const liveLabel = tab?.label?.trim() ?? ''
  const chosenLabel = tab?.customLabel?.trim() || tab?.quickCommandLabel?.trim() || ''
  const vaultTitle = tab?.aiVaultTitle?.title.trim() || ''
  const generatedLabel = generatedTitlesEnabled ? (tab?.generatedLabel?.trim() ?? '') : ''
  const resolved =
    chosenLabel ||
    (isMeaningfulOpenCodeTerminalTitle(liveLabel) ? liveLabel : '') ||
    vaultTitle ||
    generatedLabel ||
    liveLabel ||
    fallback

  if (chosenLabel || vaultTitle || generatedLabel) {
    return resolved
  }
  return composeTerminalTitleWithActivity(resolved, activitySummary)
}

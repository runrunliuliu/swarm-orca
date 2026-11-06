import type { Tab } from '../../../shared/tab-types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import {
  resolveTerminalTabTitle,
  resolveUnifiedTabLabel
} from '../../../shared/tab-title-resolution'

export type TerminalPaletteTitles = {
  title: string
  /** Live activity line; '' when no pane reported fresh work. */
  secondaryText: string
  /** Search-index form of `secondaryText`. */
  secondaryTexts: string[]
}

/**
 * Label projection for a terminal palette row. Tab-label precedence is unchanged (rename, quick
 * command, generated title, live title); the only addition is the per-tab activity line, which the
 * label resolver uses when the title names no work and which the row shows as its second line.
 */
export function resolveTerminalPaletteTitles({
  tab,
  terminalTab,
  generatedTitlesEnabled,
  activitySummaryByTabId
}: {
  tab: Tab
  terminalTab: TerminalTab | null | undefined
  generatedTitlesEnabled: boolean
  activitySummaryByTabId?: ReadonlyMap<string, string>
}): TerminalPaletteTitles {
  const secondaryText = activitySummaryByTabId?.get(tab.entityId)?.trim() ?? ''
  const terminalTitle = terminalTab
    ? resolveTerminalTabTitle(terminalTab, generatedTitlesEnabled, 'Terminal', secondaryText)
    : 'Terminal'
  const title = resolveUnifiedTabLabel(
    {
      ...tab,
      customLabel: tab.customLabel ?? terminalTab?.customTitle ?? null,
      quickCommandLabel: tab.quickCommandLabel ?? terminalTab?.quickCommandLabel,
      generatedLabel: tab.generatedLabel ?? terminalTab?.generatedTitle
    },
    generatedTitlesEnabled,
    terminalTitle,
    secondaryText
  )
  return { title, secondaryText, secondaryTexts: secondaryText ? [secondaryText] : [] }
}

import { translate } from '@/i18n/i18n'

/**
 * The "N ago" form one agent row prints, shared by the dashboard's kanban card
 * and the task workbench's flat agent row (README §7.4.2).
 *
 * Why a module of its own instead of a helper inside `AgentKanbanCard`: the
 * workbench deliberately does not render the board card any more (that card is
 * the body + footer, card-in-a-card shape the visual rework removed), and
 * importing the module just for this formatter would reintroduce the dependency
 * the import-boundary test now forbids. Two copies of the arithmetic would also
 * be two places to forget a new unit.
 */

/** Compact "started N ago" (both surfaces are glanceable — coarse units are fine). */
export function formatStartedAgo(startedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000))
  if (seconds < 60) {
    return translate('dashboardPopout.card.time.justNow', 'just now')
  }
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return translate('dashboardPopout.card.time.minutes', '{{count}}m', { count: minutes })
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return translate('dashboardPopout.card.time.hours', '{{count}}h', { count: hours })
  }
  return translate('dashboardPopout.card.time.days', '{{count}}d', {
    count: Math.floor(hours / 24)
  })
}

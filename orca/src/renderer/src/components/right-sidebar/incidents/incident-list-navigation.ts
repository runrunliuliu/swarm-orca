// Keyboard behaviour for the incident list (§12, M7-B).
//
// The rows are real `<button>`s, so Tab already reaches every row and Enter/Space already opens one.
// This adds the list conventions a reader expects (Arrow/Home/End/Enter/Escape) without inventing a
// second focus model: the component keeps one `focusIndex`, the roving tabindex makes the focused row
// the single tab stop, and every other row stays reachable with the arrow keys it now answers to.
//
// Pure for the same reason `file-explorer-keyboard-navigation.ts` is: "what does ArrowDown do on the
// last row" is a decision to pin in a test, not to re-derive in a JSX handler. Clamping (rather than
// wrapping) is deliberate: a wrap from last to first makes a long list feel like it lost your place.

export type IncidentListNavigationKey =
  | 'ArrowDown'
  | 'ArrowUp'
  | 'Home'
  | 'End'
  | 'Enter'
  | 'Escape'

export type IncidentListNavigationIntent =
  | { type: 'focus'; index: number }
  | { type: 'open' }
  | { type: 'close' }
  | { type: 'unhandled' }

export function resolveIncidentListNavigation(args: {
  key: string
  /** Index with roving focus, or null when the list has none yet. */
  currentIndex: number | null
  total: number
  /** Whether the detail drawer is open; Enter must not re-open it, Escape only closes it. */
  detailOpen: boolean
}): IncidentListNavigationIntent {
  const { key, currentIndex, total, detailOpen } = args
  if (total === 0) {
    return { type: 'unhandled' }
  }
  switch (key) {
    case 'Enter':
      // While the drawer owns the interaction, Enter belongs to whatever is focused inside it.
      return detailOpen || currentIndex === null ? { type: 'unhandled' } : { type: 'open' }
    case 'Escape':
      return detailOpen ? { type: 'close' } : { type: 'unhandled' }
    case 'ArrowDown': {
      const base = currentIndex ?? -1
      return { type: 'focus', index: Math.min(total - 1, base + 1) }
    }
    case 'ArrowUp': {
      if (currentIndex === null) {
        return { type: 'focus', index: total - 1 }
      }
      return { type: 'focus', index: Math.max(0, currentIndex - 1) }
    }
    case 'Home':
      return { type: 'focus', index: 0 }
    case 'End':
      return { type: 'focus', index: total - 1 }
    default:
      return { type: 'unhandled' }
  }
}

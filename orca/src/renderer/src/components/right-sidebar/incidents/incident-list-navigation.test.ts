// Keyboard navigation for the list (§12, M7-B): clamped, no wrap, and Enter only opens a row that has
// focus. Escape is not the list's key — it resolves to `unhandled` so the drawer keeps owning it.
import { describe, expect, it } from 'vitest'
import { resolveIncidentListNavigation } from './incident-list-navigation'

describe('resolveIncidentListNavigation', () => {
  it('moves down and clamps at the last row', () => {
    expect(resolveIncidentListNavigation({ key: 'ArrowDown', currentIndex: 0, total: 3 })).toEqual({
      type: 'focus',
      index: 1
    })
    expect(resolveIncidentListNavigation({ key: 'ArrowDown', currentIndex: 2, total: 3 })).toEqual({
      type: 'focus',
      index: 2
    })
  })

  it('enters the list from the top on ArrowUp when no row has focus', () => {
    expect(resolveIncidentListNavigation({ key: 'ArrowUp', currentIndex: null, total: 3 })).toEqual({
      type: 'focus',
      index: 2
    })
    expect(resolveIncidentListNavigation({ key: 'ArrowUp', currentIndex: 0, total: 3 })).toEqual({
      type: 'focus',
      index: 0
    })
  })

  it('supports Home and End', () => {
    expect(resolveIncidentListNavigation({ key: 'Home', currentIndex: 2, total: 5 })).toEqual({
      type: 'focus',
      index: 0
    })
    expect(resolveIncidentListNavigation({ key: 'End', currentIndex: null, total: 5 })).toEqual({
      type: 'focus',
      index: 4
    })
  })

  it('opens on Enter for the focused row', () => {
    expect(resolveIncidentListNavigation({ key: 'Enter', currentIndex: 1, total: 3 })).toEqual({
      type: 'open'
    })
  })

  it('leaves Escape to the drawer that owns it', () => {
    expect(resolveIncidentListNavigation({ key: 'Escape', currentIndex: 0, total: 3 })).toEqual({
      type: 'unhandled'
    })
  })

  it('ignores everything for an empty list', () => {
    expect(resolveIncidentListNavigation({ key: 'ArrowDown', currentIndex: null, total: 0 })).toEqual({
      type: 'unhandled'
    })
  })
})

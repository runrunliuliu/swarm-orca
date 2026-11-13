// Keyboard navigation for the list (§12, M7-B): clamped, no wrap, and Enter/Escape only act in the
// state they belong to.
import { describe, expect, it } from 'vitest'
import { resolveIncidentListNavigation } from './incident-list-navigation'

describe('resolveIncidentListNavigation', () => {
  it('moves down and clamps at the last row', () => {
    expect(resolveIncidentListNavigation({ key: 'ArrowDown', currentIndex: 0, total: 3, detailOpen: false })).toEqual({
      type: 'focus',
      index: 1
    })
    expect(resolveIncidentListNavigation({ key: 'ArrowDown', currentIndex: 2, total: 3, detailOpen: false })).toEqual({
      type: 'focus',
      index: 2
    })
  })

  it('enters the list from the top on ArrowUp when no row has focus', () => {
    expect(resolveIncidentListNavigation({ key: 'ArrowUp', currentIndex: null, total: 3, detailOpen: false })).toEqual({
      type: 'focus',
      index: 2
    })
    expect(resolveIncidentListNavigation({ key: 'ArrowUp', currentIndex: 0, total: 3, detailOpen: false })).toEqual({
      type: 'focus',
      index: 0
    })
  })

  it('supports Home and End', () => {
    expect(resolveIncidentListNavigation({ key: 'Home', currentIndex: 2, total: 5, detailOpen: false })).toEqual({
      type: 'focus',
      index: 0
    })
    expect(resolveIncidentListNavigation({ key: 'End', currentIndex: null, total: 5, detailOpen: false })).toEqual({
      type: 'focus',
      index: 4
    })
  })

  it('opens on Enter only while the drawer is closed', () => {
    expect(resolveIncidentListNavigation({ key: 'Enter', currentIndex: 1, total: 3, detailOpen: false })).toEqual({
      type: 'open'
    })
    // Inside the drawer, Enter belongs to the focused control there.
    expect(resolveIncidentListNavigation({ key: 'Enter', currentIndex: 1, total: 3, detailOpen: true })).toEqual({
      type: 'unhandled'
    })
  })

  it('closes on Escape only while the drawer is open', () => {
    expect(resolveIncidentListNavigation({ key: 'Escape', currentIndex: 0, total: 3, detailOpen: true })).toEqual({
      type: 'close'
    })
    expect(resolveIncidentListNavigation({ key: 'Escape', currentIndex: 0, total: 3, detailOpen: false })).toEqual({
      type: 'unhandled'
    })
  })

  it('ignores everything for an empty list', () => {
    expect(resolveIncidentListNavigation({ key: 'ArrowDown', currentIndex: null, total: 0, detailOpen: false })).toEqual({
      type: 'unhandled'
    })
  })
})

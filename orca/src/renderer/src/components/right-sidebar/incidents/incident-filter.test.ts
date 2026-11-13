// List filtering (§12, M7-B).
//
// The two cases that matter: the default view is `untriaged` only, and the two view filters can only
// see the page the panel holds — so a filtered-empty result is not the same claim as "nothing exists".
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_INCIDENT_FILTERS,
  INCIDENT_LIST_LOAD_LIMIT,
  applyIncidentViewFilters,
  incidentFiltersActive,
  incidentListRequest,
  incidentWorktreeOptions
} from './incident-filter'
import { FIXTURE_NOW, listItemFixture } from './incident-panel-fixtures'

describe('incidentListRequest', () => {
  it('sends no status filter for all, and limits the page', () => {
    expect(incidentListRequest({ ...DEFAULT_INCIDENT_FILTERS, status: 'all' })).toEqual({
      limit: INCIDENT_LIST_LOAD_LIMIT
    })
  })

  it('defaults to untriaged and sends class only when one is chosen', () => {
    expect(incidentListRequest(DEFAULT_INCIDENT_FILTERS)).toEqual({
      limit: INCIDENT_LIST_LOAD_LIMIT,
      status: 'untriaged'
    })
    expect(
      incidentListRequest({ ...DEFAULT_INCIDENT_FILTERS, class: 'tool_error', status: 'watch' })
    ).toEqual({ limit: INCIDENT_LIST_LOAD_LIMIT, status: 'watch', class: 'tool_error' })
  })
})

describe('applyIncidentViewFilters', () => {
  const items = [
    listItemFixture({ id: 'a', worktreeId: 'wt-1', createdAt: FIXTURE_NOW - 60_000 }),
    listItemFixture({ id: 'b', worktreeId: 'wt-2', createdAt: FIXTURE_NOW - 3 * 24 * 60 * 60_000 }),
    listItemFixture({ id: 'c', worktreeId: null, createdAt: FIXTURE_NOW - 30 * 60_000 })
  ]

  it('passes everything through when both view filters are off', () => {
    expect(applyIncidentViewFilters(items, { worktree: 'all', window: 'all' }, FIXTURE_NOW)).toHaveLength(3)
  })

  it('filters by worktree, and an unbound row is not a worktree', () => {
    expect(
      applyIncidentViewFilters(items, { worktree: 'wt-1', window: 'all' }, FIXTURE_NOW).map(
        (item) => item.id
      )
    ).toEqual(['a'])
  })

  it('filters by a 24h window using the injected now, not the wall clock', () => {
    expect(
      applyIncidentViewFilters(items, { worktree: 'all', window: '24h' }, FIXTURE_NOW).map(
        (item) => item.id
      )
    ).toEqual(['a', 'c'])
    expect(
      applyIncidentViewFilters(items, { worktree: 'all', window: '7d' }, FIXTURE_NOW).map(
        (item) => item.id
      )
    ).toEqual(['a', 'b', 'c'])
  })
})

describe('incidentWorktreeOptions', () => {
  it('counts the loaded page, biggest first, and drops rows with no worktree', () => {
    const options = incidentWorktreeOptions([
      listItemFixture({ worktreeId: 'wt-2' }),
      listItemFixture({ worktreeId: 'wt-2' }),
      listItemFixture({ worktreeId: 'wt-1' }),
      listItemFixture({ worktreeId: null })
    ])
    expect(options).toEqual([
      { worktreeId: 'wt-2', count: 2 },
      { worktreeId: 'wt-1', count: 1 }
    ])
  })
})

describe('incidentFiltersActive', () => {
  it('is false only for the default view', () => {
    expect(incidentFiltersActive(DEFAULT_INCIDENT_FILTERS)).toBe(false)
    expect(incidentFiltersActive({ ...DEFAULT_INCIDENT_FILTERS, status: 'all' })).toBe(true)
    expect(incidentFiltersActive({ ...DEFAULT_INCIDENT_FILTERS, window: '24h' })).toBe(true)
    expect(incidentFiltersActive({ ...DEFAULT_INCIDENT_FILTERS, worktree: 'wt-1' })).toBe(true)
  })
})

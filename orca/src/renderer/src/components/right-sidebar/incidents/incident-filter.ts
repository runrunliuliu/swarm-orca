// List filtering for the incident panel (§12, M7-B).
//
// Two of the four filters are the store's: `status` and `class` are part of `incident list`'s request,
// so the panel asks the host rather than fetching everything and hiding rows here (a client-side
// status filter over a truncated page would claim "0 confirmed" while confirmed rows exist beyond the
// page). Worktree and time window are *view* filters over the rows already loaded, and the panel says
// so: they cannot see past the page it holds.
//
// The pure functions live here so a test can pin the semantics without a store or a DOM, matching
// `incident-badge.ts` — and so "default shows untriaged" is stated once, not in three JSX branches.

import type {
  IncidentClassDto,
  IncidentListItemDto,
  IncidentListRequest,
  IncidentStatusDto
} from '../../../../../shared/incident-api-types'

/** `all` is a real filter value, not an absent one: "no status filter" is a choice the reader makes. */
export type IncidentStatusFilter = IncidentStatusDto | 'all'
export type IncidentClassFilter = IncidentClassDto | 'all'
export type IncidentWorktreeFilter = string | 'all'
export type IncidentTimeWindowFilter = '24h' | '7d' | 'all'

export type IncidentFilters = {
  status: IncidentStatusFilter
  class: IncidentClassFilter
  worktree: IncidentWorktreeFilter
  window: IncidentTimeWindowFilter
}

/**
 * The default view is `untriaged` only. That is the languishing-state rule from §2.7: triage is the
 * job, and a panel that opens on "everything" makes the one status that needs a decision the hardest
 * thing to find.
 */
export const DEFAULT_INCIDENT_FILTERS: IncidentFilters = {
  status: 'untriaged',
  class: 'all',
  worktree: 'all',
  window: 'all'
}

/**
 * How many rows the panel asks for. The store's own default is 50, which is smaller than a week of
 * incidents on a busy host; 200 keeps the list scrollable without turning the panel into a report.
 */
export const INCIDENT_LIST_LOAD_LIMIT = 200

const WINDOW_MS: Record<Exclude<IncidentTimeWindowFilter, 'all'>, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000
}

/** The store request for the two filters the host owns. `all` means "omit the field". */
export function incidentListRequest(filters: IncidentFilters): IncidentListRequest {
  return {
    limit: INCIDENT_LIST_LOAD_LIMIT,
    ...(filters.status === 'all' ? {} : { status: filters.status }),
    ...(filters.class === 'all' ? {} : { class: filters.class })
  }
}

/**
 * Apply the two view filters to the loaded page.
 *
 * `now` is a parameter, not `Date.now()` inside: a time window that silently uses the wall clock is
 * untestable, and an incident list is exactly where "is this stale" questions get asked.
 */
export function applyIncidentViewFilters(
  items: readonly IncidentListItemDto[],
  filters: Pick<IncidentFilters, 'worktree' | 'window'>,
  now: number
): IncidentListItemDto[] {
  const cutoff =
    filters.window === 'all' ? null : now - WINDOW_MS[filters.window]
  return items.filter((item) => {
    if (filters.worktree !== 'all' && item.worktreeId !== filters.worktree) {
      return false
    }
    if (cutoff !== null && item.createdAt < cutoff) {
      return false
    }
    return true
  })
}

export type IncidentWorktreeOption = { worktreeId: string; count: number }

/**
 * Worktree choices, from the loaded page only, biggest first.
 *
 * Rows without a worktree binding are not an option: "no worktree" is not a worktree, and offering it
 * as one would suggest the row belongs to a workspace.
 */
export function incidentWorktreeOptions(
  items: readonly IncidentListItemDto[]
): IncidentWorktreeOption[] {
  const counts = new Map<string, number>()
  for (const item of items) {
    if (item.worktreeId === null) {
      continue
    }
    counts.set(item.worktreeId, (counts.get(item.worktreeId) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([worktreeId, count]) => ({ worktreeId, count }))
    .sort((left, right) => right.count - left.count || left.worktreeId.localeCompare(right.worktreeId))
}

/**
 * Which empty-state sentence applies. A pure function because the distinction is the point: a
 * worktree/time filter runs over the loaded page only, so "nothing matches" from it is *not* a
 * statement about the store, and the panel must not render it as one (M7-B review B3).
 */
export type IncidentEmptyStateKind =
  /** Worktree/time filter active: say "loaded page only", never "no incidents". */
  | 'view_filtered'
  /** A local coverage hole already makes the list a lower bound. */
  | 'lower_bound'
  /** The default untriaged view, with rows elsewhere behind the status filter. */
  | 'untriaged'
  | 'filtered'

export function incidentEmptyStateKind(input: {
  filters: IncidentFilters
  localGap: boolean
}): IncidentEmptyStateKind {
  if (input.filters.worktree !== 'all' || input.filters.window !== 'all') {
    return 'view_filtered'
  }
  if (input.localGap) {
    return 'lower_bound'
  }
  return input.filters.status === 'untriaged' && input.filters.class === 'all'
    ? 'untriaged'
    : 'filtered'
}

/** True when anything other than the default view is in effect (for the "clear filters" affordance). */
export function incidentFiltersActive(filters: IncidentFilters): boolean {
  return (
    filters.status !== DEFAULT_INCIDENT_FILTERS.status ||
    filters.class !== DEFAULT_INCIDENT_FILTERS.class ||
    filters.worktree !== DEFAULT_INCIDENT_FILTERS.worktree ||
    filters.window !== DEFAULT_INCIDENT_FILTERS.window
  )
}

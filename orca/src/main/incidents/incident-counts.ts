// The count read model (issue-sedimentation.md §12, M7-A).
//
// One place answers "how many rows are still untriaged" for the activity-bar badge, and it answers
// with aggregates rather than by paginating `listIncidents` and counting client-side: a 50k-row store
// must not be read in full to draw a number.
//
// Three decisions worth keeping:
//   * untriaged is the *projected* status (`incident_state`), not the row's entry status — a row whose
//     entry status is `untriaged` but which was triaged to `watch` is not untriaged any more;
//   * `untriaged` is the sum of `byClass` by construction, so the total and the breakdown cannot drift;
//   * rows without a `worktree_id` are counted but not listed per worktree: there is no honest
//     worktree key to attribute them to, and inventing one ("unattached") would create a fake
//     worktree in every consumer.
//
// `coverage` is summarized here, not re-derived: the store already owns the latch, the replay state
// and the capacity numbers, and a second interpretation of `currently_limited` is exactly what this
// milestone must not introduce.

import type Database from '../sqlite/sync-database'
import { INCIDENT_CLASSES, type IncidentClass, type IncidentCoverage } from './incident-types'
import type { IncidentCountsDto } from '../../shared/incident-api-types'

export const DEFAULT_TOP_WORKTREES = 5
export const MAX_TOP_WORKTREES = 100

/** Clamp the caller's `topWorktrees` so a renderer cannot ask for the whole table. */
export function clampTopWorktrees(value: unknown): number {
  const requested = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : NaN
  if (!Number.isFinite(requested) || requested < 1) {
    return DEFAULT_TOP_WORKTREES
  }
  return Math.min(requested, MAX_TOP_WORKTREES)
}

/**
 * Read the counts.
 *
 * Takes `coverage` from the caller (i.e. from the same store instance) rather than reading the meta
 * table twice: a count and the coverage that qualifies it must come from one snapshot of the store.
 */
export function readIncidentCounts(options: {
  db: Database.Database
  coverage: IncidentCoverage
  topWorktrees?: number
  now?: () => number
}): IncidentCountsDto {
  const { db, coverage } = options
  const topWorktrees = clampTopWorktrees(options.topWorktrees ?? DEFAULT_TOP_WORKTREES)
  const now = options.now ?? (() => Date.now())

  // Every class key present, 0 default: a badge indexes this directly and must not need `?? 0`.
  const byClass = Object.fromEntries(INCIDENT_CLASSES.map((name) => [name, 0])) as Record<
    IncidentClass,
    number
  >
  const classRows = db
    .prepare(
      `SELECT i.class AS class, COUNT(*) AS n
         FROM incidents i JOIN incident_state s ON s.incident_id = i.id
        WHERE s.status = 'untriaged'
        GROUP BY i.class`
    )
    .all()
  let untriaged = 0
  for (const row of classRows) {
    const count = Number(row.n ?? 0)
    const name = String(row.class)
    // A class this build does not know is still a row: count it in the total, not in a made-up key.
    if ((INCIDENT_CLASSES as readonly string[]).includes(name)) {
      byClass[name as IncidentClass] += count
    }
    untriaged += count
  }

  const byWorktree = db
    .prepare(
      `SELECT i.worktree_id AS worktree_id, COUNT(*) AS n
         FROM incidents i JOIN incident_state s ON s.incident_id = i.id
        WHERE s.status = 'untriaged' AND i.worktree_id IS NOT NULL
        GROUP BY i.worktree_id
        -- Deterministic on both keys: equal counts must not reshuffle between two reads.
        ORDER BY n DESC, i.worktree_id ASC
        LIMIT ?`
    )
    .all(topWorktrees)
    .map((row) => ({ worktreeId: String(row.worktree_id), untriaged: Number(row.n ?? 0) }))

  const totalRow = db.prepare('SELECT COUNT(*) AS n FROM incidents').get()

  const gap = coverage.currentlyLimited || coverage.shadowReplay.incomplete
  return {
    untriaged,
    total: totalRow ? Number(totalRow.n ?? 0) : 0,
    byClass,
    byWorktree,
    coverage: {
      currentlyLimited: coverage.currentlyLimited,
      capacityLatchSet: coverage.capacityLatchSet,
      shadowReplayIncomplete: coverage.shadowReplay.incomplete,
      shadowReplayDropped: coverage.shadowReplay.dropped,
      remoteIncidentCapture: coverage.remoteIncidentCapture,
      gap
    },
    readAt: now()
  }
}

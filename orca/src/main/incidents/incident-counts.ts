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
  // A1/B-F3: one scan.
  //
  // The old shape read `incidents` three times — twice through the `incident_state` view, whose
  // `status` is a correlated `COALESCE(... ORDER BY created_at DESC LIMIT 1)` subquery evaluated per
  // row, and once more for `total` — and the worktree query added two temp B-trees for its
  // `ORDER BY`/`LIMIT`. One grouped query returns everything this read model needs: the per-row
  // subquery is evaluated once instead of three times, `total` is the sum of the groups (the view has
  // exactly one row per incident, so the join cannot drop one), and `untriaged`/`byClass`/top-N are
  // derived from the same rows, so they cannot disagree with each other.
  const grouped = db
    .prepare(
      `SELECT i.class AS class, i.worktree_id AS worktree_id, COUNT(*) AS n,
              SUM(CASE WHEN s.status = 'untriaged' THEN 1 ELSE 0 END) AS untriaged
         FROM incidents i JOIN incident_state s ON s.incident_id = i.id
        GROUP BY i.class, i.worktree_id`
    )
    .all()
  let untriaged = 0
  let total = 0
  // Grouped by `(class, worktree_id)`, so one worktree appears once per class: sum it back into one
  // entry per worktree before the top-N cut, which is what the per-worktree SQL read returned.
  const worktrees = new Map<string, number>()
  for (const row of grouped) {
    const count = Number(row.n ?? 0)
    const open = Number(row.untriaged ?? 0)
    total += count
    untriaged += open
    const name = String(row.class)
    // A class this build does not know is still a row: count it in the total, not in a made-up key.
    if ((INCIDENT_CLASSES as readonly string[]).includes(name)) {
      byClass[name as IncidentClass] += open
    }
    // Rows without a worktree binding are counted but not attributed; a group with nothing untriaged
    // is absent, exactly as the `WHERE status = 'untriaged'` query left it out.
    if (row.worktree_id !== null && row.worktree_id !== undefined && open > 0) {
      const worktreeId = String(row.worktree_id)
      worktrees.set(worktreeId, (worktrees.get(worktreeId) ?? 0) + open)
    }
  }
  const byWorktree = [...worktrees.entries()]
    .map(([worktreeId, open]) => ({ worktreeId, untriaged: open }))
    // Deterministic on both keys, and `worktreeId` compares as bytes (SQLite's default BINARY
    // collation on TEXT), so this order is the one the SQL `ORDER BY n DESC, worktree_id ASC` gave.
    .sort((a, b) => {
      const byCount = b.untriaged - a.untriaged
      if (byCount !== 0) {
        return byCount
      }
      return a.worktreeId < b.worktreeId ? -1 : a.worktreeId > b.worktreeId ? 1 : 0
    })
    .slice(0, topWorktrees)

  // A *local* gap makes `untriaged` a floor. The capacity latch belongs here even though it is past
  // tense: a store that once refused a write may already be missing rows, so the count is a lower
  // bound the same way an unfinished replay does. Keeping it out of this boolean (while the badge
  // OR'd it in itself) was a split brain — one question, two answers. §11.5 still keeps the two
  // capacity fields separate for *wording*; this flag is only "is the number complete?".
  const gap =
    coverage.currentlyLimited || coverage.shadowReplay.incomplete || coverage.capacityLatchSet
  return {
    untriaged,
    total,
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

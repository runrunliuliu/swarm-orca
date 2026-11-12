// Prune: the only deletion path (§11.5).
//
// Three rules, each of which a cheaper implementation would get wrong:
//   * only closed / invalid / duplicate rows — an untriaged crash is evidence, not clutter, however
//     old it is;
//   * only past the retention window;
//   * a dry run by default, and `--apply` is the caller's explicit word for it.
//
// The immutability trigger admits a DELETE only while `incident_store_meta.prune_deleting` is set.
// The marker and the delete share one transaction, so an interrupted prune rolls the marker back and
// cannot leave the store deletable.

import type Database from '../sqlite/sync-database'
import { PRUNABLE_STATUSES, type IncidentStatus } from './incident-types'
import {
  DEFAULT_INCIDENT_RETENTION_DAYS,
  type PruneOptions,
  type PruneResult
} from './incident-store-contract'
import { writeMeta } from './incident-store-capacity'
import { VERIFIED_PRUNE_FLAG } from './incident-store-prune-flag'

const DAY_MS = 24 * 60 * 60 * 1000

export function pruneIncidents(options: {
  db: Database.Database
  readOnly: boolean
  now: () => number
  runImmediate: <T>(run: () => T) => T
  requested?: PruneOptions
}): PruneResult {
  const { db, readOnly, now, runImmediate } = options
  const requested = options.requested ?? {}
  const dryRun = requested.dryRun ?? true
  const olderThanDays = requested.olderThanDays ?? DEFAULT_INCIDENT_RETENTION_DAYS
  const cutoff = (requested.now ?? now()) - olderThanDays * DAY_MS
  const placeholders = PRUNABLE_STATUSES.map(() => '?').join(', ')

  const candidateRows = db
    .prepare(
      `SELECT s.status AS status, COUNT(*) AS count FROM incidents i
       JOIN incident_state s ON s.incident_id = i.id
       WHERE s.status IN (${placeholders}) AND i.created_at < ? GROUP BY s.status`
    )
    .all(...PRUNABLE_STATUSES, cutoff)
  const byStatus: Partial<Record<IncidentStatus, number>> = {}
  let candidates = 0
  for (const row of candidateRows) {
    const count = Number(row.count ?? 0)
    byStatus[String(row.status) as IncidentStatus] = count
    candidates += count
  }
  if (dryRun || readOnly || candidates === 0) {
    return { dryRun, olderThanDays, cutoff, candidates, deleted: 0, byStatus }
  }
  return runImmediate(() => {
    writeMeta(db, VERIFIED_PRUNE_FLAG, '1')
    let deleted = 0
    try {
      const result = db
        .prepare(
          `DELETE FROM incidents WHERE id IN (
             SELECT i.id FROM incidents i JOIN incident_state s ON s.incident_id = i.id
             WHERE s.status IN (${placeholders}) AND i.created_at < ?)`
        )
        .run(...PRUNABLE_STATUSES, cutoff)
      deleted = Number(result.changes)
    } finally {
      writeMeta(db, VERIFIED_PRUNE_FLAG, '0')
    }
    return { dryRun, olderThanDays, cutoff, candidates, deleted, byStatus }
  })
}

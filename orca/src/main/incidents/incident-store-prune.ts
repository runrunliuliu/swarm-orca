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
//
// The reported ids matter beyond reporting: `incident_decisions` rows deliberately outlive the
// incident they explain, so once prune removes the row the id in this output is the only handle back
// to "why was this closed".

import type Database from '../sqlite/sync-database'
import { PRUNABLE_STATUSES, type IncidentStatus } from './incident-types'
import {
  DEFAULT_INCIDENT_RETENTION_DAYS,
  PRUNE_ID_REPORT_LIMIT,
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
  const idLimit = Math.max(1, Math.min(requested.idReportLimit ?? PRUNE_ID_REPORT_LIMIT, 5000))
  const placeholders = PRUNABLE_STATUSES.map(() => '?').join(', ')

  const eligible = `FROM incidents i JOIN incident_state s ON s.incident_id = i.id
     WHERE s.status IN (${placeholders}) AND i.created_at < ?`

  const candidateRows = db
    .prepare(`SELECT s.status AS status, COUNT(*) AS count ${eligible} GROUP BY s.status`)
    .all(...PRUNABLE_STATUSES, cutoff)
  const byStatus: Partial<Record<IncidentStatus, number>> = {}
  let candidates = 0
  for (const row of candidateRows) {
    const count = Number(row.count ?? 0)
    byStatus[String(row.status) as IncidentStatus] = count
    candidates += count
  }

  /**
   * One row more than the cap: the extra row is how truncation is detected without a second count.
   */
  function readCandidateIds(): { ids: string[]; truncated: boolean } {
    const rows = db
      .prepare(`SELECT i.id AS id ${eligible} ORDER BY i.created_at ASC, i.id ASC LIMIT ?`)
      .all(...PRUNABLE_STATUSES, cutoff, idLimit + 1)
    const ids = rows.map((row) => String(row.id))
    return { ids: ids.slice(0, idLimit), truncated: ids.length > idLimit }
  }

  if (dryRun || readOnly || candidates === 0) {
    const read = readCandidateIds()
    return {
      dryRun,
      olderThanDays,
      cutoff,
      candidates,
      deleted: 0,
      byStatus,
      candidateIds: read.ids,
      candidateIdsTruncated: read.truncated,
      deletedIds: [],
      deletedIdsTruncated: false
    }
  }
  return runImmediate(() => {
    // Same transaction as the delete, so the ids reported are exactly the rows this run removed.
    const read = readCandidateIds()
    writeMeta(db, VERIFIED_PRUNE_FLAG, '1')
    let deleted = 0
    try {
      const result = db
        .prepare(
          `DELETE FROM incidents WHERE id IN (SELECT i.id ${eligible})`
        )
        .run(...PRUNABLE_STATUSES, cutoff)
      deleted = Number(result.changes)
    } finally {
      writeMeta(db, VERIFIED_PRUNE_FLAG, '0')
    }
    return {
      dryRun,
      olderThanDays,
      cutoff,
      candidates,
      deleted,
      byStatus,
      candidateIds: read.ids,
      candidateIdsTruncated: read.truncated,
      deletedIds: read.ids,
      deletedIdsTruncated: read.truncated
    }
  })
}

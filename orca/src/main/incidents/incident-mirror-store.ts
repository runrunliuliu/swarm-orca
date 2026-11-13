// Storage for the remote mirror: link state, provenance, and the mirrored-insert path
// (issue-sedimentation.md §11.1, M7-C).
//
// Two rules shape this file:
//   1. the mirrored fact is written THROUGH the store (`store.insertIncident`), so sanitizing, the
//      capacity gate and — crucially — the existing `UNIQUE(source_kind, source_id, facet)` key are
//      exactly the same ones a local writer meets. The mirror does not get a private dedupe path;
//      provenance only classifies what the store already decided;
//   2. a failed probe never zeroes the retained unsynced count. The last number the origin stated
//      stays, with the timestamp it was stated at, so an unreachable mirror reads as "N unsynced as
//      of T", never as "caught up" (§11.5: missing evidence is not zero).
//
// Every table read here tolerates a store written before M7-C (the tables then simply do not exist):
// `incident list --json` on such a file must keep working, and `unsupported` is the truthful answer.

import type Database from '../sqlite/sync-database'
import { runIncidentsTransaction } from './incidents-database'
import type { IncidentRecord } from './incident-types'
import type { IncidentStore } from './incident-store'
import type {
  MirrorCoverage,
  MirrorHostCoverage,
  MirrorInsertResult,
  MirrorProvenance
} from './incident-mirror-types'

export const MIRROR_LINKS_TABLE = 'incident_mirror_links'
export const MIRROR_ROWS_TABLE = 'incident_mirror_rows'

const MAX_ERROR_CHARS = 300

type Row = Record<string, unknown>

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null
  }
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** True when this file has the M7-C tables. A pre-M7-C store (or a v0 file) does not. */
export function mirrorTablesPresent(db: Database.Database): boolean {
  try {
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN (?, ?)")
      .get(MIRROR_LINKS_TABLE, MIRROR_ROWS_TABLE)
    return Number((row as { n?: unknown } | undefined)?.n ?? 0) === 2
  } catch {
    return false
  }
}

/**
 * The answer when there is no mirror table: no origin host is registered here.
 *
 * `unsupported` is a scope statement about this client, not a claim about a remote host's health.
 */
export function emptyMirrorCoverage(): MirrorCoverage {
  return {
    capture: 'unsupported',
    hosts: [],
    unsynced: null,
    unsyncedAsOf: null,
    unreachable: 0,
    rejected: 0,
    pruned: 0,
    lastError: null,
    mirroredRowsPresent: 0,
    skippedRows: 0,
    provenanceConflicts: 0
  }
}

function toHostCoverage(row: Row, rowsPresent: number): MirrorHostCoverage {
  const lastSuccessAt = numberOrNull(row.last_success_at)
  const runLines = numberOrNull(row.last_run_lines)
  const runMs = numberOrNull(row.last_run_ms)
  return {
    hostId: String(row.host_id),
    // Derived: only a completed pull makes a mirrored answer different from an untried one.
    state: lastSuccessAt === null ? 'not_probed' : 'mirrored',
    lastCursor: numberOrNull(row.last_cursor) ?? 0,
    firstProbeAt: numberOrNull(row.first_probe_at),
    lastProbeAt: numberOrNull(row.last_probe_at),
    lastSuccessAt,
    lastError: textOrNull(row.last_error),
    failureCount: numberOrNull(row.failure_count) ?? 0,
    unsynced: numberOrNull(row.pending_count),
    unsyncedAsOf: numberOrNull(row.pending_at),
    mirroredRows: numberOrNull(row.mirrored_count) ?? 0,
    duplicateRows: numberOrNull(row.duplicate_count) ?? 0,
    rejectedRows: numberOrNull(row.rejected_count) ?? 0,
    prunedRows: numberOrNull(row.pruned_count) ?? 0,
    droppedRows: numberOrNull(row.dropped_count) ?? 0,
    lastRejectedReason: textOrNull(row.last_rejected_reason),
    rowsPresent,
    skippedRows: numberOrNull(row.skipped_count) ?? 0,
    skippedRanges: numberOrNull(row.skipped_ranges) ?? 0,
    lastSkippedReason: textOrNull(row.last_skipped_reason),
    lastRun: runLines === null && runMs === null ? null : { lines: runLines ?? 0, ms: runMs ?? 0 }
  }
}

/** The read model: three-state answer plus per-host detail, derived from the link and provenance rows. */
export function readIncidentMirrorCoverage(db: Database.Database): MirrorCoverage {
  if (!mirrorTablesPresent(db)) {
    return emptyMirrorCoverage()
  }
  let rows: Row[]
  let present: Row[]
  let conflicts = 0
  try {
    conflicts = Number(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM (
               SELECT 1 FROM ${MIRROR_ROWS_TABLE}
                GROUP BY source_kind, source_id, facet HAVING COUNT(*) > 1
             )`
          )
          .get() as { n?: unknown } | undefined
      )?.n ?? 0
    )
    rows = db.prepare(`SELECT * FROM ${MIRROR_LINKS_TABLE} ORDER BY host_id ASC`).all() as Row[]
    // Joined to `incidents` on purpose: provenance outlives a pruned row (it is the tombstone), so a
    // bare GROUP BY would keep counting facts the store no longer holds. "Rows present" must mean
    // rows present.
    present = db
      .prepare(
        `SELECT p.host_id AS host_id, COUNT(*) AS n
           FROM ${MIRROR_ROWS_TABLE} p JOIN incidents i ON i.id = p.incident_id
          GROUP BY p.host_id`
      )
      .all() as Row[]
  } catch {
    // A corrupt link table must not turn a diagnostics command into an error; it is a gap.
    return { ...emptyMirrorCoverage(), capture: 'not_probed', lastError: 'mirror_tables_unreadable' }
  }
  if (rows.length === 0) {
    // Tables exist (a migrated store that never mirrored anything) but no origin is registered.
    return emptyMirrorCoverage()
  }
  const presentByHost = new Map<string, number>(
    present.map((row) => [String(row.host_id), Number(row.n ?? 0)])
  )
  const hosts = rows.map((row) => toHostCoverage(row, presentByHost.get(String(row.host_id)) ?? 0))
  const capture =
    hosts.some((host) => host.state === 'mirrored') ? ('mirrored' as const) : ('not_probed' as const)
  // One unknown count makes the sum unknown: a partial sum printed as a total is the same mistake as
  // printing an absent number as 0.
  const unsynced = hosts.some((host) => host.unsynced === null)
    ? null
    : hosts.reduce((total, host) => total + (host.unsynced ?? 0), 0)
  // Only a probe that actually ran and failed counts; a link row created and then interrupted has no
  // probe time and must not be described as unreachable.
  const unreachable = hosts.filter(
    (host) => host.lastProbeAt !== null && host.lastError !== null
  ).length
  const newestError = hosts
    .filter((host) => host.lastError !== null)
    .sort((left, right) => (right.lastProbeAt ?? 0) - (left.lastProbeAt ?? 0))[0]
  const newestPending = hosts
    .filter((host) => host.unsyncedAsOf !== null)
    .sort((left, right) => (right.unsyncedAsOf ?? 0) - (left.unsyncedAsOf ?? 0))[0]
  return {
    capture,
    hosts,
    unsynced,
    unsyncedAsOf: newestPending?.unsyncedAsOf ?? null,
    unreachable,
    rejected: hosts.reduce((total, host) => total + host.rejectedRows, 0),
    pruned: hosts.reduce((total, host) => total + host.prunedRows, 0),
    lastError: newestError?.lastError ?? null,
    mirroredRowsPresent: hosts.reduce((total, host) => total + host.rowsPresent, 0),
    skippedRows: hosts.reduce((total, host) => total + host.skippedRows, 0),
    provenanceConflicts: conflicts
  }
}

/**
 * Where the next request starts for this origin host.
 *
 * A missing row reads as 0 (read from the beginning) — safe because the store's UNIQUE key absorbs a
 * re-offered page, so a lost cursor costs time, never records (same reasoning as §11.2's watermark).
 */
export function readMirrorCursor(db: Database.Database, hostId: string): number {
  if (!mirrorTablesPresent(db)) {
    return 0
  }
  const row = db
    .prepare(`SELECT last_cursor FROM ${MIRROR_LINKS_TABLE} WHERE host_id = ?`)
    .get(hostId)
  return row ? (numberOrNull(row.last_cursor) ?? 0) : 0
}

/**
 * Register (or re-register) an origin at the start of a probe.
 *
 * `DO NOTHING` on conflict: the first probe must not reset a cursor a previous attempt advanced, and
 * re-registering on every reconnect is the normal case.
 */
export function ensureMirrorLink(db: Database.Database, hostId: string, now: number): void {
  db.prepare(
    `INSERT INTO ${MIRROR_LINKS_TABLE} (host_id, first_probe_at, last_probe_at, last_probe_ok)
     VALUES (?, ?, ?, 0)
     ON CONFLICT(host_id) DO NOTHING`
  ).run(hostId, now, now)
}

export type MirrorProbeOutcome = {
  hostId: string
  now: number
  cursor: number
  /** Origin-stated rows still past `cursor`; NULL = the origin did not say (retain the last value). */
  pending: number | null
  inserted: number
  duplicates: number
  rejected: number
  dropped: number
  pruned: number
  /** Origin-declared rows it chose not to export (C3); unknown counts are not invented. */
  skippedRows: number
  skippedRanges: number
  lastSkippedReason: string | null
  lastRejectedReason: string | null
  lines: number
  ms: number
}

/** A probe that reached the origin: cursor advances, the retained unsynced count is refreshed. */
export function recordMirrorProbeSuccess(db: Database.Database, outcome: MirrorProbeOutcome): void {
  db.prepare(
    `UPDATE ${MIRROR_LINKS_TABLE} SET
       last_cursor = MAX(last_cursor, ?),
       last_probe_at = ?,
       last_probe_ok = 1,
       last_success_at = ?,
       last_error = NULL,
       mirrored_count = mirrored_count + ?,
       duplicate_count = duplicate_count + ?,
       rejected_count = rejected_count + ?,
       dropped_count = dropped_count + ?,
       pruned_count = pruned_count + ?,
       skipped_count = skipped_count + ?,
       skipped_ranges = skipped_ranges + ?,
       last_skipped_reason = COALESCE(?, last_skipped_reason),
       last_rejected_reason = COALESCE(?, last_rejected_reason),
       pending_count = COALESCE(?, pending_count),
       pending_at = CASE WHEN ? IS NULL THEN pending_at ELSE ? END,
       last_run_lines = ?,
       last_run_ms = ?
     WHERE host_id = ?`
  ).run(
    outcome.cursor,
    outcome.now,
    outcome.now,
    outcome.inserted,
    outcome.duplicates,
    outcome.rejected,
    outcome.dropped,
    outcome.pruned,
    outcome.skippedRows,
    outcome.skippedRanges,
    outcome.lastSkippedReason,
    outcome.lastRejectedReason,
    outcome.pending,
    outcome.pending,
    outcome.now,
    outcome.lines,
    outcome.ms,
    outcome.hostId
  )
}

/**
 * A probe that did not finish: the link is down, or a line/page was refused.
 *
 * What this never does is overwrite `pending_count`: the unsynced number is the last thing the origin
 * told us, and zeroing it on failure is how "we are behind" turns into "we are caught up".
 *
 * What it does persist is the cursor the run actually reached. A stop in the middle of a page can
 * follow rows that were applied (the shadow replay persists its watermark the same way, §11.2), and
 * refusing to record them would re-pull them every time on a permanently bad tail. The cursor is the
 * last *applied* seq, never a skipped one.
 */
export function recordMirrorProbeFailure(
  db: Database.Database,
  input: {
    hostId: string
    now: number
    error: string
    lines: number
    ms: number
    /** Highest origin seq this run applied; omitted when nothing was applied. */
    cursor?: number
  }
): void {
  db.prepare(
    `UPDATE ${MIRROR_LINKS_TABLE} SET
       last_cursor = MAX(last_cursor, ?),
       last_probe_at = ?,
       last_probe_ok = 0,
       last_error = ?,
       failure_count = failure_count + 1,
       last_run_lines = ?,
       last_run_ms = ?
     WHERE host_id = ?`
  ).run(
    input.cursor ?? 0,
    input.now,
    input.error.slice(0, MAX_ERROR_CHARS),
    input.lines,
    input.ms,
    input.hostId
  )
}

/** Provenance of one incident, by the incident's own id. */
export function readMirrorProvenance(
  db: Database.Database,
  incidentId: string
): MirrorProvenance | null {
  if (!mirrorTablesPresent(db)) {
    return null
  }
  const row = db
    .prepare(
      `SELECT incident_id, host_id, origin_seq, pulled_at FROM ${MIRROR_ROWS_TABLE}
        WHERE incident_id = ?`
    )
    .get(incidentId)
  if (!row) {
    return null
  }
  return {
    incidentId: String(row.incident_id),
    hostId: String(row.host_id),
    originSeq: Number(row.origin_seq ?? 0),
    pulledAt: Number(row.pulled_at ?? 0)
  }
}

/**
 * Insert a fact authored on another host.
 *
 * Order matters, and each step is a rule:
 *   1. `host_mismatch` — a feed may only speak for its own host. Refused before anything is written,
 *      because filing one host's fact under another is worse than a missing row;
 *   2. `provenance_conflict` — the fact key has more than one provenance row. The key is UNIQUE in
 *      schema v6, so this means the file predates that constraint or was edited outside this code;
 *      the answer is to stop, not to pick a row and continue on a guess (M7-C review C2);
 *   3. a provenance row for the fact key means this link saw it before: if the incident row is still
 *      here it is a `duplicate` (idempotent re-pull), and if it is gone an operator pruned it, so the
 *      mirror refuses to resurrect it (`pruned_locally`);
 *   4. otherwise the store's own insert decides, and the incident row and its provenance row are
 *      written in ONE transaction: a provenance failure rolls the incident row back. That is what
 *      makes "mirrored row without provenance" a state this code cannot produce (review C1). The
 *      store's capacity latch is the one thing that cannot run inside an outer transaction (it opens
 *      its own IMMEDIATE), so that path is detected and re-run outside; the refusal stays the store's.
 */
export function insertMirroredIncident(input: {
  store: IncidentStore
  db: Database.Database
  record: IncidentRecord
  originHostId: string
  originSeq: number
  pulledAt: number
}): MirrorInsertResult {
  const { store, db, record, originHostId, originSeq, pulledAt } = input
  if (record.hostId !== originHostId) {
    return { outcome: 'host_mismatch', id: null, reason: 'record_host_is_not_feed_host' }
  }
  // One lookup per line, not per step: the sync can call this thousands of times per pass and the
  // table set is fixed for the connection's lifetime.
  const tables = mirrorTablesPresent(db)
  if (tables) {
    const priors = db
      .prepare(
        `SELECT incident_id, host_id, origin_seq FROM ${MIRROR_ROWS_TABLE}
          WHERE source_kind = ? AND source_id = ? AND facet = ?`
      )
      .all(record.sourceKind, record.sourceId, record.facet) as Row[]
    if (priors.length > 1) {
      return {
        outcome: 'provenance_conflict',
        id: null,
        reason: `${priors.length}_provenance_rows_for_fact_key`
      }
    }
    const prior = priors[0]
    if (prior) {
      const incidentId = String(prior.incident_id)
      const stillHere = db.prepare('SELECT 1 AS n FROM incidents WHERE id = ?').get(incidentId)
      if (stillHere) {
        return {
          outcome: 'duplicate',
          id: incidentId,
          mirroredByHostId: String(prior.host_id),
          existingOriginSeq: numberOrNull(prior.origin_seq)
        }
      }
      return {
        outcome: 'pruned_locally',
        id: incidentId,
        mirroredByHostId: String(prior.host_id),
        existingOriginSeq: numberOrNull(prior.origin_seq)
      }
    }
  }

  /** A provenance write that failed inside the transaction, tagged so the caller can name it. */
  class ProvenanceWriteFailure extends Error {
    constructor(readonly detail: string) {
      super(detail)
    }
  }

  /** The provenance insert itself. `ON CONFLICT DO NOTHING` covers the id and the fact-key UNIQUE. */
  function writeProvenance(incidentId: string): void {
    db.prepare(
      `INSERT INTO ${MIRROR_ROWS_TABLE}
         (incident_id, source_kind, source_id, facet, host_id, origin_seq, pulled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`
    ).run(
      incidentId,
      record.sourceKind,
      record.sourceId,
      record.facet,
      originHostId,
      originSeq,
      pulledAt
    )
  }

  type StoreInsert = ReturnType<IncidentStore['insertIncident']>

  /**
   * The fallback for the one path that cannot join our transaction: `insertIncident` refuses a
   * non-crash row under capacity by writing the latch in its own IMMEDIATE transaction, which SQLite
   * rejects while ours is open. Re-running it outside gives the store the last word — the latch is
   * persisted and the outcome is `capacity_limited`, exactly as a local writer sees.
   */
  function insertOutsideTransaction(): MirrorInsertResult {
    const outside = store.insertIncident(record)
    if (outside.outcome === 'inserted' && tables) {
      try {
        writeProvenance(record.id)
      } catch (error) {
        return {
          outcome: 'provenance_failed',
          id: record.id,
          reason: `provenance_write_failed:${error instanceof Error ? error.name : 'unknown'}`
        }
      }
    }
    if (outside.outcome === 'duplicate') {
      return classifyExistingOwnership(outside.id)
    }
    return {
      outcome: outside.outcome,
      id: outside.id,
      ...(outside.limitedBy === undefined ? {} : { limitedBy: outside.limitedBy }),
      ...(outside.reason === undefined ? {} : { reason: outside.reason })
    }
  }

  /**
   * A row already owns the fact key and no provenance exists for it: decide by the row's own
   * `host_id` whether this is a locally observed fact (refuse and count) or a mirrored row from a
   * build that did not write the two statements atomically (report duplicate; the caller has already
   * healed the provenance where it could).
   */
  function classifyExistingOwnership(incidentId: string | null): MirrorInsertResult {
    const existing = db
      .prepare(
        `SELECT id, host_id FROM incidents WHERE source_kind = ? AND source_id = ? AND facet = ?`
      )
      .get(record.sourceKind, record.sourceId, record.facet)
    const existingHostId = existing ? String(existing.host_id) : null
    if (tables && existing !== undefined && existingHostId === originHostId) {
      return {
        outcome: 'duplicate',
        id: String(existing.id),
        mirroredByHostId: existingHostId,
        existingOriginSeq: null
      }
    }
    return { outcome: 'local_owner_conflict', id: incidentId, reason: 'key_owned_by_local_row' }
  }

  let result: StoreInsert
  try {
    result = runIncidentsTransaction(db, () => {
      const inserted = store.insertIncident(record)
      if (inserted.outcome === 'inserted') {
        if (!tables) {
          // A writable open always migrates the mirror tables in. Reaching here means the write path
          // and the schema disagree; roll the incident row back rather than keep it unprovenanced.
          throw new ProvenanceWriteFailure('mirror_tables_missing')
        }
        try {
          writeProvenance(record.id)
        } catch (error) {
          throw new ProvenanceWriteFailure(
            `provenance_write_failed:${error instanceof Error ? error.name : 'unknown'}`
          )
        }
      }
      if (inserted.outcome === 'duplicate' && tables) {
        // A row holds the key but there is no provenance for it. Two situations look identical from
        // the key alone, and the row itself is the only witness:
        //   * `host_id` is this feed's origin — a row written by a build that did not write the two
        //     statements atomically (this branch is unreachable for rows this build writes). Heal the
        //     provenance so the tombstone and the dedupe classification work from now on;
        //   * `host_id` is anything else — a locally observed row owns the key. One fact, one row.
        const existing = db
          .prepare(
            `SELECT id, host_id FROM incidents WHERE source_kind = ? AND source_id = ? AND facet = ?`
          )
          .get(record.sourceKind, record.sourceId, record.facet)
        if (existing !== undefined && String(existing.host_id) === originHostId) {
          try {
            writeProvenance(String(existing.id))
          } catch (error) {
            throw new ProvenanceWriteFailure(
              `provenance_heal_failed:${error instanceof Error ? error.name : 'unknown'}`
            )
          }
        }
      }
      return inserted
    })
  } catch (error) {
    if (error instanceof ProvenanceWriteFailure) {
      // The transaction rolled back: no incident row, no provenance row. Nothing landed to prune, and
      // the line stays retryable (the sync stops without advancing the cursor).
      return { outcome: 'provenance_failed', id: null, reason: error.detail }
    }
    if (error instanceof Error && /within a transaction/i.test(error.message)) {
      return insertOutsideTransaction()
    }
    throw error
  }

  if (result.outcome === 'duplicate') {
    // The healed row records this pull's seq: the original one is no longer observable, and inventing
    // it would be worse than naming the delivery that repaired the provenance.
    return classifyExistingOwnership(result.id)
  }
  return {
    outcome: result.outcome,
    id: result.id,
    ...(result.limitedBy === undefined ? {} : { limitedBy: result.limitedBy }),
    ...(result.reason === undefined ? {} : { reason: result.reason })
  }
}

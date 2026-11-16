// Tool-call failures as FACTS (M8-3).
//
// The old collector normalized an error into a code (`permission_denied`, `non_zero_exit`, ...), kept
// a 5-in-10-minutes window per session/turn/tool, and wrote an incident once a threshold was crossed.
// All of that was judgement and left the main process in M8-3. What remains is the fact the journal
// already carries: this tool call failed, at this time, with this provider-stamped `errorKind` and/or
// exit code. No text is stored, no code is invented, no window is counted.
//
// The table is bounded both ways, because a long-lived host produces these continuously:
//   * rows older than TOOL_FAILURE_RETENTION_MS are pruned at most once a minute;
//   * a hard row cap refuses new rows and increments a visible `dropped` counter instead of silently
//     discarding the oldest evidence. Both numbers are read by the CLI and the panel, and `dropped`
//     means what it says: only a fact that is not already recorded is refused by capacity.
//
// The cap is decided by one authoritative row count per recorded failure: a single `SELECT COUNT(*)`
// over `incident_tool_failures` (see its comment). Nothing durable recites the table's size, so the cap
// cannot read a number the table does not have. At the cap there is no `INSERT OR IGNORE` left to ask
// whether this exact fact is already recorded, so one primary-key probe answers that question instead —
// without it, repeating a recorded fact would be reported as evidence lost to capacity.

import type Database from '../sqlite/sync-database'
import { bumpMetaNumber, readMeta, writeMeta } from './incident-store-meta'

export const TOOL_FAILURE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
export const MAX_TOOL_FAILURE_ROWS = 20_000
export const TOOL_FAILURE_DROPPED_META = 'tool_failure_dropped'
export const TOOL_FAILURE_LAST_PRUNE_META = 'tool_failure_last_prune'
const PRUNE_INTERVAL_MS = 60 * 1000

export type ToolFailureFact = {
  sessionId: string
  /** Stable journal item id; `(session, item, ordinal)` is the dedupe key. */
  itemKey: string
  /** Position within the item, so two failures in one message are two rows. */
  ordinal: number
  /** The journal's turn attribution: a turn item id, or the literal `thread`. */
  turn: string
  toolName: string
  /** Provider-stamped refusal kind, as given. Not normalized. */
  errorKind: string | null
  /** Structured exit status from the journal item, or null when the provider did not supply one. */
  exitCode: number | null
  observedAt: number
}

export type ToolFailureRow = ToolFailureFact

/** A CLI/renderer read is bounded: the table cap is the storage bound, this is the display bound. */
export const MAX_TOOL_FAILURE_READ = 5_000

export function clampToolFailureLimit(value: number): number {
  if (!Number.isFinite(value)) {
    return 200
  }
  return Math.max(1, Math.min(Math.floor(value), MAX_TOOL_FAILURE_READ))
}

export type ToolFailureRecordResult = 'inserted' | 'duplicate' | 'dropped'

/**
 * How many rows the table holds, asked once per recorded failure and nowhere else.
 *
 * This is the cap's only source of truth, deliberately: a stored counter would be a second copy of a
 * number the table already knows, and every path that adds, deletes or crashes between the two would
 * have to keep it in step. One bounded `COUNT(*)` over `incident_tool_failures` (bounded by that same
 * 20 000-row cap) states the answer directly.
 */
function toolFailureRowCount(db: Database.Database): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM incident_tool_failures').get()
  return row ? Number(row.n ?? 0) : 0
}

/** Delete expired rows at most once a minute, so the journal path does not pay a DELETE per event. */
function pruneIfDue(db: Database.Database, now: number): void {
  const last = Number(readMeta(db, TOOL_FAILURE_LAST_PRUNE_META) ?? 0)
  if (Number.isFinite(last) && now - last < PRUNE_INTERVAL_MS) {
    return
  }
  db.prepare('DELETE FROM incident_tool_failures WHERE observed_at < ?').run(
    now - TOOL_FAILURE_RETENTION_MS
  )
  // No recount to repair afterwards: the cap counts the table on every attempt, so a DELETE needs no
  // follow-up bookkeeping. Only the prune's own clock is written.
  writeMeta(db, TOOL_FAILURE_LAST_PRUNE_META, String(now))
}

/**
 * Whether this exact fact is already recorded, by its real primary key `(session_id, item_key,
 * ordinal)`.
 *
 * Only the cap path asks. Below the cap `INSERT OR IGNORE` answers the same question for free; at the
 * cap there is no insert to ask, and a duplicate is not evidence lost to capacity. The lookup is a
 * primary-key index seek for one row (the PK is this table's unique index), not a count and not a scan:
 * a single bounded probe, on a path that is rare by construction.
 */
function isRecorded(db: Database.Database, fact: ToolFailureFact): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS present FROM incident_tool_failures
        WHERE session_id = ? AND item_key = ? AND ordinal = ?`
    )
    .get(fact.sessionId, fact.itemKey, fact.ordinal)
  return row !== undefined
}

/**
 * Record one failed tool call. Never throws into the journal append: the caller wraps this, and a
 * diagnostics counter must not be able to fail a session's write.
 */
export function recordToolFailure(db: Database.Database, fact: ToolFailureFact): ToolFailureRecordResult {
  try {
    pruneIfDue(db, fact.observedAt)
    if (toolFailureRowCount(db) >= MAX_TOOL_FAILURE_ROWS) {
      // A fact already in the table adds no row, so capacity is not what refused it: classify it the
      // same way the below-cap `INSERT OR IGNORE` does, and let `dropped` count only real loss.
      if (isRecorded(db, fact)) {
        return 'duplicate'
      }
      bumpMetaNumber(db, TOOL_FAILURE_DROPPED_META)
      return 'dropped'
    }
    const result = db
      .prepare(
        `INSERT OR IGNORE INTO incident_tool_failures
           (session_id, item_key, ordinal, turn, tool_name, error_kind, exit_code, observed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        fact.sessionId,
        fact.itemKey,
        fact.ordinal,
        fact.turn,
        fact.toolName,
        fact.errorKind,
        fact.exitCode,
        fact.observedAt
      )
    if (Number(result.changes) !== 1) {
      // A duplicate is the same fact again: `INSERT OR IGNORE` added no row, and no capacity was
      // consumed by it, so it is not evidence lost and must not touch `dropped`.
      return 'duplicate'
    }
    return 'inserted'
  } catch {
    try {
      bumpMetaNumber(db, TOOL_FAILURE_DROPPED_META)
    } catch {
      // Nothing left to do.
    }
    return 'dropped'
  }
}

export type ToolFailuresSnapshot = {
  since: number
  rows: ToolFailureRow[]
  /** Rows in the window, before the read limit. */
  total: number
  truncated: boolean
  /** Rows refused by the hard cap or lost to an insert failure since this store was created. */
  dropped: number
}

export function readToolFailures(
  db: Database.Database,
  options: { now: number; windowMs: number; limit: number }
): ToolFailuresSnapshot {
  const since = options.now - options.windowMs
  const limit = Math.max(1, Math.floor(options.limit))
  const rows = db
    .prepare(
      `SELECT session_id, item_key, ordinal, turn, tool_name, error_kind, exit_code, observed_at
         FROM incident_tool_failures
        WHERE observed_at >= ?
        ORDER BY observed_at DESC, session_id ASC, item_key ASC, ordinal ASC
        LIMIT ?`
    )
    .all(since, limit + 1) as Record<string, unknown>[]
  const truncated = rows.length > limit
  const visible = truncated ? rows.slice(0, limit) : rows
  const total = Number(
    (
      db.prepare('SELECT COUNT(*) AS n FROM incident_tool_failures WHERE observed_at >= ?').get(since) as
        | { n?: number }
        | undefined
    )?.n ?? 0
  )
  return {
    since,
    rows: visible.map((row) => ({
      sessionId: String(row.session_id),
      itemKey: String(row.item_key),
      ordinal: Number(row.ordinal),
      turn: String(row.turn),
      toolName: String(row.tool_name),
      errorKind: row.error_kind === null ? null : String(row.error_kind),
      exitCode: row.exit_code === null ? null : Number(row.exit_code),
      observedAt: Number(row.observed_at)
    })),
    total,
    truncated,
    dropped: Number(readMeta(db, TOOL_FAILURE_DROPPED_META) ?? 0)
  }
}

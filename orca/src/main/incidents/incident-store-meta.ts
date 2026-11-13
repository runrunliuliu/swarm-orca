// The incident store's small key/value metadata table (simplify S2).
//
// `incident_store_meta` holds the few durable facts that are not rows: the capacity latch, the shadow
// replay watermark and its coverage counters, the stall sampler's last pass, the tool-error window
// snapshot, and the prune flag. Two modules used to own their own read/write pair, which is two places
// for "what does a corrupt number mean" to be decided.
//
// The keys themselves are NOT here. They belong to the feature that writes them
// (`incident-store-capacity.ts`, `incident-shadow-coverage.ts`, …), so this file cannot mistake a
// vocabulary for policy.
//
// Semantics are exactly the previous ones, deliberately:
//   * `readMeta` returns the stored string, or null when absent;
//   * `readMetaNumber` reads a non-finite or negative value as 0 rather than poisoning arithmetic;
//   * `writeMeta` upserts, so a counter can be re-read after a crash.

import type Database from '../sqlite/sync-database'

export const META_TABLE = 'incident_store_meta'

export function readMeta(db: Database.Database, key: string): string | null {
  const row = db.prepare(`SELECT value FROM ${META_TABLE} WHERE key = ?`).get(key)
  return row ? String(row.value) : null
}

export function writeMeta(db: Database.Database, key: string, value: string): void {
  db.prepare(
    `INSERT INTO ${META_TABLE} (key, value) VALUES (?, ?) ` +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value)
}

/** Non-negative number from meta; a corrupt value reads as 0 rather than poisoning arithmetic. */
export function readMetaNumber(db: Database.Database, key: string): number {
  const value = Number(readMeta(db, key) ?? 0)
  return Number.isFinite(value) && value >= 0 ? value : 0
}

/** Add `by` to a counter in meta. Used by the replay for durable drop/failure counts. */
export function bumpMetaNumber(db: Database.Database, key: string, by = 1): void {
  writeMeta(db, key, String(readMetaNumber(db, key) + by))
}

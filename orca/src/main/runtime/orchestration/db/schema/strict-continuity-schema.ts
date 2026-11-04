import type Database from '../../../../sqlite/sync-database'

const statements = [
  `CREATE TABLE IF NOT EXISTS strict_continuity_database (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  database_id TEXT NOT NULL UNIQUE
)`,
  `CREATE TABLE IF NOT EXISTS strict_continuity_seals (
  recovery_epoch INTEGER PRIMARY KEY CHECK (recovery_epoch > 0),
  run_id TEXT NOT NULL REFERENCES strict_run_coordinators(run_id),
  source_runtime_id TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  snapshot_canonical_sha256 TEXT NOT NULL,
  seal TEXT NOT NULL
)`,
  `CREATE TRIGGER IF NOT EXISTS trg_continuity_database_update
BEFORE UPDATE ON strict_continuity_database
BEGIN SELECT RAISE(ABORT, 'strict_continuity_database_immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_continuity_database_delete
BEFORE DELETE ON strict_continuity_database
BEGIN SELECT RAISE(ABORT, 'strict_continuity_database_immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_continuity_seal_update
BEFORE UPDATE ON strict_continuity_seals
BEGIN SELECT RAISE(ABORT, 'strict_continuity_seal_immutable'); END`,
  `CREATE TRIGGER IF NOT EXISTS trg_continuity_seal_delete
BEFORE DELETE ON strict_continuity_seals
BEGIN SELECT RAISE(ABORT, 'strict_continuity_seal_immutable'); END`
]

// No public seal/resume RPC until Server lineage and the reviewed file chain are implemented.
export const STRICT_CONTINUITY_SCHEMA_SQL = `${statements.join(';')};`

function normalized(sql: string): string {
  return sql
    .replace(/IF NOT EXISTS /g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Once enrolled, missing or changed objects are evidence damage, never a migration to repair. */
export function assertStrictContinuitySchema(db: Database.Database, allowAbsent = false): void {
  const actual = db
    .prepare(`SELECT sql FROM main.sqlite_master WHERE sql IS NOT NULL AND
    (name IN ('strict_continuity_database', 'strict_continuity_seals',
      'trg_continuity_database_update', 'trg_continuity_database_delete',
      'trg_continuity_seal_update', 'trg_continuity_seal_delete')
      OR tbl_name IN ('strict_continuity_database', 'strict_continuity_seals'))`)
    .all()
    .map((row) => (typeof row.sql === 'string' ? normalized(row.sql) : ''))
    .sort()
  if (allowAbsent && actual.length === 0) {
    return
  }
  if (JSON.stringify(actual) !== JSON.stringify(statements.map(normalized).sort())) {
    throw new Error('strict_continuity_required: continuity schema changed or incomplete')
  }
}

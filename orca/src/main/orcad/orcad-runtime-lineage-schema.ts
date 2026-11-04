import type Database from '../sqlite/sync-database'

const statements = [
  `CREATE TABLE identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1), body TEXT NOT NULL)`,
  `CREATE TABLE boots (epoch INTEGER PRIMARY KEY, runtime_id TEXT NOT NULL UNIQUE,
    canonical_sha256 TEXT NOT NULL UNIQUE, body TEXT NOT NULL)`,
  `CREATE TABLE database_seals (source_boot_sha256 TEXT PRIMARY KEY,
    body TEXT NOT NULL, canonical_sha256 TEXT NOT NULL)`,
  `CREATE TABLE recovery_inspections (boot_epoch INTEGER PRIMARY KEY,
    body TEXT NOT NULL, canonical_sha256 TEXT NOT NULL)`,
  `CREATE TABLE source_inventories (source_boot_sha256 TEXT PRIMARY KEY,
    body TEXT NOT NULL, canonical_sha256 TEXT NOT NULL)`,
  ...['identity', 'boots', 'database_seals', 'recovery_inspections', 'source_inventories'].flatMap(
    (table) =>
      ['UPDATE', 'DELETE'].map((operation) => {
        const name =
          table === 'boots' ? 'boot' : table === 'database_seals' ? 'database_seal' : table
        return `CREATE TRIGGER immutable_${name}_${operation.toLowerCase()} BEFORE ${operation} ON ${table}
        BEGIN SELECT RAISE(ABORT, 'lineage_immutable'); END`
      })
  )
]

const restartStatements = [
  `CREATE TABLE planned_restarts (cycle TEXT NOT NULL,
    stage TEXT NOT NULL CHECK(stage IN ('prepare', 'review', 'attempt', 'consume')),
    attempt INTEGER NOT NULL DEFAULT 0,
    body TEXT NOT NULL, canonical_sha256 TEXT NOT NULL, PRIMARY KEY(cycle, stage, attempt))`,
  ...['UPDATE', 'DELETE'].map(
    (operation) => `CREATE TRIGGER immutable_planned_restarts_${operation.toLowerCase()}
      BEFORE ${operation} ON planned_restarts BEGIN SELECT RAISE(ABORT, 'lineage_immutable'); END`
  )
]

function normalized(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

/** Existing journals are evidence: never repair missing tables/triggers during admission. */
export function initializeRuntimeLineageSchema(db: Database.Database, existing: boolean): void {
  if (!existing) {
    db.exec([...statements, ...restartStatements].join(';'))
  }
  const actual = db
    .prepare("SELECT sql FROM main.sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => (typeof row.sql === 'string' ? normalized(row.sql) : ''))
    .sort()
  const legacy = statements.map(normalized).sort()
  const expected = [...statements, ...restartStatements].map(normalized).sort()
  if (
    JSON.stringify(actual) !== JSON.stringify(expected) &&
    JSON.stringify(actual) !== JSON.stringify(legacy)
  ) {
    throw new Error('orcad_runtime_lineage_refused: journal schema changed')
  }
}

/** Only a live, unsealed source may add the planned-restart records to an older journal. */
export function preparePlannedRestartLineageSchema(db: Database.Database): void {
  initializeRuntimeLineageSchema(db, true)
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'planned_restarts'").get()) {
    return
  }
  if (db.prepare('SELECT 1 FROM database_seals LIMIT 1').get()) {
    throw new Error('orcad_runtime_lineage_refused: cannot upgrade a sealed journal')
  }
  db.exec(restartStatements.join(';'))
}

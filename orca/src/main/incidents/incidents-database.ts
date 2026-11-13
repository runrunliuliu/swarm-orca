// The incident store's own SQLite database (issue-sedimentation.md v2.2 §6.1).
//
// Deliberately NOT the orchestration database: incidents are not all Run-scoped (a bare terminal can
// crash), they outlive Run retention, and keeping them apart means `SCHEMA_VERSION = 44` is not
// touched at all. The file lives in the per-host user-data directory — never in a Run archive,
// never inside the user's working tree (see incidents-paths.ts).
//
// Shapes mirror the house patterns: `user_version` is read on a connection that has run no DDL
// (a database written by a newer build must be left byte-identical, and `journal_mode = WAL` writes
// the file header), the migration and the version bump are ONE transaction, and immutability is an
// engine constraint via triggers rather than a rule each writer is trusted to remember.

import { existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import Database from '../sqlite/sync-database'
import { hardenSqliteDatabaseFiles } from '../sqlite/harden-database-files'
import { PRUNE_FLAG_TABLE, VERIFIED_PRUNE_FLAG } from './incident-store-prune-flag'

/**
 * Bump only for additive changes; a newer version opens read-only here.
 *
 * v2 (M3) adds the stall surface: wait declarations and the last sample.
 * v3 (M3 review) changes the *sample* shape: the age basis is now a semantic event clock with an
 * explicit fallback marker, and the verdict is named `would_write_if_enabled`. The sample table is a
 * derived cache refreshed every tick, so its migration is "drop and recreate" — declarations, incident
 * rows, triggers and decisions are untouched.
 */
export const INCIDENTS_DB_SCHEMA_VERSION = 4

export const INCIDENTS_BUSY_TIMEOUT_MS = 5000

/**
 * Why NORMAL rather than the journal's FULL: an incident write happens inside the PTY-exit path,
 * where a per-write fsync would add disk latency to every pane teardown. The trade is explicit —
 * on power loss the last few diagnostic rows may be lost, while the exit itself is never slowed.
 * Nothing downstream treats an incident as a durability receipt (§16).
 */
export const INCIDENTS_SYNCHRONOUS = 'NORMAL'

/**
 * Table shape.
 *
 * `UNIQUE(source_kind, source_id, facet)` is the whole idempotency story (§6.2.1): `source_id`
 * carries the epoch, so a repeat callback for the same failure is a no-op while a second genuine
 * failure of the same entity is a new row.
 *
 * `incident_decisions.incident_id` is intentionally NOT a foreign key. Prune (§11.5) may delete a
 * `closed/invalid/duplicate` incident after 90 days, but decisions are the audit trail of *why* it
 * was closed and must survive that deletion. A `REFERENCES ... ON DELETE RESTRICT` would forbid the
 * only sanctioned deletion; `CASCADE`/`SET NULL` would erase or orphan the audit silently.
 */
function createIncidentTablesSql(): string {
  return `
CREATE TABLE IF NOT EXISTS incidents (
  id                 TEXT PRIMARY KEY,
  source_kind        TEXT NOT NULL,
  source_id          TEXT NOT NULL,
  facet              TEXT NOT NULL,
  host_id            TEXT NOT NULL,
  worktree_id        TEXT,
  run_id             TEXT,
  task_id            TEXT,
  dispatch_id        TEXT,
  agent_session_id   TEXT,
  pty_incarnation_id TEXT,
  class              TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'untriaged',
  exit_cause         TEXT,
  fingerprint        TEXT NOT NULL,
  evidence           TEXT NOT NULL,
  summary            TEXT NOT NULL,
  created_at         INTEGER NOT NULL,
  UNIQUE(source_kind, source_id, facet)
);
CREATE INDEX IF NOT EXISTS idx_incidents_fingerprint ON incidents(fingerprint, created_at);
CREATE INDEX IF NOT EXISTS idx_incidents_created_at ON incidents(created_at);
CREATE INDEX IF NOT EXISTS idx_incidents_class ON incidents(class, created_at);

CREATE TABLE IF NOT EXISTS incident_decisions (
  id          TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL,
  from_status TEXT NOT NULL,
  to_status   TEXT NOT NULL,
  actor       TEXT NOT NULL,
  reason      TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_incident_decisions_incident
  ON incident_decisions(incident_id, created_at);

CREATE TABLE IF NOT EXISTS ${PRUNE_FLAG_TABLE} (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- The projection §6.2 asks for. A view, not a table: a mutable shadow copy would be a second place
-- for the effective status to be wrong, and this one cannot drift from the decision log.
CREATE VIEW IF NOT EXISTS incident_state AS
SELECT
  i.id AS incident_id,
  COALESCE(
    (SELECT d.to_status FROM incident_decisions d
      WHERE d.incident_id = i.id
      ORDER BY d.created_at DESC, d.rowid DESC LIMIT 1),
    i.status
  ) AS status,
  (SELECT COUNT(*) FROM incident_decisions d WHERE d.incident_id = i.id) AS decision_count,
  (SELECT MAX(d.created_at) FROM incident_decisions d WHERE d.incident_id = i.id) AS last_decision_at
FROM incidents i;

-- Immutability (§6.2). UPDATE is unconditional: a status change is a decision row, never an edit.
CREATE TRIGGER IF NOT EXISTS trg_incidents_no_update
BEFORE UPDATE ON incidents
BEGIN SELECT RAISE(ABORT, 'incident_immutable'); END;

-- DELETE is allowed only inside prune's transaction, which sets the marker first. The marker is a
-- guard against accidental mutation, not a security boundary: this store is a local diagnostics
-- file owned by the same user, and an adversarial local process could rewrite it regardless.
CREATE TRIGGER IF NOT EXISTS trg_incidents_no_delete
BEFORE DELETE ON incidents
WHEN COALESCE((SELECT value FROM ${PRUNE_FLAG_TABLE} WHERE key = '${VERIFIED_PRUNE_FLAG}'), '0') <> '1'
BEGIN SELECT RAISE(ABORT, 'incident_immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_incident_decisions_no_update
BEFORE UPDATE ON incident_decisions
BEGIN SELECT RAISE(ABORT, 'incident_decision_immutable'); END;

CREATE TRIGGER IF NOT EXISTS trg_incident_decisions_no_delete
BEFORE DELETE ON incident_decisions
BEGIN SELECT RAISE(ABORT, 'incident_decision_immutable'); END;

-- Wait declarations (M3-1). One row per (pane, epoch): a pane that is torn down and respawned comes
-- back with a new epoch, so the old declaration can never suppress its stalls. The epoch column is
-- the stateStartedAt observed when the declaration was made, stored as text so a caller cannot
-- accidentally compare a number against a JSON string.
CREATE TABLE IF NOT EXISTS incident_wait_declarations (
  pane_key    TEXT NOT NULL,
  epoch       TEXT NOT NULL,
  reason      TEXT NOT NULL,
  actor       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER,
  PRIMARY KEY (pane_key, epoch)
);
CREATE INDEX IF NOT EXISTS idx_incident_wait_expiry ON incident_wait_declarations(expires_at);

-- The last stall sample (M3-3). One row per pane, replaced wholesale on each tick: this is the
-- read model behind the stalls command, and the epoch source a wait declaration binds to.
CREATE TABLE IF NOT EXISTS incident_stall_samples (
  pane_key             TEXT PRIMARY KEY,
  terminal_handle      TEXT,
  state                TEXT NOT NULL,
  state_started_at     INTEGER NOT NULL,
  turn_started_at      INTEGER,
  last_semantic_event_at INTEGER,
  age_ms               INTEGER NOT NULL,
  age_basis            TEXT NOT NULL,
  threshold_ms         INTEGER NOT NULL,
  would_write_if_enabled INTEGER NOT NULL,
  reason               TEXT NOT NULL,
  declared_wait        TEXT
);
CREATE INDEX IF NOT EXISTS idx_incident_stall_would
  ON incident_stall_samples(would_write_if_enabled);

-- Dispatch acceptance (M5). Declarations live here, not in the orchestration database: they are
-- business expectations about a dispatch, the orchestration schema is frozen at v44, and an incident is
-- the durable proof that one failed. Each rule is independent (its own row, its own verdict).
CREATE TABLE IF NOT EXISTS dispatch_acceptance_rules (
  host_id     TEXT NOT NULL,
  dispatch_id TEXT NOT NULL,
  rule_id     TEXT NOT NULL,
  program     TEXT NOT NULL,
  args        TEXT NOT NULL,
  expect      TEXT NOT NULL,
  timeout_ms  INTEGER NOT NULL,
  cwd         TEXT NOT NULL,
  actor       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  digest      TEXT NOT NULL,
  PRIMARY KEY (host_id, dispatch_id, rule_id)
);
CREATE INDEX IF NOT EXISTS idx_dispatch_acceptance_rules_dispatch
  ON dispatch_acceptance_rules(dispatch_id);

-- One verdict per (dispatch, rule): a re-run replaces it, so the gate always reads the latest.
CREATE TABLE IF NOT EXISTS dispatch_acceptance_verdicts (
  dispatch_id   TEXT NOT NULL,
  rule_id       TEXT NOT NULL,
  verdict       TEXT NOT NULL,
  exit_code     INTEGER,
  signal        TEXT,
  stdout_digest TEXT,
  stdout_bytes  INTEGER,
  detail        TEXT,
  evaluated_at  INTEGER NOT NULL,
  PRIMARY KEY (dispatch_id, rule_id)
);

-- The visible stop. pending is non-terminal and owned; accepted lets settlement resume through the
-- existing path; rejected keeps the dispatch unsettled and hands it back to its owner.
CREATE TABLE IF NOT EXISTS dispatch_acceptance_stops (
  dispatch_id TEXT PRIMARY KEY,
  state       TEXT NOT NULL,
  incident_id TEXT,
  opened_at   INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  actor       TEXT,
  reason      TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0
);
`
}

export type OpenIncidentsDatabase = {
  db: Database.Database
  path: string
  /** A newer `user_version` was met: this build reads and never writes. */
  readOnly: boolean
  /** Bytes on disk for the database and its WAL sidecars; the capacity limit counts real bytes. */
  fileSizeBytes: () => number
}

function incidentsPragmaNumber(db: Database.Database, name: string): number {
  return Number(db.pragma(name, { simple: true }) ?? 0)
}

function databaseFileBytes(path: string): number {
  let total = 0
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      if (existsSync(candidate)) {
        total += statSync(candidate).size
      }
    } catch {
      // A sidecar can disappear between existsSync and statSync during a checkpoint; 0 is honest.
    }
  }
  return total
}

/**
 * A read-only connection that does not create the WAL sidecars.
 *
 * Measured on this runtime: a plain read-only open of a cleanly closed WAL database creates a 0-byte
 * `-wal` and a 32KB `-shm`. `list`/`show` must not do that — they are diagnostics, and a listing that
 * grows files in user data is a surprise, not a feature.
 *
 * `immutable=1` is only safe when there is no `-wal`: a writer attached in WAL mode always has one,
 * so its absence means there are no uncommitted frames to miss. When `-wal` exists, the normal
 * read-only open is used *and* leaves it byte-identical (measured: the shm read-mark update does not
 * change either file), because it joins the existing sidecars instead of creating them.
 */
function readOnlyTarget(dbPath: string): { target: string; immutable: boolean } {
  return existsSync(`${dbPath}-wal`)
    ? { target: dbPath, immutable: false }
    : { target: `${pathToFileURL(dbPath).href}?immutable=1`, immutable: true }
}

/**
 * Open (and if needed create/migrate) the incident database.
 *
 * Never throws into a caller's failure path any harder than the filesystem already did: the caller
 * (incident-writer.ts) turns a failed open into a typed skip reason.
 */
export function openIncidentsDatabase(
  dbPath: string,
  options: { readOnly?: boolean } = {}
): OpenIncidentsDatabase {
  if (options.readOnly === true) {
    // Read paths (list/show) must not take a write lock, create a `-wal`/`-shm`, or migrate:
    // a v0 file opened read-only keeps its version and its missing tables, which is the evidence
    // that the read path never ran the schema.
    const readOnly = readOnlyTarget(dbPath)
    return {
      db: new Database(readOnly.target, {
        readonly: true,
        // A URI cannot be stat()ed, so existence is the caller's check there.
        fileMustExist: !readOnly.immutable
      }),
      path: dbPath,
      readOnly: true,
      fileSizeBytes: () => databaseFileBytes(dbPath)
    }
  }
  // SQLite creates the file but never its parent directory; the first crash on a fresh profile must
  // not fail because `<userData>/incidents/` was never made.
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 })
  const probe = new Database(dbPath)
  let stored: number
  try {
    stored = incidentsPragmaNumber(probe, 'user_version')
  } catch (error) {
    probe.close()
    throw error
  }
  if (stored > INCIDENTS_DB_SCHEMA_VERSION) {
    probe.close()
    return {
      db: new Database(dbPath, { readonly: true, fileMustExist: true }),
      path: dbPath,
      readOnly: true,
      fileSizeBytes: () => databaseFileBytes(dbPath)
    }
  }
  let transferred = false
  try {
    configureIncidentsPragmas(probe, stored)
    createIncidentSchema(probe, stored)
    hardenSqliteDatabaseFiles(dbPath)
    transferred = true
    return {
      db: probe,
      path: dbPath,
      readOnly: false,
      fileSizeBytes: () => databaseFileBytes(dbPath)
    }
  } finally {
    if (!transferred) {
      probe.close()
    }
  }
}

function configureIncidentsPragmas(db: Database.Database, stored: number): void {
  if (stored === 0) {
    // Only takes on an empty file; lets a later prune free pages in bounded steps.
    db.pragma('auto_vacuum = INCREMENTAL')
  }
  db.pragma('journal_mode = WAL')
  db.pragma(`busy_timeout = ${INCIDENTS_BUSY_TIMEOUT_MS}`)
  db.pragma('foreign_keys = ON')
  db.pragma(`synchronous = ${INCIDENTS_SYNCHRONOUS}`)
}

/**
 * Table creation and the `user_version` bump are one transaction, so a crash between them cannot
 * leave a shaped database still reporting version 0 (which an older build would then write into).
 */
function createIncidentSchema(db: Database.Database, stored: number): void {
  if (stored >= INCIDENTS_DB_SCHEMA_VERSION) {
    return
  }
  runIncidentsTransaction(db, () => {
    if (stored > 0) {
      // The sample table is a derived per-tick cache; recreating it is cheaper and safer than a
      // column-by-column rewrite, and it cannot lose anything an operator would miss.
      db.exec('DROP TABLE IF EXISTS incident_stall_samples')
    }
    db.exec(createIncidentTablesSql())
    db.pragma(`user_version = ${INCIDENTS_DB_SCHEMA_VERSION}`)
  })
}

/**
 * One IMMEDIATE transaction whose COMMIT sits inside the failure boundary: SQLite can leave a
 * transaction open after a failed COMMIT, and the connection is shared. `run` must be synchronous —
 * an await inside it would let another writer's statements land in this transaction.
 */
export function runIncidentsTransaction<T>(
  db: Database.Database,
  run: (db: Database.Database) => T
): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = run(db)
    if (result instanceof Promise) {
      throw new Error('an incident store transaction must not await')
    }
    db.exec('COMMIT')
    return result
  } catch (error) {
    if (db.isTransaction) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // Best effort: the original error is what the caller needs.
      }
    }
    throw error
  }
}

export { createIncidentTablesSql, databaseFileBytes }

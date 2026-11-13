/**
 * The store's own database: shape versioning, immutability as an engine constraint, and the
 * read-only path a newer build must take. §6.1/§6.2.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../sqlite/sync-database'
import {
  INCIDENTS_DB_SCHEMA_VERSION,
  openIncidentsDatabase,
  type OpenIncidentsDatabase
} from './incidents-database'

const temporaryDirectories: string[] = []
const openDatabases: OpenIncidentsDatabase[] = []

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'orca-incidents-db-'))
  temporaryDirectories.push(directory)
  return join(directory, 'incidents.db')
}

function open(path = databasePath()): OpenIncidentsDatabase {
  const opened = openIncidentsDatabase(path)
  openDatabases.push(opened)
  return opened
}

function insertSample(db: Database.Database, id = 'inc_1'): void {
  db.prepare(
    `INSERT INTO incidents (id, source_kind, source_id, facet, host_id, class, status, fingerprint,
       evidence, summary, created_at)
     VALUES (?, 'pty_exit', 'inc-1', 'exit', 'h', 'crash', 'untriaged', 'f', '{"pointers":[],"unknownBoundaries":[]}',
       's', 1)`
  ).run(id)
}

afterEach(() => {
  for (const opened of openDatabases.splice(0)) {
    try {
      opened.db.close()
    } catch {
      // Already closed by the test.
    }
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('openIncidentsDatabase', () => {
  it('creates the schema and records its own shape version', () => {
    const opened = open()
    expect(opened.readOnly).toBe(false)
    expect(Number(opened.db.pragma('user_version', { simple: true }))).toBe(INCIDENTS_DB_SCHEMA_VERSION)
    const tables = opened.db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view','trigger') ORDER BY name")
      .all()
      .map((row) => String(row.name))
    expect(tables).toEqual(
      expect.arrayContaining([
        'incidents',
        'incident_decisions',
        'incident_store_meta',
        'incident_state',
        'trg_incidents_no_update',
        'trg_incidents_no_delete',
        'trg_incident_decisions_no_update',
        'trg_incident_decisions_no_delete'
      ])
    )
    expect(String(opened.db.pragma('journal_mode', { simple: true }))).toBe('wal')
  })

  it('is idempotent: reopening a current database migrates nothing and keeps its bytes', () => {
    const path = databasePath()
    const first = open(path)
    insertSample(first.db)
    first.db.close()
    openDatabases.length = 0

    const second = open(path)
    expect(second.readOnly).toBe(false)
    expect(Number(second.db.pragma('user_version', { simple: true }))).toBe(INCIDENTS_DB_SCHEMA_VERSION)
    expect(second.db.prepare('SELECT COUNT(*) AS n FROM incidents').get()?.n).toBe(1)
    // A second migration pass would append rows or rebuild tables; the row count above proves it did not.
  })

  it('opens a newer database read-only without touching it', () => {
    const path = databasePath()
    const first = open(path)
    first.db.pragma(`user_version = ${INCIDENTS_DB_SCHEMA_VERSION + 1}`)
    first.db.close()
    openDatabases.length = 0
    const bytesBefore = statSync(path).size

    const newer = open(path)
    expect(newer.readOnly).toBe(true)
    expect(() => newer.db.exec("INSERT INTO incidents (id) VALUES ('x')")).toThrow()
    expect(statSync(path).size).toBe(bytesBefore)
  })

  it('migrates a v1 database by adding the M3 tables and keeping its rows', () => {
    const path = databasePath()
    // A v1 file: build the old schema by opening and then rolling the version back (the tables that
    // v1 had are exactly the ones createIncidentTablesSql still creates, minus the M3 additions).
    const first = open(path)
    insertSample(first.db)
    first.db.exec('DROP TABLE incident_wait_declarations; DROP TABLE IF EXISTS incident_stall_samples')
    first.db.pragma('user_version = 1')
    first.db.close()
    openDatabases.length = 0

    const migrated = open(path)
    expect(Number(migrated.db.pragma('user_version', { simple: true }))).toBe(
      INCIDENTS_DB_SCHEMA_VERSION
    )
    expect(migrated.db.prepare('SELECT COUNT(*) AS n FROM incidents').get()?.n).toBe(1)
    const tables = migrated.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => String(row.name))
    expect(tables).toEqual(
      expect.arrayContaining(['incident_wait_declarations', 'incident_pane_clocks'])
    )
  })

  it('supports an explicit read-only open for the CLI read paths', () => {
    const path = databasePath()
    const writable = open(path)
    insertSample(writable.db)
    writable.db.close()
    openDatabases.length = 0

    const readOnly = openIncidentsDatabase(path, { readOnly: true })
    openDatabases.push(readOnly)
    expect(readOnly.readOnly).toBe(true)
    expect(readOnly.db.prepare('SELECT COUNT(*) AS n FROM incidents').get()?.n).toBe(1)
  })

  it('opens a cleanly closed database read-only without creating WAL sidecars (C4)', () => {
    const path = databasePath()
    const writable = open(path)
    insertSample(writable.db)
    writable.db.close()
    openDatabases.length = 0
    // A clean close checkpoints and removes the sidecars; that is the state `list` must not disturb.
    expect(existsSync(`${path}-wal`)).toBe(false)
    expect(existsSync(`${path}-shm`)).toBe(false)
    const dbBytes = statSync(path).size
    const digest = createHash('sha256').update(readFileSync(path)).digest('hex')

    const readOnly = openIncidentsDatabase(path, { readOnly: true })
    openDatabases.push(readOnly)
    expect(readOnly.db.prepare('SELECT COUNT(*) AS n FROM incidents').get()?.n).toBe(1)
    expect(Number(readOnly.db.pragma('user_version', { simple: true }))).toBe(INCIDENTS_DB_SCHEMA_VERSION)

    expect(existsSync(`${path}-wal`)).toBe(false)
    expect(existsSync(`${path}-shm`)).toBe(false)
    expect(statSync(path).size).toBe(dbBytes)
    expect(createHash('sha256').update(readFileSync(path)).digest('hex')).toBe(digest)
  })

  it('does not migrate a database whose schema version predates this build (C4)', () => {
    const path = databasePath()
    // A plain database this build never touched: version 0 and no incidents tables.
    const raw = new Database(path)
    raw.exec('CREATE TABLE unrelated (a TEXT)')
    raw.close()
    expect(existsSync(`${path}-wal`)).toBe(false)

    const readOnly = openIncidentsDatabase(path, { readOnly: true })
    openDatabases.push(readOnly)
    expect(Number(readOnly.db.pragma('user_version', { simple: true }))).toBe(0)
    const tables = readOnly.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => String(row.name))
    expect(tables).toEqual(['unrelated'])
    expect(existsSync(`${path}-wal`)).toBe(false)
  })

  it('leaves a live writer\'s WAL untouched when reading (C4)', () => {
    const path = databasePath()
    const writer = open(path)
    insertSample(writer.db)
    expect(existsSync(`${path}-wal`)).toBe(true)
    const walBefore = readFileSync(`${path}-wal`)
    const shmSizeBefore = statSync(`${path}-shm`).size

    const readOnly = openIncidentsDatabase(path, { readOnly: true })
    openDatabases.push(readOnly)
    expect(readOnly.db.prepare('SELECT COUNT(*) AS n FROM incidents').get()?.n).toBe(1)

    // The WAL is data: a reader must not append to it or checkpoint it away.
    expect(readFileSync(`${path}-wal`).equals(walBefore)).toBe(true)
    // The shm carries SQLite's reader marks, so a reader is expected to write its own slot there.
    // What it must not do is grow it, drop it, or create a second one.
    expect(statSync(`${path}-shm`).size).toBe(shmSizeBefore)
    expect(existsSync(`${path}-wal`)).toBe(true)
    expect(existsSync(`${path}-shm`)).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('restricts the database files to the owning user', () => {
    const path = databasePath()
    open(path)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })
})

describe('immutability triggers', () => {
  it('refuses an UPDATE of an incident row', () => {
    const opened = open()
    insertSample(opened.db)
    expect(() => opened.db.exec("UPDATE incidents SET summary = 'edited'")).toThrow(/incident_immutable/)
  })

  it('refuses a DELETE outside prune', () => {
    const opened = open()
    insertSample(opened.db)
    expect(() => opened.db.exec('DELETE FROM incidents')).toThrow(/incident_immutable/)
  })

  it('refuses UPDATE and DELETE of a decision', () => {
    const opened = open()
    insertSample(opened.db)
    opened.db
      .prepare(
        `INSERT INTO incident_decisions (id, incident_id, from_status, to_status, actor, reason, created_at)
         VALUES ('dec_1', 'inc_1', 'untriaged', 'watch', 'a', 'r', 2)`
      )
      .run()
    expect(() => opened.db.exec("UPDATE incident_decisions SET actor = 'b'")).toThrow(
      /incident_decision_immutable/
    )
    expect(() => opened.db.exec('DELETE FROM incident_decisions')).toThrow(
      /incident_decision_immutable/
    )
  })

  it('projects the effective status from the decision log', () => {
    const opened = open()
    insertSample(opened.db)
    expect(opened.db.prepare('SELECT status FROM incident_state').get()?.status).toBe('untriaged')
    opened.db
      .prepare(
        `INSERT INTO incident_decisions (id, incident_id, from_status, to_status, actor, reason, created_at)
         VALUES ('dec_1', 'inc_1', 'untriaged', 'watch', 'a', 'r', 2),
                ('dec_2', 'inc_1', 'watch', 'invalid', 'a', 'r2', 3)`
      )
      .run()
    expect(opened.db.prepare('SELECT status FROM incident_state').get()?.status).toBe('invalid')
    // The row itself never moved: that is the whole point of the projection.
    expect(opened.db.prepare('SELECT status FROM incidents').get()?.status).toBe('untriaged')
  })
})

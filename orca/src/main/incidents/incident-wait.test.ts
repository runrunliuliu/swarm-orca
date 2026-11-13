/**
 * Wait declarations (§7.2, M3-1): epoch-keyed, expiry-honest, and removable.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openIncidentsDatabase, type OpenIncidentsDatabase } from './incidents-database'
import {
  WaitDeclarationError,
  clearWait,
  declareWait,
  listActiveWaits,
  pruneExpiredWaits,
  readDeclaredWaitCount,
  publishDeclaredWaitCount,
  PANE_CLOCK_DECLARED_WAITS_META
} from './incident-wait'

const NOW = 1_700_000_000_000
const directories: string[] = []
const databases: OpenIncidentsDatabase[] = []

function db(): OpenIncidentsDatabase['db'] {
  const directory = mkdtempSync(join(tmpdir(), 'orca-wait-'))
  directories.push(directory)
  const opened = openIncidentsDatabase(join(directory, 'incidents', 'incidents.db'))
  databases.push(opened)
  return opened.db
}

afterEach(() => {
  for (const opened of databases.splice(0)) {
    try {
      opened.db.close()
    } catch {
      // Already closed.
    }
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('declareWait', () => {
  it('keys the declaration by pane and epoch, and replaces the same key', () => {
    const database = db()
    declareWait(database, { paneKey: 'p', epoch: '100', reason: 'build', actor: 'a', expiresAt: null, now: NOW })
    declareWait(database, { paneKey: 'p', epoch: '100', reason: 'build (extended)', actor: 'b', expiresAt: null, now: NOW + 1 })
    const active = listActiveWaits(database, { now: NOW + 2 })
    expect(active).toHaveLength(1)
    expect(active[0]).toMatchObject({ paneKey: 'p', epoch: '100', reason: 'build (extended)', actor: 'b' })

    // A different epoch is a different declaration: the respawned pane gets its own.
    declareWait(database, { paneKey: 'p', epoch: '200', reason: 'build', actor: 'a', expiresAt: null, now: NOW })
    expect(listActiveWaits(database, { now: NOW + 2 })).toHaveLength(2)
  })

  it('requires a reason, an actor and an epoch, and refuses a past deadline', () => {
    const database = db()
    const base = { paneKey: 'p', epoch: '1', reason: 'r', actor: 'a', expiresAt: null, now: NOW }
    expect(() => declareWait(database, { ...base, reason: '  ' })).toThrow(WaitDeclarationError)
    expect(() => declareWait(database, { ...base, actor: '  ' })).toThrow(/missing_actor/)
    expect(() => declareWait(database, { ...base, epoch: ' ' })).toThrow(/missing_epoch/)
    expect(() => declareWait(database, { ...base, expiresAt: NOW })).toThrow(/expired_deadline/)
  })
})

describe('expiry and clearing', () => {
  it('hides an expired declaration from reads and deletes it on sweep', () => {
    const database = db()
    declareWait(database, { paneKey: 'p', epoch: '1', reason: 'r', actor: 'a', expiresAt: NOW + 1_000, now: NOW })
    expect(listActiveWaits(database, { now: NOW + 999 })).toHaveLength(1)
    expect(listActiveWaits(database, { now: NOW + 1_000 })).toHaveLength(0)
    expect(pruneExpiredWaits(database, NOW + 1_000)).toBe(1)
    expect(listActiveWaits(database, { now: NOW })).toHaveLength(0)
  })

  it('clears one epoch, or every epoch of a pane', () => {
    const database = db()
    declareWait(database, { paneKey: 'p', epoch: '1', reason: 'r', actor: 'a', expiresAt: null, now: NOW })
    declareWait(database, { paneKey: 'p', epoch: '2', reason: 'r', actor: 'a', expiresAt: null, now: NOW })
    declareWait(database, { paneKey: 'q', epoch: '1', reason: 'r', actor: 'a', expiresAt: null, now: NOW })

    expect(clearWait(database, { paneKey: 'p', epoch: '1' })).toBe(1)
    expect(listActiveWaits(database, { now: NOW }).map((entry) => entry.paneKey).sort()).toEqual(['p', 'q'])
    expect(clearWait(database, { paneKey: 'p' })).toBe(1)
    expect(listActiveWaits(database, { now: NOW })).toHaveLength(1)
    // Clearing again is a no-op, not an error.
    expect(clearWait(database, { paneKey: 'p' })).toBe(0)
  })
})

describe('declared-wait count for coverage', () => {
  it('round-trips through meta', () => {
    const database = db()
    publishDeclaredWaitCount(database, 3)
    expect(readDeclaredWaitCount(database)).toBe(3)
    // A corrupt value reads as zero instead of poisoning the coverage line.
    database.prepare("UPDATE incident_store_meta SET value = 'nope' WHERE key = ?").run(
      PANE_CLOCK_DECLARED_WAITS_META
    )
    expect(readDeclaredWaitCount(database)).toBe(0)
  })
})

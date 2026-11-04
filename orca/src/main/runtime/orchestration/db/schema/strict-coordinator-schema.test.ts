import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../../../../sqlite/sync-database'
import { OrchestrationDb } from '../orchestration-db'
import {
  hasStrictCoordinatorRuns,
  strictCoordinatorPolicy,
  strictRunRetirement
} from '../../strict-coordinator-policy'
import { STRICT_COORDINATOR_SCHEMA_SQL } from './strict-coordinator-schema'
import { SCHEMA_VERSION } from '../contract-constants'

const authority = {
  terminalHandle: 'coord',
  paneKey: 'tab:11111111-1111-4111-8111-111111111111',
  processIncarnation: 'pty:1',
  launchTokenHash: 'launch-hash',
  hostScope: { kind: 'local', hostId: 'local' }
} as const
const params = {
  objective: 'strict',
  coordinatorHandle: authority.terminalHandle,
  coordinatorPaneKey: authority.paneKey,
  strictCoordinator: authority
}

describe('strict Coordinator persistence', () => {
  const databases: OrchestrationDb[] = []
  const directories: string[] = []
  afterEach(() => {
    for (const db of databases.splice(0)) {
      db.close()
    }
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })
  const open = (path: string) => {
    const db = new OrchestrationDb(path)
    databases.push(db)
    return db
  }
  const path = () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-strict-schema-'))
    directories.push(directory)
    return join(directory, 'orchestration.db')
  }

  it('persists the pin across restart and refuses rebinding/deletion at the storage boundary', () => {
    const file = path()
    const original = open(file)
    expect(hasStrictCoordinatorRuns(original)).toBe(false)
    const run = original.createRun(params)
    expect(hasStrictCoordinatorRuns(original)).toBe(true)
    databases.pop()!.close()
    const db = open(file)
    expect(hasStrictCoordinatorRuns(db)).toBe(true)
    expect(strictCoordinatorPolicy(db, run.id)).toEqual({ runId: run.id, authority })
    const before = db.listRuns({})
    expect(() => db.createRun({ ...params, objective: 'replace' })).toThrow(
      expect.objectContaining({ code: 'strict_coordinator_required' })
    )
    expect(db.listRuns({})).toEqual(before)
    for (const sql of [
      'UPDATE runs SET consumer_generation = 2 WHERE id = ?',
      "UPDATE runs SET coordinator_handle = 'operator' WHERE id = ?",
      'DELETE FROM runs WHERE id = ?',
      "UPDATE strict_run_coordinators SET authority = '{}' WHERE run_id = ?",
      'DELETE FROM strict_run_coordinators WHERE run_id = ?'
    ]) {
      expect(() => db.db.prepare(sql).run(run.id)).toThrow('strict_coordinator_required')
    }
    expect(db.getRun(run.id)).toEqual(run)
  })

  it('rolls back both Run creation and prior binding changes when the pin is invalid', () => {
    const db = open(':memory:')
    const prior = db.createRun({ ...params, strictCoordinator: undefined })
    const before = db.listRuns({})
    expect(() =>
      db.createRun({ ...params, strictCoordinator: { ...authority, launchTokenHash: '' } })
    ).toThrow()
    expect(db.listRuns({})).toEqual(before)
    expect(db.getCurrentRunForPane(authority.paneKey)?.id).toBe(prior.id)
    expect(hasStrictCoordinatorRuns(db)).toBe(false)
  })

  it('upgrades v42 without changing ordinary ownership and installs strict policy atomically', () => {
    const file = path()
    const original = open(file)
    const prior = original.createRun({ ...params, strictCoordinator: undefined })
    databases.pop()!.close()
    const raw = new Database(file)
    raw.exec(`DROP TRIGGER trg_strict_run_binding; DROP TRIGGER trg_strict_run_delete;
      DROP TRIGGER trg_strict_policy_update; DROP TRIGGER trg_strict_policy_delete;
      DROP TABLE strict_run_coordinators;`)
    raw.pragma('user_version = 42')
    raw.close()
    const db = open(file)
    expect(db.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    expect(db.getRun(prior.id)).toEqual(prior)
    expect(strictCoordinatorPolicy(db, prior.id)).toBeUndefined()
    expect(strictCoordinatorPolicy(db, db.createRun(params).id)?.authority).toEqual(authority)
  })

  it('upgrades v43, retains retirement across restart, and never permits reactivation', () => {
    const file = path()
    const original = open(file)
    const run = original.createRun(params)
    databases.pop()!.close()
    const raw = new Database(file)
    raw.exec(`DROP TRIGGER trg_strict_retirement_update; DROP TRIGGER trg_strict_retirement_delete;
      DROP TABLE strict_run_retirements; DROP TRIGGER trg_strict_run_binding;`)
    raw.exec(STRICT_COORDINATOR_SCHEMA_SQL)
    raw.pragma('user_version = 43')
    raw.close()
    const upgraded = open(file)
    expect(upgraded.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    expect(strictRunRetirement(upgraded, run.id)).toBeUndefined()
    expect(() =>
      upgraded.db
        .prepare('UPDATE runs SET coordinator_orca_session_id_generation = 2 WHERE id = ?')
        .run(run.id)
    ).toThrow('strict_coordinator_required')
    const receipt = { runId: run.id, coordinatorState: 'retired', generation: 2 }
    upgraded.db.exec('BEGIN IMMEDIATE')
    upgraded.db
      .prepare('INSERT INTO strict_run_retirements VALUES (?, ?, ?)')
      .run(run.id, 1, JSON.stringify(receipt))
    upgraded.db
      .prepare(`UPDATE runs SET coordinator_handle = NULL, coordinator_pane_key = NULL,
      coordinator_orca_session_id = NULL, coordinator_orca_session_id_generation = NULL,
      consumer_generation = 2 WHERE id = ?`)
      .run(run.id)
    upgraded.db.exec('COMMIT')
    databases.pop()!.close()
    const reopened = open(file)
    expect(strictRunRetirement(reopened, run.id)).toEqual(receipt)
    expect(hasStrictCoordinatorRuns(reopened)).toBe(true)
    expect(reopened.getRun(run.id)).toMatchObject({
      coordinator_handle: null,
      consumer_generation: 2
    })
    for (const sql of [
      "UPDATE runs SET coordinator_handle = 'operator' WHERE id = ?",
      'UPDATE runs SET consumer_generation = 3 WHERE id = ?',
      'DELETE FROM runs WHERE id = ?',
      "UPDATE strict_run_retirements SET receipt = '{}' WHERE run_id = ?",
      'DELETE FROM strict_run_retirements WHERE run_id = ?'
    ]) {
      expect(() => reopened.db.prepare(sql).run(run.id)).toThrow('strict_coordinator_required')
    }
    expect(reopened.createRun(params).id).not.toBe(run.id)
  })
})

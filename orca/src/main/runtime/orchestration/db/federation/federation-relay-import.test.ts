/**
 * F7 on the federated relay path: a duplicate or stale relay item must not write acceptance evidence.
 *
 * `importFederatedRelayItem` evaluates the gate before its own duplicate check (sequence cursor) and
 * before the settlement's admission checks, so a re-delivered item — or one whose dispatch/task already
 * closed — used to open an acceptance incident and bump the stop's seen count for a settlement that
 * never happens. The gate is now evaluated only for a report the settlement would act on; the replay
 * path that *does* resume after an operator resolves the stop still evaluates it, unconditionally.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type Database from '../../../../sqlite/sync-database'
import { OrchestrationDb } from '../orchestration-db'
import { createRootDispatch } from '../root-dispatch-test-fixture'
import {
  openIncidentsDatabase,
  type OpenIncidentsDatabase
} from '../../../../incidents/incidents-database'
import { createIncidentStore, type IncidentStore } from '../../../../incidents/incident-store'
import {
  __configureIncidentStoreForTests,
  __resetIncidentWriterForTests
} from '../../../../incidents/incident-writer'
import {
  declareAcceptanceRule,
  getAcceptanceStop,
  writeAcceptanceVerdict
} from '../../../../incidents/dispatch-acceptance-store'
import { gateSettlement } from '../../../../incidents/acceptance-runtime'
import { acceptanceGateState } from '../../../../incidents/dispatch-acceptance-stops'

const T0 = 1_700_000_000_000
const directories: string[] = []
const opened: OpenIncidentsDatabase[] = []
let orchestration: OrchestrationDb | undefined

function incidentsStore(): { db: Database.Database; store: IncidentStore } {
  const directory = mkdtempSync(join(tmpdir(), 'orca-federation-relay-import-'))
  directories.push(directory)
  const database = openIncidentsDatabase(join(directory, 'incidents', 'incidents.db'))
  opened.push(database)
  const store = createIncidentStore({ db: database.db, fileSizeBytes: database.fileSizeBytes })
  __configureIncidentStoreForTests(store, database.db)
  return { db: database.db, store }
}

function rootDispatch(): { db: OrchestrationDb; taskId: string; dispatchId: string } {
  orchestration = new OrchestrationDb(':memory:')
  const task = orchestration.createTask({ runId: 'run_legacy_local', spec: 'work' })
  const dispatch = createRootDispatch(orchestration, task.id, 'term_a')
  orchestration.db
    .prepare(
      `INSERT INTO federated_dispatches
         (dispatch_id, environment_id, environment_name, peer_fingerprint, to_home_imported_sequence)
       VALUES (?, 'env_1', 'peer', 'fp', 0)`
    )
    .run(dispatch.id)
  return { db: orchestration, taskId: task.id, dispatchId: dispatch.id }
}

function incidentCount(db: Database.Database, incidentClass: string): number {
  return (
    db.prepare('SELECT COUNT(*) AS n FROM incidents WHERE class = ?').get(incidentClass) as {
      n: number
    }
  ).n
}

function armBlockingRule(db: Database.Database, dispatchId: string): void {
  const rule = declareAcceptanceRule(db, {
    hostId: 'host-a',
    dispatchId,
    ruleId: 'tests',
    program: 'npm',
    args: ['test'],
    expect: { exitCode: 0 },
    cwd: '/work/tree',
    worktreeRoot: '/work',
    actor: 'alice',
    now: T0
  })
  writeAcceptanceVerdict(db, {
    dispatchId,
    ruleId: 'tests',
    verdict: 'failed',
    exitCode: 2,
    signal: null,
    stdoutDigest: null,
    stdoutBytes: 0,
    detail: 'exit_code_expected_0_got_2',
    evaluatedAt: T0,
    ruleDigest: rule.digest,
    ruleDeclaredAt: rule.createdAt
  })
}

beforeEach(() => {
  __resetIncidentWriterForTests()
})

afterEach(() => {
  __resetIncidentWriterForTests()
  orchestration?.close()
  orchestration = undefined
  for (const database of opened.splice(0)) {
    try {
      database.db.close()
    } catch {
      // Already closed.
    }
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('a federated item that cannot settle writes no acceptance evidence (F7)', () => {
  it('answers a re-delivered relay item as duplicate, with no incident and no gateSeenCount bump', () => {
    const { db, taskId, dispatchId } = rootDispatch()
    const incidents = incidentsStore()
    const importItem = (messageId: string) =>
      db.importFederatedRelayItem({
        dispatchId,
        sequence: 1,
        message: {
          id: messageId,
          runId: 'run_legacy_local',
          from: 'term_remote',
          to: 'term_coordinator',
          subject: 'Done',
          body: 'remote says done',
          type: 'worker_done',
          priority: 'normal'
        },
        lifecycle: { kind: 'worker_report', taskId, outcome: 'succeeded', result: 'ok' }
      })

    expect(importItem('relay_done').lifecycle).toMatchObject({
      action: 'settled',
      duplicate: false
    })
    // Now a rule blocks this dispatch: a second evaluation would write incident + stop.
    armBlockingRule(incidents.db, dispatchId)
    expect(acceptanceGateState(incidents.db, dispatchId).state).toBe('blocked')

    const replay = importItem('relay_done')
    expect(replay.duplicate).toBe(true)
    expect(replay.lifecycle).toMatchObject({ action: 'settled', duplicate: true })
    expect(incidentCount(incidents.db, 'acceptance_failed')).toBe(0)
    expect(getAcceptanceStop(incidents.db, dispatchId)).toBeNull()

    // Proof the fixture is armed rather than quiet: the gate does write when it is asked.
    expect(gateSettlement({ dispatchId }).verdict).toBe('blocked')
    expect(incidentCount(incidents.db, 'acceptance_failed')).toBe(1)
  })

  it('rejects an inactive federated report with no incident and no gateSeenCount bump', () => {
    const { db, taskId, dispatchId } = rootDispatch()
    const incidents = incidentsStore()
    armBlockingRule(incidents.db, dispatchId)
    expect(acceptanceGateState(incidents.db, dispatchId).state).toBe('blocked')

    // The dispatch is closed while its task is not: the settlement's answer is `inactive_dispatch`.
    db.completeDispatch(dispatchId)

    const imported = db.importFederatedRelayItem({
      dispatchId,
      sequence: 1,
      message: {
        id: 'relay_late',
        runId: 'run_legacy_local',
        from: 'term_remote',
        to: 'term_coordinator',
        subject: 'Done',
        body: 'remote says done late',
        type: 'worker_done',
        priority: 'normal'
      },
      lifecycle: { kind: 'worker_report', taskId, outcome: 'succeeded', result: 'ok' }
    })

    expect(imported.lifecycle).toMatchObject({ action: 'rejected', code: 'inactive_dispatch' })
    expect(incidentCount(incidents.db, 'acceptance_failed')).toBe(0)
    expect(getAcceptanceStop(incidents.db, dispatchId)).toBeNull()
  })

  it('writes the incident and the stop exactly once for a blocked admissible relay item', () => {
    const { db, taskId, dispatchId } = rootDispatch()
    const incidents = incidentsStore()
    armBlockingRule(incidents.db, dispatchId)
    const importItem = () =>
      db.importFederatedRelayItem({
        dispatchId,
        sequence: 1,
        message: {
          id: 'relay_done',
          runId: 'run_legacy_local',
          from: 'term_remote',
          to: 'term_coordinator',
          subject: 'Done',
          body: 'remote says done',
          type: 'worker_done',
          priority: 'normal'
        },
        lifecycle: { kind: 'worker_report', taskId, outcome: 'succeeded', result: 'ok' }
      })

    expect(importItem().lifecycle).toMatchObject({
      action: 'acceptance_pending',
      reason: 'blocked'
    })
    expect(incidentCount(incidents.db, 'acceptance_failed')).toBe(1)
    expect(getAcceptanceStop(incidents.db, dispatchId)).toMatchObject({
      state: 'pending',
      gateSeenCount: 1
    })
    expect(db.getDispatchContextById(dispatchId)?.status).toBe('dispatched')

    // The blocked item stays unread; the coordinator tick replays the same sequence once the stop is
    // resolved. That replay is admissible, so the gate is evaluated (and persists) again — the
    // counter moves, the incident key does not.
    expect(importItem().lifecycle).toMatchObject({
      action: 'acceptance_pending',
      reason: 'blocked'
    })
    expect(incidentCount(incidents.db, 'acceptance_failed')).toBe(1)
    expect(getAcceptanceStop(incidents.db, dispatchId)).toMatchObject({ gateSeenCount: 2 })
    expect(db.getDispatchContextById(dispatchId)?.status).toBe('dispatched')
  })
})

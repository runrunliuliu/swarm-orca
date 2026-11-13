/**
 * The gate point is every worker-report entry, and a store it cannot read never opens the door.
 *
 * Three claims, each one a review finding (M5 C1/C3/C4):
 *   * the in-transaction settlement refuses to settle without an `acceptance` decision, and a blocked
 *     decision returns `acceptance_pending` with the dispatch untouched;
 *   * the federation relay import and the legacy lifecycle operation — the two paths that used to call
 *     the settlement sink directly — now produce the same pending answer and keep their message unread;
 *   * a host with no declarations has NO incidents database created for it, not even by the warm path.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../runtime/orchestration/db'
import { createRootDispatch } from '../runtime/orchestration/db/root-dispatch-test-fixture'
import { setAppEnvironment, type AppEnvironment } from '../../shared/app-environment'
import { openIncidentsDatabase, type OpenIncidentsDatabase } from './incidents-database'
import { createIncidentStore } from './incident-store'
import {
  __configureIncidentStoreForTests,
  __resetIncidentWriterForTests,
  incidentRuntimeStoreIfPresent
} from './incident-writer'
import {
  declareAcceptanceRule,
  getAcceptanceStop,
  writeAcceptanceVerdict
} from './dispatch-acceptance-store'
import {
  decideWorkerReportAcceptance,
  evaluateAcceptanceForDispatch,
  gateSettlement
} from './acceptance-runtime'
import { incidentsDatabaseFileFor } from './incidents-paths'
import { initDataPath } from '../persistence/loading-store/user-data-path'

const T0 = 1_700_000_000_000
const directories: string[] = []
const opened: OpenIncidentsDatabase[] = []
let orchestration: OrchestrationDb | undefined

function incidents(): { opened: OpenIncidentsDatabase; store: ReturnType<typeof createIncidentStore> } {
  const directory = mkdtempSync(join(tmpdir(), 'orca-acceptance-entry-'))
  directories.push(directory)
  const db = openIncidentsDatabase(join(directory, 'incidents', 'incidents.db'))
  opened.push(db)
  return { opened: db, store: createIncidentStore({ db: db.db, fileSizeBytes: db.fileSizeBytes }) }
}

/** A root dispatch plus its task, as every ingestion path expects to find them. */
function rootDispatch(): { db: OrchestrationDb; taskId: string; dispatchId: string } {
  orchestration = new OrchestrationDb(':memory:')
  const task = orchestration.createTask({ runId: 'run_legacy_local', spec: 'work' })
  const dispatch = createRootDispatch(orchestration, task.id, 'term_a')
  return { db: orchestration, taskId: task.id, dispatchId: dispatch.id }
}

function declareFailedRule(db: OpenIncidentsDatabase['db'], dispatchId: string): void {
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
  for (const db of opened.splice(0)) {
    try {
      db.db.close()
    } catch {
      // Already closed.
    }
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
  setAppEnvironment(null as unknown as AppEnvironment)
})

describe('the settlement sink itself', () => {
  it('returns acceptance_pending and leaves the dispatch dispatched when blocked (C1)', () => {
    const { db, taskId, dispatchId } = rootDispatch()
    const blocked = decideWorkerReportAcceptance(dispatchId)
    // Nothing declared on this host: the regression path still allows settlement.
    expect(blocked).toEqual({ action: 'allow', via: 'no_rules' })

    db.db.exec('BEGIN IMMEDIATE')
    const settlement = db.settleWorkerReportInTransaction({
      taskId,
      dispatchId,
      outcome: 'succeeded',
      result: 'ok',
      acceptance: { action: 'blocked', reason: 'blocked', dispatchId }
    })
    db.db.exec('COMMIT')

    expect(settlement).toEqual({
      action: 'acceptance_pending',
      taskId,
      dispatchId,
      reason: 'blocked'
    })
    // The whole point: a blocked report settles nothing.
    expect(db.getDispatchContextById(dispatchId)?.status).toBe('dispatched')
    expect(db.getTask(taskId)?.status).toBe('dispatched')
  })

  it('records the store-unavailable reason separately from a rule verdict (C3)', () => {
    const { db, taskId, dispatchId } = rootDispatch()
    db.db.exec('BEGIN IMMEDIATE')
    const settlement = db.settleWorkerReportInTransaction({
      taskId,
      dispatchId,
      outcome: 'succeeded',
      result: 'ok',
      acceptance: { action: 'blocked', reason: 'store_unavailable', dispatchId }
    })
    db.db.exec('COMMIT')
    expect(settlement).toMatchObject({ action: 'acceptance_pending', reason: 'store_unavailable' })
    expect(db.getDispatchContextById(dispatchId)?.status).toBe('dispatched')
  })
})

describe('the federation relay import goes through the gate (C1)', () => {
  it('does not settle a declared dispatch whose rule failed, and keeps the message unread', () => {
    const { db, taskId, dispatchId } = rootDispatch()
    const { opened: store, store: incidentStore } = incidents()
    declareFailedRule(store.db, dispatchId)
    __configureIncidentStoreForTests(incidentStore, store.db)

    db.db
      .prepare(
        `INSERT INTO federated_dispatches
           (dispatch_id, environment_id, environment_name, peer_fingerprint, to_home_imported_sequence)
         VALUES (?, 'env_1', 'peer', 'fp', 0)`
      )
      .run(dispatchId)

    expect(gateSettlement({ dispatchId }).verdict).toBe('blocked')

    const imported = db.importFederatedRelayItem({
      dispatchId,
      sequence: 1,
      message: {
        id: 'relay_worker_done',
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

    expect(imported.lifecycle).toMatchObject({ action: 'acceptance_pending', reason: 'blocked' })
    expect(db.getDispatchContextById(dispatchId)?.status).toBe('dispatched')
    expect(db.getTask(taskId)?.status).toBe('dispatched')
    // Unread, so the coordinator tick can retry after a resolve — the imported message is the resume hook.
    expect(db.getUnreadMessages('term_coordinator').map((message) => message.id)).toContain(
      'relay_worker_done'
    )
    expect(getAcceptanceStop(store.db, dispatchId)).toMatchObject({ state: 'pending' })
  })
})

describe('an incidents store that cannot be read (C3)', () => {
  it('fails closed instead of reading as no_rules', () => {
    const userData = mkdtempSync(join(tmpdir(), 'orca-acceptance-broken-'))
    directories.push(userData)
    setAppEnvironment({
      getPath: () => userData,
      getAppPath: () => userData,
      getVersion: () => 'test',
      isPackaged: () => false,
      onWillQuit: () => undefined,
      exit: () => undefined,
      getAppMetrics: () => []
    })
    // The canonical userData path is captured once per process; refresh it to this fixture.
    initDataPath()
    __resetIncidentWriterForTests()
    // A file that exists but is not a SQLite database: the store "should exist" and cannot be read.
    const dbPath = incidentsDatabaseFileFor(userData)
    mkdirSync(join(userData, 'incidents'), { recursive: true })
    writeFileSync(dbPath, 'this is not a database\n')

    const { db, taskId, dispatchId } = rootDispatch()

    expect(gateSettlement({ dispatchId })).toMatchObject({ verdict: 'store_unavailable' })
    expect(decideWorkerReportAcceptance(dispatchId)).toEqual({
      action: 'blocked',
      reason: 'store_unavailable',
      dispatchId
    })

    db.db.exec('BEGIN IMMEDIATE')
    const settlement = db.settleWorkerReportInTransaction({
      taskId,
      dispatchId,
      outcome: 'succeeded',
      result: 'ok',
      acceptance: decideWorkerReportAcceptance(dispatchId)
    })
    db.db.exec('COMMIT')
    expect(settlement).toMatchObject({ action: 'acceptance_pending', reason: 'store_unavailable' })
    expect(db.getDispatchContextById(dispatchId)?.status).toBe('dispatched')
  })
})

describe('a host with no declarations pays nothing (C4)', () => {
  it('does not create or migrate the incidents database on the settlement path', async () => {
    const userData = mkdtempSync(join(tmpdir(), 'orca-acceptance-userdata-'))
    directories.push(userData)
    setAppEnvironment({
      getPath: (name) =>
        name === 'userData' ? userData : (() => {
          throw new Error('unused')
        })(),
      getAppPath: () => userData,
      getVersion: () => 'test',
      isPackaged: () => false,
      onWillQuit: () => undefined,
      exit: () => undefined,
      getAppMetrics: () => []
    })
    initDataPath()
    __resetIncidentWriterForTests()
    const dbPath = incidentsDatabaseFileFor(userData)
    expect(existsSync(dbPath)).toBe(false)

    const { db, dispatchId } = rootDispatch()
    // The warm path (a worker_done admission runs this) and the gate must both be side-effect free.
    const evaluation = await evaluateAcceptanceForDispatch(dispatchId)
    expect(evaluation).toMatchObject({ evaluated: 0, unavailable: false })
    expect(decideWorkerReportAcceptance(dispatchId)).toEqual({ action: 'allow', via: 'no_rules' })

    expect(existsSync(dbPath)).toBe(false)
    expect(incidentRuntimeStoreIfPresent()).toBeNull()
    expect(db.getDispatchContextById(dispatchId)?.status).toBe('dispatched')
  })
})

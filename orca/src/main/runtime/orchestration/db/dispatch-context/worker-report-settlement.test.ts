/**
 * F7: the acceptance gate's side effects belong to settlements that actually happen.
 *
 * The gate's blocked branch writes an incident and upserts the acceptance stop, which bumps
 * `gate_seen_count` — all in a second database. When it ran before the settlement's own admission
 * checks, a re-delivered `worker_done`, a stale report or an inactive dispatch wrote that evidence for
 * a settlement the settlement then refused. These tests pin the opposite: admission first, gate second,
 * and the gate's persist still unconditional once the report is admissible.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type Database from '../../../../sqlite/sync-database'
import { OrchestrationDb } from '../orchestration-db'
import { createRootDispatch } from '../root-dispatch-test-fixture'
import { openIncidentsDatabase, type OpenIncidentsDatabase } from '../../../../incidents/incidents-database'
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
import { readWorkerReportAdmission } from './worker-report-settlement'

const T0 = 1_700_000_000_000
const directories: string[] = []
const opened: OpenIncidentsDatabase[] = []
let orchestration: OrchestrationDb | undefined

/** An incidents store wired into the module-level cache, so the gate resolves it like production. */
function incidentsStore(): { db: Database.Database; store: IncidentStore } {
  const directory = mkdtempSync(join(tmpdir(), 'orca-worker-report-settlement-'))
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
  return { db: orchestration, taskId: task.id, dispatchId: dispatch.id }
}

function incidentCount(db: Database.Database, incidentClass: string): number {
  return (
    db.prepare('SELECT COUNT(*) AS n FROM incidents WHERE class = ?').get(incidentClass) as {
      n: number
    }
  ).n
}

/** A declared rule whose stored verdict is `failed`: the gate blocks, so it would write evidence. */
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

function sqliteFor(db: OrchestrationDb): Database.Database {
  return (db as unknown as { db: Database.Database }).db
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

describe('a report that cannot settle writes no acceptance evidence (F7)', () => {
  it('answers a re-delivered worker_done as duplicate, with no incident and no gateSeenCount bump', () => {
    const { db, taskId, dispatchId } = rootDispatch()
    const incidents = incidentsStore()
    expect(
      db.settleWorkerReport({ taskId, dispatchId, outcome: 'succeeded', result: 'ok' })
    ).toEqual({ action: 'settled', outcome: 'succeeded', duplicate: false })

    // The dispatch now has a blocking rule: this is the fabrication the ordering allowed — the gate
    // itself would answer "blocked" and write the incident + stop for a settlement that never happens.
    // (`acceptanceGateState` is the read-only question; asking `decideWorkerReportAcceptance` here
    // would be the very write under test.)
    armBlockingRule(incidents.db, dispatchId)
    expect(acceptanceGateState(incidents.db, dispatchId).state).toBe('blocked')

    expect(
      db.settleWorkerReport({ taskId, dispatchId, outcome: 'succeeded', result: 'ok again' })
    ).toEqual({ action: 'settled', outcome: 'succeeded', duplicate: true })

    expect(incidentCount(incidents.db, 'acceptance_failed')).toBe(0)
    expect(getAcceptanceStop(incidents.db, dispatchId)).toBeNull()

    // Proof the fixture is armed rather than merely quiet: the gate does write when it is asked.
    expect(gateSettlement({ dispatchId }).verdict).toBe('blocked')
    expect(incidentCount(incidents.db, 'acceptance_failed')).toBe(1)
    expect(getAcceptanceStop(incidents.db, dispatchId)).toMatchObject({ state: 'pending' })
  })

  it('rejects an inactive (already-closed) report with no incident and no gateSeenCount bump', () => {
    const { db, taskId, dispatchId } = rootDispatch()
    const incidents = incidentsStore()
    armBlockingRule(incidents.db, dispatchId)
    expect(acceptanceGateState(incidents.db, dispatchId).state).toBe('blocked')

    // The dispatch is closed and the task is not, so the settlement's answer is `inactive_dispatch`.
    db.completeDispatch(dispatchId)

    expect(
      db.settleWorkerReport({ taskId, dispatchId, outcome: 'succeeded', result: 'late' })
    ).toMatchObject({ action: 'rejected', code: 'inactive_dispatch' })
    expect(incidentCount(incidents.db, 'acceptance_failed')).toBe(0)
    expect(getAcceptanceStop(incidents.db, dispatchId)).toBeNull()
  })

  it('writes the incident and the stop exactly once for a blocked but admissible report', () => {
    const { db, taskId, dispatchId } = rootDispatch()
    const incidents = incidentsStore()
    armBlockingRule(incidents.db, dispatchId)

    const first = db.settleWorkerReport({
      taskId,
      dispatchId,
      outcome: 'succeeded',
      result: 'ok'
    })
    expect(first).toEqual({
      action: 'acceptance_pending',
      taskId,
      dispatchId,
      reason: 'blocked'
    })
    // Blocked never means failed: both rows keep their status so the owner can re-report.
    expect(db.getDispatchContextById(dispatchId)?.status).toBe('dispatched')
    expect(db.getTask(taskId)?.status).toBe('dispatched')
    expect(incidentCount(incidents.db, 'acceptance_failed')).toBe(1)
    expect(getAcceptanceStop(incidents.db, dispatchId)).toMatchObject({
      state: 'pending',
      incidentId: expect.any(String),
      gateSeenCount: 1
    })

    // The persist stays unconditional: a second admissible report re-reads the same stop (the counter
    // moves, the incident key does not) instead of being settled or silently dropped.
    const second = db.settleWorkerReport({
      taskId,
      dispatchId,
      outcome: 'succeeded',
      result: 'ok again'
    })
    expect(second).toEqual({
      action: 'acceptance_pending',
      taskId,
      dispatchId,
      reason: 'blocked'
    })
    expect(incidentCount(incidents.db, 'acceptance_failed')).toBe(1)
    expect(getAcceptanceStop(incidents.db, dispatchId)).toMatchObject({ gateSeenCount: 2 })
    expect(db.getDispatchContextById(dispatchId)?.status).toBe('dispatched')
  })

  it('refuses to settle an admissible report that arrives with no gate decision (fail closed)', () => {
    const { db, taskId, dispatchId } = rootDispatch()
    const statuses = {
      task: db.getTask(taskId)?.status,
      dispatch: db.getDispatchContextById(dispatchId)?.status
    }
    expect(readWorkerReportAdmission(db, { taskId, dispatchId, outcome: 'succeeded' }).verdict).toBe(
      'admitted'
    )

    db.db.exec('BEGIN IMMEDIATE')
    const settlement = db.settleWorkerReportInTransaction({
      taskId,
      dispatchId,
      outcome: 'succeeded',
      result: 'ok',
      acceptance: null,
      siblingDecisions: new Map()
    })
    db.db.exec('COMMIT')

    expect(settlement).toMatchObject({ action: 'rejected', code: 'inactive_dispatch' })
    expect(db.getTask(taskId)?.status).toBe(statuses.task)
    expect(db.getDispatchContextById(dispatchId)?.status).toBe(statuses.dispatch)
  })
})

describe('the pre-admission predicate and the transaction agree (F7)', () => {
  type Case = {
    name: string
    /** Expected rejection code, or `null` for the duplicate answer (a settlement that did happen). */
    code: string | null
    /** Pins *which* branch produced the code, so two cases cannot pass on one accident. */
    reason?: RegExp
    setup: () => { db: OrchestrationDb; taskId: string; dispatchId: string }
  }

  const cases: Case[] = [
    {
      name: 'unknown task',
      code: 'unknown_task',
      reason: /^Unknown task task_missing\.$/,
      setup: () => ({ ...rootDispatch(), taskId: 'task_missing' })
    },
    {
      name: 'unknown dispatch',
      code: 'unknown_dispatch',
      reason: /^Unknown dispatch ctx_missing\.$/,
      setup: () => ({ ...rootDispatch(), dispatchId: 'ctx_missing' })
    },
    {
      name: 'task/dispatch mismatch',
      code: 'task_dispatch_mismatch',
      reason: /^Dispatch \S+ belongs to task \S+, not \S+\.$/,
      setup: () => {
        const fixture = rootDispatch()
        const otherTask = fixture.db.createTask({ runId: 'run_legacy_local', spec: 'other' })
        return { ...fixture, taskId: otherTask.id }
      }
    },
    {
      name: 'inactive dispatch (its own row is already closed)',
      code: 'inactive_dispatch',
      reason: /^inactive dispatch \S+: it or task \S+ is already settled\.$/,
      setup: () => {
        const fixture = rootDispatch()
        fixture.db.completeDispatch(fixture.dispatchId)
        return fixture
      }
    },
    {
      name: 'inactive dispatch (a supervised sibling is still active)',
      code: 'inactive_dispatch',
      reason: /still has active supervised Dispatch/,
      setup: () => {
        const fixture = rootDispatch()
        // The report targets the context-only dispatch; a sibling worker is still starting.
        sqliteFor(fixture.db)
          .prepare("UPDATE tasks SET status = 'ready' WHERE id = ?")
          .run(fixture.taskId)
        fixture.db.createStartingWorkerDispatch({
          creator: { kind: 'system' },
          maxDepth: Number.MAX_SAFE_INTEGER,
          taskId: fixture.taskId,
          startOptions: {}
        })
        return fixture
      }
    },
    {
      name: 'stale dispatch (not the task current dispatch)',
      code: 'stale_dispatch',
      reason: /is not the current dispatch for task/,
      setup: () => {
        const fixture = rootDispatch()
        sqliteFor(fixture.db)
          .prepare("UPDATE tasks SET status = 'ready' WHERE id = ?")
          .run(fixture.taskId)
        createRootDispatch(fixture.db, fixture.taskId, 'term_current')
        sqliteFor(fixture.db)
          .prepare("UPDATE dispatch_contexts SET status = 'dispatched' WHERE id = ?")
          .run(fixture.dispatchId)
        return fixture
      }
    },
    {
      name: 'duplicate (the settlement already happened)',
      code: null,
      setup: () => {
        const fixture = rootDispatch()
        fixture.db.settleWorkerReport({
          taskId: fixture.taskId,
          dispatchId: fixture.dispatchId,
          outcome: 'succeeded',
          result: 'ok'
        })
        return fixture
      }
    }
  ]

  it.each(cases)('$name', ({ code, reason, setup }) => {
    const { db, taskId, dispatchId } = setup()
    const params = { taskId, dispatchId, outcome: 'succeeded' as const }
    const preflight = readWorkerReportAdmission(db, params)
    if (preflight.verdict === 'admitted') {
      throw new Error(`${taskId}/${dispatchId} was expected to be refused, not admitted`)
    }
    const expected = preflight.result
    if (code === null) {
      expect(expected).toEqual({ action: 'settled', outcome: 'succeeded', duplicate: true })
    } else {
      expect(expected).toMatchObject({ action: 'rejected', code })
      if (reason) {
        expect((expected as { reason: string }).reason).toMatch(reason)
      }
    }

    // The transaction re-runs the same predicate; given no decision it must return that same answer
    // instead of deciding one inside the write transaction.
    db.db.exec('BEGIN IMMEDIATE')
    const inTransaction = db.settleWorkerReportInTransaction({
      ...params,
      result: 'ok',
      acceptance: null,
      siblingDecisions: new Map()
    })
    db.db.exec('COMMIT')

    expect(inTransaction).toEqual(expected)
  })
})

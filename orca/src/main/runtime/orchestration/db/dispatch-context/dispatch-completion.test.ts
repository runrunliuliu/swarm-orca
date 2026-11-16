/**
 * The maintenance gate decides OUTSIDE the lifecycle write transaction (review F1).
 *
 * `updateTaskStatus` and `completeActiveDispatchesForTask` settle a task's active dispatches, and the
 * acceptance gate writes incidents plus an acceptance stop into a *second* database. These tests pin
 * the two facts that make that safe: the decision is taken before the transaction opens, and the
 * transaction itself never asks the gate again — it applies a precomputed map, and a dispatch the map
 * does not cover is left unsettled (never allowed) and named.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import { createRootDispatch } from '../root-dispatch-test-fixture'
import { openIncidentsDatabase, type OpenIncidentsDatabase } from '../../../../incidents/incidents-database'
import { createIncidentStore } from '../../../../incidents/incident-store'
import {
  __configureIncidentStoreForTests,
  __resetIncidentWriterForTests
} from '../../../../incidents/incident-writer'
import {
  declareAcceptanceRule,
  getAcceptanceStop,
  writeAcceptanceVerdict,
  type AcceptanceRule
} from '../../../../incidents/dispatch-acceptance-store'
import {
  precomputeActiveDispatchAcceptance,
  settleActiveDispatchesForTask
} from './dispatch-completion'

const T0 = 1_700_000_000_000

/**
 * What the mocked gate saw, and in which transaction state.
 *
 * `vi.hoisted` because the module mock is hoisted above the imports: the factory may only close over
 * this object. `db` is the orchestration connection under test, so every recorded call also says
 * whether that connection had a transaction open at that instant.
 */
const gate = vi.hoisted(() => ({
  calls: [] as { dispatchId: string; inTransaction: boolean }[],
  events: [] as string[],
  db: null as null | { isTransaction: boolean },
  afterDecide: null as null | (() => void)
}))

vi.mock('../../../../incidents/integration', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../incidents/integration')>()
  return {
    ...actual,
    decideMaintenanceAcceptance: (
      input: Parameters<typeof actual.decideMaintenanceAcceptance>[0]
    ) => {
      gate.calls.push({
        dispatchId: input.dispatchId,
        inTransaction: gate.db?.isTransaction === true
      })
      gate.events.push(`gate:${input.dispatchId}`)
      const decision = actual.decideMaintenanceAcceptance(input)
      gate.afterDecide?.()
      return decision
    }
  }
})

const directories: string[] = []
const databases: OpenIncidentsDatabase[] = []
const open: OrchestrationDb[] = []

function orchestration(): OrchestrationDb {
  const db = new OrchestrationDb(':memory:')
  open.push(db)
  return db
}

function incidents(): {
  opened: OpenIncidentsDatabase
  store: ReturnType<typeof createIncidentStore>
} {
  const directory = mkdtempSync(join(tmpdir(), 'orca-dispatch-completion-'))
  directories.push(directory)
  const opened = openIncidentsDatabase(join(directory, 'incidents', 'incidents.db'))
  databases.push(opened)
  return { opened, store: createIncidentStore({ db: opened.db, fileSizeBytes: opened.fileSizeBytes }) }
}

function declareRule(
  db: OpenIncidentsDatabase['db'],
  dispatchId: string,
  verdict: 'passed' | 'failed' | 'undeterminable' = 'failed'
): AcceptanceRule {
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
    verdict,
    exitCode: verdict === 'passed' ? 0 : 2,
    signal: null,
    stdoutDigest: 'a'.repeat(64),
    stdoutBytes: 12,
    detail: 'exit_code_expected_0_got_2',
    evaluatedAt: T0,
    ruleDigest: rule.digest,
    ruleDeclaredAt: rule.createdAt
  })
  return rule
}

/** Record the transaction boundary statements this connection executes, in order, into `gate.events`. */
function traceTransactions(db: OrchestrationDb): () => void {
  const target = db.db as { exec: (sql: string) => void }
  const original = target.exec.bind(target)
  target.exec = (sql: string) => {
    const statement = sql.trim().toUpperCase()
    if (
      statement.startsWith('BEGIN') ||
      statement.startsWith('COMMIT') ||
      statement.startsWith('ROLLBACK') ||
      statement.startsWith('SAVEPOINT') ||
      statement.startsWith('RELEASE')
    ) {
      gate.events.push(statement.split(/\s+/).slice(0, 2).join(' '))
    }
    return original(sql)
  }
  return () => {
    target.exec = original
  }
}

function fixture(): {
  db: OrchestrationDb
  taskId: string
  dispatchId: string
} {
  const db = orchestration()
  const task = db.createTask({ runId: 'run_legacy_local', spec: 'work' })
  const dispatch = createRootDispatch(db, task.id, 'term_a')
  return { db, taskId: task.id, dispatchId: dispatch.id }
}

afterEach(() => {
  gate.calls.length = 0
  gate.events.length = 0
  gate.db = null
  gate.afterDecide = null
  vi.restoreAllMocks()
  __resetIncidentWriterForTests()
  for (const db of open.splice(0)) {
    db.close()
  }
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

describe('updateTaskStatus settles maintenance dispatches from a precomputed decision', () => {
  it('decides before the transaction, writes the stop and incident, and never asks the gate inside it', () => {
    const { db, taskId, dispatchId } = fixture()
    const { opened, store } = incidents()
    declareRule(opened.db, dispatchId)
    __configureIncidentStoreForTests(store, opened.db)
    gate.db = db.db
    const restore = traceTransactions(db)

    try {
      expect(db.updateTaskStatus(taskId, 'completed')?.status).toBe('completed')
    } finally {
      restore()
    }

    // Exactly one gate call, and it was taken with no transaction open on the orchestration connection.
    expect(gate.calls).toEqual([{ dispatchId, inTransaction: false }])
    // …and it happened before the transaction even started.
    const gateEvent = gate.events.indexOf(`gate:${dispatchId}`)
    const beginEvent = gate.events.findIndex((event) => event === 'BEGIN IMMEDIATE')
    expect(gateEvent).toBeGreaterThanOrEqual(0)
    expect(beginEvent).toBeGreaterThan(gateEvent)
    // The blocked branch's side effects are visible, and blocked never means failed.
    expect(getAcceptanceStop(opened.db, dispatchId)).toMatchObject({ state: 'pending' })
    expect(store.listIncidents().incidents.map((incident) => incident.class)).toEqual([
      'acceptance_failed'
    ])
    expect(db.getDispatchContextById(dispatchId)?.status).toBe('dispatched')
  })

  it('honours --override-acceptance in the precompute instead of inside the transaction', () => {
    const { db, taskId, dispatchId } = fixture()
    const { opened, store } = incidents()
    declareRule(opened.db, dispatchId)
    __configureIncidentStoreForTests(store, opened.db)
    gate.db = db.db

    expect(
      db.updateTaskStatus(taskId, 'completed', undefined, {
        actor: 'alice',
        reason: 'hotfix deployed by hand'
      })?.status
    ).toBe('completed')

    expect(gate.calls).toEqual([{ dispatchId, inTransaction: false }])
    expect(getAcceptanceStop(opened.db, dispatchId)).toMatchObject({
      state: 'overridden',
      actor: 'alice'
    })
    expect(db.getDispatchContextById(dispatchId)?.status).toBe('completed')
    // The bypass is recorded, not silent: the audit row is its own class.
    expect(
      store
        .listIncidents()
        .incidents.some((incident) => incident.class === 'acceptance_overridden')
    ).toBe(true)
  })

  it('keeps the visible stop when the lifecycle transaction rolls back', () => {
    const { db, taskId, dispatchId } = fixture()
    const { opened, store } = incidents()
    declareRule(opened.db, dispatchId)
    __configureIncidentStoreForTests(store, opened.db)
    gate.db = db.db
    const target = db.db as { exec: (sql: string) => void }
    const original = target.exec.bind(target)
    target.exec = (sql: string) => {
      if (sql.trim().toUpperCase() === 'COMMIT') {
        throw new Error('simulated commit failure')
      }
      return original(sql)
    }

    try {
      expect(() => db.updateTaskStatus(taskId, 'completed')).toThrow('simulated commit failure')
    } finally {
      target.exec = original
    }

    // The orchestration write rolled back…
    expect(db.getTask(taskId)?.status).toBe('dispatched')
    expect(db.getDispatchContextById(dispatchId)?.status).toBe('dispatched')
    // …while the second database's evidence was never part of it.
    expect(gate.calls).toEqual([{ dispatchId, inTransaction: false }])
    expect(getAcceptanceStop(opened.db, dispatchId)).toMatchObject({ state: 'pending' })
    expect(store.listIncidents().incidents.map((incident) => incident.class)).toEqual([
      'acceptance_failed'
    ])
  })
})

describe('a dispatch that appeared after the precompute', () => {
  it('is left unsettled without being decided, and is named in the log', () => {
    const db = orchestration()
    const task = db.createTask({ runId: 'run_legacy_local', spec: 'work' })
    const earlier = createRootDispatch(db, task.id, 'term_a')
    db.failDispatch(earlier.id, 'retry me')
    const active = createRootDispatch(db, task.id, 'term_b')
    const { opened, store } = incidents()
    declareRule(opened.db, active.id)
    __configureIncidentStoreForTests(store, opened.db)
    gate.db = db.db
    // Between the decision and the transaction, the earlier dispatch becomes active again: it has no
    // precomputed decision and must therefore be left alone.
    gate.afterDecide = () => {
      db.db.prepare("UPDATE dispatch_contexts SET status = 'pending' WHERE id = ?").run(earlier.id)
    }
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    expect(db.updateTaskStatus(task.id, 'completed')?.status).toBe('completed')

    // Only the dispatch the map covers was decided; the newcomer was never asked about.
    expect(gate.calls).toEqual([{ dispatchId: active.id, inTransaction: false }])
    expect(getAcceptanceStop(opened.db, earlier.id)).toBeNull()
    // It keeps its status instead of being settled by a decision nobody took.
    expect(db.getDispatchContextById(earlier.id)?.status).toBe('pending')
    const messages = warning.mock.calls.map((call) => String(call[1]))
    expect(messages.some((message) => message.includes(earlier.id))).toBe(true)
    expect(
      messages.some((message) => message.includes('no precomputed acceptance decision'))
    ).toBe(true)
  })

  it('names it in `skipped`, the CLI-facing "not settled" signal', () => {
    const db = orchestration()
    const task = db.createTask({ runId: 'run_legacy_local', spec: 'work' })
    const earlier = createRootDispatch(db, task.id, 'term_a')
    db.failDispatch(earlier.id, 'retry me')
    const active = createRootDispatch(db, task.id, 'term_b')
    const { opened, store } = incidents()
    declareRule(opened.db, active.id)
    __configureIncidentStoreForTests(store, opened.db)
    const decisions = precomputeActiveDispatchAcceptance(db, task.id)
    db.db.prepare("UPDATE dispatch_contexts SET status = 'pending' WHERE id = ?").run(earlier.id)

    const result = settleActiveDispatchesForTask(db, task.id, 'completed', undefined, { decisions })

    expect([...result.skipped].sort()).toEqual([earlier.id, active.id].sort())
    expect(getAcceptanceStop(opened.db, earlier.id)).toBeNull()
  })
})

describe('the failed path', () => {
  it('settles without consulting acceptance at all', () => {
    const { db, taskId, dispatchId } = fixture()
    const { opened, store } = incidents()
    declareRule(opened.db, dispatchId)
    __configureIncidentStoreForTests(store, opened.db)
    gate.db = db.db

    expect(db.updateTaskStatus(taskId, 'failed', 'operator gave up')?.status).toBe('failed')

    expect(gate.calls).toEqual([])
    expect(db.getDispatchContextById(dispatchId)?.status).toBe('failed')
    expect(getAcceptanceStop(opened.db, dispatchId)).toBeNull()
    expect(store.listIncidents().incidents).toEqual([])
  })
})

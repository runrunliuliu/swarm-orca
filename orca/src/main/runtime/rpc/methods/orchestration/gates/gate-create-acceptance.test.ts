/**
 * `orchestration.gateCreate` uses the same precomputed acceptance map as the task terminal (F1).
 *
 * Opening a gate settles the task's active dispatches. The acceptance decision has to be a value taken
 * before `createGate` opens its write transaction: its blocked branch writes an incident and an
 * acceptance stop into a second database, which cannot be atomic with the orchestration writer and
 * must not extend it. The blocked case must then behave exactly like the task terminal: gate created,
 * task blocked, dispatch left unsettled, stop visible.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'
import { createRootDispatch } from '../../../../orchestration/db/root-dispatch-test-fixture'
import { openIncidentsDatabase, type OpenIncidentsDatabase } from '../../../../../incidents/incidents-database'
import { createIncidentStore } from '../../../../../incidents/incident-store'
import {
  __configureIncidentStoreForTests,
  __resetIncidentWriterForTests
} from '../../../../../incidents/incident-writer'
import {
  declareAcceptanceRule,
  getAcceptanceStop,
  writeAcceptanceVerdict
} from '../../../../../incidents/dispatch-acceptance-store'

const T0 = 1_700_000_000_000

const gate = vi.hoisted(() => ({
  calls: [] as { dispatchId: string; inTransaction: boolean }[],
  events: [] as string[],
  db: null as null | { isTransaction: boolean }
}))

vi.mock('../../../../../incidents/integration', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../../incidents/integration')>()
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
      return actual.decideMaintenanceAcceptance(input)
    }
  }
})

const directories: string[] = []
const databases: OpenIncidentsDatabase[] = []

function incidents(): {
  opened: OpenIncidentsDatabase
  store: ReturnType<typeof createIncidentStore>
} {
  const directory = mkdtempSync(join(tmpdir(), 'orca-gate-create-acceptance-'))
  directories.push(directory)
  const opened = openIncidentsDatabase(join(directory, 'incidents', 'incidents.db'))
  databases.push(opened)
  return { opened, store: createIncidentStore({ db: opened.db, fileSizeBytes: opened.fileSizeBytes }) }
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
    stdoutDigest: 'a'.repeat(64),
    stdoutBytes: 12,
    detail: 'exit_code_expected_0_got_2',
    evaluatedAt: T0,
    ruleDigest: rule.digest,
    ruleDeclaredAt: rule.createdAt
  })
}

afterEach(() => {
  gate.calls.length = 0
  gate.events.length = 0
  gate.db = null
  vi.restoreAllMocks()
  __resetIncidentWriterForTests()
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

describe('orchestration.gateCreate and a blocked maintenance dispatch', () => {
  it('decides before the gate transaction and leaves the dispatch unsettled with a visible stop', async () => {
    const h = createOrchestrationRpcHarness()
    const { db, ctx } = h.setup()
    try {
      const task = db.createTask({ spec: 'needs approval' })
      const dispatch = createRootDispatch(db, task.id, 'term_a')
      const { opened, store } = incidents()
      declareFailedRule(opened.db, dispatch.id)
      __configureIncidentStoreForTests(store, opened.db)
      gate.db = db.db
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

      let result: { gate: { id: string; status: string } }
      try {
        result = (await h.call(
          'orchestration.gateCreate',
          { task: task.id, question: 'Proceed with migration?' },
          ctx
        )) as { gate: { id: string; status: string } }
      } finally {
        target.exec = original
      }

      // The gate exists and the task is blocked, exactly as before the fix.
      expect(result.gate.id).toMatch(/^gate_/)
      expect(result.gate.status).toBe('pending')
      expect(db.getTask(task.id)?.status).toBe('blocked')
      // Blocked never means failed: the dispatch keeps its status, and the stop is the visible part.
      expect(db.getDispatchContextById(dispatch.id)?.status).toBe('dispatched')
      expect(getAcceptanceStop(opened.db, dispatch.id)).toMatchObject({ state: 'pending' })
      expect(store.listIncidents().incidents.map((incident) => incident.class)).toEqual([
        'acceptance_failed'
      ])
      // The decision came from the RPC precompute: one call, no transaction open, before the savepoint.
      expect(gate.calls).toEqual([{ dispatchId: dispatch.id, inTransaction: false }])
      const gateEvent = gate.events.indexOf(`gate:${dispatch.id}`)
      const savepointEvent = gate.events.indexOf('SAVEPOINT CREATE_GATE')
      expect(gateEvent).toBeGreaterThanOrEqual(0)
      expect(savepointEvent).toBeGreaterThan(gateEvent)
    } finally {
      h.cleanup()
    }
  })

  it('honours an operator override recorded through the same precompute', async () => {
    const h = createOrchestrationRpcHarness()
    const { db, ctx } = h.setup()
    try {
      const task = db.createTask({ spec: 'needs approval' })
      const dispatch = createRootDispatch(db, task.id, 'term_a')
      const { opened, store } = incidents()
      declareFailedRule(opened.db, dispatch.id)
      __configureIncidentStoreForTests(store, opened.db)
      gate.db = db.db

      const result = (await h.call(
        'orchestration.gateCreate',
        {
          task: task.id,
          question: 'Proceed with migration?',
          overrideAcceptance: { actor: 'alice', reason: 'checked by hand' }
        },
        ctx
      )) as { gate: { id: string; status: string } }

      expect(result.gate.status).toBe('pending')
      expect(gate.calls).toEqual([{ dispatchId: dispatch.id, inTransaction: false }])
      expect(getAcceptanceStop(opened.db, dispatch.id)).toMatchObject({
        state: 'overridden',
        actor: 'alice'
      })
      expect(db.getDispatchContextById(dispatch.id)?.status).toBe('completed')
    } finally {
      h.cleanup()
    }
  })
})

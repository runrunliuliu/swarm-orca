/**
 * A DIRECT `db.createGate` caller keeps the §8 C1 invariant without passing a map.
 *
 * `acceptanceDecisions` is optional on purpose: the RPC path (`orchestration.gateCreate`) computes the
 * map itself, while a direct caller is allowed to omit it. The contract the omission must not weaken
 * is the load-bearing one — the gate decides BEFORE `SAVEPOINT create_gate`, because its blocked branch
 * writes an incident and an acceptance stop into a second database that cannot be atomic with the
 * orchestration writer. This test pins the fallback (`precomputeActiveDispatchAcceptance`) on that
 * outside-the-transaction, before-the-savepoint path, and pins the fail-closed write side: the blocked
 * Dispatch is left unsettled with its stop visible.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as IntegrationModule from '../../../../incidents/integration'
import { OrchestrationDb } from '../orchestration-db'
import { createRootDispatch } from '../root-dispatch-test-fixture'
import {
  openIncidentsDatabase,
  type OpenIncidentsDatabase
} from '../../../../incidents/incidents-database'
import { createIncidentStore } from '../../../../incidents/incident-store'
import {
  __configureIncidentStoreForTests,
  __resetIncidentWriterForTests
} from '../../../../incidents/incident-writer'
import {
  declareAcceptanceRule,
  getAcceptanceStop,
  writeAcceptanceVerdict
} from '../../../../incidents/dispatch-acceptance-store'

const T0 = 1_700_000_000_000

const gate = vi.hoisted(() => ({
  calls: [] as { dispatchId: string; inTransaction: boolean }[],
  events: [] as string[],
  db: null as null | { isTransaction: boolean }
}))

vi.mock('../../../../incidents/integration', async (importOriginal) => {
  const actual = await importOriginal<typeof IntegrationModule>()
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
let db: OrchestrationDb | undefined

function incidents(): {
  opened: OpenIncidentsDatabase
  store: ReturnType<typeof createIncidentStore>
} {
  const directory = mkdtempSync(join(tmpdir(), 'orca-decision-gate-store-'))
  directories.push(directory)
  const opened = openIncidentsDatabase(join(directory, 'incidents', 'incidents.db'))
  databases.push(opened)
  return { opened, store: createIncidentStore({ db: opened.db, fileSizeBytes: opened.fileSizeBytes }) }
}

function declareFailedRule(
  incidentsDb: OpenIncidentsDatabase['db'],
  dispatchId: string
): void {
  const rule = declareAcceptanceRule(incidentsDb, {
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
  writeAcceptanceVerdict(incidentsDb, {
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
  __resetIncidentWriterForTests()
  db?.close()
  db = undefined
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

describe('createGate for a direct caller that omits acceptanceDecisions', () => {
  it('decides outside the transaction, before SAVEPOINT create_gate, and stays fail-closed', () => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ runId: 'run_legacy_local', spec: 'direct gate caller' })
    const dispatch = createRootDispatch(db, task.id, 'term_a')
    const { opened, store } = incidents()
    declareFailedRule(opened.db, dispatch.id)
    __configureIncidentStoreForTests(store, opened.db)
    gate.db = db.db

    const target = db.db as { exec: (sql: string) => void }
    const original = target.exec.bind(target)
    target.exec = (sql: string) => {
      const statement = sql.trim().toUpperCase()
      if (/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/.test(statement)) {
        gate.events.push(statement.split(/\s+/).slice(0, 2).join(' '))
      }
      return original(sql)
    }

    try {
      // No `acceptanceDecisions`: the fallback has to produce it.
      const created = db.createGate({ taskId: task.id, question: 'Proceed?' })
      expect(created.status).toBe('pending')
    } finally {
      target.exec = original
    }

    // One decision, taken with no transaction open, and before the savepoint that opens the gate's.
    expect(gate.calls).toEqual([{ dispatchId: dispatch.id, inTransaction: false }])
    const gateEvent = gate.events.indexOf(`gate:${dispatch.id}`)
    const savepointEvent = gate.events.indexOf('SAVEPOINT CREATE_GATE')
    expect(gateEvent).toBeGreaterThanOrEqual(0)
    expect(savepointEvent).toBeGreaterThan(gateEvent)

    // The write side is unchanged: blocked never means failed, and the stop is the visible part.
    expect(db.getTask(task.id)?.status).toBe('blocked')
    expect(db.getDispatchContextById(dispatch.id)?.status).toBe('dispatched')
    expect(getAcceptanceStop(opened.db, dispatch.id)).toMatchObject({ state: 'pending' })
  })
})

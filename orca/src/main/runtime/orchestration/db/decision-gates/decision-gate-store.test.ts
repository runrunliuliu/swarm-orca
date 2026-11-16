/**
 * A DIRECT `db.createGate` caller keeps the §8 C1 invariant without passing a map.
 *
 * `acceptanceDecisions` is optional on purpose: the RPC path (`orchestration.gateCreate`) computes the
 * map itself, while a direct caller is allowed to omit it. The contract the omission must not weaken
 * is the load-bearing one — the gate decides BEFORE `SAVEPOINT create_gate`, because its blocked branch
 * writes an incident and an acceptance stop into a second database that cannot be atomic with the
 * orchestration writer. This test pins the fallback (`precomputeActiveDispatchAcceptance`) on that
 * outside-the-transaction, before-the-gate-row path — observed from inside the decision, not from the
 * order of SQL tokens — and pins the fail-closed write side: the blocked Dispatch is left unsettled
 * with its stop visible.
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
  calls: [] as { dispatchId: string; inTransaction: boolean; gateRows: number }[],
  db: null as null | { isTransaction: boolean },
  gateRows: null as null | (() => number)
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
        inTransaction: gate.db?.isTransaction === true,
        gateRows: gate.gateRows?.() ?? -1
      })
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
  gate.db = null
  gate.gateRows = null
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
  it('decides with no transaction open and no gate row yet, and stays fail-closed', () => {
    db = new OrchestrationDb(':memory:')
    const orchestration = db
    const task = db.createTask({ runId: 'run_legacy_local', spec: 'direct gate caller' })
    const dispatch = createRootDispatch(db, task.id, 'term_a')
    const { opened, store } = incidents()
    declareFailedRule(opened.db, dispatch.id)
    __configureIncidentStoreForTests(store, opened.db)
    gate.db = orchestration.db
    // Observed from INSIDE the decision: the orchestration connection has no transaction open, and the
    // gate's own row has not been written yet. Both facts are read at that instant, not inferred from
    // the order of SQL tokens afterwards, so a refactor that inserts the row or opens the savepoint
    // first is caught here even if the final statuses still match.
    gate.gateRows = () =>
      (
        orchestration.db
          .prepare('SELECT COUNT(*) AS count FROM decision_gates WHERE task_id = ?')
          .get(task.id) as { count: number }
      ).count

    // No `acceptanceDecisions`: the fallback has to produce it.
    const { gate: created } = db.createGate({ taskId: task.id, question: 'Proceed?' })
    expect(created.status).toBe('pending')

    // One decision, taken outside the transaction and before the gate row existed.
    expect(gate.calls).toEqual([{ dispatchId: dispatch.id, inTransaction: false, gateRows: 0 }])

    // The write side is unchanged: blocked never means failed, and the stop is the visible part.
    expect(db.getTask(task.id)?.status).toBe('blocked')
    expect(db.getDispatchContextById(dispatch.id)?.status).toBe('dispatched')
    expect(getAcceptanceStop(opened.db, dispatch.id)).toMatchObject({ state: 'pending' })
  })
})

/**
 * B-F10: `createGate` reports the settlement helper's own `skipped` ids.
 *
 * `gate-create` settles the Task's active Dispatches and used to be silent about the ones it left open,
 * while `task-update` printed a separately queried list. Both now carry the same answer.
 */
describe('createGate returns the settlement answer', () => {
  it('names the blocked dispatch by exact id', () => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ runId: 'run_legacy_local', spec: 'gate over a blocked dispatch' })
    const dispatch = createRootDispatch(db, task.id, 'term_a')
    const { opened, store } = incidents()
    declareFailedRule(opened.db, dispatch.id)
    __configureIncidentStoreForTests(store, opened.db)

    const created = db.createGate({ taskId: task.id, question: 'Proceed?' })

    expect(created.gate.status).toBe('pending')
    expect(created.skipped).toEqual([dispatch.id])
    expect(db.getTask(task.id)?.status).toBe('blocked')
    expect(db.getDispatchContextById(dispatch.id)?.status).toBe('dispatched')
  })

  it('omits the key entirely on a clean settle', () => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ runId: 'run_legacy_local', spec: 'gate with nothing active' })

    const created = db.createGate({ taskId: task.id, question: 'Proceed?' })

    expect(created.gate.status).toBe('pending')
    expect(created.skipped).toEqual([])
  })
})

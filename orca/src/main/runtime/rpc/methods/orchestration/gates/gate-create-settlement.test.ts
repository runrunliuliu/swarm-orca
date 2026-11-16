/**
 * B-F10: `orchestration.gateCreate` reports the same settlement answer `taskUpdate` does.
 *
 * Opening a gate settles the Task's active Dispatches, so it can leave one unsettled for exactly the
 * same reasons. It was silent about them (`{ gate }` only) while `task-update` printed a separately
 * queried list; both now carry the settlement helper's own `skipped` ids.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'
import { createRootDispatch } from '../../../../orchestration/db/root-dispatch-test-fixture'
import {
  openIncidentsDatabase,
  type OpenIncidentsDatabase
} from '../../../../../incidents/incidents-database'
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

const directories: string[] = []
const databases: OpenIncidentsDatabase[] = []

function incidents(): {
  opened: OpenIncidentsDatabase
  store: ReturnType<typeof createIncidentStore>
} {
  const directory = mkdtempSync(join(tmpdir(), 'orca-gate-create-settlement-'))
  directories.push(directory)
  const opened = openIncidentsDatabase(join(directory, 'incidents', 'incidents.db'))
  databases.push(opened)
  return {
    opened,
    store: createIncidentStore({ db: opened.db, fileSizeBytes: opened.fileSizeBytes })
  }
}

function declareRule(
  db: OpenIncidentsDatabase['db'],
  dispatchId: string,
  verdict: 'passed' | 'failed'
): void {
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
    detail: verdict === 'passed' ? 'ok' : 'exit_code_expected_0_got_2',
    evaluatedAt: T0,
    ruleDigest: rule.digest,
    ruleDeclaredAt: rule.createdAt
  })
}

afterEach(() => {
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

describe('orchestration.gateCreate and the settlement answer', () => {
  it('names the blocked sibling by exact id in skippedAcceptance', async () => {
    const h = createOrchestrationRpcHarness()
    const { db, ctx } = h.setup()
    try {
      const task = db.createTask({ spec: 'needs approval' })
      const dispatch = createRootDispatch(db, task.id, 'term_a')
      const { opened, store } = incidents()
      declareRule(opened.db, dispatch.id, 'failed')
      __configureIncidentStoreForTests(store, opened.db)

      const result = (await h.call(
        'orchestration.gateCreate',
        { task: task.id, question: 'Proceed with migration?' },
        ctx
      )) as { gate: { id: string; status: string }; skippedAcceptance?: string[] }

      expect(result.gate.id).toMatch(/^gate_/)
      expect(result.gate.status).toBe('pending')
      expect(result.skippedAcceptance).toEqual([dispatch.id])
      expect(getAcceptanceStop(opened.db, dispatch.id)).toMatchObject({ state: 'pending' })
    } finally {
      h.cleanup()
    }
  })

  it('omits skippedAcceptance when the gate settles the dispatch', async () => {
    const h = createOrchestrationRpcHarness()
    const { db, ctx } = h.setup()
    try {
      const task = db.createTask({ spec: 'needs approval' })
      const dispatch = createRootDispatch(db, task.id, 'term_a')
      const { opened, store } = incidents()
      declareRule(opened.db, dispatch.id, 'passed')
      __configureIncidentStoreForTests(store, opened.db)

      const result = (await h.call(
        'orchestration.gateCreate',
        { task: task.id, question: 'Proceed with migration?' },
        ctx
      )) as { gate: { status: string }; skippedAcceptance?: string[] }

      expect(result.gate.status).toBe('pending')
      expect(result.skippedAcceptance).toBeUndefined()
      expect(db.getDispatchContextById(dispatch.id)?.status).toBe('completed')
    } finally {
      h.cleanup()
    }
  })
})

/**
 * B-F10: `orchestration.taskUpdate` reports the settlement helper's exact `skipped` ids.
 *
 * The result used to be built from a second hand-written query ("which dispatches are still active after
 * the mutation"). That is a different question from "which dispatches did this settlement leave
 * unsettled", and two definitions of one operator-facing fact drift. These tests pin the answer to the
 * settlement decision itself and pin the absence of the second query's tell-tale: a dispatch that was
 * never part of this settlement cannot appear.
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
  const directory = mkdtempSync(join(tmpdir(), 'orca-task-update-settlement-'))
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

describe('orchestration.taskUpdate and the settlement answer', () => {
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
        'orchestration.taskUpdate',
        { id: task.id, status: 'completed' },
        ctx
      )) as { task: { id: string; status: string }; skippedAcceptance?: string[] }

      expect(result.task).toMatchObject({ id: task.id, status: 'completed' })
      expect(result.skippedAcceptance).toEqual([dispatch.id])
      // The fail-closed stop is what makes the id actionable, not just visible.
      expect(getAcceptanceStop(opened.db, dispatch.id)).toMatchObject({ state: 'pending' })
    } finally {
      h.cleanup()
    }
  })

  it('omits skippedAcceptance on a clean settle', async () => {
    const h = createOrchestrationRpcHarness()
    const { db, ctx } = h.setup()
    try {
      const task = db.createTask({ spec: 'needs approval' })
      const dispatch = createRootDispatch(db, task.id, 'term_a')
      const { opened, store } = incidents()
      declareRule(opened.db, dispatch.id, 'passed')
      __configureIncidentStoreForTests(store, opened.db)

      const result = (await h.call(
        'orchestration.taskUpdate',
        { id: task.id, status: 'completed' },
        ctx
      )) as { task: { status: string }; skippedAcceptance?: string[] }

      expect(result.task.status).toBe('completed')
      expect(result.skippedAcceptance).toBeUndefined()
      expect(db.getDispatchContextById(dispatch.id)?.status).toBe('completed')
    } finally {
      h.cleanup()
    }
  })

  it('does not report an inactive dispatch that this transition never touched', async () => {
    const h = createOrchestrationRpcHarness()
    const { db, ctx } = h.setup()
    try {
      const task = db.createTask({ spec: 'needs approval' })
      const earlier = createRootDispatch(db, task.id, 'term_a')
      db.failDispatch(earlier.id, 'retry me')
      const active = createRootDispatch(db, task.id, 'term_b')
      const { opened, store } = incidents()
      declareRule(opened.db, active.id, 'failed')
      __configureIncidentStoreForTests(store, opened.db)

      const result = (await h.call(
        'orchestration.taskUpdate',
        { id: task.id, status: 'completed' },
        ctx
      )) as { skippedAcceptance?: string[] }

      // Only the settlement's own answer: the failed attempt is inactive, so it is not "left unsettled".
      expect(result.skippedAcceptance).toEqual([active.id])
    } finally {
      h.cleanup()
    }
  })
})

/**
 * C2: every consumer of an unread worker_done must leave an acceptance-blocked one unread.
 *
 * The coordinator had a keep-set; `orchestration.check` did not, so the very first check consumed the
 * message that `acceptance resolve --accept` needed in order to resume settlement. This test drives the
 * real `checkDirectMailbox` with a declared, failing rule and asserts the message is still unread AND
 * the dispatch is still dispatched.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../../../../orchestration/db'
import { createRootDispatch } from '../../../../orchestration/db/root-dispatch-test-fixture'
import { checkDirectMailbox } from './check-direct'
import { openIncidentsDatabase, type OpenIncidentsDatabase } from '../../../../../incidents/incidents-database'
import { createIncidentStore } from '../../../../../incidents/incident-store'
import {
  __configureIncidentStoreForTests,
  __resetIncidentWriterForTests
} from '../../../../../incidents/incident-writer'
import {
  declareAcceptanceRule,
  writeAcceptanceVerdict
} from '../../../../../incidents/dispatch-acceptance-store'

const T0 = 1_700_000_000_000
const directories: string[] = []
const opened: OpenIncidentsDatabase[] = []
let orchestration: OrchestrationDb | undefined

function incidents(): { db: OpenIncidentsDatabase; store: ReturnType<typeof createIncidentStore> } {
  const directory = mkdtempSync(join(tmpdir(), 'orca-check-acceptance-'))
  directories.push(directory)
  const db = openIncidentsDatabase(join(directory, 'incidents', 'incidents.db'))
  opened.push(db)
  return { db, store: createIncidentStore({ db: db.db, fileSizeBytes: db.fileSizeBytes }) }
}

function fixture(declareRule: boolean): {
  db: OrchestrationDb
  taskId: string
  dispatchId: string
  mailbox: string
} {
  orchestration = new OrchestrationDb(':memory:')
  // A real Run, not the legacy adoption: `check` refuses to acknowledge legacy mail by design.
  const run = orchestration.createRun({
    objective: 'acceptance check',
    coordinatorHandle: 'term_coordinator',
    coordinatorPaneKey: 'tab_c:22222222-2222-4222-9222-222222222222'
  })
  const task = orchestration.createTask({ runId: run.id, spec: 'work' })
  const dispatch = createRootDispatch(orchestration, task.id, 'term_a')
  orchestration.insertMessage({
    runId: run.id,
    from: 'term_a',
    to: 'term_coordinator',
    subject: 'Done',
    type: 'worker_done',
    payload: JSON.stringify({ taskId: task.id, dispatchId: dispatch.id, outcome: 'succeeded' })
  })
  if (declareRule) {
    const { db: storeDb, store } = incidents()
    const rule = declareAcceptanceRule(storeDb.db, {
      hostId: 'host-a',
      dispatchId: dispatch.id,
      ruleId: 'tests',
      program: 'npm',
      expect: { exitCode: 0 },
      cwd: '/work/tree',
      worktreeRoot: '/work',
      actor: 'alice',
      now: T0
    })
    writeAcceptanceVerdict(storeDb.db, {
      dispatchId: dispatch.id,
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
    __configureIncidentStoreForTests(store, storeDb.db)
  } else {
    __configureIncidentStoreForTests(null)
  }
  // A Run-scoped message is delivered to the Run mailbox, which is the handle `check` resolves for a
  // run consumer — reading the terminal handle would find nothing and the test would prove nothing.
  return { db: orchestration, taskId: task.id, dispatchId: dispatch.id, mailbox: `run:${run.id}` }
}

const runtime = {
  waitForMessage: async () => 'timeout'
} as unknown as Parameters<typeof checkDirectMailbox>[0]['runtime']

async function check(db: OrchestrationDb, mailbox: string): Promise<void> {
  await checkDirectMailbox({
    params: { unread: true },
    runtime,
    db,
    handle: mailbox,
    typeFilter: undefined,
    signal: undefined
  } as unknown as Parameters<typeof checkDirectMailbox>[0])
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
})

describe('orchestration.check with an acceptance-blocked worker_done', () => {
  it('keeps the message unread so a later resolve can resume settlement', async () => {
    const { db, dispatchId, mailbox } = fixture(true)
    await check(db, mailbox)
    expect(db.getDispatchContextById(dispatchId)?.status).toBe('dispatched')
    // The resume hook survives the check: this is the regression the review found.
    expect(db.getUnreadMessages(mailbox).map((message) => message.type)).toEqual(['worker_done'])
  })

  it('marks a worker_done with no declaration read, exactly as before (regression)', async () => {
    const { db, dispatchId, mailbox } = fixture(false)
    await check(db, mailbox)
    expect(db.getUnreadMessages(mailbox)).toEqual([])
    expect(db.getDispatchContextById(dispatchId)?.status).toBe('completed')
  })
})

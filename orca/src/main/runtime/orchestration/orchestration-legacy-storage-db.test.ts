import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from '../../sqlite/sync-database'
import {
  CURRENT_CONTRACT_VERSION,
  LEGACY_CONTRACT_VERSION,
  LEGACY_RUN_ID,
  OrchestrationDb
} from './db'
import { openIncidentsDatabase, type OpenIncidentsDatabase } from '../../incidents/incidents-database'
import { createIncidentStore } from '../../incidents/incident-store'
import {
  __configureIncidentStoreForTests,
  __resetIncidentWriterForTests
} from '../../incidents/incident-writer'
import {
  declareAcceptanceRule,
  getAcceptanceStop,
  writeAcceptanceVerdict
} from '../../incidents/dispatch-acceptance-store'
import { createRootDispatch } from './db/root-dispatch-test-fixture'
import {
  createLegacyStorageCutoverFixture,
  type LegacyStorageCutoverFixture
} from './orchestration-legacy-storage-test-fixture'

describe('OrchestrationDb legacy contract storage', () => {
  let db: OrchestrationDb | undefined
  let tempDir: string | undefined
  const incidentDatabases: OpenIncidentsDatabase[] = []
  const incidentDirectories: string[] = []

  afterEach(() => {
    db?.close()
    db = undefined
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
      tempDir = undefined
    }
    __resetIncidentWriterForTests()
    vi.restoreAllMocks()
    for (const opened of incidentDatabases.splice(0)) {
      try {
        opened.db.close()
      } catch {
        // Already closed.
      }
    }
    for (const directory of incidentDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  function createCutoverFixture(): LegacyStorageCutoverFixture {
    const created = createLegacyStorageCutoverFixture()
    tempDir = created.tempDir
    return created.fixture
  }

  function openAdoptedFixture(): {
    fixture: LegacyStorageCutoverFixture
    adoptedRunId: string
    workerPrincipalId: string
    coordinatorPrincipalId: string
  } {
    const fixture = createCutoverFixture()
    db = new OrchestrationDb(fixture.dbPath)
    const adoptedRunId = db.getLegacyAdoption()?.adopted_run_id as string
    const worker = db.commitLegacyCompatibilityPrincipal({
      runId: adoptedRunId,
      dispatchId: fixture.legacyDispatchId,
      role: 'worker',
      hostScope: 'local:runtime_1',
      terminalHandle: 'term_legacy_worker',
      paneKey: 'tab_legacy:33333333-3333-4333-8333-333333333333',
      launchTokenHash: 'legacy_launch_hash',
      processIncarnation: 'process_1'
    })
    const coordinator = db.commitLegacyCompatibilityPrincipal({
      runId: adoptedRunId,
      role: 'coordinator',
      hostScope: 'local:runtime_1',
      terminalHandle: 'term_legacy_coord',
      paneKey: 'tab_coord:44444444-4444-4444-8444-444444444444',
      launchTokenHash: 'coord_launch_hash',
      processIncarnation: 'process_coord'
    })
    return {
      fixture,
      adoptedRunId,
      workerPrincipalId: worker.principal.id,
      coordinatorPrincipalId: coordinator.principal.id
    }
  }

  /** A real incidents store in the process-global slot `decideWorkerReportAcceptance` resolves. */
  function openIncidents(): {
    opened: OpenIncidentsDatabase
    store: ReturnType<typeof createIncidentStore>
  } {
    const directory = mkdtempSync(join(tmpdir(), 'orca-legacy-acceptance-'))
    incidentDirectories.push(directory)
    const opened = openIncidentsDatabase(join(directory, 'incidents', 'incidents.db'))
    incidentDatabases.push(opened)
    const store = createIncidentStore({ db: opened.db, fileSizeBytes: opened.fileSizeBytes })
    __configureIncidentStoreForTests(store, opened.db)
    return { opened, store }
  }

  /** One rule whose stored verdict fails, so a gate call on this dispatch would block and write. */
  function declareFailedRule(incidentsDb: OpenIncidentsDatabase['db'], dispatchId: string): void {
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
      now: 1_700_000_000_000
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
      evaluatedAt: 1_700_000_000_000,
      ruleDigest: rule.digest,
      ruleDeclaredAt: rule.createdAt
    })
  }

  /**
   * A legacy Task with two active Dispatches: an older context-only sibling and the reporting one,
   * created last so it is the current Dispatch, plus a third that is completed up front so a test can
   * make it reappear after the acceptance preflight.
   *
   * `createDispatchContext` only accepts a `ready` Task, which the lifecycle guard tests also work
   * around: opening a Dispatch flips the Task to `dispatched`, so the intervening ones are opened by
   * resetting the Task first. The three Dispatches are then marked as legacy attempts (the cutover
   * fixture's rows are legacy because they predate it; freshly created ones are current-contract) so
   * `commitLegacyLifecycleOperation` and `commitLegacyCompatibilityPrincipal` accept them.
   */
  function createLegacySiblingSplit(spec: string): {
    adoptedRunId: string
    principalId: string
    taskId: string
    siblingDispatchId: string
    lateDispatchId: string
    reportingDispatchId: string
  } {
    const state = openAdoptedFixture()
    const sqlite = (db as unknown as { db: Database.Database }).db
    const forceReady = (taskId: string): void => {
      sqlite.prepare("UPDATE tasks SET status = 'ready' WHERE id = ?").run(taskId)
    }
    const task = db!.createTask({ runId: state.adoptedRunId, spec })
    const sibling = createRootDispatch(db!, task.id, 'term_sibling')
    forceReady(task.id)
    const late = createRootDispatch(db!, task.id, 'term_late')
    db!.completeDispatch(late.id)
    forceReady(task.id)
    const reporting = createRootDispatch(db!, task.id, 'term_reporter')
    sqlite
      .prepare('UPDATE dispatch_contexts SET contract_version = ? WHERE id IN (?, ?, ?)')
      .run(LEGACY_CONTRACT_VERSION, sibling.id, late.id, reporting.id)
    const principal = db!.commitLegacyCompatibilityPrincipal({
      runId: state.adoptedRunId,
      dispatchId: reporting.id,
      role: 'worker',
      hostScope: 'local:runtime_1',
      terminalHandle: 'term_reporter',
      paneKey: 'tab_reporter:55555555-5555-4555-8555-555555555555',
      launchTokenHash: 'reporter_launch_hash',
      processIncarnation: 'process_reporter'
    })
    return {
      adoptedRunId: state.adoptedRunId,
      principalId: principal.principal.id,
      taskId: task.id,
      siblingDispatchId: sibling.id,
      lateDispatchId: late.id,
      reportingDispatchId: reporting.id
    }
  }

  it('atomically rehomes the full graph, fences legacy Delivery, and preserves current rows', () => {
    const fixture = createCutoverFixture()
    db = new OrchestrationDb(fixture.dbPath)
    const adoption = db.getLegacyAdoption()
    const adoptedRunId = adoption?.adopted_run_id as string
    const sqlite = (db as unknown as { db: Database.Database }).db

    expect(adoption).toMatchObject({
      source_run_id: LEGACY_RUN_ID,
      scheduler_state_lost: 1
    })
    expect(db.getRun(adoptedRunId)).toMatchObject({ legacy: 0, consumer_generation: 0 })
    expect(db.getRunMailboxOwnerIdsForHandle('term_legacy_coord')).toEqual([adoptedRunId])
    expect(db.getRunMailboxOwnerIdsForHandle('term_invented')).toEqual([])
    expect(db.listTasks({ runId: LEGACY_RUN_ID })).toEqual([])
    expect(db.getDispatchContextById(fixture.legacyDispatchId)).toMatchObject({
      run_id: adoptedRunId,
      contract_version: LEGACY_CONTRACT_VERSION,
      launch_token_hash: null
    })
    expect(db.getGate(fixture.legacyGateId)).toMatchObject({ run_id: adoptedRunId })
    expect(db.getQuestion(fixture.legacyQuestionId)).toMatchObject({ run_id: adoptedRunId })
    expect(db.getMessageById(fixture.legacyMessageIds[0])).toMatchObject({
      run_id: adoptedRunId,
      delivery_contract: 'legacy_direct'
    })
    expect(db.getMessageById(fixture.rejectionMessageId)).toMatchObject({
      run_id: adoptedRunId,
      delivery_contract: 'audit_only'
    })
    expect(db.getMessageById(fixture.lookalikeMessageId)).toMatchObject({
      run_id: adoptedRunId,
      delivery_contract: 'legacy_direct'
    })
    for (const messageId of fixture.malformedRejectionMessageIds) {
      expect(db.getMessageById(messageId)).toMatchObject({
        run_id: adoptedRunId,
        delivery_contract: 'legacy_direct'
      })
    }
    expect(
      sqlite.prepare('SELECT * FROM deliveries WHERE id = ?').get(fixture.legacyDeliveryId)
    ).toMatchObject({
      run_id: adoptedRunId,
      mailbox_handle: `run:${LEGACY_RUN_ID}`,
      status: 'fenced'
    })
    expect(db.getDispatchContextById(fixture.currentDispatchId)).toMatchObject({
      run_id: fixture.currentRunId,
      contract_version: CURRENT_CONTRACT_VERSION,
      launch_token_hash: 'current_launch_hash'
    })

    db.close()
    const partial = new Database(fixture.dbPath)
    partial
      .prepare('UPDATE tasks SET run_id = ? WHERE id = ?')
      .run(LEGACY_RUN_ID, fixture.legacyTaskId)
    partial.pragma('user_version = 19')
    partial.close()
    db = new OrchestrationDb(fixture.dbPath)
    expect(db.getLegacyAdoption()?.adopted_run_id).toBe(adoptedRunId)
    expect(db.getTask(fixture.legacyTaskId)?.run_id).toBe(adoptedRunId)
    expect(db.getDispatchContextById(fixture.currentDispatchId)?.contract_version).toBe(
      CURRENT_CONTRACT_VERSION
    )
    expect(db.listTasks({ runId: LEGACY_RUN_ID })).toEqual([])
  })

  it('ignores unrelated cross-Run anomalies while validating adopted rows', () => {
    const fixture = createCutoverFixture()
    const raw = new Database(fixture.dbPath)
    raw
      .prepare('UPDATE dispatch_contexts SET run_id = ? WHERE id = ?')
      .run(fixture.unrelatedRunId, fixture.currentDispatchId)
    raw.close()

    db = new OrchestrationDb(fixture.dbPath)

    expect(db.getLegacyAdoption()).toBeDefined()
    expect(db.getDispatchContextById(fixture.currentDispatchId)?.run_id).toBe(
      fixture.unrelatedRunId
    )
  })

  it('fails closed when an adopted coordinator handle becomes a current-contract worker', () => {
    const state = openAdoptedFixture()
    expect(db!.getRunMailboxOwnerIdsForHandle('term_legacy_coord')).toEqual([state.adoptedRunId])
    const task = db!.createTask({
      runId: state.adoptedRunId,
      spec: 'mixed contract worker identity',
      createdByTerminalHandle: 'term_legacy_coord'
    })

    const dispatch = db!.createDispatchContext({
      taskId: task.id,
      assigneeHandle: 'term_legacy_coord',
      assigneePaneKey: 'tab_mixed:leaf_mixed',
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER
    })

    expect(dispatch.contract_version).toBe(CURRENT_CONTRACT_VERSION)
    expect(db!.getRunMailboxOwnerIdsForHandle('term_legacy_coord')).toEqual([])
  })

  it('does not synthesize an adopted Run or compatibility authority for a fresh database', () => {
    db = new OrchestrationDb(':memory:')

    expect(db.getLegacyAdoption()).toBeUndefined()
    expect(db.listLegacyCompatibilityPrincipals(LEGACY_RUN_ID)).toEqual([])
    expect(db.listRuns().runs).toEqual([expect.objectContaining({ id: LEGACY_RUN_ID, legacy: 1 })])
  })

  it('keeps current Delivery disjoint from adopted direct and audit-only mail', () => {
    const state = openAdoptedFixture()
    const run = db!.getRun(state.adoptedRunId) as NonNullable<ReturnType<OrchestrationDb['getRun']>>
    db!.insertMessage({
      runId: state.adoptedRunId,
      from: 'current_worker',
      to: `run:${state.adoptedRunId}`,
      subject: 'current retry mail'
    })

    const delivery = db!.getOrCreateRunDelivery({
      runId: state.adoptedRunId,
      consumerGeneration: run.consumer_generation
    })

    expect(delivery?.messages.map((message) => message.subject)).toEqual(['current retry mail'])
  })

  it('drains a durable recovery cohort in bounded replaying pages before unread mail', () => {
    const state = openAdoptedFixture()
    const first = db!.getLegacyMailPage({ principalId: state.workerPrincipalId, limit: 1 })
    const replay = db!.getLegacyMailPage({ principalId: state.workerPrincipalId, limit: 1 })

    expect(first.recovery).toBe(true)
    expect(replay.messages.map((message) => message.id)).toEqual(
      first.messages.map((message) => message.id)
    )
    expect(() =>
      db!.acknowledgeLegacyMail({
        principalId: state.workerPrincipalId,
        messageIds: [state.fixture.legacyMessageIds[2]]
      })
    ).toThrow(/current replay page/)
    db!.acknowledgeLegacyMail({
      principalId: state.workerPrincipalId,
      messageIds: first.messages.map((message) => message.id)
    })
    const second = db!.getLegacyMailPage({ principalId: state.workerPrincipalId, limit: 1 })
    expect(second.recovery).toBe(true)
    expect(second.messages[0].id).not.toBe(first.messages[0].id)
    db!.acknowledgeLegacyMail({
      principalId: state.workerPrincipalId,
      messageIds: second.messages.map((message) => message.id)
    })
    expect(db!.getLegacyMailPage({ principalId: state.workerPrincipalId, limit: 1 }).recovery).toBe(
      false
    )
  })

  it('returns complete addressed legacy history without changing read state', () => {
    const state = openAdoptedFixture()
    const unread = db!.insertMessage({
      runId: state.adoptedRunId,
      deliveryContract: 'legacy_direct',
      from: 'term_legacy_coord',
      to: 'term_legacy_worker',
      subject: 'unread history'
    })
    db!.insertMessage({
      runId: state.adoptedRunId,
      deliveryContract: 'legacy_direct',
      from: 'other',
      to: 'other',
      subject: 'not addressed'
    })

    const history = db!.getLegacyMailHistory({ principalId: state.workerPrincipalId })

    expect(history.recovery).toBe(false)
    expect(history.messages.map((message) => message.subject)).toEqual([
      'read worker mail',
      'second worker page',
      'unread history'
    ])
    expect(db!.getMessageById(unread.id)?.read).toBe(0)
  })

  it('resolves legacy principals and completion evidence only within exact assignments', () => {
    const state = openAdoptedFixture()
    const taskId = db!.getDispatchContextById(state.fixture.legacyDispatchId)!.task_id
    const payload = JSON.stringify({ taskId, dispatchId: state.fixture.legacyDispatchId })
    const completion = db!.insertMessage({
      runId: state.adoptedRunId,
      deliveryContract: 'legacy_direct',
      from: 'term_legacy_worker',
      to: 'term_legacy_coord',
      subject: 'Completed',
      body: 'done',
      type: 'worker_done',
      payload
    })

    expect(
      db!.resolveLegacyWorkerCandidate({
        runId: state.adoptedRunId,
        terminalHandle: 'term_legacy_worker',
        paneKey: 'tab_reminted:33333333-3333-4333-8333-333333333333',
        taskId
      })
    ).toMatchObject({ dispatch: { id: state.fixture.legacyDispatchId } })
    expect(
      db!.resolveLegacyWorkerCandidate({
        runId: state.adoptedRunId,
        terminalHandle: 'term_legacy_worker',
        paneKey: 'tab_wrong:99999999-9999-4999-8999-999999999999',
        taskId
      })
    ).toBeUndefined()
    expect(
      db!.resolveLegacyCoordinatorCandidate({
        runId: state.adoptedRunId,
        terminalHandle: 'term_legacy_coord',
        paneKey: 'tab_coord:44444444-4444-4444-8444-444444444444'
      })
    ).toMatchObject({ terminalHandle: 'term_legacy_coord' })
    expect(
      db!.findLegacyWorkerCompletion({
        principalId: state.workerPrincipalId,
        taskId,
        recipientHandle: 'term_legacy_coord',
        subject: 'Completed',
        body: 'done',
        payload
      })
    ).toMatchObject({ id: completion.id })
  })

  it('prevents an unproven coordinator from taking over an active adopted Run', () => {
    const state = openAdoptedFixture()
    expect(() =>
      db!.bindRun({
        runId: state.adoptedRunId,
        coordinatorHandle: 'term_other',
        coordinatorPaneKey: 'tab_other:55555555-5555-4555-8555-555555555555'
      })
    ).toThrow(/attested coordinator may rebind/)

    const bound = db!.bindRun({
      runId: state.adoptedRunId,
      coordinatorHandle: 'term_legacy_coord',
      coordinatorPaneKey: 'tab_coord:44444444-4444-4444-8444-444444444444',
      legacyCoordinatorAuthority: {
        runId: state.adoptedRunId,
        principalId: state.coordinatorPrincipalId,
        terminalHandle: 'term_legacy_coord',
        paneKey: 'tab_coord:44444444-4444-4444-8444-444444444444',
        consumerGeneration: 0
      }
    })
    expect(bound).toMatchObject({ coordinator_handle: 'term_legacy_coord' })
    expect(
      db!.bindRun({
        runId: state.adoptedRunId,
        coordinatorHandle: 'term_legacy_coord',
        coordinatorPaneKey: 'tab_coord:44444444-4444-4444-8444-444444444444'
      })
    ).toMatchObject({ coordinator_handle: 'term_legacy_coord' })
  })

  it.each([
    ['generation', { consumerGeneration: 1 }],
    ['principal', { principalId: 'legacy_principal_wrong' }],
    ['handle', { terminalHandle: 'term_wrong' }],
    ['pane', { paneKey: 'tab_wrong:99999999-9999-4999-8999-999999999999' }]
  ] as const)('rejects stale legacy coordinator %s proof inside Run binding', (_label, patch) => {
    const state = openAdoptedFixture()
    const before = db!.getRun(state.adoptedRunId)

    expect(() =>
      db!.bindRun({
        runId: state.adoptedRunId,
        coordinatorHandle: 'term_legacy_coord',
        coordinatorPaneKey: 'tab_coord:44444444-4444-4444-8444-444444444444',
        legacyCoordinatorAuthority: {
          runId: state.adoptedRunId,
          principalId: state.coordinatorPrincipalId,
          terminalHandle: 'term_legacy_coord',
          paneKey: 'tab_coord:44444444-4444-4444-8444-444444444444',
          consumerGeneration: 0,
          ...patch
        }
      })
    ).toThrow(/no longer has lifecycle authority/)
    expect(db!.getRun(state.adoptedRunId)).toEqual(before)
  })

  it('revokes the legacy coordinator when a current coordinator takes over after settlement', () => {
    const state = openAdoptedFixture()
    db!.settleWorkerReport({
      taskId: state.fixture.legacyTaskId,
      dispatchId: state.fixture.legacyDispatchId,
      outcome: 'succeeded',
      result: 'done'
    })

    expect(
      db!.bindRun({
        runId: state.adoptedRunId,
        coordinatorHandle: 'term_current_coord',
        coordinatorPaneKey: 'tab_current:11111111-1111-4111-8111-111111111111'
      })
    ).toMatchObject({ coordinator_handle: 'term_current_coord' })
    expect(db!.getLegacyCompatibilityPrincipal(state.coordinatorPrincipalId)?.status).toBe(
      'revoked'
    )
    expect(() =>
      db!.commitLegacyCompatibilityPrincipal({
        runId: state.adoptedRunId,
        role: 'coordinator',
        hostScope: 'local:runtime_1',
        terminalHandle: 'term_legacy_coord',
        paneKey: 'tab_coord:44444444-4444-4444-8444-444444444444',
        launchTokenHash: 'coord_launch_hash',
        processIncarnation: 'process_coord'
      })
    ).toThrow(/revoked/)
  })

  it('promotes only mail addressed to the replaced legacy coordinator', () => {
    const state = openAdoptedFixture()
    const coordinatorMail = db!.insertMessage({
      runId: state.adoptedRunId,
      deliveryContract: 'legacy_direct',
      from: 'term_legacy_worker',
      to: 'term_legacy_coord',
      subject: 'coordinator outcome'
    })
    const workerMail = db!.insertMessage({
      runId: state.adoptedRunId,
      deliveryContract: 'legacy_direct',
      from: 'term_legacy_worker',
      to: 'term_other_worker',
      subject: 'worker-only guidance'
    })

    db!.bindRun({
      runId: state.adoptedRunId,
      coordinatorHandle: 'term_current_coord',
      coordinatorPaneKey: 'tab_current:11111111-1111-4111-8111-111111111111',
      takeoverLegacy: true
    })

    expect(db!.getMessageById(coordinatorMail.id)).toMatchObject({
      to_handle: `run:${state.adoptedRunId}`,
      delivery_contract: 'current_delivery'
    })
    expect(db!.getMessageById(workerMail.id)).toMatchObject({
      to_handle: 'term_other_worker',
      delivery_contract: 'legacy_direct'
    })
  })

  it('commits legacy messages, lifecycle effects, and invocation receipts exactly once', () => {
    const state = openAdoptedFixture()
    const params = {
      principalId: state.workerPrincipalId,
      operationKey: 'invocation_1',
      method: 'orchestration.send',
      payloadHash: 'payload_1',
      message: {
        to: 'term_legacy_coord',
        subject: 'alive',
        type: 'heartbeat' as const
      },
      lifecycle: { kind: 'heartbeat' as const, at: '2026-07-28T12:00:00.000Z' }
    }

    const first = db!.commitLegacyLifecycleOperation(params)
    const replay = db!.commitLegacyLifecycleOperation(params)

    expect(replay).toMatchObject({
      duplicate: true,
      message: { id: first.message.id },
      receipt: { effect_id: first.message.id }
    })
    expect(db!.getDispatchContextById(state.fixture.legacyDispatchId)?.last_heartbeat_at).toBe(
      '2026-07-28T12:00:00.000Z'
    )
    expect(db!.getUnreadMessages('term_legacy_coord')).toEqual([])
    expect(db!.getUndeliveredUnreadMessages('term_legacy_coord')).toEqual([])
    expect(() =>
      db!.commitLegacyLifecycleOperation({ ...params, payloadHash: 'different' })
    ).toThrow(/different input/)
  })

  it('reconstructs a matching pre-receipt settlement without changing its persisted outcome', () => {
    const state = openAdoptedFixture()
    const accepted = db!.insertMessage({
      runId: state.adoptedRunId,
      deliveryContract: 'legacy_direct',
      from: 'term_legacy_worker',
      to: 'term_legacy_coord',
      subject: 'Completed',
      type: 'worker_done'
    })
    expect(
      db!.settleWorkerReport({
        taskId: db!.getDispatchContextById(state.fixture.legacyDispatchId)!.task_id,
        dispatchId: state.fixture.legacyDispatchId,
        outcome: 'succeeded',
        result: 'accepted by A'
      })
    ).toMatchObject({ action: 'settled', duplicate: false })

    const reconstructed = db!.commitLegacyLifecycleOperation({
      principalId: state.workerPrincipalId,
      operationKey: `settlement:${state.fixture.legacyDispatchId}`,
      method: 'orchestration.send',
      payloadHash: 'settlement_payload',
      message: {
        existingId: accepted.id,
        to: 'term_legacy_coord',
        subject: 'Completed',
        type: 'worker_done'
      },
      lifecycle: {
        kind: 'worker_report',
        taskId: db!.getDispatchContextById(state.fixture.legacyDispatchId)!.task_id,
        outcome: 'succeeded',
        result: 'accepted by A'
      }
    })

    expect(reconstructed).toMatchObject({
      duplicate: false,
      message: { id: accepted.id },
      settlement: { action: 'settled', outcome: 'succeeded', duplicate: true }
    })
    expect(db!.getLegacyCompatibilityPrincipal(state.workerPrincipalId)?.status).toBe('settled')
  })

  it('reconstructs a read pre-takeover completion through its original legacy route', () => {
    const state = openAdoptedFixture()
    const taskId = db!.getDispatchContextById(state.fixture.legacyDispatchId)!.task_id
    const accepted = db!.insertMessage({
      runId: state.adoptedRunId,
      deliveryContract: 'legacy_direct',
      from: 'term_legacy_worker',
      to: 'term_legacy_coord',
      subject: 'Completed',
      body: 'accepted before takeover',
      type: 'worker_done'
    })
    db!.markAsRead([accepted.id])
    db!.settleWorkerReport({
      taskId,
      dispatchId: state.fixture.legacyDispatchId,
      outcome: 'succeeded',
      result: 'accepted before takeover'
    })
    db!.bindRun({
      runId: state.adoptedRunId,
      coordinatorHandle: 'term_current_coord',
      coordinatorPaneKey: 'tab_current:11111111-1111-4111-8111-111111111111',
      takeoverLegacy: true
    })
    const beforeIds = db!.getInbox(100).map((message) => message.id)

    const reconstructed = db!.commitLegacyLifecycleOperation({
      principalId: state.workerPrincipalId,
      operationKey: 'read_completion_after_takeover',
      method: 'orchestration.send',
      payloadHash: 'read_completion_after_takeover_payload',
      message: {
        existingId: accepted.id,
        to: 'term_legacy_coord',
        subject: 'Completed',
        body: 'accepted before takeover',
        type: 'worker_done'
      },
      lifecycle: {
        kind: 'worker_report',
        taskId,
        outcome: 'succeeded',
        result: 'accepted before takeover'
      }
    })

    expect(reconstructed).toMatchObject({
      duplicate: false,
      message: {
        id: accepted.id,
        to_handle: 'term_legacy_coord',
        delivery_contract: 'legacy_direct'
      },
      settlement: { action: 'settled', outcome: 'succeeded', duplicate: true }
    })
    expect(db!.getInbox(100).map((message) => message.id)).toEqual(beforeIds)
  })

  it('rejects cross-cutover completion reconstruction for another recipient', () => {
    const state = openAdoptedFixture()
    const taskId = db!.getDispatchContextById(state.fixture.legacyDispatchId)!.task_id
    const payload = JSON.stringify({ taskId, dispatchId: state.fixture.legacyDispatchId })
    const foreign = db!.insertMessage({
      runId: state.adoptedRunId,
      deliveryContract: 'legacy_direct',
      from: 'term_legacy_worker',
      to: 'term_other_coord',
      subject: 'Completed',
      body: 'accepted elsewhere',
      type: 'worker_done',
      payload
    })
    db!.settleWorkerReport({
      taskId,
      dispatchId: state.fixture.legacyDispatchId,
      outcome: 'succeeded',
      result: 'accepted elsewhere'
    })
    const beforeIds = db!.getInbox(100).map((message) => message.id)

    expect(
      db!.findLegacyWorkerCompletion({
        principalId: state.workerPrincipalId,
        taskId,
        recipientHandle: 'term_legacy_coord',
        subject: 'Completed',
        body: 'accepted elsewhere',
        payload
      })
    ).toBeUndefined()
    expect(() =>
      db!.commitLegacyLifecycleOperation({
        principalId: state.workerPrincipalId,
        operationKey: 'wrong_recipient_retry',
        method: 'orchestration.send',
        payloadHash: 'wrong_recipient_retry_payload',
        message: {
          to: 'term_legacy_coord',
          subject: 'Completed',
          body: 'accepted elsewhere',
          type: 'worker_done',
          payload
        },
        lifecycle: {
          kind: 'worker_report',
          taskId,
          outcome: 'succeeded',
          result: 'accepted elsewhere'
        }
      })
    ).toThrow(/settled/)
    expect(() =>
      db!.commitLegacyLifecycleOperation({
        principalId: state.workerPrincipalId,
        operationKey: 'wrong_recipient_reconstruction',
        method: 'orchestration.send',
        payloadHash: 'wrong_recipient_payload',
        message: {
          existingId: foreign.id,
          to: 'term_legacy_coord',
          subject: 'Completed',
          body: 'accepted elsewhere',
          type: 'worker_done',
          payload
        },
        lifecycle: {
          kind: 'worker_report',
          taskId,
          outcome: 'succeeded',
          result: 'accepted elsewhere'
        }
      })
    ).toThrow(/does not match this principal/)
    expect(db!.getInbox(100).map((message) => message.id)).toEqual(beforeIds)
    expect(
      db!.getLegacyOperationReceipt(state.workerPrincipalId, 'wrong_recipient_reconstruction')
    ).toBeUndefined()
    expect(
      db!.getLegacyOperationReceipt(state.workerPrincipalId, 'wrong_recipient_retry')
    ).toBeUndefined()
    expect(db!.getTask(taskId)).toMatchObject({
      status: 'completed',
      result: 'accepted elsewhere'
    })
  })

  it('writes the acceptance stop and incident exactly once for an admissible blocked legacy report', () => {
    const state = openAdoptedFixture()
    const { opened, store } = openIncidents()
    const dispatchId = state.fixture.legacyDispatchId
    const taskId = db!.getDispatchContextById(dispatchId)!.task_id
    declareFailedRule(opened.db, dispatchId)

    const result = db!.commitLegacyLifecycleOperation({
      principalId: state.workerPrincipalId,
      operationKey: 'legacy_blocked_report',
      method: 'orchestration.send',
      payloadHash: 'legacy_blocked_report_payload',
      message: { to: 'term_legacy_coord', subject: 'Completed', type: 'worker_done' },
      lifecycle: { kind: 'worker_report', taskId, outcome: 'succeeded', result: 'done' }
    })

    expect(result.settlement).toMatchObject({ action: 'acceptance_pending' })
    // Blocked never means failed: the dispatch keeps its status and the stop owns the next step.
    expect(db!.getDispatchContextById(dispatchId)?.status).toBe('dispatched')
    expect(getAcceptanceStop(opened.db, dispatchId)).toMatchObject({
      state: 'pending',
      gateSeenCount: 1
    })
    expect(
      store.listIncidents().incidents.filter((incident) => incident.class === 'acceptance_failed')
    ).toHaveLength(1)
  })

  it('writes no second acceptance evidence when the same operation is re-delivered (F7)', () => {
    const state = openAdoptedFixture()
    const { opened, store } = openIncidents()
    const dispatchId = state.fixture.legacyDispatchId
    const taskId = db!.getDispatchContextById(dispatchId)!.task_id
    declareFailedRule(opened.db, dispatchId)
    const params = {
      principalId: state.workerPrincipalId,
      operationKey: 'legacy_duplicate_report',
      method: 'orchestration.send',
      payloadHash: 'legacy_duplicate_report_payload',
      message: { to: 'term_legacy_coord', subject: 'Completed', type: 'worker_done' as const },
      lifecycle: {
        kind: 'worker_report' as const,
        taskId,
        outcome: 'succeeded' as const,
        result: 'done'
      }
    }

    const first = db!.commitLegacyLifecycleOperation(params)
    expect(first.settlement).toMatchObject({ action: 'acceptance_pending' })
    expect(getAcceptanceStop(opened.db, dispatchId)).toMatchObject({ gateSeenCount: 1 })
    const incidentIds = store.listIncidents().incidents.map((incident) => incident.id)
    expect(incidentIds).toHaveLength(1)

    // The replay never settles anything, so it must not write acceptance evidence for a settlement
    // that does not happen: no new incident row, and the stop's seen count stays where it was.
    const replay = db!.commitLegacyLifecycleOperation(params)
    expect(replay).toMatchObject({ duplicate: true, message: { id: first.message.id } })
    expect(store.listIncidents().incidents.map((incident) => incident.id)).toEqual(incidentIds)
    expect(getAcceptanceStop(opened.db, dispatchId)).toMatchObject({ gateSeenCount: 1 })
  })

  it('writes no acceptance evidence when the legacy dispatch is no longer active (F7)', () => {
    const state = openAdoptedFixture()
    const { opened, store } = openIncidents()
    const dispatchId = state.fixture.legacyDispatchId
    const taskId = db!.getDispatchContextById(dispatchId)!.task_id
    declareFailedRule(opened.db, dispatchId)
    // A settled dispatch: the transaction rejects this report, so the gate must never run.
    db!.completeDispatch(dispatchId)

    expect(() =>
      db!.commitLegacyLifecycleOperation({
        principalId: state.workerPrincipalId,
        operationKey: 'legacy_inactive_report',
        method: 'orchestration.send',
        payloadHash: 'legacy_inactive_report_payload',
        message: { to: 'term_legacy_coord', subject: 'Completed', type: 'worker_done' },
        lifecycle: { kind: 'worker_report', taskId, outcome: 'succeeded', result: 'done' }
      })
    ).toThrow(/settled/)
    expect(store.listIncidents().incidents).toEqual([])
    expect(getAcceptanceStop(opened.db, dispatchId)).toBeNull()
  })

  it('settles an older context-only sibling through a legacy worker_report', () => {
    const split = createLegacySiblingSplit('legacy sibling split')

    const result = db!.commitLegacyLifecycleOperation({
      principalId: split.principalId,
      operationKey: 'legacy_sibling_report',
      method: 'orchestration.send',
      payloadHash: 'legacy_sibling_report_payload',
      message: { to: 'term_legacy_coord', subject: 'Completed', type: 'worker_done' },
      lifecycle: {
        kind: 'worker_report',
        taskId: split.taskId,
        outcome: 'succeeded',
        result: 'done'
      }
    })

    expect(result.settlement).toMatchObject({
      action: 'settled',
      outcome: 'succeeded',
      duplicate: false
    })
    expect(db!.getDispatchContextById(split.reportingDispatchId)?.status).toBe('completed')
    expect(db!.getTask(split.taskId)?.status).toBe('completed')
    // The map was handed over under the name the settlement actually reads (`siblingDecisions`); with
    // any other property name it is dropped at runtime and this sibling stays `dispatched`.
    expect(db!.getDispatchContextById(split.siblingDispatchId)).toMatchObject({
      status: 'completed',
      capability_revoked_at: expect.any(String)
    })
  })

  it('leaves a sibling that appears only after the preflight unsettled and names it', () => {
    const split = createLegacySiblingSplit('legacy late sibling split')
    const sqlite = (db as unknown as { db: Database.Database }).db
    const connection = (db as unknown as { db: { exec: (sql: string) => void } }).db
    const originalExec = connection.exec.bind(connection)
    let injected = false
    // The seam is `BEGIN IMMEDIATE`: the acceptance preflight has already run, and the settlement has
    // not read the dispatch set yet, which is exactly the window a real concurrent writer would hit.
    connection.exec = (sql: string) => {
      if (!injected && sql.trim().toUpperCase() === 'BEGIN IMMEDIATE') {
        injected = true
        sqlite
          .prepare("UPDATE dispatch_contexts SET status = 'pending' WHERE id = ?")
          .run(split.lateDispatchId)
      }
      return originalExec(sql)
    }
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    let result: ReturnType<OrchestrationDb['commitLegacyLifecycleOperation']>
    try {
      result = db!.commitLegacyLifecycleOperation({
        principalId: split.principalId,
        operationKey: 'legacy_late_sibling_report',
        method: 'orchestration.send',
        payloadHash: 'legacy_late_sibling_report_payload',
        message: { to: 'term_legacy_coord', subject: 'Completed', type: 'worker_done' },
        lifecycle: {
          kind: 'worker_report',
          taskId: split.taskId,
          outcome: 'succeeded',
          result: 'done'
        }
      })
    } finally {
      connection.exec = originalExec
    }

    expect(injected).toBe(true)
    expect(result!.settlement).toMatchObject({ action: 'settled', outcome: 'succeeded' })
    // The sibling the preflight knew about settled; the newcomer had no decision and was left alone.
    expect(db!.getDispatchContextById(split.siblingDispatchId)?.status).toBe('completed')
    expect(db!.getDispatchContextById(split.lateDispatchId)?.status).toBe('pending')
    const messages = warning.mock.calls.map((call) => String(call[1]))
    expect(
      messages.some(
        (message) =>
          message.includes(split.lateDispatchId) &&
          message.includes('no precomputed acceptance decision')
      )
    ).toBe(true)
  })

  it('uses invocation identity for repeated asks and atomically conflicts divergent replies', () => {
    const state = openAdoptedFixture()
    const ask = {
      principalId: state.workerPrincipalId,
      operationKey: 'ask_invocation_1',
      method: 'orchestration.ask',
      payloadHash: 'ask_payload',
      question: 'Same text?',
      options: ['yes', 'no'],
      recipientHandle: 'term_legacy_coord'
    }
    const first = db!.commitLegacyAskOperation(ask)
    const replay = db!.commitLegacyAskOperation(ask)
    const repeated = db!.commitLegacyAskOperation({
      ...ask,
      operationKey: 'ask_invocation_2'
    })

    expect(replay).toMatchObject({ duplicate: true, question: { message_id: first.message.id } })
    expect(repeated.message.id).not.toBe(first.message.id)
    expect(db!.findPendingLegacyQuestions(ask)).toHaveLength(2)
    expect(
      db!.findPendingLegacyQuestions({
        ...ask,
        question: '  Same text?\r\n',
        options: ['yes ', ' no']
      })
    ).toHaveLength(2)

    const inherited = db!.createQuestion({
      runId: state.adoptedRunId,
      dispatchId: state.fixture.legacyDispatchId,
      askerHandle: 'term_legacy_worker',
      question: 'Inherited?'
    })
    const sqlite = (db as unknown as { db: Database.Database }).db
    sqlite
      .prepare(
        `UPDATE messages
         SET from_handle = 'term_legacy_worker', to_handle = 'term_legacy_coord',
             delivery_contract = 'legacy_direct'
         WHERE id = ?`
      )
      .run(inherited.message.id)
    const inheritedAsk = {
      ...ask,
      operationKey: 'ask_inherited_1',
      payloadHash: 'ask_inherited_payload_1',
      question: 'Inherited?',
      options: [],
      existingQuestionId: inherited.message.id
    }
    const adopted = db!.commitLegacyAskOperation(inheritedAsk)
    const distinct = db!.commitLegacyAskOperation({
      ...inheritedAsk,
      operationKey: 'ask_inherited_2',
      payloadHash: 'ask_inherited_payload_2'
    })
    expect(adopted.message.id).toBe(inherited.message.id)
    expect(distinct.message.id).not.toBe(inherited.message.id)

    const reply = {
      principalId: state.coordinatorPrincipalId,
      operationKey: 'reply_invocation_1',
      method: 'orchestration.reply',
      payloadHash: 'reply_payload',
      questionId: first.message.id,
      body: 'yes'
    }
    const answered = db!.commitLegacyReplyOperation(reply)
    const answerReplay = db!.commitLegacyReplyOperation(reply)
    expect(answerReplay).toMatchObject({
      duplicate: true,
      message: { id: answered.message.id }
    })
    expect(
      db!
        .findLegacyQuestionsBySemanticIdentity(ask)
        .find((row) => row.question.message_id === first.message.id)
    ).toMatchObject({ question: { status: 'answered' }, answerAcknowledged: false })
    db!.acknowledgeLegacyQuestionAnswer({
      principalId: state.workerPrincipalId,
      questionId: first.message.id,
      answerMessageId: answered.message.id
    })
    expect(
      db!
        .findLegacyQuestionsBySemanticIdentity(ask)
        .find((row) => row.question.message_id === first.message.id)
    ).toMatchObject({ answerAcknowledged: true })
    expect(() =>
      db!.commitLegacyReplyOperation({
        ...reply,
        operationKey: 'reply_invocation_2',
        payloadHash: 'different_reply',
        body: 'no'
      })
    ).toThrow(/different answer/)

    const currentTask = db!.createTask({ runId: state.adoptedRunId, spec: 'current retry' })
    const currentDispatch = db!.createDispatchContext({
      taskId: currentTask.id,
      assigneeHandle: 'term_current_retry',
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER
    })
    const currentQuestion = db!.createQuestion({
      runId: state.adoptedRunId,
      dispatchId: currentDispatch.id,
      askerHandle: 'term_current_retry',
      question: 'Current question?'
    })
    expect(() =>
      db!.commitLegacyReplyOperation({
        ...reply,
        operationKey: 'reply_current_question',
        payloadHash: 'current_question',
        questionId: currentQuestion.message.id
      })
    ).toThrow(/not actionable/)
  })
})

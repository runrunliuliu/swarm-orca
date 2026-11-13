/**
 * The settlement gate on the real reconciliation path (§8, M5-3): a declared dispatch that fails
 * acceptance is NOT settled, the stop is visible, and the dispatch is never failed by acceptance.
 *
 * This is the path-level test: it drives `reconcileLifecycleMessage` — the single function every
 * worker-report ingestion path funnels through — rather than the gate helper alone.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../runtime/orchestration/db'
import { createRootDispatch } from '../runtime/orchestration/db/root-dispatch-test-fixture'
import { reconcileLifecycleMessage } from '../runtime/orchestration/lifecycle-reconciliation'
import { openIncidentsDatabase, type OpenIncidentsDatabase } from './incidents-database'
import { createIncidentStore } from './incident-store'
import {
  __configureIncidentStoreForTests,
  __resetIncidentWriterForTests
} from './incident-writer'
import {
  declareAcceptanceRule,
  getAcceptanceStop,
  resolveAcceptanceStop,
  writeAcceptanceVerdict,
  type AcceptanceRule
} from './dispatch-acceptance-store'
import { decideMaintenanceAcceptance, gateSettlement } from './acceptance-runtime'

const T0 = 1_700_000_000_000
const directories: string[] = []
const databases: OpenIncidentsDatabase[] = []
let orchestration: OrchestrationDb | undefined

function incidents(): { opened: OpenIncidentsDatabase; store: ReturnType<typeof createIncidentStore> } {
  const directory = mkdtempSync(join(tmpdir(), 'orca-acceptance-gate-'))
  directories.push(directory)
  const opened = openIncidentsDatabase(join(directory, 'incidents', 'incidents.db'))
  databases.push(opened)
  return {
    opened,
    store: createIncidentStore({ db: opened.db, fileSizeBytes: opened.fileSizeBytes })
  }
}

function fixture(): {
  dispatch: { id: string; taskId: string }
  message: ReturnType<OrchestrationDb['insertMessage']>
} {
  orchestration = new OrchestrationDb(':memory:')
  const task = orchestration.createTask({ runId: 'run_legacy_local', spec: 'work' })
  const dispatch = createRootDispatch(orchestration, task.id, 'term_a')
  const message = orchestration.insertMessage({
    runId: 'run_legacy_local',
    from: 'term_a',
    to: 'term_coordinator',
    subject: 'Done',
    type: 'worker_done',
    payload: JSON.stringify({ taskId: task.id, dispatchId: dispatch.id, outcome: 'succeeded' })
  })
  return { dispatch: { id: dispatch.id, taskId: task.id }, message }
}

/** Declare one rule and, when a verdict is asked for, bind it to the revision that was declared. */
function declareRule(
  db: ReturnType<typeof incidents>['opened']['db'],
  dispatchId: string,
  verdict?: 'passed' | 'failed' | 'undeterminable',
  detail = 'exit_code_expected_0_got_2'
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
  if (verdict !== undefined) {
    writeAcceptanceVerdict(db, {
      dispatchId,
      ruleId: 'tests',
      verdict,
      exitCode: verdict === 'passed' ? 0 : 2,
      signal: null,
      stdoutDigest: 'a'.repeat(64),
      stdoutBytes: 12,
      detail,
      evaluatedAt: T0,
      ruleDigest: rule.digest,
      ruleDeclaredAt: rule.createdAt
    })
  }
  return rule
}

afterEach(() => {
  __resetIncidentWriterForTests()
  orchestration?.close()
  orchestration = undefined
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

describe('a dispatch with no acceptance rules (regression)', () => {
  it('settles exactly as before, with no incidents store configured', () => {
    const { dispatch, message } = fixture()
    __configureIncidentStoreForTests(null)
    expect(reconcileLifecycleMessage(orchestration as OrchestrationDb, message).action).toBe(
      'completed'
    )
    expect(orchestration?.getDispatchContextById(dispatch.id)?.status).toBe('completed')
  })

  it('settles exactly as before when the store exists but nothing was declared', () => {
    const { dispatch, message } = fixture()
    const { opened, store } = incidents()
    __configureIncidentStoreForTests(store, opened.db)
    expect(reconcileLifecycleMessage(orchestration as OrchestrationDb, message).action).toBe(
      'completed'
    )
    expect(store.countIncidents()).toBe(0)
    expect(getAcceptanceStop(opened.db, dispatch.id)).toBeNull()
  })
})

describe('a declared dispatch that fails acceptance', () => {
  it('is NOT settled, is never failed, and leaves a visible pending stop plus an incident', () => {
    const { dispatch, message } = fixture()
    const { opened, store } = incidents()
    declareRule(opened.db, dispatch.id, 'failed')
    __configureIncidentStoreForTests(store, opened.db)

    expect(reconcileLifecycleMessage(orchestration as OrchestrationDb, message).action).toBe(
      'acceptance_pending'
    )
    // Neither settled nor failed: the dispatch keeps its status and the stop owns the next step.
    expect(orchestration?.getDispatchContextById(dispatch.id)?.status).toBe('dispatched')
    expect(getAcceptanceStop(opened.db, dispatch.id)).toMatchObject({ state: 'pending' })
    const incident = store.listIncidents().incidents[0]
    expect(incident.class).toBe('acceptance_failed')
    expect(incident.effectiveStatus).toBe('untriaged')
  })

  it('blocks when a rule was never evaluated, and says so in the incident', () => {
    const { dispatch, message } = fixture()
    const { opened, store } = incidents()
    declareRule(opened.db, dispatch.id)
    __configureIncidentStoreForTests(store, opened.db)
    expect(gateSettlement({ dispatchId: dispatch.id }).verdict).toBe('blocked')
    const view = store.getIncident(store.listIncidents().incidents[0].id)!
    expect(view.summary).toContain('not_evaluated')
    expect(reconcileLifecycleMessage(orchestration as OrchestrationDb, message).action).toBe(
      'acceptance_pending'
    )
  })

  it('settles after the operator accepts the stop, and never before', () => {
    const { dispatch, message } = fixture()
    const { opened, store } = incidents()
    declareRule(opened.db, dispatch.id, 'failed')

    __configureIncidentStoreForTests(store, opened.db)
    reconcileLifecycleMessage(orchestration as OrchestrationDb, message)
    expect(orchestration?.getDispatchContextById(dispatch.id)?.status).toBe('dispatched')

    resolveAcceptanceStop(opened.db, {
      dispatchId: dispatch.id,
      decision: 'accept',
      actor: 'alice',
      reason: 'verified by hand',
      now: T0 + 1
    })
    // The coordinator keeps a blocked worker_done unread, so the existing flow re-runs reconciliation.
    expect(reconcileLifecycleMessage(orchestration as OrchestrationDb, message).action).toBe(
      'completed'
    )
    expect(orchestration?.getDispatchContextById(dispatch.id)?.status).toBe('completed')
  })

  it('keeps a rejected dispatch unsettled without failing it', () => {
    const { dispatch, message } = fixture()
    const { opened, store } = incidents()
    declareRule(opened.db, dispatch.id, 'failed')

    __configureIncidentStoreForTests(store, opened.db)
    reconcileLifecycleMessage(orchestration as OrchestrationDb, message)
    resolveAcceptanceStop(opened.db, {
      dispatchId: dispatch.id,
      decision: 'reject',
      actor: 'alice',
      reason: 'the worker must retry',
      now: T0 + 1
    })
    expect(reconcileLifecycleMessage(orchestration as OrchestrationDb, message).action).toBe(
      'acceptance_pending'
    )
    expect(orchestration?.getDispatchContextById(dispatch.id)?.status).toBe('dispatched')
  })

  it('marks an operator maintenance bypass as overridden, never as accepted (C1)', () => {
    const { dispatch, message } = fixture()
    const { opened, store } = incidents()
    declareRule(opened.db, dispatch.id, 'failed')
    __configureIncidentStoreForTests(store, opened.db)

    // The real maintenance entry point: it writes the stop AND the audit incident.
    const decision = decideMaintenanceAcceptance({
      dispatchId: dispatch.id,
      override: { actor: 'alice', reason: 'hotfix deployed by hand' }
    })
    expect(decision).toEqual({ action: 'allow', via: 'overridden' })

    // The gate now allows settlement, but reports how it got there.
    expect(gateSettlement({ dispatchId: dispatch.id })).toMatchObject({
      verdict: 'passed',
      via: 'overridden'
    })
    expect(getAcceptanceStop(opened.db, dispatch.id)).toMatchObject({
      state: 'overridden',
      actor: 'alice',
      overriddenRules: ['tests']
    })
    // The audit row is its own class, so a triage read cannot mistake it for a pass or a failure.
    const override = store
      .listIncidents()
      .incidents.find((incident) => incident.class === 'acceptance_overridden')
    expect(override).toBeDefined()
    expect(override?.summary).toContain('hotfix deployed by hand')
    expect(reconcileLifecycleMessage(orchestration as OrchestrationDb, message).action).toBe(
      'completed'
    )
  })

  it('separates command runs from settlement reads instead of counting one as the other (C6)', () => {
    const { dispatch } = fixture()
    const { opened, store } = incidents()
    declareRule(opened.db, dispatch.id, 'failed')
    __configureIncidentStoreForTests(store, opened.db)

    for (let tick = 0; tick < 3; tick += 1) {
      expect(gateSettlement({ dispatchId: dispatch.id, now: T0 + tick }).verdict).toBe('blocked')
    }
    const stop = getAcceptanceStop(opened.db, dispatch.id)
    // Three settlement reads, zero command runs: the M5 build reported "attempts=3", which read as
    // three retries of a command that was executed once.
    expect(stop).toMatchObject({ gateSeenCount: 3, evaluationAttempts: 0 })
    expect(stop?.lastSeenAt).toBe(T0 + 2)
  })

  it('opens a visible blocked stop and keeps the incident when the rule was never evaluated (C7)', () => {
    const { dispatch } = fixture()
    const { opened, store } = incidents()
    const rule = declareRule(opened.db, dispatch.id, 'passed')
    __configureIncidentStoreForTests(store, opened.db)
    expect(gateSettlement({ dispatchId: dispatch.id }).verdict).toBe('passed')

    // Same rule id, different contract: the pass no longer describes this rule.
    declareAcceptanceRule(opened.db, {
      hostId: 'host-a',
      dispatchId: dispatch.id,
      ruleId: 'tests',
      program: 'npm',
      args: ['test'],
      expect: { exitCode: 7 },
      cwd: '/work/tree',
      worktreeRoot: '/work',
      actor: 'alice',
      now: T0 + 5
    })
    expect(rule.expect).toEqual({ exitCode: 0 })
    expect(gateSettlement({ dispatchId: dispatch.id }).verdict).toBe('blocked')
    expect(getAcceptanceStop(opened.db, dispatch.id)).toMatchObject({ state: 'pending' })
  })
})

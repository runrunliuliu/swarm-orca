import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  COORD,
  OPERATOR,
  WORKER,
  strictCoordinatorHarness
} from './strict-coordinator-test-fixture'
import { idOf, resultOf } from './orchestration-session-caller-test-fixture'

const refused = { ok: false, error: { code: 'strict_coordinator_required' } }

describe.each([false, true])('strict retirement (streaming=%s)', (streaming) => {
  let h: ReturnType<typeof strictCoordinatorHarness>
  beforeEach(() => {
    h = strictCoordinatorHarness(streaming)
  })
  afterEach(() => {
    h.close()
    vi.restoreAllMocks()
  })
  const retire = (run: string, caller = COORD, generation = 1, requestId?: string) =>
    h.call(
      'orchestration.runRetireStrict',
      { run, from: caller, generation, decision: 'archive/reconciled.json' },
      caller,
      requestId
    )
  async function settled() {
    const run = await h.create()
    const dispatch = await h.dispatch(run)
    const task = h.db.getDispatchContextById(dispatch)!.task_id
    resultOf(
      await h.call(
        'orchestration.send',
        {
          from: WORKER,
          type: 'worker_done',
          payload: JSON.stringify({ taskId: task, dispatchId: dispatch, outcome: 'succeeded' })
        },
        WORKER
      )
    )
    return { run, dispatch, task }
  }

  it('fences the retired Run, retains audit history, and frees its Coordinator for a new Run', async () => {
    const { run, dispatch } = await settled()
    const probe = vi
      .spyOn(h.runtime, 'inspectTerminalProcessIncarnationLiveness')
      .mockResolvedValue('exited')
    expect(resultOf(await retire(run))).toMatchObject({
      runId: run,
      coordinatorState: 'retired',
      generation: 2
    })
    expect(probe).toHaveBeenCalledWith(
      h.authorities.get(WORKER)!.processIncarnation,
      JSON.stringify({ kind: 'local', hostId: 'local' })
    )
    expect(h.db.getRun(run)).toMatchObject({ coordinator_handle: null, consumer_generation: 2 })
    expect(h.db.getDispatchContextById(dispatch)).toBeDefined()
    expect(resultOf(await h.call('orchestration.runShow', { id: run }))).toHaveProperty(
      'strictRetirement'
    )
    expect(
      await h.call(
        'orchestration.taskCreate',
        { run, callerTerminalHandle: COORD, spec: 'revive' },
        COORD
      )
    ).toMatchObject(refused)
    expect(await h.call('orchestration.runUse', { id: run, from: COORD }, COORD)).toMatchObject(
      refused
    )
    expect(await h.call('orchestration.reset', { all: true }, COORD)).toMatchObject(refused)
    expect(await h.create()).not.toBe(run)
    expect(
      resultOf(
        await h.call('terminal.send', { terminal: WORKER, text: 'new user work', enter: true })
      )
    ).toHaveProperty('send.accepted', true)
  })

  it.each(['live', 'unverifiable'] as const)(
    'does not treat settled or absent as exited (%s)',
    async (verdict) => {
      const { run } = await settled()
      vi.spyOn(h.runtime, 'inspectTerminalProcessIncarnationLiveness').mockResolvedValue(verdict)
      expect(await retire(run)).toMatchObject(refused)
      expect(h.db.getRun(run)?.consumer_generation).toBe(1)
      expect(await h.call('terminal.send', { terminal: WORKER, text: 'bypass' })).toMatchObject(
        refused
      )
    }
  )

  it('requires the original identity and exact generation; unfinished work is not retirement', async () => {
    const run = await h.create()
    expect(await retire(run, OPERATOR)).toMatchObject(refused)
    expect(await retire(run, COORD, 2)).toMatchObject(refused)
    await h.dispatch(run)
    expect(await retire(run)).toMatchObject(refused)
    h.authorities.get(COORD)!.processIncarnation = 'changed:2'
    expect(await retire(run)).toMatchObject(refused)
  })

  it('retains an idempotent receipt without permitting Operator replay', async () => {
    const run = await h.create()
    const requestId = 'retire-request'
    const receipt = resultOf(await retire(run, COORD, 1, requestId))
    expect(resultOf(await retire(run, COORD, 1, requestId))).toMatchObject({
      runId: run,
      retiredAt: receipt.retiredAt
    })
    expect(await retire(run, OPERATOR, 1, requestId)).toMatchObject(refused)
    expect(resultOf(await retire(run))).toMatchObject({ retiredAt: receipt.retiredAt })
    expect(h.db.getRun(run)?.consumer_generation).toBe(2)
  })

  it('blocks unknown durable operations without deleting their evidence', async () => {
    const run = await h.create()
    h.db.beginMutationReceipt({
      callerFingerprint: 'unknown',
      requestId: 'unknown',
      method: 'orchestration.workerStart',
      payloadHash: 'hash'
    })
    expect(await retire(run)).toMatchObject(refused)
    expect(h.db.getMutationReceipt('unknown', 'unknown')?.state).toBe('pending')
  })

  it('refuses missing historical host proof without probing a guessed process', async () => {
    const { run, dispatch } = await settled()
    h.db.db.prepare('UPDATE dispatch_contexts SET host_scope = NULL WHERE id = ?').run(dispatch)
    const probe = vi.spyOn(h.runtime, 'inspectTerminalProcessIncarnationLiveness')
    expect(await retire(run)).toMatchObject(refused)
    expect(probe).not.toHaveBeenCalled()
    expect(h.db.getRun(run)?.consumer_generation).toBe(1)
  })

  it('rechecks the original Coordinator after asynchronous host inspection', async () => {
    const { run } = await settled()
    vi.spyOn(h.runtime, 'inspectTerminalProcessIncarnationLiveness').mockImplementation(
      async () => {
        h.authorities.get(COORD)!.processIncarnation = 'replacement'
        return 'exited'
      }
    )
    expect(await retire(run)).toMatchObject(refused)
    expect(h.db.getRun(run)?.consumer_generation).toBe(1)
  })

  it('blocks writes while inspecting and rejects a changed inventory', async () => {
    const { run, task } = await settled()
    let finishProbe: (value: 'exited') => void = () => {
      throw new Error('not started')
    }
    let enteredProbe: () => void = () => undefined
    const entered = new Promise<void>((resolve) => {
      enteredProbe = resolve
    })
    vi.spyOn(h.runtime, 'inspectTerminalProcessIncarnationLiveness').mockImplementation(() => {
      enteredProbe()
      return new Promise((resolve) => {
        finishProbe = resolve
      })
    })
    const pending = retire(run)
    await entered
    expect(
      await h.call(
        'orchestration.taskCreate',
        { run, callerTerminalHandle: COORD, spec: 'race' },
        COORD
      )
    ).toMatchObject(refused)
    // An internal lifecycle observer can change durable state outside RPC.
    h.db.db.prepare('UPDATE tasks SET result = ? WHERE id = ?').run('changed', task)
    finishProbe('exited')
    expect(await pending).toMatchObject(refused)
    expect(h.db.getRun(run)?.consumer_generation).toBe(1)
  })

  it('refuses retirement during an existing non-durable async dispatch', async () => {
    const run = await h.create()
    const task = idOf(
      resultOf(
        await h.call(
          'orchestration.taskCreate',
          { run, callerTerminalHandle: COORD, spec: 'race' },
          COORD
        )
      ).task
    )
    let finishDiscovery: () => void = () => {
      throw new Error('not started')
    }
    let enteredDiscovery: () => void = () => undefined
    const entered = new Promise<void>((resolve) => {
      enteredDiscovery = resolve
    })
    vi.spyOn(h.runtime, 'isTerminalRunningAgent').mockImplementationOnce(async () => {
      enteredDiscovery()
      await new Promise<void>((resolve) => {
        finishDiscovery = resolve
      })
      return true
    })
    const pending = h.call(
      'orchestration.dispatch',
      { run, from: COORD, task, to: WORKER, inject: true },
      COORD
    )
    await entered
    expect(await retire(run)).toMatchObject(refused)
    finishDiscovery()
    // This harness has no process host; the injection fails after the in-flight guard.
    expect(await pending).toMatchObject({ ok: false, error: { code: 'runtime_unavailable' } })
    expect(h.db.getRun(run)?.consumer_generation).toBe(1)
  })

  it('rolls back the retirement receipt and owner fence together on transaction failure', async () => {
    const run = await h.create()
    vi.spyOn(h.db, 'fenceUnacknowledgedMailboxDeliveries').mockImplementationOnce(() => {
      throw new Error('fence failed')
    })
    expect(await retire(run, COORD, 1, 'rollback-retire')).toMatchObject({ ok: false })
    expect(h.db.db.isTransaction).toBe(false)
    expect(
      h.db.db.prepare('SELECT * FROM strict_run_retirements WHERE run_id = ?').get(run)
    ).toBeUndefined()
    expect(h.db.getRun(run)).toMatchObject({ coordinator_handle: COORD, consumer_generation: 1 })
    expect(resultOf(await retire(run, COORD, 1, 'rollback-retire'))).toHaveProperty(
      'coordinatorState',
      'retired'
    )
  })

  it('does not replay an old message into a released Worker pane', async () => {
    const { run } = await settled()
    const params = { from: COORD, to: WORKER, body: 'old instruction' }
    resultOf(await h.call('orchestration.send', params, COORD, 'old-message'))
    vi.spyOn(h.runtime, 'inspectTerminalProcessIncarnationLiveness').mockResolvedValue('exited')
    resultOf(await retire(run))
    h.nudge.mockClear()
    expect(await h.call('orchestration.send', params, COORD, 'old-message')).toMatchObject(refused)
    expect(h.nudge).not.toHaveBeenCalled()
    const nextRun = await h.create()
    await h.dispatch(nextRun)
    const nextParams = { from: COORD, to: WORKER, body: 'new instruction' }
    resultOf(await h.call('orchestration.send', nextParams, COORD, 'new-message'))
    h.nudge.mockClear()
    resultOf(await h.call('orchestration.send', nextParams, COORD, 'new-message'))
    expect(h.nudge).toHaveBeenCalled()
  })
})

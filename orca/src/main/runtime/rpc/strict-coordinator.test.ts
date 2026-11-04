import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  COORD,
  WORKER,
  OTHER,
  OPERATOR,
  strictCoordinatorHarness
} from './strict-coordinator-test-fixture'
import { idOf, resultOf } from './orchestration-session-caller-test-fixture'
import { sendTerminalStreamInput } from './methods/terminal/terminal-input-delivery'

const refused = { ok: false, error: { code: 'strict_coordinator_required' } }

describe.each([false, true])('strict Coordinator (streaming=%s)', (streaming) => {
  let h: ReturnType<typeof strictCoordinatorHarness>
  beforeEach(() => {
    h = strictCoordinatorHarness(streaming)
  })
  afterEach(() => h.close())

  it('exposes the actual SQLite second-precision creation timestamp consistently', async () => {
    const created = resultOf(
      await h.call('orchestration.runCreateStrict', { from: COORD, objective: 'timestamp' }, COORD)
    )
    expect(created).toMatchObject({
      run: { created_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/) }
    })
    const run = h.db.getRun(idOf(created.run))!
    expect(created).toMatchObject({ run: { id: run.id, created_at: run.created_at } })
    for (const response of [
      await h.call('orchestration.runShow', { id: run.id }),
      await h.call('orchestration.runCurrent', { from: COORD }, COORD)
    ]) {
      expect(resultOf(response)).toMatchObject({ run: { id: run.id, created_at: run.created_at } })
    }
  })

  it('requires native launch proof, not a declared --from, and leaves ordinary Runs unchanged', async () => {
    const before = h.db.listRuns({}).runs
    expect(
      await h.call('orchestration.runCreateStrict', { from: COORD, objective: 'bad' })
    ).toMatchObject(refused)
    expect(h.db.listRuns({}).runs).toEqual(before)
    const run = await h.create()
    expect(resultOf(await h.call('orchestration.runShow', { id: run }))).toMatchObject({
      coordinatorPolicy: 'strict-v1'
    })
    expect(
      resultOf(await h.call('orchestration.runCreate', { from: OPERATOR, objective: 'ordinary' }))
    ).toHaveProperty('run')
  })

  it('preserves Operator→Coordinator messages and read-only inspection', async () => {
    const run = await h.create()
    await h.dispatch(run)
    expect(
      resultOf(
        await h.call('orchestration.send', {
          from: OPERATOR,
          to: `run:${run}`,
          body: 'Research while training'
        })
      )
    ).toHaveProperty('message')
    expect(resultOf(await h.call('orchestration.taskList', { run }))).toMatchObject({ count: 1 })
    expect(
      resultOf(await h.call('orchestration.inbox', { terminal: `run:${run}` }))
    ).toHaveProperty('messages')
  })

  it('allows two independent live Dispatches without making training block research', async () => {
    const run = await h.create()
    const ids = await Promise.all([h.dispatch(run), h.dispatch(run, OTHER)])
    expect(new Set(ids).size).toBe(2)
    for (const id of ids) {
      expect(h.db.getDispatchContextById(id)?.status).toBe('dispatched')
    }
    expect(
      resultOf(
        await h.call(
          'orchestration.send',
          { from: COORD, to: `dispatch:${ids[0]}`, body: 'continue' },
          COORD
        )
      )
    ).toHaveProperty('message')
  })

  it('blocks direct, mailbox and spoofed sender instructions before messages or wake-ups', async () => {
    const run = await h.create()
    const dispatch = await h.dispatch(run)
    const before = h.db.getInbox(1000).length
    h.nudge.mockClear()
    for (const to of [WORKER, `dispatch:${dispatch}`]) {
      expect(
        await h.call('orchestration.send', { from: OPERATOR, to, body: 'bypass' })
      ).toMatchObject(refused)
      expect(
        await h.call('orchestration.send', { from: COORD, to, body: 'spoof' }, OPERATOR)
      ).toMatchObject(refused)
    }
    expect(h.db.getInbox(1000)).toHaveLength(before)
    expect(h.nudge).not.toHaveBeenCalled()
  })

  it('rejects control specified only by dispatch ID or gate ID', async () => {
    const run = await h.create()
    const dispatchId = await h.dispatch(run)
    expect(await h.call('orchestration.workerStop', { dispatch: dispatchId })).toMatchObject(
      refused
    )
    const gate = h.db.createGate({
      taskId: h.db.getDispatchContextById(dispatchId)!.task_id,
      question: 'approve',
      options: ['yes', 'no']
    })
    expect(
      await h.call('orchestration.gateResolve', { id: gate.id, resolution: 'yes', from: OPERATOR })
    ).toMatchObject(refused)
    expect(h.db.getGate(gate.id)?.status).toBe('pending')
  })

  it('refuses raw input via RPC and binary-stream delivery even with Coordinator proof', async () => {
    await h.dispatch(await h.create())
    expect(
      await h.call('terminal.send', { terminal: WORKER, text: 'bypass', enter: true }, COORD)
    ).toMatchObject(refused)
    expect(
      await sendTerminalStreamInput(h.runtime, {
        terminal: WORKER,
        text: 'bypass',
        client: undefined,
        isMobile: false
      })
    ).toBe('rejected')
    expect(h.rawSend).not.toHaveBeenCalled()
  })

  it('refuses stale Coordinator incarnation and silent rebind/reset', async () => {
    const run = await h.create()
    const prior = h.db.getRun(run)
    expect(await h.call('orchestration.runUse', { id: run, from: OPERATOR })).toMatchObject(refused)
    expect(await h.call('orchestration.reset', { all: true })).toMatchObject(refused)
    expect(
      await h.call('orchestration.runCreate', { from: COORD, objective: 'replace' }, COORD)
    ).toMatchObject(refused)
    h.authorities.get(COORD)!.processIncarnation = 'replacement:2'
    expect(
      await h.call(
        'orchestration.taskCreate',
        { run, callerTerminalHandle: COORD, spec: 'stale' },
        COORD
      )
    ).toMatchObject(refused)
    expect(h.db.getRun(run)).toEqual(prior)
    expect(h.db.listTasks({ runId: run })).toHaveLength(0)
  })

  it('forbids Workers becoming nested controllers, including a spoofed new identity', async () => {
    const run = await h.create()
    await h.dispatch(run)
    for (const from of [WORKER, OPERATOR]) {
      expect(
        await h.call('orchestration.runCreate', { from, objective: 'nested' }, WORKER)
      ).toMatchObject(refused)
    }
    expect(
      await h.call(
        'orchestration.taskCreate',
        { run, callerTerminalHandle: WORKER, spec: 'nested' },
        WORKER
      )
    ).toMatchObject(refused)
  })

  it('refuses unsupported federated placement before creating any resource', async () => {
    const run = await h.create()
    expect(
      await h.call(
        'orchestration.workerStart',
        { run, from: COORD, on: 'remote', spec: 'train' },
        COORD
      )
    ).toMatchObject(refused)
    expect(h.db.listTasks({ runId: run })).toHaveLength(0)
    expect(h.db.listWorkerTerminalResources({ runId: run })).toHaveLength(0)
  })
})

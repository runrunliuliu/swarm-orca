import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  COORD,
  WORKER,
  OTHER,
  OPERATOR,
  strictCoordinatorHarness
} from './strict-coordinator-test-fixture'
import { idOf, resultOf } from './orchestration-session-caller-test-fixture'

const refused = { ok: false, error: { code: 'strict_coordinator_required' } }

describe.each([false, true])('strict messaging (streaming=%s)', (streaming) => {
  let h: ReturnType<typeof strictCoordinatorHarness>
  beforeEach(() => {
    h = strictCoordinatorHarness(streaming)
  })
  afterEach(() => h.close())

  it('permits Worker report receipt replay after settlement, but not nested dispatch', async () => {
    const run = await h.create()
    const dispatchId = await h.dispatch(run)
    const taskId = h.db.getDispatchContextById(dispatchId)!.task_id
    const params = {
      from: WORKER,
      type: 'worker_done',
      payload: JSON.stringify({ taskId, dispatchId, outcome: 'succeeded' })
    }
    const first = resultOf(await h.call('orchestration.send', params, WORKER, 'worker-report'))
    expect(h.db.getTask(taskId)?.status).toBe('completed')
    const before = h.db.getInbox(1000)
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(resultOf(await h.call('orchestration.send', params, WORKER, 'worker-report'))).toEqual(
        {
          ...first,
          mutation: { requestId: 'worker-report', replayed: true }
        }
      )
    }
    expect(h.db.getInbox(1000)).toEqual(before)
    expect(
      await h.call('orchestration.runCreate', { from: WORKER, objective: 'nested' }, WORKER)
    ).toMatchObject(refused)
    expect(
      await h.call('orchestration.send', { from: WORKER, to: OPERATOR }, WORKER)
    ).toMatchObject(refused)
  })

  it('allows Worker mailbox consumption and replies only to its own instructions', async () => {
    const run = await h.create()
    const dispatch = await h.dispatch(run)
    const instruction = resultOf(
      await h.call('orchestration.send', { from: COORD, to: `dispatch:${dispatch}` }, COORD)
    )
    expect(
      resultOf(await h.call('orchestration.check', { terminal: WORKER }, WORKER))
    ).toHaveProperty('messages')
    expect(
      resultOf(
        await h.call(
          'orchestration.reply',
          { from: WORKER, id: idOf(instruction.message), body: 'ack' },
          WORKER
        )
      )
    ).toHaveProperty('message')
    const foreign = resultOf(await h.call('orchestration.send', { from: COORD, to: OTHER }, COORD))
    expect(
      await h.call(
        'orchestration.reply',
        { from: WORKER, id: idOf(foreign.message), body: 'foreign' },
        WORKER
      )
    ).toMatchObject(refused)
  })

  it('fences spoofed Worker peek/ack and changed Worker host identity', async () => {
    const run = await h.create()
    const dispatch = await h.dispatch(run)
    resultOf(await h.call('orchestration.send', { from: COORD, to: `dispatch:${dispatch}` }, COORD))
    const before = h.db.getInbox(1000)
    expect(
      await h.call('orchestration.check', { terminal: WORKER, peek: true }, OPERATOR)
    ).toMatchObject(refused)
    expect(h.db.getInbox(1000)).toEqual(before)
    h.authorities.get(WORKER)!.hostScope = { kind: 'ssh', targetId: 'replaced' }
    expect(
      await h.call('orchestration.send', { from: WORKER, to: `run:${run}` }, WORKER)
    ).toMatchObject(refused)
    expect(h.db.getInbox(1000)).toEqual(before)
  })

  it('allows Worker ask and only its Coordinator to answer', async () => {
    const run = await h.create()
    await h.dispatch(run)
    let answer: unknown
    vi.spyOn(h.runtime, 'waitForMessage').mockImplementation(async () => {
      const question = h.db
        .getUnreadRunMailbox(run, 100)
        .find((message) => message.type === 'question')!
      expect(
        await h.call('orchestration.reply', { id: question.id, from: OPERATOR, body: 'bypass' })
      ).toMatchObject(refused)
      answer = await h.call(
        'orchestration.reply',
        { id: question.id, from: COORD, body: 'continue' },
        COORD
      )
      return 'notified'
    })
    const asked = resultOf(
      await h.call(
        'orchestration.ask',
        { from: WORKER, question: 'Proceed?', timeoutMs: 1000 },
        WORKER
      )
    )
    expect(resultOf(answer)).toHaveProperty('message')
    expect(asked.answer).toBe('continue')
  })

  it('refuses mailbox delivery when the Worker identity changes during a wait', async () => {
    const run = await h.create()
    const dispatch = await h.dispatch(run)
    vi.spyOn(h.runtime, 'waitForMessage').mockImplementation(async () => {
      resultOf(
        await h.call('orchestration.send', { from: COORD, to: `dispatch:${dispatch}` }, COORD)
      )
      h.authorities.get(WORKER)!.processIncarnation = 'replaced'
      return 'notified'
    })
    expect(
      await h.call('orchestration.check', { terminal: WORKER, wait: true }, WORKER)
    ).toMatchObject(refused)
    expect(h.db.getUnreadMessages(`dispatch:${dispatch}`)).toHaveLength(1)
  })

  it('rejects mixed-workspace fanout atomically and allows Coordinator Run fanout', async () => {
    const run = await h.create()
    await h.dispatch(run)
    const before = h.db.getInbox(1000)
    h.nudge.mockClear()
    expect(
      await h.call('orchestration.send', { from: OPERATOR, to: '@worktree:folder' })
    ).toMatchObject(refused)
    expect(h.db.getInbox(1000)).toEqual(before)
    expect(h.nudge).not.toHaveBeenCalled()
    expect(
      resultOf(await h.call('orchestration.send', { from: COORD, to: '@all' }, COORD))
    ).toMatchObject({ recipients: 1 })
  })

  it('refuses a group replay when a formerly unbound recipient is now a strict Worker', async () => {
    const params = { from: OPERATOR, to: '@worktree:folder' }
    resultOf(await h.call('orchestration.send', params, undefined, 'old-group'))
    await h.dispatch(await h.create())
    const before = h.db.getInbox(1000)
    h.nudge.mockClear()
    expect(await h.call('orchestration.send', params, undefined, 'old-group')).toMatchObject(
      refused
    )
    expect(h.db.getInbox(1000)).toEqual(before)
    expect(h.nudge).not.toHaveBeenCalled()
  })

  it('revalidates Coordinator identity after asynchronous group discovery', async () => {
    await h.dispatch(await h.create())
    const terminals = await h.listTerminals()
    h.listTerminals.mockImplementationOnce(async () => {
      h.authorities.get(COORD)!.processIncarnation = 'replaced'
      return terminals
    })
    const before = h.db.getInbox(1000)
    expect(
      await h.call('orchestration.send', { from: COORD, to: '@worktree:folder' }, COORD)
    ).toMatchObject(refused)
    expect(h.db.getInbox(1000)).toEqual(before)
  })

  it('fences reminted Worker aliases by pane, including self-dispatch by alias', async () => {
    const run = await h.create()
    await h.dispatch(run)
    h.authorities.get(OTHER)!.paneKey = h.authorities.get(WORKER)!.paneKey
    expect(await h.call('terminal.send', { terminal: OTHER, text: 'bypass' })).toMatchObject(
      refused
    )
    h.authorities.get(OTHER)!.paneKey = h.authorities.get(COORD)!.paneKey
    const task = idOf(
      resultOf(
        await h.call(
          'orchestration.taskCreate',
          { run, callerTerminalHandle: COORD, spec: 'self' },
          COORD
        )
      ).task
    )
    expect(
      await h.call('orchestration.dispatch', { run, from: COORD, to: OTHER, task }, COORD)
    ).toMatchObject(refused)
    expect(h.db.getDispatchContext(task)).toBeUndefined()
  })
})

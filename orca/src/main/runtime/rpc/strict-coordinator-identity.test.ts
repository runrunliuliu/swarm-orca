import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  COORD,
  WORKER,
  OPERATOR,
  strictCoordinatorHarness
} from './strict-coordinator-test-fixture'
import { idOf, resultOf } from './orchestration-session-caller-test-fixture'
import { assertStrictCoordinator } from './strict-coordinator-authority'
import { createExistingWorktreeWorkerTerminal } from './methods/orchestration/worker/worker-topology'
import { createWorkerWorktree } from './methods/orchestration/worker/worker-worktree-creation'

const refused = { ok: false, error: { code: 'strict_coordinator_required' } }

describe.each([false, true])('strict launch identity (streaming=%s)', (streaming) => {
  let h: ReturnType<typeof strictCoordinatorHarness>
  beforeEach(() => {
    h = strictCoordinatorHarness(streaming)
  })
  afterEach(() => h.close())

  it('rechecks a newly pinned Worker before input that began on an ordinary terminal is written', async () => {
    let wrote = false
    h.rawSend.mockImplementation(async (_handle, _action, options) => {
      await h.dispatch(await h.create())
      await options?.beforeWrite?.(`pty-${WORKER}`)
      wrote = true
      return { handle: WORKER, accepted: true, bytesWritten: 1 }
    })
    expect(await h.call('terminal.send', { terminal: WORKER, text: 'late bypass' })).toMatchObject(
      refused
    )
    expect(wrote).toBe(false)
  })

  it.each(['token', 'host'] as const)('refuses changed Coordinator %s evidence', async (kind) => {
    const run = await h.create()
    if (kind === 'token') {
      h.authorities.get(COORD)!.launchTokenHash = 'replacement'
    } else {
      h.authorities.get(COORD)!.hostScope = { kind: 'ssh', targetId: 'other-host' }
    }
    expect(
      await h.call(
        'orchestration.taskCreate',
        { run, callerTerminalHandle: COORD, spec: 'no' },
        COORD
      )
    ).toMatchObject(refused)
    expect(h.db.listTasks({ runId: run })).toHaveLength(0)
  })

  it('protects a starting terminal before its Dispatch has bound an assignee', async () => {
    const run = await h.create()
    const started = h.db.createStartingWorkerDispatch({
      taskSpec: 'start',
      taskRunId: run,
      startOptions: {},
      creator: { kind: 'system' },
      maxDepth: 2
    })
    h.db.createWorkerTerminalResourceStatement({
      dispatchId: started.dispatch.id,
      worktreeId: 'folder',
      terminalHandle: WORKER,
      paneKey: h.authorities.get(WORKER)!.paneKey,
      processIncarnation: h.authorities.get(WORKER)!.processIncarnation,
      ownership: 'owned'
    })
    expect(h.db.getDispatchContextById(started.dispatch.id)?.assignee_handle).toBeNull()
    expect(await h.call('terminal.send', { terminal: WORKER, text: 'bypass' })).toMatchObject(
      refused
    )
    expect(await h.call('orchestration.send', { from: OPERATOR, to: WORKER })).toMatchObject(
      refused
    )
    expect(h.rawSend).not.toHaveBeenCalled()
  })

  it('revalidates the Coordinator at terminal and worktree creation boundaries', async () => {
    const run = await h.create()
    const started = h.db.createStartingWorkerDispatch({
      taskSpec: 'start',
      taskRunId: run,
      startOptions: {},
      creator: { kind: 'system' },
      maxDepth: 2
    })
    const createTerminal = vi.spyOn(h.runtime, 'createTerminal')
    const createWorktree = vi.spyOn(h.runtime, 'createManagedWorktree')
    const evidence = h.evidence(COORD)
    const revalidateCoordinator = () =>
      assertStrictCoordinator(
        { runtime: h.runtime, orchestrationCompatibilityEvidence: evidence },
        run
      )
    h.authorities.get(COORD)!.processIncarnation = 'replaced'
    await expect(
      createExistingWorktreeWorkerTerminal({
        runtime: h.runtime,
        worktreeId: 'folder',
        agent: 'codex',
        taskId: started.task.id,
        effects: [],
        revalidateCoordinator
      })
    ).rejects.toMatchObject({ code: 'strict_coordinator_required' })
    await expect(
      createWorkerWorktree({
        runtime: h.runtime,
        db: h.db,
        dispatchId: started.dispatch.id,
        requestedWorktree: 'new-child',
        coordinatorWorktree: { id: 'folder', repoId: 'repo' },
        params: { from: COORD, name: 'worker' },
        agent: 'codex',
        withAgentTerminal: true,
        effects: [],
        revalidateCoordinator
      })
    ).rejects.toMatchObject({ code: 'strict_coordinator_required' })
    expect(createTerminal).not.toHaveBeenCalled()
    expect(createWorktree).not.toHaveBeenCalled()
  })

  it.each(['coordinator', 'worker-token', 'worker-host'] as const)(
    'rechecks %s just before prompt delivery',
    async (kind) => {
      const run = await h.create()
      const task = idOf(
        resultOf(
          await h.call(
            'orchestration.taskCreate',
            {
              run,
              callerTerminalHandle: COORD,
              spec: 'work'
            },
            COORD
          )
        ).task
      )
      let wrote = false
      vi.spyOn(h.runtime, 'sendTerminalAgentPrompt').mockImplementation(
        async (_handle, _text, options) => {
          if (kind === 'coordinator') {
            h.authorities.get(COORD)!.processIncarnation = 'replaced'
          } else if (kind === 'worker-token') {
            h.authorities.get(WORKER)!.launchTokenHash = 'replaced'
          } else {
            h.authorities.get(WORKER)!.hostScope = { kind: 'ssh', targetId: 'other-host' }
          }
          await options?.beforeWrite?.(`pty-${WORKER}`)
          wrote = true
          throw new Error('should not reach the write')
        }
      )
      expect(
        await h.call(
          'orchestration.dispatch',
          { run, from: COORD, task, to: WORKER, inject: true },
          COORD
        )
      ).toMatchObject(refused)
      expect(wrote).toBe(false)
      expect(h.db.getDispatchContext(task)?.status).toBe('failed')
    }
  )
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { COORD, WORKER, strictCoordinatorHarness } from './strict-coordinator-test-fixture'
import { resultOf } from './orchestration-session-caller-test-fixture'

describe.each([false, true])('strict worker-start (streaming=%s)', (streaming) => {
  let h: ReturnType<typeof strictCoordinatorHarness>
  beforeEach(() => {
    h = strictCoordinatorHarness(streaming)
    vi.spyOn(h.runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Workspace resolution only reads worktreeId from this terminal fixture.
    vi.spyOn(h.runtime, 'showTerminal').mockResolvedValue({
      handle: COORD,
      worktreeId: 'folder'
    } as never)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Existing-workspace placement only reads id and repoId from this fixture.
    vi.spyOn(h.runtime, 'showManagedTerminalWorkspace').mockResolvedValue({
      id: 'folder',
      repoId: 'repo'
    } as never)
    vi.spyOn(h.runtime, 'createTerminal').mockResolvedValue({
      handle: WORKER,
      worktreeId: 'folder',
      title: 'worker'
    })
    vi.spyOn(h.runtime, 'waitForTerminal').mockResolvedValue({
      handle: WORKER,
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    })
    vi.spyOn(h.runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
    vi.spyOn(h.runtime, 'getExactWorkerProviderSession').mockReturnValue(null)
  })
  afterEach(() => h.close())

  it('starts a terminal Worker through the pinned Coordinator and prevents nested dispatch instructions', async () => {
    const run = await h.create()
    const send = vi
      .spyOn(h.runtime, 'sendTerminalAgentPrompt')
      .mockImplementation(async (_handle, _text, options) => {
        await options?.beforeWrite?.(`pty-${WORKER}`)
        return { handle: WORKER, accepted: true, bytesWritten: 1 }
      })
    const result = resultOf(
      await h.call(
        'orchestration.workerStart',
        {
          run,
          from: COORD,
          spec: 'Independent research',
          agent: 'codex',
          mode: 'terminal'
        },
        COORD
      )
    )
    expect(result).toMatchObject({ state: 'ready', runId: run })
    expect(send).toHaveBeenCalledOnce()
    expect(send.mock.calls[0]?.[1]).not.toContain('orca orchestration worker-start')
    expect(h.db.listWorkerTerminalResources({ runId: run })).toHaveLength(1)
  })

  it('retains a failed attempt without delivering work when the Coordinator changes during readiness', async () => {
    const run = await h.create()
    const send = vi.spyOn(h.runtime, 'sendTerminalAgentPrompt')
    vi.mocked(h.runtime.waitForTerminal).mockImplementation(async () => {
      h.authorities.get(COORD)!.processIncarnation = 'replaced'
      return {
        handle: WORKER,
        condition: 'tui-idle',
        satisfied: true,
        status: 'running',
        exitCode: null
      }
    })
    const result = resultOf(
      await h.call(
        'orchestration.workerStart',
        {
          run,
          from: COORD,
          spec: 'Independent research',
          agent: 'codex',
          mode: 'terminal'
        },
        COORD
      )
    )
    expect(result).toMatchObject({ state: 'failed', runId: run })
    expect(send).not.toHaveBeenCalled()
    expect(h.db.listWorkerTerminalResources({ runId: run })).toHaveLength(1)
  })
})

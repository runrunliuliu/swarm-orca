import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOrchestrationWorkerReleaseHarness } from './worker-release.test-support'

describe('worker-show provider-session accounting receipt', () => {
  const h = createOrchestrationWorkerReleaseHarness()
  afterEach(() => h.cleanup())

  function createReadyTraeDispatch(): string {
    const task = h.db.createTask({ spec: 'accounting receipt fixture', runId: h.activeRunId })
    // Exercise workerShow's real authority checks without simulating the unrelated startup handshake.
    const { dispatch } = h.db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: 1,
      taskId: task.id,
      startOptions: { agent: 'trae' }
    })
    h.db.prepareStartingWorkerAuthority({
      dispatchId: dispatch.id,
      handle: 'term_worker',
      paneKey: h.workerPaneKey,
      processIncarnation: 'runtime_test:term_worker:1',
      worktreeId: 'repo::worktree',
      effects: [],
      setupState: 'not_applicable',
      terminalOwnership: 'created'
    })
    h.db.markWorkerDispatchReady(dispatch.id)
    return dispatch.id
  }

  it('publishes the canonical session using the exact terminal and worker start fence', async () => {
    h.setup()
    const dispatchId = createReadyTraeDispatch()
    const session = {
      paneKey: h.workerPaneKey,
      processIncarnation: 'runtime_test:term_worker:1',
      connectionId: null,
      agent: 'trae' as const,
      providerSession: {
        key: 'session_id' as const,
        id: 'thread-1',
        transcriptPath: '/sessions/thread-1.jsonl'
      },
      observedAt: Date.now()
    }
    const selector = vi.mocked(h.runtime.getExactWorkerProviderSession)
    selector.mockClear().mockReturnValue(session)
    await expect(
      h.call('orchestration.workerShow', { dispatch: dispatchId })
    ).resolves.toMatchObject({ providerSession: session })
    expect(selector).toHaveBeenCalledWith('term_worker', expect.any(Number))
    expect(selector.mock.calls[0][1]).toBeGreaterThan(0)
  })

  it('never publishes a session for a different process incarnation', async () => {
    h.setup()
    const dispatchId = createReadyTraeDispatch()
    vi.mocked(h.runtime.getTerminalProcessIncarnation).mockReturnValue('replaced')
    h.inspectProcessLiveness.mockResolvedValue('exited')
    const selector = vi.mocked(h.runtime.getExactWorkerProviderSession)
    selector.mockClear()
    await expect(
      h.call('orchestration.workerShow', { dispatch: dispatchId })
    ).resolves.toMatchObject({ providerSession: null })
    expect(selector).not.toHaveBeenCalled()
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createOrchestrationWorkerReleaseHarness } from './worker-release.test-support'

const deliverySchema = z.object({
  deliveryId: z.string(),
  messages: z.array(z.object({ id: z.string(), body: z.string(), payload: z.string() }))
})

describe('fresh Trae durable task delivery', () => {
  const h = createOrchestrationWorkerReleaseHarness()
  beforeEach(() => {
    h.setup()
    vi.useFakeTimers()
    vi.spyOn(h.runtime, 'showTerminalWorkspaceLaunchScope').mockResolvedValue({
      id: 'repo::worktree',
      path: 'worktree',
      connectionId: null,
      repo: null,
      folderWorkspace: null
    })
    vi.spyOn(h.runtime, 'waitForFreshWorkerComposer').mockImplementation(() => {
      throw new Error('No screen-based readiness allowed')
    })
  })
  afterEach(() => {
    vi.useRealTimers()
    h.cleanup()
  })

  function start(options: Record<string, unknown> = {}) {
    const queued = h.deferred<string>()
    const insert = h.db.insertMessage.bind(h.db)
    vi.spyOn(h.db, 'insertMessage').mockImplementation((message) => {
      const result = insert(message)
      if (message.type === 'dispatch') {
        queued.resolve(result.to_handle)
      }
      return result
    })
    const task = h.db.createTask({ spec: 'mailbox task', runId: h.activeRunId })
    const pending = h.call('orchestration.workerStart', {
      task: task.id,
      from: 'term_coord',
      agent: 'trae',
      timeoutMs: 5_000,
      ...options
    })
    return { pending, queued: queued.promise }
  }

  async function receiveAndReport() {
    const receipt = deliverySchema.parse(
      await h.call('orchestration.check', { terminal: 'term_worker' })
    )
    const body = receipt.messages[0]?.body ?? ''
    const [, taskId, dispatchId, threadId] =
      body.match(/--task-id (\S+) --dispatch-id (\S+) --phase "startup" --thread-id (\S+)/) ?? []
    if (!taskId || !dispatchId || !threadId) {
      throw new Error('Missing startup command')
    }
    await h.call('orchestration.check', { terminal: 'term_worker', ack: receipt.deliveryId })
    await h.call('orchestration.send', {
      from: 'term_worker',
      type: 'heartbeat',
      subject: 'worker_started',
      threadId,
      payload: JSON.stringify({ taskId, dispatchId, threadId, phase: 'startup' })
    })
    await vi.advanceTimersByTimeAsync(100)
    return receipt
  }

  it('replays one durable delivery until acknowledged; queued input alone is not ready', async () => {
    const { pending, queued } = start()
    const address = await queued
    const first = deliverySchema.parse(
      await h.call('orchestration.check', { terminal: 'term_worker' })
    )
    const second = await h.call('orchestration.check', { terminal: 'term_worker' })
    expect(second).toMatchObject({ ...first, replayed: true })
    expect(h.db.getWorkerDispatch(address.slice('dispatch:'.length))?.state).toBe('starting')
    await receiveAndReport()
    await expect(pending).resolves.toMatchObject({ state: 'ready' })
    expect(h.db.getUnreadMessages(address)).toHaveLength(0)
    expect(h.runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
    expect(h.runtime.readTerminal).not.toHaveBeenCalled()
  })

  it('wakes a check started before Dispatch binding, whose next check gets the task', async () => {
    const entered = h.deferred<void>()
    const wake = h.deferred<'notified'>()
    vi.spyOn(h.runtime, 'waitForMessage').mockImplementation((address) => {
      expect(address).toBe('term_worker')
      entered.resolve()
      return wake.promise
    })
    vi.mocked(h.runtime.notifyMessageArrived).mockImplementation((address) => {
      if (address === 'term_worker') {
        wake.resolve('notified')
      }
    })
    const beforeBinding = h.call('orchestration.check', {
      terminal: 'term_worker',
      wait: true,
      timeoutMs: 1000
    })
    await entered.promise
    const { pending, queued } = start()
    await queued
    await expect(beforeBinding).resolves.toMatchObject({ count: 0 })
    await receiveAndReport()
    await expect(pending).resolves.toMatchObject({ state: 'ready' })
  })

  it('keeps the durable task when nudging fails and accepts a delayed startup within its budget', async () => {
    vi.mocked(h.runtime.notifyMessageArrived).mockImplementation(() => {
      throw new Error('lost wake-up')
    })
    const { pending, queued } = start()
    await queued
    await vi.advanceTimersByTimeAsync(4_000)
    vi.mocked(h.runtime.notifyMessageArrived).mockImplementation(() => {})
    await receiveAndReport()
    await expect(pending).resolves.toMatchObject({ state: 'ready' })
  })

  it('retains undelivered mail and the worker after the configured timeout, without resending', async () => {
    const { pending, queued } = start({ timeoutMs: 750 })
    const address = await queued
    await vi.advanceTimersByTimeAsync(750)
    await expect(pending).resolves.toMatchObject({ state: 'outcome_unknown', timeoutMs: 750 })
    expect(h.db.getUnreadMessages(address)).toHaveLength(1)
    expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
    expect(h.runtime.createTerminal).toHaveBeenCalledOnce()
    expect(h.runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })

  function createdSetup() {
    vi.spyOn(h.runtime, 'showManagedWorktree').mockResolvedValue({
      id: 'repo::parent',
      repoId: 'repo'
    })
    vi.spyOn(h.runtime, 'showRepo').mockResolvedValue({
      id: 'repo',
      path: '/repo',
      displayName: 'Repo',
      badgeColor: '',
      addedAt: 0
    })
    vi.spyOn(h.runtime, 'createManagedWorktree').mockResolvedValue({
      worktree: {
        id: 'repo::child',
        repoId: 'repo',
        path: '/repo/child',
        head: 'test-head',
        branch: 'worker',
        isBare: false,
        isMainWorktree: false,
        displayName: 'Worker',
        comment: '',
        linkedIssue: null,
        linkedPR: null,
        linkedLinearIssue: null,
        isArchived: false,
        isUnread: false,
        isPinned: false,
        sortOrder: 0,
        lastActivityAt: 0
      },
      startupTerminal: { spawned: true, handle: 'term_worker' },
      setupReceipt: {
        requested: 'run',
        hookFound: true,
        startupPolicy: 'wait-for-setup',
        state: 'running',
        terminalHandle: 'term_setup'
      }
    })
    vi.spyOn(h.runtime, 'listTerminals').mockResolvedValue({
      terminals: [],
      totalCount: 0,
      truncated: false
    })
  }

  it('passes the bootstrap through agent-first worktree creation and waits for setup completion', async () => {
    createdSetup()
    const setup = h.deferred<{ exitCode: number }>()
    vi.spyOn(h.runtime, 'waitForSetupTerminalCompletion').mockReturnValue(setup.promise)
    const { pending, queued } = start({ worktree: 'new-child', name: 'worker' })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.runtime.waitForSetupTerminalCompletion).toHaveBeenCalledWith('term_setup')
    expect(h.db.insertMessage).not.toHaveBeenCalled()
    expect(h.runtime.createManagedWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        startupAgent: 'trae',
        startupPrompt: expect.stringContaining('orchestration check --wait')
      })
    )
    setup.resolve({ exitCode: 0 })
    await queued
    await receiveAndReport()
    await expect(pending).resolves.toMatchObject({ state: 'ready', setup: { state: 'succeeded' } })
    expect(h.runtime.createTerminal).not.toHaveBeenCalled()
    expect(h.runtime.waitForFreshWorkerComposer).not.toHaveBeenCalled()
  })

  it('does not enqueue the task after setup fails', async () => {
    createdSetup()
    vi.spyOn(h.runtime, 'waitForSetupTerminalCompletion').mockResolvedValue({ exitCode: 1 })
    const { pending } = start({ worktree: 'new-child', name: 'worker' })
    await expect(pending).resolves.toMatchObject({ state: 'failed', failedStage: 'setup_wait' })
    expect(h.db.insertMessage).not.toHaveBeenCalled()
    expect(h.runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })
})

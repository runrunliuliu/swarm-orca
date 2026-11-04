import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeTerminalPromptDelivery } from '../../../../../../shared/runtime-terminal-contracts'
import { createOrchestrationWorkerReleaseHarness } from './worker-release.test-support'

type StartupCommand = { taskId: string; dispatchId: string; threadId: string }
const TASK_SPEC = 'Perform the real task after the startup check'
const STARTUP_TIMEOUT_MS = 60_000

function readStartupCommand(text: string): StartupCommand {
  const [, taskId, dispatchId, threadId] =
    text.match(
      /^orca orchestration send --from term_worker --type heartbeat --subject "worker_started" --task-id (\S+) --dispatch-id (\S+) --phase "startup" --thread-id (\S+)$/m
    ) ?? []
  if (!taskId || !dispatchId || !threadId) {
    throw new Error('Missing executable startup command')
  }
  return { taskId, dispatchId, threadId }
}

function nativeDelivery(
  overrides: Partial<RuntimeTerminalPromptDelivery> = {}
): RuntimeTerminalPromptDelivery {
  return {
    requestId: 'req_startup',
    stages: ['input_accepted'],
    provider: 'unsupported',
    observation: 'unsupported',
    processIncarnation: 'runtime_test:term_worker:1',
    generation: 1,
    baselineWorkingSequence: 0,
    ...overrides
  }
}

describe('Trae executable startup check', () => {
  const h = createOrchestrationWorkerReleaseHarness()
  beforeEach(() => {
    h.setup()
    vi.spyOn(h.runtime, 'waitForFreshWorkerComposer').mockResolvedValue()
    vi.spyOn(h.runtime, 'showTerminalWorkspaceLaunchScope').mockResolvedValue({
      id: 'repo::worktree',
      path: 'worktree',
      connectionId: null,
      repo: null,
      folderWorkspace: null
    })
  })
  afterEach(() => {
    vi.useRealTimers()
    h.cleanup()
  })

  function start(preferences: { model?: string; effort?: string; backendVariant?: string } = {}) {
    const task = h.db.createTask({ spec: TASK_SPEC, runId: h.activeRunId })
    return h.call('orchestration.workerStart', {
      task: task.id,
      from: 'term_coord',
      agent: 'trae',
      ...preferences
    })
  }

  function interceptPrompt(
    onSubmit: (command: StartupCommand) => void | Promise<void> = () => {},
    prompt?: RuntimeTerminalPromptDelivery
  ) {
    if (prompt) {
      vi.mocked(h.runtime.sendTerminalAgentPrompt).mockResolvedValue({
        handle: 'term_worker',
        accepted: true,
        bytesWritten: 0,
        prompt
      })
    }
    return new Promise<StartupCommand>((resolve, reject) => {
      vi.mocked(h.runtime.notifyMessageArrived).mockImplementation((address, type) => {
        if (!address.startsWith('dispatch:') || type !== 'dispatch') {
          return
        }
        void (async () => {
          const [message] = h.db.getUnreadMessages(address)
          if (!message) {
            throw new Error('Missing durable preamble')
          }
          const text = message.body ?? ''
          const command = readStartupCommand(text)
          expect(text).toContain(`=== TASK ===\n${TASK_SPEC}`)
          expect(text.match(/--subject "worker_started"/g)).toHaveLength(1)
          const checked = await h.call('orchestration.check', { terminal: 'term_worker' })
          expect(checked).toMatchObject({
            deliveryId: expect.any(String),
            messages: [expect.objectContaining({ id: message.id, body: text })]
          })
          if (typeof checked !== 'object' || !checked || !('deliveryId' in checked)) {
            throw new Error('Missing delivery receipt')
          }
          await h.call('orchestration.check', {
            terminal: 'term_worker',
            ack: checked.deliveryId
          })
          await onSubmit(command)
          resolve(command)
        })().catch(reject)
      })
    })
  }

  async function acknowledge(command: StartupCommand): Promise<void> {
    await h.call('orchestration.send', {
      from: 'term_worker',
      type: 'heartbeat',
      subject: 'worker_started',
      threadId: command.threadId,
      payload: JSON.stringify({ ...command, phase: 'startup' })
    })
  }

  function expectRetained(command: StartupCommand): void {
    expect(h.db.getWorkerDispatch(command.dispatchId)?.state).toBe('start_unknown')
    expect(h.db.getDispatchContextById(command.dispatchId)?.capability_revoked_at).toBeNull()
    expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
    expect(h.runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
  }

  it.each([
    { model: 'gpt-5.6-sol', effort: 'high', backendVariant: 'max' },
    { model: 'gpt-5.4', effort: 'xhigh', backendVariant: 'standard' }
  ])('carries GPT overrides through fresh placement: %j', async (preferences) => {
    interceptPrompt(acknowledge)
    await expect(start(preferences)).resolves.toMatchObject({
      state: 'ready',
      launch: {
        requested: { agent: 'trae', ...preferences },
        effective: { agent: 'trae', ...preferences }
      },
      startupHandshake: { verdict: 'observed' }
    })
    expect(h.runtime.createTerminal).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ launchPreferences: preferences })
    )
    expect(h.runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })

  it('launches an argv bootstrap and confirms mailbox delivery without a screen gate', async () => {
    vi.mocked(h.runtime.waitForFreshWorkerComposer).mockImplementation(() => {
      throw new Error('Screen parsing must not gate Trae')
    })
    const submitted = interceptPrompt(acknowledge)
    const pending = start()
    const command = await submitted
    await expect(pending).resolves.toMatchObject({
      state: 'ready',
      turnStart: 'unsupported',
      startupHandshake: { threadId: command.threadId, verdict: 'observed' }
    })
    expect(h.runtime.createTerminal).toHaveBeenCalledWith(
      'id:repo::worktree',
      expect.objectContaining({
        startupAgent: 'trae',
        startupPrompt: expect.stringContaining(`expected Dispatch: ${command.dispatchId}`)
      })
    )
    expect(h.runtime.waitForFreshWorkerComposer).not.toHaveBeenCalled()
    expect(h.runtime.waitForTerminal).not.toHaveBeenCalled()
    expect(h.runtime.readTerminal).not.toHaveBeenCalled()
    expect(h.runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
    await h.call('orchestration.send', {
      from: 'term_worker',
      type: 'heartbeat',
      subject: 'alive',
      payload: JSON.stringify({ taskId: command.taskId, dispatchId: command.dispatchId })
    })
    expect(h.db.getDispatchContextById(command.dispatchId)?.last_heartbeat_at).toBeTruthy()
  })

  it('sees an early callback already consumed by the coordinator without taking its waiter', async () => {
    const waiter = vi.spyOn(h.runtime, 'waitForMessage')
    interceptPrompt(async (command) => {
      await acknowledge(command)
      const messages = h.db.getThreadMessagesFor(command.threadId, `run:${h.activeRunId}`)
      expect(messages).toHaveLength(1)
      h.db.markAsReadAndDelivered(messages.map((message) => message.id))
    })
    await expect(start()).resolves.toMatchObject({
      state: 'ready',
      startupHandshake: { verdict: 'observed', messageId: expect.any(String) }
    })
    expect(waiter).not.toHaveBeenCalled()
  })

  const nativeCases: {
    name: string
    prompt?: RuntimeTerminalPromptDelivery
    turnStart: string
  }[] = [
    { name: 'a missing receipt', turnStart: 'unsupported' },
    { name: 'unsupported observation', prompt: nativeDelivery(), turnStart: 'unsupported' },
    {
      name: 'native turn-start alone',
      prompt: nativeDelivery({ stages: ['input_accepted', 'turn_started'] }),
      turnStart: 'unsupported'
    },
    {
      name: 'supported observation without a turn-start',
      prompt: nativeDelivery({ provider: 'codex', observation: 'supported' }),
      turnStart: 'unsupported'
    }
  ]
  it.each(nativeCases)('does not confirm startup from $name', async ({ prompt, turnStart }) => {
    vi.useFakeTimers()
    const observe = vi.spyOn(h.runtime, 'observeTerminalAgentPrompt')
    if (prompt) {
      observe.mockResolvedValue(prompt)
    }
    const submitted = interceptPrompt(undefined, prompt)
    const pending = start()
    const command = await submitted
    await vi.advanceTimersByTimeAsync(STARTUP_TIMEOUT_MS)
    await expect(pending).resolves.toMatchObject({
      state: 'outcome_unknown',
      stage: 'startup_handshake_unobserved',
      turnStart,
      startupHandshake: { verdict: 'unobserved' },
      lastError: expect.stringContaining('do not resend the task blindly')
    })
    expectRetained(command)
    expect(observe).not.toHaveBeenCalled()
  })

  it('ignores ordinary messages and old callbacks, then sees a later matching callback', async () => {
    vi.useFakeTimers()
    let ignoredSequence: number | undefined
    const reads = vi.spyOn(h.db, 'getThreadMessagesFor')
    const submitted = interceptPrompt(async (command) => {
      ignoredSequence = h.db.insertMessage({
        from: 'term_worker',
        to: `run:${h.activeRunId}`,
        runId: h.activeRunId,
        senderPaneKey: h.workerPaneKey,
        type: 'status',
        subject: 'worker_started',
        threadId: command.threadId,
        payload: JSON.stringify({ ...command, phase: 'startup' })
      }).sequence
      await acknowledge({ ...command, threadId: 'previous-startup' })
    })
    let finished = false
    const pending = start().then((result) => {
      finished = true
      return result
    })
    const command = await submitted
    await vi.advanceTimersByTimeAsync(200)
    expect(finished).toBe(false)
    expect(reads).toHaveBeenLastCalledWith(
      command.threadId,
      `run:${h.activeRunId}`,
      ignoredSequence
    )
    expect(h.runtime.readTerminal).not.toHaveBeenCalled()
    await acknowledge(command)
    await vi.advanceTimersByTimeAsync(100)
    await expect(pending).resolves.toMatchObject({
      state: 'ready',
      startupHandshake: { verdict: 'observed' }
    })
  })

  it('rejects even a valid callback when the worker process has been replaced', async () => {
    const submitted = interceptPrompt(async (command) => {
      await acknowledge(command)
      vi.mocked(h.runtime.getTerminalProcessIncarnation).mockReturnValue('replacement-process')
    })
    const pending = start()
    const command = await submitted
    await expect(pending).resolves.toMatchObject({
      state: 'outcome_unknown',
      startupHandshake: { verdict: 'unobserved' },
      lastError: expect.stringContaining('process identity changed')
    })
    expectRetained(command)
  })

  it('retains submitted work when reading the callback fails', async () => {
    vi.spyOn(h.db, 'getThreadMessagesFor').mockImplementation(() => {
      throw new Error('Callback database temporarily unavailable')
    })
    const submitted = interceptPrompt()
    const pending = start()
    const command = await submitted
    await expect(pending).resolves.toMatchObject({ state: 'outcome_unknown' })
    expectRetained(command)
  })

  it('preserves a real task completion that arrives during the startup wait', async () => {
    vi.useFakeTimers()
    const submitted = interceptPrompt()
    const pending = start()
    const command = await submitted
    await vi.advanceTimersByTimeAsync(0)
    h.settle(command.taskId, command.dispatchId, 'succeeded')
    await vi.advanceTimersByTimeAsync(100)
    await expect(pending).resolves.toMatchObject({
      state: 'ready',
      stage: 'settled',
      workerOutcome: 'succeeded'
    })
  })

  it('allows the real task report to settle after startup timed out, without resending', async () => {
    vi.useFakeTimers()
    const submitted = interceptPrompt()
    const pending = start()
    const command = await submitted
    await vi.advanceTimersByTimeAsync(STARTUP_TIMEOUT_MS)
    await expect(pending).resolves.toMatchObject({ state: 'outcome_unknown' })
    expectRetained(command)
    await h.call('orchestration.send', {
      from: 'term_worker',
      type: 'worker_done',
      subject: 'done',
      payload: JSON.stringify({ ...command, outcome: 'succeeded' })
    })
    expect(h.db.getWorkerDispatch(command.dispatchId)?.state).toBe('succeeded')
    expect(h.db.getTask(command.taskId)?.status).toBe('completed')
    expect(h.runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })

  it('does not launch when target CLI resolution fails', async () => {
    const reason = 'runtime_access_denied'
    vi.mocked(h.runtime.showTerminalWorkspaceLaunchScope).mockRejectedValue(new Error(reason))
    await expect(start()).resolves.toMatchObject({
      state: 'failed',
      stage: 'terminal_create',
      failedStage: 'terminal_create',
      lastError: reason
    })
    expect(h.runtime.sendTerminalAgentPrompt).not.toHaveBeenCalled()
    expect(h.runtime.waitForTerminal).not.toHaveBeenCalled()
    expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
    expect(h.runtime.createTerminal).not.toHaveBeenCalled()
  })

  it.each([{ agent: 'codex' }, { terminal: 'term_worker' }] as const)(
    'keeps existing startup behavior for %o',
    async (options) => {
      await h.startWorker(options)
      expect(h.runtime.waitForFreshWorkerComposer).not.toHaveBeenCalled()
      const text = vi.mocked(h.runtime.sendTerminalAgentPrompt).mock.calls[0]?.[1]
      expect(text).not.toContain('STARTUP CHECK')
    }
  )
})

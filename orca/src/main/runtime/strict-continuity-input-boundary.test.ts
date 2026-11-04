import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_PROMPT_BRACKETED_PASTE_END } from '../../shared/agent-prompt-injection'
import { createAgentPromptSubmissionRuntime } from './agent-prompt-submission-runtime-test-fixture'
import { strictCoordinatorHarness } from './rpc/strict-coordinator-test-fixture'
import { sealStrictContinuityDatabase } from './orchestration/strict-continuity-store'
import { bindStrictContinuityResume } from './orchestration/strict-continuity-resume'
import {
  createBoundRun,
  createRuntime,
  driveToLiveIdle,
  insertDirectRunMessage,
  pointerCount,
  TERMINAL_HANDLE
} from './orchestration-mailbox-notification-test-harness'

vi.mock('../git/worktree', () => {
  const worktrees = [
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/prompt-verification',
      isBare: false,
      isMainWorktree: false
    }
  ]
  return {
    listWorktrees: vi.fn().mockResolvedValue(worktrees),
    listWorktreesStrict: vi.fn().mockResolvedValue(worktrees)
  }
})

describe('continuity fence at the PTY effect boundary', () => {
  let h: ReturnType<typeof strictCoordinatorHarness>
  let runId: string
  beforeEach(async () => {
    h = strictCoordinatorHarness()
    runId = await h.create()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    h.close()
  })
  const seal = () =>
    sealStrictContinuityDatabase(h.db, {
      runId,
      sourceRuntimeId: h.runtime.getRuntimeId(),
      expiresAtMs: Date.now() + 60_000
    })

  it('refuses paste before any bytes are written', async () => {
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(() => undefined)
    runtime.setOrchestrationDb(h.db)
    seal()
    await expect(
      runtime.sendTerminalAgentPrompt(handle, 'do not send', { inputKind: 'driving' })
    ).rejects.toThrow('fenced')
    expect(writes).toEqual([])
  })

  it('refuses Enter if sealed after the paste and never retries the staged text', async () => {
    const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(
      (_runtime, data) => {
        if (data.includes(AGENT_PROMPT_BRACKETED_PASTE_END)) {
          queueMicrotask(seal)
        }
      }
    )
    runtime.setOrchestrationDb(h.db)
    const rejected = expect(
      runtime.sendTerminalAgentPrompt(handle, 'staged only', { inputKind: 'driving' })
    ).rejects.toThrow('fenced')
    await vi.runAllTimersAsync()
    await rejected
    expect(writes).toHaveLength(1)
    expect(writes[0]).toContain('staged only')
    expect(writes).not.toContain('\r')
    await expect(
      runtime.sendTerminalAgentPrompt(handle, 'staged only', { inputKind: 'driving' })
    ).rejects.toThrow('fenced')
    expect(writes).toHaveLength(1)
  })

  it.each([false, true])(
    'sends mailbox text and Enter on an admitted connection without consuming mail (headless=%s)',
    async (headless) => {
      const run = createBoundRun(h.db, 'resumed mailbox')
      const { runtime, write } = createRuntime(h.db, { headless })
      const message = insertDirectRunMessage(h.db, run.id, 'still pending after wakeup')
      await driveToLiveIdle(runtime)
      seal()
      // Admission is a fixture here; the native journal integration tests authenticate it.
      bindStrictContinuityResume(h.db.db, () => {})
      runtime.notifyMessageArrived(TERMINAL_HANDLE, 'status')
      await vi.advanceTimersByTimeAsync(2_000)
      expect(pointerCount(write)).toBe(1)
      expect(write.mock.calls.filter(([, data]) => data === '\r')).toHaveLength(1)
      expect(h.db.getMessageById(message.id)?.read).toBe(0)
    }
  )

  it.each([false, true])(
    'cancels delayed mailbox Enter without ACK (headless=%s)',
    async (headless) => {
      const run = createBoundRun(h.db, 'mailbox fence')
      const { runtime, write } = createRuntime(h.db, { headless })
      const message = insertDirectRunMessage(h.db, run.id, 'must remain pending')
      await driveToLiveIdle(runtime)
      runtime.notifyMessageArrived(TERMINAL_HANDLE, 'status')
      await Promise.resolve()
      expect(pointerCount(write)).toBe(1)
      // Allow the accepted provider write to settle; the delayed Enter is still pending.
      await vi.advanceTimersByTimeAsync(0)
      seal()
      await vi.advanceTimersByTimeAsync(2_000)
      expect(write.mock.calls.filter(([, data]) => data === '\r')).toHaveLength(0)
      expect(h.db.getMessageById(message.id)?.read).toBe(0)
      runtime.notifyMessageArrived(TERMINAL_HANDLE, 'status')
      await vi.advanceTimersByTimeAsync(2_000)
      expect(pointerCount(write)).toBe(1)
    }
  )
})

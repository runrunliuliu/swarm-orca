import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { waitForAgentReady } from './agent-ready-wait'
import { useAppStore } from '@/store'
import { inspectRuntimeTerminalProcess } from '@/runtime/runtime-terminal-inspection'

vi.mock('@/store', () => ({
  useAppStore: {
    getState: vi.fn()
  }
}))

vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  inspectRuntimeTerminalProcess: vi.fn()
}))

vi.mock('./tui-agent-startup', () => ({
  isShellProcess: vi.fn(() => false)
}))

describe('waitForAgentReady', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('window', { setTimeout })
    vi.mocked(useAppStore.getState).mockReturnValue({
      ptyIdsByTabId: { 'tab-1': ['pty-1'] },
      runtimePaneTitlesByTabId: {},
      tabsByWorktree: {},
      settings: {}
    } as never)
  })

  afterEach(() => vi.useRealTimers())

  it('recognizes a Windows foreground process reported as a full executable path', async () => {
    vi.mocked(inspectRuntimeTerminalProcess).mockResolvedValue({
      foregroundProcess: String.raw`C:\Users\dev\AppData\Roaming\npm\claude.exe`,
      hasChildProcesses: false
    })

    await expect(waitForAgentReady('tab-1', 'claude', { timeoutMs: 100 })).resolves.toEqual({
      ready: true,
      reason: 'foreground-match'
    })
  })

  it('bounds a hanging process inspection by the caller deadline', async () => {
    vi.useFakeTimers()
    vi.mocked(inspectRuntimeTerminalProcess).mockReturnValue(new Promise(() => {}))

    const ready = waitForAgentReady('tab-1', 'traecli', { timeoutMs: 1000 })
    await vi.advanceTimersByTimeAsync(1000)

    await expect(ready).resolves.toEqual({ ready: false, reason: 'timeout' })
    expect(inspectRuntimeTerminalProcess).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})

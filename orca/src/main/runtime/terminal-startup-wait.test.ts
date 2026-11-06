import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTranscriptPane, TRANSCRIPT_PANE_PTY_ID } from './agent-transcript-pane-test-harness'
import { waitForTraeStartupComposer } from './runtime-trae-startup-composer'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

async function pane(connectionId?: string, launchAgent: 'trae' | 'codex' = 'trae') {
  const result = await createTranscriptPane({
    paneTitle: 'worker-trae',
    foregroundProcess: 'traecli',
    launchAgent,
    connectionId,
    data: readFileSync(join(__dirname, '__fixtures__/trae-ready-linux.txt'), 'utf8'),
    size: { cols: 120, rows: 40 }
  })
  result.runtime.terminalRunFacts.recordSpawnCommit({
    id: TRANSCRIPT_PANE_PTY_ID,
    incarnationId: 'inc-1'
  })
  return result
}

describe('explicit first-task startup wait', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it.each([undefined, 'ssh:test-host'])(
    'accepts the captured composer on %s without ordinary idle',
    async (connectionId) => {
      const { runtime, handle } = await pane(connectionId)
      await expect(runtime.waitForTerminalStartup(handle, { timeoutMs: 1000 })).resolves.toEqual({
        handle,
        agent: 'trae',
        ready: true,
        incarnationId: 'inc-1'
      })
      await expect(
        runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 20 })
      ).rejects.toThrow('timeout')
    }
  )

  it('requires launch identity rather than trusting Trae-looking text', async () => {
    const { runtime, handle } = await pane(undefined, 'codex')
    await expect(runtime.waitForTerminalStartup(handle, { timeoutMs: 1000 })).rejects.toThrow(
      'terminal_startup_agent_unsupported'
    )
  })

  it('rejects a caller incarnation mismatch', async () => {
    const { runtime, handle } = await pane()
    await expect(
      runtime.waitForTerminalStartup(handle, {
        timeoutMs: 1000,
        expectedIncarnationId: 'replaced'
      })
    ).rejects.toThrow('terminal_handle_stale')
  })

  it.each([false, true])('rejects an observed working turn (then idle: %s)', async (thenIdle) => {
    const { runtime, handle } = await pane()
    runtime.onPtyData(
      TRANSCRIPT_PANE_PTY_ID,
      '\x1b]9999;{"state":"working","agentType":"trae"}\x07',
      Date.now()
    )
    if (thenIdle) {
      runtime.onPtyData(
        TRANSCRIPT_PANE_PTY_ID,
        '\x1b]9999;{"state":"done","agentType":"trae"}\x07',
        Date.now()
      )
    }
    await expect(runtime.waitForTerminalStartup(handle, { timeoutMs: 1000 })).rejects.toThrow(
      'terminal_not_fresh'
    )
  })

  it('rejects input arriving during a screen read', async () => {
    const { runtime, handle } = await pane()
    const read = runtime.readTerminal.bind(runtime)
    vi.spyOn(runtime, 'readTerminal').mockImplementationOnce(async (...args) => {
      const frame = await read(...args)
      runtime.terminalRunFacts.recordInput(TRANSCRIPT_PANE_PTY_ID, 'driving', 'task\r')
      return frame
    })
    await expect(runtime.waitForTerminalStartup(handle, { timeoutMs: 1000 })).rejects.toThrow(
      'terminal_not_fresh'
    )
  })

  it('refuses a process with incomplete input history', async () => {
    const { runtime, handle } = await pane()
    runtime.terminalRunFacts.recordSpawnCommit({ id: TRANSCRIPT_PANE_PTY_ID })
    await expect(runtime.waitForTerminalStartup(handle, { timeoutMs: 1000 })).rejects.toThrow(
      'terminal_not_fresh'
    )
  })

  it('rejects a process replacement during the screen read', async () => {
    const { runtime, handle } = await pane()
    const read = runtime.readTerminal.bind(runtime)
    vi.spyOn(runtime, 'readTerminal').mockImplementationOnce(async (...args) => {
      const frame = await read(...args)
      runtime.registerPty(TRANSCRIPT_PANE_PTY_ID, 'wt-1', null, {
        tabId: 'tab-1',
        leafId: '11111111-1111-4111-8111-111111111111',
        incarnationId: 'inc-2'
      })
      return frame
    })
    await expect(runtime.waitForTerminalStartup(handle, { timeoutMs: 1000 })).rejects.toThrow(
      'terminal_handle_stale'
    )
  })

  it('rechecks freshness after an asynchronous screen read', async () => {
    const { runtime, handle } = await pane()
    const read = await runtime.readTerminal(handle, { screen: true })
    const assertFresh = vi
      .fn()
      .mockImplementationOnce(() => {})
      .mockImplementation(() => {
        throw new Error('terminal_not_fresh')
      })
    await expect(
      waitForTraeStartupComposer(async () => read, 1000, { assertFresh })
    ).rejects.toThrow('terminal_not_fresh')
    expect(assertFresh).toHaveBeenCalledTimes(2)
  })

  it('aborts a hanging read immediately and removes its deadline timer', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const pending = waitForTraeStartupComposer(() => new Promise(() => {}), 60_000, {
      signal: controller.signal
    })
    const assertion = expect(pending).rejects.toThrow('request_aborted')
    controller.abort()
    await assertion
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not read for an already cancelled request', async () => {
    const read = vi.fn()
    await expect(
      waitForTraeStartupComposer(read, 1000, { signal: AbortSignal.abort() })
    ).rejects.toThrow('request_aborted')
    expect(read).not.toHaveBeenCalled()
  })
})

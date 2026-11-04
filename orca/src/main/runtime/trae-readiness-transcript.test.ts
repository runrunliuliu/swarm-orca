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

function transcript(name = 'trae-ready-linux.txt'): Buffer {
  return readFileSync(join(__dirname, '__fixtures__', name))
}

const TRUST_TRANSCRIPT = 'trae-trust-workspace-linux.txt'
const TRUST_BLOCKED = 'Agent startup blocked: agent-trust-workspace'

function pane(data: string, connectionId?: string) {
  return createTranscriptPane({
    paneTitle: 'worker-trae',
    foregroundProcess: 'traecli',
    launchAgent: 'trae',
    data,
    connectionId,
    size: { cols: 120, rows: 40 }
  })
}

describe('Trae startup composer from captured terminal bytes', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it.each([undefined, 'ssh:test-host'])(
    'accepts the current composer despite ongoing banner repaint on host %s',
    async (connectionId) => {
      const data = transcript()
      const { runtime, handle } = await pane(data.subarray(0, 6427).toString(), connectionId)
      await expect(
        runtime.waitForFreshWorkerComposer(handle, 'trae', 1_000)
      ).resolves.toBeUndefined()
      runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, data.subarray(6427).toString(), Date.now())
      const read = await runtime.readTerminal(handle, { screen: true })
      expect(read.source).toBe('screen')
      expect(read.tail.join('\n')).toContain('Context 100% left')
      await expect(
        runtime.waitForFreshWorkerComposer(handle, 'trae', 1_000)
      ).resolves.toBeUndefined()
    }
  )

  it('waits through the loading composer until the captured loaded frame arrives', async () => {
    const data = transcript()
    const { runtime, handle } = await pane(data.subarray(0, 2296).toString())
    const loading = await runtime.readTerminal(handle, { screen: true })
    expect(loading.tail.join('\n')).toMatch(/model:\s+loading/)
    const reads = vi.spyOn(runtime, 'readTerminal')
    let ready = false
    const pending = runtime.waitForFreshWorkerComposer(handle, 'trae', 2_000).then(() => {
      ready = true
    })
    await vi.waitFor(() => expect(reads.mock.calls.length).toBeGreaterThanOrEqual(2))
    expect(ready).toBe(false)
    runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, data.subarray(2296).toString(), Date.now())
    await pending
    expect(ready).toBe(true)
  })

  it('rejects the current hooks menu even though an earlier composer exists in the replay', async () => {
    const data = transcript('trae-hooks-menu-linux.txt').toString()
    expect(data).toContain('Context 100% left')
    const { runtime, handle } = await pane(data)
    const read = await runtime.readTerminal(handle, { screen: true })
    expect(read.tail.join('\n')).toContain('PreToolUse')
    await expect(runtime.waitForFreshWorkerComposer(handle, 'trae', 100)).rejects.toThrow('timeout')
  })

  it.each([undefined, 'ssh:test-host'])(
    'reports the captured trust prompt on the first screen read on host %s',
    async (connectionId) => {
      const data = transcript(TRUST_TRANSCRIPT).toString()
      expect(data).toContain('\x1b')
      expect(data).toContain('\r')
      const { runtime, handle } = await pane(data, connectionId)
      const read = await runtime.readTerminal(handle, { screen: true })
      expect(read.source).toBe('screen')
      expect(read.tail.join('\n')).toContain('Folder access')
      const reads = vi.spyOn(runtime, 'readTerminal')
      vi.useFakeTimers()
      const started = Date.now()
      const pending = runtime.waitForFreshWorkerComposer(handle, 'trae', 60_000).catch(String)
      await vi.runAllTimersAsync()
      expect(await pending).toBe(`Error: ${TRUST_BLOCKED}`)
      expect(Date.now() - started).toBe(0)
      expect(reads).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('does not let captured trust history veto a later current composer', async () => {
    const { runtime, handle } = await pane(transcript(TRUST_TRANSCRIPT).toString())
    runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, transcript().toString(), Date.now())
    const read = await runtime.readTerminal(handle, { screen: true })
    expect(read.tail.join('\n')).not.toContain('Do you trust')
    await expect(runtime.waitForFreshWorkerComposer(handle, 'trae', 1_000)).resolves.toBeUndefined()
  })

  it.each(['stream', 'screen-unavailable'] as const)(
    'does not classify trust text from a %s fallback as a current blocker',
    async (source) => {
      const { runtime, handle } = await pane(transcript(TRUST_TRANSCRIPT).toString())
      const read = await runtime.readTerminal(handle, { screen: true })
      expect(read.tail.join('\n')).toContain('Do you trust')
      await expect(
        waitForTraeStartupComposer(async () => ({ ...read, source }), 20)
      ).rejects.toThrow('timeout')
    }
  )

  it.each(['stream', 'screen-unavailable'] as const)(
    'does not treat a %s fallback as a current composer',
    async (source) => {
      const { runtime, handle } = await pane(transcript().toString())
      const read = await runtime.readTerminal(handle, { screen: true })
      expect(read.tail.join('\n')).toContain('Context 100% left')
      await expect(
        waitForTraeStartupComposer(async () => ({ ...read, source }), 20)
      ).rejects.toThrow('timeout')
    }
  )

  it('bounds an asynchronous screen read that never settles', async () => {
    vi.useFakeTimers()
    const pending = waitForTraeStartupComposer(() => new Promise(() => {}), 1_000)
    const assertion = expect(pending).rejects.toThrow('timeout')
    await vi.advanceTimersByTimeAsync(1_000)
    await assertion
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retries an ordinary read failure without weakening the deadline', async () => {
    const { runtime, handle } = await pane(transcript().toString())
    const read = await runtime.readTerminal(handle, { screen: true })
    const readScreen = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary read error'))
      .mockResolvedValue(read)
    vi.useFakeTimers()
    const started = Date.now()
    const pending = waitForTraeStartupComposer(readScreen, 1_000)
    await vi.advanceTimersByTimeAsync(100)
    await expect(pending).resolves.toBeUndefined()
    expect(readScreen).toHaveBeenCalledTimes(2)
    expect(Date.now() - started).toBe(100)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([false, true])(
    'preserves a stale read error immediately (synchronous: %s)',
    async (sync) => {
      vi.useFakeTimers()
      const readScreen = vi.fn(() => {
        const error = new Error('terminal_handle_stale')
        if (sync) {
          throw error
        }
        return Promise.reject(error)
      })
      const started = Date.now()
      const pending = waitForTraeStartupComposer(readScreen, 60_000).catch(String)
      await vi.runAllTimersAsync()
      expect(await pending).toBe('Error: terminal_handle_stale')
      expect(readScreen).toHaveBeenCalledOnce()
      expect(Date.now() - started).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it.each(['trae-ready-linux.txt', TRUST_TRANSCRIPT])(
    'rejects a %s frame after its PTY was replaced',
    async (name) => {
      const { runtime, handle } = await pane(transcript(name).toString())
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
      vi.useFakeTimers()
      const started = Date.now()
      const pending = runtime
        .waitForFreshWorkerComposer(handle, 'trae', 60_000)
        .catch((error: unknown) => ({
          error: String(error),
          elapsedMs: Date.now() - started
        }))
      await vi.advanceTimersByTimeAsync(0)
      await vi.runAllTimersAsync()
      expect(await pending).toEqual({ error: 'Error: terminal_handle_stale', elapsedMs: 0 })
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it.each(['trae-ready-linux.txt', TRUST_TRANSCRIPT])(
    'rejects a %s frame after its PTY disconnected',
    async (name) => {
      const { runtime, handle } = await pane(transcript(name).toString())
      const read = runtime.readTerminal.bind(runtime)
      vi.spyOn(runtime, 'readTerminal').mockImplementationOnce(async (...args) => {
        const frame = await read(...args)
        await runtime.onPtyExit(TRANSCRIPT_PANE_PTY_ID, 0, 'inc-1')
        return frame
      })
      vi.useFakeTimers()
      const started = Date.now()
      const pending = runtime
        .waitForFreshWorkerComposer(handle, 'trae', 60_000)
        .catch((error: unknown) => ({
          error: String(error),
          elapsedMs: Date.now() - started
        }))
      await vi.advanceTimersByTimeAsync(0)
      await vi.runAllTimersAsync()
      expect(await pending).toEqual({ error: 'Error: terminal_handle_stale', elapsedMs: 0 })
      expect(vi.getTimerCount()).toBe(0)
    }
  )
})

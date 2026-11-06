import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTranscriptPane, TRANSCRIPT_PANE_PTY_ID } from './agent-transcript-pane-test-harness'
import { readRuntimeMetadata } from './runtime-metadata'
import { classifyRuntimeLongPoll, OrcaRuntimeRpcServer } from './runtime-rpc'
import { openFramedSession, waitFor } from './runtime-rpc-test-harness'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

async function startupServer() {
  const { runtime, handle } = await createTranscriptPane({
    paneTitle: 'worker-trae',
    foregroundProcess: 'traecli',
    launchAgent: 'trae',
    data: '',
    size: { cols: 120, rows: 40 }
  })
  runtime.terminalRunFacts.recordSpawnCommit({
    id: TRANSCRIPT_PANE_PTY_ID,
    incarnationId: 'inc-1'
  })
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-startup-wait-rpc-'))
  const server = new OrcaRuntimeRpcServer({
    runtime,
    userDataPath,
    keepaliveIntervalMs: 20,
    longPollCap: 1
  })
  await server.start()
  const metadata = readRuntimeMetadata(userDataPath)!
  const openWait = (id: string, timeoutMs: number) =>
    openFramedSession(metadata.transports[0]!.endpoint, {
      id,
      authToken: metadata.authToken,
      method: 'terminal.waitForStartup',
      params: { terminal: handle, expectedIncarnationId: 'inc-1', timeoutMs }
    })
  return { runtime, handle, server, openWait }
}

describe('startup wait long-poll transport', () => {
  afterEach(() => vi.restoreAllMocks())

  it('classifies startup waits as keepalive-backed long polls', () => {
    expect(
      classifyRuntimeLongPoll({
        id: 'startup',
        authToken: 'token',
        method: 'terminal.waitForStartup',
        params: { terminal: 'term_1', timeoutMs: 60_000 }
      })
    ).toBe('wait')
  })

  it.each(['ready', 'timeout'] as const)(
    'keeps the socket alive until the real startup handler returns %s',
    async (outcome) => {
      const { runtime, handle, server, openWait } = await startupServer()
      const session = openWait('startup', outcome === 'ready' ? 5_000 : 300)
      try {
        if (outcome === 'ready') {
          await waitFor(
            () => session.frames.filter((frame) => frame._keepalive === true).length >= 2
          )
          runtime.onPtyData(
            TRANSCRIPT_PANE_PTY_ID,
            readFileSync(join(__dirname, '__fixtures__/trae-ready-linux.txt'), 'utf8'),
            Date.now()
          )
        }
        await session.done
        expect(
          session.frames.filter((frame) => frame._keepalive === true).length
        ).toBeGreaterThanOrEqual(2)
        const responses = session.frames.filter((frame) => frame.ok !== undefined)
        expect(responses).toHaveLength(1)
        expect(responses[0]).toMatchObject(
          outcome === 'ready'
            ? {
                id: 'startup',
                ok: true,
                result: { startup: { handle, ready: true, incarnationId: 'inc-1' } }
              }
            : { id: 'startup', ok: false, error: { code: 'timeout' } }
        )
        expect(server['activeLongPolls']).toBe(0)
      } finally {
        session.socket.destroy()
        await session.done
        await server.stop()
      }
    }
  )

  it('aborts a disconnected startup wait and releases its admission slot', async () => {
    const { runtime, server, openWait } = await startupServer()
    const startup = vi.spyOn(runtime, 'waitForTerminalStartup')
    const session = openWait('startup', 5_000)
    try {
      await waitFor(() => startup.mock.calls.length === 1)
      const signal = startup.mock.calls[0]![1].signal
      expect(signal).toBeDefined()
      expect(server['activeLongPolls']).toBe(1)

      const overflow = openWait('overflow', 50)
      await overflow.done
      expect(overflow.frames.find((frame) => frame.ok !== undefined)).toMatchObject({
        ok: false,
        error: { code: 'runtime_busy' }
      })

      session.socket.destroy()
      await session.done
      await waitFor(() => signal?.aborted === true && server['activeLongPolls'] === 0)

      const next = openWait('next', 50)
      await next.done
      expect(next.frames.find((frame) => frame.ok !== undefined)).toMatchObject({
        id: 'next',
        ok: false,
        error: { code: 'timeout' }
      })
    } finally {
      session.socket.destroy()
      await session.done
      await server.stop()
    }
  })
})

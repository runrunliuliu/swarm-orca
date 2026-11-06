import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import capture from './__fixtures__/trae-ready-0213-linux.json'
import { createTranscriptPane, TRANSCRIPT_PANE_PTY_ID } from './agent-transcript-pane-test-harness'
import { waitForTraeStartupComposer } from './runtime-trae-startup-composer'
import { hasTraeStartupComposer } from './trae-terminal-readiness'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const data = capture.chunks.join('')
// The final captured repaint removes the MCP boot row and moves the composer up.
const readyStart = data.lastIndexOf('\x1b[?2026h\x1b[11;1H\x1b[J')

async function pane(text = data, connectionId?: string) {
  const result = await createTranscriptPane({
    paneTitle: 'worker-trae',
    foregroundProcess: 'traecli',
    launchAgent: 'trae',
    data: text,
    connectionId,
    size: { cols: capture.cols, rows: capture.rows }
  })
  result.runtime.terminalRunFacts.recordSpawnCommit({
    id: TRANSCRIPT_PANE_PTY_ID,
    incarnationId: 'inc-1'
  })
  return result
}

describe('Trae 0.213.1 Full Access startup capture', () => {
  afterEach(() => vi.restoreAllMocks())

  it('pins the raw capture including CR, escapes and repaint boundary', () => {
    expect(data).toContain('\x1b')
    expect(data).toContain('\r')
    expect(readyStart).toBeGreaterThan(0)
    expect(createHash('sha256').update(data).digest('hex')).toBe(capture.transcriptSha256)
  })

  it.each([undefined, 'ssh:test-host'])(
    'recognizes startup on %s without declaring business idle',
    async (connectionId) => {
      const { runtime, handle } = await pane(data, connectionId)
      const read = await runtime.readTerminal(handle, { screen: true })
      expect(read.source).toBe('screen')
      expect(read.tail.some((line) => line.trim().endsWith(' · Context 100% left'))).toBe(true)
      expect(read.tail.join('\n')).toContain(
        'Full Access (shift+tab to cycle) · ? for shortcuts · ← for agents'
      )
      await expect(
        runtime.waitForTerminalStartup(handle, {
          timeoutMs: 100,
          expectedIncarnationId: 'inc-1'
        })
      ).resolves.toEqual({ handle, agent: 'trae', ready: true, incarnationId: 'inc-1' })
      await expect(
        runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 20 })
      ).rejects.toThrow('timeout')
    }
  )

  it('rejects the captured MCP boot frame until the final repaint arrives', async () => {
    const { runtime, handle } = await pane(data.slice(0, readyStart))
    const read = await runtime.readTerminal(handle, { screen: true })
    expect(read.tail.join('\n')).toContain('Booting MCP server:')
    expect(read.tail.join('\n')).toContain('Context 100% left')
    await expect(runtime.waitForTerminalStartup(handle, { timeoutMs: 20 })).rejects.toThrow(
      'timeout'
    )
    runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, data.slice(readyStart), Date.now())
    await expect(runtime.waitForTerminalStartup(handle, { timeoutMs: 100 })).resolves.toMatchObject(
      {
        ready: true
      }
    )
  })

  it('preserves readiness with fragmented PTY delivery', async () => {
    const { runtime, handle } = await pane('')
    for (const chunk of data.match(/[\s\S]{1,137}/g) ?? []) {
      runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, chunk, Date.now())
    }
    await expect(runtime.waitForTerminalStartup(handle, { timeoutMs: 100 })).resolves.toMatchObject(
      {
        ready: true
      }
    )
  })

  it.each(['stream', 'screen-unavailable'] as const)('rejects %s fallback', async (source) => {
    const { runtime, handle } = await pane()
    const read = await runtime.readTerminal(handle, { screen: true })
    await expect(waitForTraeStartupComposer(async () => ({ ...read, source }), 20)).rejects.toThrow(
      'timeout'
    )
  })

  it('clears historical trust only after the captured current composer', async () => {
    const { runtime, handle } = await pane(
      readFileSync(join(__dirname, '__fixtures__/trae-trust-workspace-linux.txt'), 'utf8')
    )
    await expect(runtime.getTerminalInteractiveWait(handle)).resolves.toMatchObject({
      reason: 'agent-trust-workspace'
    })
    runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, data, Date.now())
    await expect(runtime.getTerminalInteractiveWait(handle)).resolves.toBeNull()
    await expect(runtime.waitForTerminalStartup(handle, { timeoutMs: 100 })).resolves.toMatchObject(
      {
        ready: true
      }
    )
  })

  it.each([
    ['trae-trust-workspace-linux.txt', 'Agent startup blocked: agent-trust-workspace'],
    ['trae-hooks-menu-linux.txt', 'timeout']
  ])('does not let ready history override current %s', async (name, error) => {
    const { runtime, handle } = await pane()
    runtime.onPtyData(
      TRANSCRIPT_PANE_PTY_ID,
      readFileSync(join(__dirname, '__fixtures__', name), 'utf8'),
      Date.now()
    )
    await expect(runtime.waitForTerminalStartup(handle, { timeoutMs: 20 })).rejects.toThrow(error)
  })

  it('rejects incomplete footer and composer shapes derived from the captured screen', async () => {
    const { runtime, handle } = await pane()
    const { tail } = await runtime.readTerminal(handle, { screen: true })
    const mutations = [
      tail.map((line) => line.replace('Context 100% left', 'Context 100% lef')),
      tail.map((line) => line.replace('Context 100% left', 'Context 100% leftover')),
      tail.map((line) => line.replace(/ · \/[x/]+/, '')),
      tail.map((line) => (/─{4,}/.test(line) ? '' : line)),
      tail.map((line) => line.replace('❯', '>')),
      [...tail, 'esc to interrupt']
    ]
    for (const lines of mutations) {
      expect(hasTraeStartupComposer(lines)).toBe(false)
    }
  })
})

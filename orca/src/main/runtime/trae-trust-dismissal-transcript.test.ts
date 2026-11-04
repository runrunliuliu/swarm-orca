import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import capture from './__fixtures__/trae-trust-dismissed-linux.json'
import {
  createTranscriptPane,
  TRANSCRIPT_PANE_PTY_ID,
  TRANSCRIPT_PANE_TAB_ID,
  TRANSCRIPT_PANE_LEAF_ID
} from './agent-transcript-pane-test-harness'
import { makeAgentStatusStoreWiring } from './agent-status-store-wiring.test-fixture'
import { AgentHookServer } from '../agent-hooks/server'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener/listener-event'
import { hasTraeStartupComposer } from './trae-terminal-readiness'
import { waitForTraeStartupComposer } from './runtime-trae-startup-composer'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const data = Buffer.from(capture.chunks.join(''))
const TRUST_END = 4863
const BOOTING_END = 9221
const READY_END = 27125

async function pane(end: number, connectionId?: string) {
  const store = new TranscriptHookServer()
  const result = await createTranscriptPane(
    {
      paneTitle: 'review',
      foregroundProcess: 'traecli',
      launchAgent: 'trae',
      data: data.subarray(0, end).toString(),
      connectionId,
      size: { cols: capture.cols, rows: capture.rows }
    },
    makeAgentStatusStoreWiring(store).deps
  )
  return { ...result, store }
}

class TranscriptHookServer extends AgentHookServer {
  hook(
    handle: string,
    state: 'working' | 'done',
    connectionId?: string,
    overrides: Partial<AgentHookEventPayload> = {}
  ) {
    this.applyNormalizedStatus({
      paneKey: `${TRANSCRIPT_PANE_TAB_ID}:${TRANSCRIPT_PANE_LEAF_ID}`,
      terminalHandle: handle,
      tabId: TRANSCRIPT_PANE_TAB_ID,
      worktreeId: 'wt-1',
      launchToken: 'transcript-launch',
      connectionId: connectionId ?? null,
      source: 'trae',
      hookEventName: state === 'working' ? 'UserPromptSubmit' : 'Stop',
      payload: { agentType: 'trae', state, prompt: '' },
      providerSession: { key: 'session_id', id: 'transcript-session' },
      ...overrides
    })
  }
}

describe('Trae 0.212.1 trust dismissal from daemon PTY capture', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('preserves captured bytes, CR, escapes and the pinned digest', () => {
    expect(data.includes(27)).toBe(true)
    expect(data.includes(13)).toBe(true)
    expect(createHash('sha256').update(data).digest('hex')).toBe(capture.transcriptSha256)
  })

  it.each([undefined, 'ssh:test-host'])(
    'keeps a current trust dialog blocked on %s',
    async (connectionId) => {
      const { runtime, handle } = await pane(TRUST_END, connectionId)
      await expect(
        runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 100 })
      ).resolves.toMatchObject({ satisfied: false, blockedReason: 'agent-trust-workspace' })
      await expect(runtime.getTerminalInteractiveWait(handle)).resolves.toMatchObject({
        reason: 'agent-trust-workspace'
      })
    }
  )

  it.each([undefined, 'ssh:test-host'])(
    'clears trust history, not working evidence, on %s',
    async (connectionId) => {
      const { runtime, handle, store } = await pane(TRUST_END, connectionId)
      runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, data.subarray(TRUST_END).toString(), Date.now())
      await expect(runtime.getTerminalInteractiveWait(handle)).resolves.toBeNull()
      await expect(runtime.getTerminalAgentStatus(handle)).resolves.not.toMatchObject({
        status: 'permission'
      })
      store.hook(handle, 'working', connectionId)
      expect(store.getStatusSnapshot()).toEqual([
        expect.objectContaining({ state: 'working', connectionId: connectionId ?? null })
      ])
      await expect(runtime.getTerminalAgentStatus(handle)).resolves.toMatchObject({
        status: 'working'
      })
      await expect(
        runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 50 })
      ).rejects.toThrow('timeout')
      store.hook(handle, 'done', connectionId)
      await expect(
        runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 100 })
      ).resolves.toMatchObject({ satisfied: true })
    }
  )

  it('does not infer business idle from an unblocked startup composer', async () => {
    const { runtime, handle } = await pane(data.length)
    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 50 })
    ).rejects.toThrow('timeout')
  })

  it.each([
    { launchToken: 'previous-launch' },
    { connectionId: 'other-host' },
    { providerSession: undefined }
  ])('does not use mismatched or incomplete Stop identity %j', async (overrides) => {
    const { runtime, handle, store } = await pane(data.length)
    store.hook(handle, 'done', undefined, overrides)
    await expect(runtime.getTerminalInteractiveWait(handle)).resolves.toBeNull()
    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 50 })
    ).rejects.toThrow('timeout')
  })

  it.each([capture.chunks, data.toString().match(/[\s\S]{1,137}/g) ?? []])(
    'keeps the verdict across recorded and fragmented delivery %#',
    async (chunks) => {
      expect(chunks.length).toBeGreaterThan(0)
      const { runtime, handle, store } = await pane(0)
      for (const chunk of chunks) {
        runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, chunk, Date.now())
      }
      store.hook(handle, 'done')
      await expect(runtime.getTerminalInteractiveWait(handle)).resolves.toBeNull()
      await expect(
        runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 100 })
      ).resolves.toMatchObject({ satisfied: true })
    }
  )

  it('also dismisses trust before the older captured Context footer', async () => {
    const { runtime, handle } = await pane(TRUST_END)
    runtime.onPtyData(
      TRANSCRIPT_PANE_PTY_ID,
      readFileSync(join(__dirname, '__fixtures__', 'trae-ready-linux.txt'), 'utf8'),
      Date.now()
    )
    await expect(runtime.getTerminalInteractiveWait(handle)).resolves.toBeNull()
  })

  it('does not dismiss a real hooks review dialog with a later Trae composer', async () => {
    const { runtime, handle } = await pane(0)
    runtime.onPtyData(
      TRANSCRIPT_PANE_PTY_ID,
      readFileSync(join(__dirname, '__fixtures__', 'codex-0158-hooks-review-dialog.txt'), 'utf8'),
      Date.now()
    )
    runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, data.subarray(TRUST_END).toString(), Date.now())
    await expect(runtime.getTerminalInteractiveWait(handle)).resolves.toMatchObject({
      reason: 'agent-hooks-review-prompt'
    })
  })

  it('waits through MCP boot even with the new model/path footer', async () => {
    const { runtime, handle } = await pane(BOOTING_END)
    const booting = await runtime.readTerminal(handle, { screen: true })
    expect(booting.tail.join('\n')).toContain('Booting MCP server:')
    expect(booting.tail.join('\n')).toContain('GPT-5.5 (MAX) high')
    expect(hasTraeStartupComposer(booting.tail)).toBe(false)
    await expect(runtime.waitForFreshWorkerComposer(handle, 'trae', 20)).rejects.toThrow('timeout')
    runtime.onPtyData(
      TRANSCRIPT_PANE_PTY_ID,
      data.subarray(BOOTING_END, READY_END).toString(),
      Date.now()
    )
    await expect(runtime.waitForFreshWorkerComposer(handle, 'trae', 100)).resolves.toBeUndefined()
  })

  it.each(['stream', 'screen-unavailable'] as const)(
    'does not accept a %s fallback',
    async (source) => {
      const { runtime, handle } = await pane(data.length)
      const read = await runtime.readTerminal(handle, { screen: true })
      await expect(
        waitForTraeStartupComposer(async () => ({ ...read, source }), 20)
      ).rejects.toThrow('timeout')
    }
  )

  it.each(['replaced', 'exited'] as const)(
    'rejects a captured ready frame if the PTY %s during the read',
    async (transition) => {
      const { runtime, handle } = await pane(data.length)
      const read = runtime.readTerminal.bind(runtime)
      vi.spyOn(runtime, 'readTerminal').mockImplementationOnce(async (...args) => {
        const frame = await read(...args)
        if (transition === 'exited') {
          await runtime.onPtyExit(TRANSCRIPT_PANE_PTY_ID, 0, 'inc-1')
        } else {
          runtime.registerPty(TRANSCRIPT_PANE_PTY_ID, 'wt-1', null, {
            tabId: TRANSCRIPT_PANE_TAB_ID,
            leafId: TRANSCRIPT_PANE_LEAF_ID,
            incarnationId: 'inc-2'
          })
        }
        return frame
      })
      await expect(runtime.waitForFreshWorkerComposer(handle, 'trae', 100)).rejects.toThrow(
        'terminal_handle_stale'
      )
    }
  )

  it('keeps a later real trust frame actionable after the composer', async () => {
    const { runtime, handle } = await pane(data.length)
    runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, data.subarray(0, TRUST_END).toString(), Date.now())
    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 100 })
    ).resolves.toMatchObject({ satisfied: false, blockedReason: 'agent-trust-workspace' })
  })
})

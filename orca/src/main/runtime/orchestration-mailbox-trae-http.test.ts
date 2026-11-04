import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from '../agent-hooks/server'
import { buildBody, postHookEvent } from '../agent-hooks/server.test-fixtures'
import {
  checkBoundMailbox,
  createBoundRun,
  createDatabase,
  createRuntime,
  LAUNCH_TOKEN,
  PANE_KEY,
  PTY_ID,
  TERMINAL_HANDLE,
  pointerCount,
  TAB_ID,
  temporaryDirectories,
  WORKTREE_ID
} from './orchestration-mailbox-notification-test-harness'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()), isPackaged: false },
  BrowserWindow: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn(() => null) }
}))
vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))

class MailboxTraeHookServer extends AgentHookServer {
  constructor() {
    super()
    this._setOpenCodeBinderDepsForTests({
      dbPath: () => '/unused-opencode-test.db',
      listSessions: () => [],
      listPanes: () => [],
      sweep: async () => []
    })
  }
}

describe.each([
  [false, '0.211.1'],
  [true, '0.211.1'],
  [false, '0.212.1'],
  [true, '0.212.1']
] as const)('Trae HTTP hook to mailbox (headless=%s, version=%s)', (headless, version) => {
  afterEach(() => {
    vi.restoreAllMocks()
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('revalidates a long-idle Stop through the canonical store, resolves wait and wakes only once', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-trae-long-idle-'))
    temporaryDirectories.push(userDataPath)
    const server = new MailboxTraeHookServer()
    const db = createDatabase('orca-trae-idle-db-')
    let now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const { runtime, write } = createRuntime(db, {
      headless,
      agent: 'trae',
      getAgentStatusSnapshot: () => server.getStatusSnapshot(),
      onTerminalAgentStatus: (event) => server.ingestTerminalStatus(event)
    })
    runtime.terminalRunFacts.recordSpawnCommit({ id: PTY_ID, incarnationId: 'mailbox-incarnation' })
    const transcriptPath = join(userDataPath, 'rollout.jsonl')
    const post = async (hook_event_name: string) => {
      const result = await postHookEvent(
        server,
        buildBody(
          { hook_event_name, session_id: 'long-idle-lead', transcript_path: transcriptPath },
          { paneKey: PANE_KEY, tabId: TAB_ID, worktreeId: WORKTREE_ID, launchToken: LAUNCH_TOKEN }
        ),
        '/hook/trae'
      )
      expect(result.status).toBe(204)
    }
    try {
      await server.start({ env: 'production', userDataPath })
      await runtime.listTerminals()
      const run = createBoundRun(db, 'Long-idle recovery')
      now += 100
      await post('UserPromptSubmit')
      now += 100
      await post('Stop')
      const stopped = server.getStatusSnapshot()[0]!
      const writeCompletion = () =>
        writeFileSync(
          transcriptPath,
          [
            {
              type: 'session_meta',
              payload: {
                id: 'long-idle-lead',
                source: 'cli',
                originator: 'traex-tui',
                cli_version: version
              }
            },
            {
              type: 'event_msg',
              timestamp: new Date(now).toISOString(),
              payload: {
                type: 'task_complete',
                turn_id: '01a1854b-b1d2-7602-8790-62765be56004'
              }
            }
          ]
            .map((row) => `${JSON.stringify(row)}\n`)
            .join('')
        )
      writeCompletion()
      now += 31 * 60_000
      const waited = await runtime.waitForTerminal(TERMINAL_HANDLE, {
        condition: 'tui-idle',
        timeoutMs: 5_000
      })
      expect(waited).toMatchObject({ condition: 'tui-idle' })
      const renewed = server.getStatusSnapshot()[0]!
      expect(renewed.evidenceObservedAt).toBe(now)
      expect(renewed.stateStartedAt).toBe(stopped.stateStartedAt)
      expect(renewed.observation).toMatchObject({ origin: 'process', kind: 'snapshot' })
      expect(renewed.observation?.boundary).toBeUndefined()
      expect(renewed.traeIdleRevalidation?.hookObservedAt).toBe(stopped.evidenceObservedAt)
      const message = db.insertMessage({
        from: 'term_worker',
        to: `run:${run.id}`,
        runId: run.id,
        type: 'worker_done',
        subject: 'Completed while idle'
      })
      runtime.notifyMessageArrived(`run:${run.id}`, message.type)
      await vi.waitFor(
        () => expect(write.mock.calls.filter(([, data]) => data === '\r')).toHaveLength(1),
        { timeout: 5_000 }
      )
      runtime.notifyMessageArrived(`run:${run.id}`, message.type)
      expect(pointerCount(write)).toBe(1)
      const checked = await checkBoundMailbox(runtime)
      await checkBoundMailbox(runtime, { ack: checked.deliveryId! })
      now += 100
      await post('UserPromptSubmit')
      // A late revalidation must not overwrite a newer hook even for the same session.
      server.ingestTerminalStatus({
        paneKey: PANE_KEY,
        connectionId: null,
        origin: 'process',
        payload: { agentType: 'trae', state: 'done', prompt: '' },
        traeIdleRevalidation: { expected: renewed, proof: renewed.traeIdleRevalidation! }
      })
      expect(server.getStatusSnapshot()[0]?.state).toBe('working')
      now += 100
      await post('Stop')
      writeCompletion()
      now += 31 * 60_000
      const external = db.insertMessage({
        from: 'term_operator',
        to: `run:${run.id}`,
        runId: run.id,
        type: 'status',
        subject: 'External fact after another long idle'
      })
      runtime.notifyMessageArrived(`run:${run.id}`, external.type)
      await vi.waitFor(
        () => expect(write.mock.calls.filter(([, data]) => data === '\r')).toHaveLength(2),
        { timeout: 5_000 }
      )
      const second = await checkBoundMailbox(runtime)
      expect(second.messages).toEqual([expect.objectContaining({ id: external.id })])
      await checkBoundMailbox(runtime, { ack: second.deliveryId! })
      runtime.notifyMessageArrived(`run:${run.id}`, external.type)
      expect(pointerCount(write)).toBe(2)
    } finally {
      server.stop()
      await new Promise<void>((resolve) => setImmediate(resolve))
      db.close()
    }
  }, 15_000)

  it('ignores a child Stop and automatically delivers two lead-bound batches without a title edge', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-trae-mailbox-http-'))
    temporaryDirectories.push(userDataPath)
    const server = new MailboxTraeHookServer()
    const db = createDatabase('orca-trae-http-db-')
    const { runtime, write } = createRuntime(db, {
      headless,
      agent: 'trae',
      getAgentStatusSnapshot: () => server.getStatusSnapshot()
    })
    const run = createBoundRun(db, 'HTTP lead-only wake')
    const post = async (hook_event_name: string, child = false) => {
      const response = await postHookEvent(
        server,
        buildBody(
          {
            hook_event_name,
            source: 'startup',
            session_id: 'mailbox-lead',
            ...(child ? { agent_id: 'nested-child' } : {})
          },
          { paneKey: PANE_KEY, tabId: TAB_ID, worktreeId: WORKTREE_ID, launchToken: LAUNCH_TOKEN }
        ),
        '/hook/trae'
      )
      expect(response.status).toBe(204)
    }
    try {
      await server.start({ env: 'production', userDataPath })
      await runtime.listTerminals()
      await post('SessionStart')
      for (let cycle = 1; cycle <= 2; cycle += 1) {
        await post('UserPromptSubmit')
        await post('Stop', true)
        expect(server.getStatusSnapshot()[0]?.state).toBe('working')
        const message = db.insertMessage({
          from: 'term_worker',
          to: `run:${run.id}`,
          runId: run.id,
          type: 'worker_done',
          subject: `Finished ${cycle}`
        })
        runtime.notifyMessageArrived(`run:${run.id}`, message.type)
        expect(pointerCount(write)).toBe(cycle - 1)
        await post('Stop')
        await vi.waitFor(
          () => {
            expect(write.mock.calls.filter(([, data]) => data === '\r')).toHaveLength(cycle)
          },
          { timeout: 5_000 }
        )
        runtime.notifyMessageArrived(`run:${run.id}`, message.type)
        expect(pointerCount(write)).toBe(cycle)
        const checked = await checkBoundMailbox(runtime)
        expect(checked.messages).toEqual([expect.objectContaining({ id: message.id })])
        await checkBoundMailbox(runtime, { ack: checked.deliveryId! })
      }
    } finally {
      server.stop()
      await new Promise<void>((resolve) => setImmediate(resolve))
      db.close()
    }
  }, 15_000)
})

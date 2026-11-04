import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../shared/agent-status-types'
import trustCapture from './__fixtures__/trae-trust-dismissed-linux.json'
import {
  checkBoundMailbox,
  createBoundRun,
  createDatabase,
  createRuntime as createMailboxRuntime,
  insertDirectRunMessage,
  LAUNCH_TOKEN,
  PANE_KEY,
  pointerCount,
  PTY_ID,
  TERMINAL_HANDLE,
  temporaryDirectories
} from './orchestration-mailbox-notification-test-harness'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()), isPackaged: false },
  BrowserWindow: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn(() => null) }
}))

vi.mock('./trae-idle-log-evidence', () => ({
  readTraeIdleLogEvidence: vi.fn(async () => 'same-log')
}))

type HookRow = AgentStatusIpcPayload & { launchTokenHash?: string }

function hook(overrides: Partial<HookRow> = {}): HookRow {
  return {
    paneKey: PANE_KEY,
    terminalHandle: TERMINAL_HANDLE,
    launchToken: LAUNCH_TOKEN,
    agentType: 'trae',
    state: 'done',
    prompt: '',
    connectionId: null,
    receivedAt: Date.now(),
    evidenceObservedAt: Date.now(),
    stateStartedAt: Date.now(),
    providerSession: { key: 'session_id', id: 'trae-lead' },
    ...overrides
  }
}

describe.each([false, true])('Trae mailbox wake (headless=%s)', (headless) => {
  function createRuntime(...[db, options]: Parameters<typeof createMailboxRuntime>) {
    return createMailboxRuntime(db, { ...options, headless })
  }
  afterEach(() => {
    vi.useRealTimers()
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('wakes on Worker completion after a neutral-title turn and submits exactly once', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-trae-wake-')
    const rows = [hook()]
    const { runtime, write } = createRuntime(db, {
      agent: 'trae',
      getAgentStatusSnapshot: () => rows
    })
    const run = createBoundRun(db, 'Trae wake')
    await runtime.listTerminals()
    runtime.onPtyData(PTY_ID, '\x1b]0;Trae\x07', 1)
    db.insertMessage({
      from: 'term_worker',
      to: `run:${run.id}`,
      type: 'worker_done',
      subject: 'Review done',
      runId: run.id
    })
    runtime.deliverPendingMessagesForHandle(`run:${run.id}`)
    await vi.advanceTimersByTimeAsync(600)
    expect(pointerCount(write)).toBe(1)
    expect(write.mock.calls.filter(([, data]) => data === '\r')).toHaveLength(1)
    runtime.deliverPendingMessagesForHandle(`run:${run.id}`)
    await vi.advanceTimersByTimeAsync(600)
    expect(pointerCount(write)).toBe(1)
    const checked = await checkBoundMailbox(runtime)
    expect(checked.count).toBe(1)
    await checkBoundMailbox(runtime, { ack: checked.deliveryId! })
    db.close()
  })

  it('parks mail while working and retries after Stop without another title edge', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-trae-busy-')
    let rows = [hook({ state: 'working' })]
    const { runtime, write } = createRuntime(db, {
      agent: 'trae',
      getAgentStatusSnapshot: () => rows
    })
    const run = createBoundRun(db, 'Trae busy')
    await runtime.listTerminals()
    runtime.onPtyData(PTY_ID, '\x1b]0;Trae\x07', 1)
    insertDirectRunMessage(db, run.id, 'Later')
    runtime.deliverPendingMessagesForHandle(TERMINAL_HANDLE)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(pointerCount(write)).toBe(0)
    rows = [hook()]
    await vi.advanceTimersByTimeAsync(6_000)
    expect(pointerCount(write)).toBe(1)
    expect(write.mock.calls.filter(([, data]) => data === '\r')).toHaveLength(1)
    db.close()
  })

  it('redrives a run mailbox after stale bearer Stop evidence is revalidated', async () => {
    vi.useFakeTimers()
    const observedAt = 1_000_000
    vi.setSystemTime(observedAt)
    const db = createDatabase('orca-trae-revalidated-redrive-')
    let revision = 1
    const initialRow = hook({
      receivedAt: observedAt,
      evidenceObservedAt: observedAt,
      stateStartedAt: observedAt,
      providerSession: {
        key: 'session_id',
        id: 'trae-lead',
        transcriptPath: '/tmp/rollout.jsonl'
      },
      observation: {
        authorityId: 'main-agent-hooks',
        incarnation: 1,
        revision,
        origin: 'hook',
        kind: 'snapshot',
        observedAt
      }
    })
    let rows = [initialRow]
    const { runtime, write } = createRuntime(db, {
      agent: 'trae',
      getAgentStatusSnapshot: () => rows,
      onTerminalAgentStatus: (event) => {
        const request = event.traeIdleRevalidation
        if (!request) {
          return
        }
        rows = [
          {
            ...rows[0],
            receivedAt: Date.now(),
            evidenceObservedAt: Date.now(),
            traeIdleRevalidation: request.proof,
            observation: {
              authorityId: 'main-agent-hooks',
              incarnation: 1,
              revision: ++revision,
              origin: 'process',
              kind: 'snapshot',
              observedAt: Date.now()
            }
          }
        ]
      }
    })
    runtime.terminalRunFacts.recordSpawnCommit({
      id: PTY_ID,
      incarnationId: 'mailbox-incarnation'
    })
    const run = createBoundRun(db, 'Trae revalidated wake')
    await runtime.listTerminals()
    vi.setSystemTime(observedAt + AGENT_STATUS_STALE_AFTER_MS + 1_000)
    db.insertMessage({
      from: 'term_worker',
      to: `run:${run.id}`,
      type: 'status',
      subject: 'Needs revalidated wake',
      runId: run.id
    })
    runtime.deliverPendingMessagesForHandle(`run:${run.id}`)
    expect(pointerCount(write)).toBe(0)
    await vi.advanceTimersByTimeAsync(600)
    expect(pointerCount(write)).toBe(1)
    expect(write.mock.calls.filter(([, data]) => data === '\r')).toHaveLength(1)
    const checked = await checkBoundMailbox(runtime)
    expect(checked.count).toBe(1)
    db.close()
  })

  it.each(
    [null, 'ssh:test-host'].flatMap((connectionId) =>
      (['dismissed', 'current', 'before-text', 'before-enter'] as const).map((trustState) => ({
        connectionId,
        trustState
      }))
    )
  )(
    'fences mailbox input against captured trust ($trustState, $connectionId)',
    async ({ trustState, connectionId }) => {
      vi.useFakeTimers()
      const bytes = Buffer.from(trustCapture.chunks.join(''))
      const currentTrust = bytes.subarray(0, 4863).toString()
      const db = createDatabase('orca-trae-trust-fence-')
      const rows = [hook({ connectionId })]
      let probes = 0
      const { runtime, write } = createRuntime(db, {
        agent: 'trae',
        connectionId: connectionId ?? undefined,
        getAgentStatusSnapshot: () => rows,
        confirmForegroundProcess: async () => {
          probes++
          if (
            (trustState === 'before-text' && probes === 1) ||
            (trustState === 'before-enter' && probes === 2)
          ) {
            runtime.onPtyData(PTY_ID, currentTrust, Date.now())
          }
          return 'traex'
        }
      })
      const run = createBoundRun(db, 'Captured trust boundary')
      await runtime.listTerminals()
      runtime.onPtyData(
        PTY_ID,
        trustState === 'current' ? currentTrust : bytes.toString(),
        Date.now()
      )
      insertDirectRunMessage(db, run.id, 'Trust-fenced delivery')
      runtime.deliverPendingMessagesForHandle(TERMINAL_HANDLE)
      await vi.advanceTimersByTimeAsync(600)
      expect(pointerCount(write)).toBe(
        trustState === 'dismissed' || trustState === 'before-enter' ? 1 : 0
      )
      expect(write.mock.calls.filter(([, value]) => value === '\r')).toHaveLength(
        trustState === 'dismissed' ? 1 : 0
      )
      db.close()
    }
  )

  it.each([
    { restoredUnconfirmed: true },
    { providerSessionOnly: true },
    { launchToken: 'old-launch' },
    {
      launchToken: undefined,
      launchTokenHash: '3748435010cf968b828a57734ed1e692248249addfb3a14e7bb9b6e0d0c6ea38'
    },
    { connectionId: 'other-host' },
    { evidenceObservedAt: 0 },
    { evidenceObservedAt: Number.MAX_SAFE_INTEGER },
    { state: 'waiting' as const },
    { state: 'blocked' as const }
  ])('does not type from untrusted or stale hook %j', async (overrides) => {
    vi.useFakeTimers()
    vi.setSystemTime(AGENT_STATUS_STALE_AFTER_MS + Date.now())
    const db = createDatabase('orca-trae-refuse-')
    const { runtime, write } = createRuntime(db, {
      agent: 'trae',
      getAgentStatusSnapshot: () => [hook(overrides)]
    })
    const run = createBoundRun(db, 'Trae refused')
    await runtime.listTerminals()
    insertDirectRunMessage(db, run.id, 'Do not type')
    runtime.deliverPendingMessagesForHandle(TERMINAL_HANDLE)
    await vi.advanceTimersByTimeAsync(600)
    expect(pointerCount(write)).toBe(0)
    db.close()
  })

  it('does not press Enter in a different provider session', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-trae-session-fence-')
    let rows = [hook()]
    const { runtime, write } = createRuntime(db, {
      agent: 'trae',
      getAgentStatusSnapshot: () => rows
    })
    const run = createBoundRun(db, 'Trae session fence')
    await runtime.listTerminals()
    insertDirectRunMessage(db, run.id, 'Old session only')
    runtime.deliverPendingMessagesForHandle(TERMINAL_HANDLE)
    await vi.advanceTimersByTimeAsync(0)
    expect(pointerCount(write)).toBe(1)
    rows = [hook({ providerSession: { key: 'session_id', id: 'replacement' } })]
    await vi.advanceTimersByTimeAsync(500)
    expect(write.mock.calls.filter(([, data]) => data === '\r')).toHaveLength(0)
    runtime.deliverPendingMessagesForHandle(TERMINAL_HANDLE)
    await vi.advanceTimersByTimeAsync(6_000)
    expect(pointerCount(write)).toBe(1)
    expect(write.mock.calls.filter(([, data]) => data === '\r')).toHaveLength(0)
    db.close()
  })

  it('does not poll an empty mailbox or keep polling after mail is consumed while busy', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-trae-no-mail-')
    const snapshot = vi.fn(() => [hook({ state: 'working' })])
    const { runtime, write } = createRuntime(db, {
      agent: 'trae',
      getAgentStatusSnapshot: snapshot
    })
    const run = createBoundRun(db, 'No needless polling')
    await runtime.listTerminals()
    snapshot.mockClear()
    runtime.deliverPendingMessagesForHandle(TERMINAL_HANDLE)
    await vi.advanceTimersByTimeAsync(6_000)
    expect(snapshot).not.toHaveBeenCalled()
    const message = insertDirectRunMessage(db, run.id, 'Consumed before Stop')
    runtime.deliverPendingMessagesForHandle(TERMINAL_HANDLE)
    expect(snapshot).toHaveBeenCalled()
    db.markAsRead([message.id])
    snapshot.mockClear()
    await vi.advanceTimersByTimeAsync(6_000)
    expect(snapshot).not.toHaveBeenCalled()
    expect(pointerCount(write)).toBe(0)
    db.close()
  })

  it('does not use a fresh hook after the PTY exits', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-trae-exit-')
    const { runtime, write } = createRuntime(db, {
      agent: 'trae',
      getAgentStatusSnapshot: () => [hook()]
    })
    const run = createBoundRun(db, 'Exited pane')
    await runtime.listTerminals()
    runtime.onPtyExit(PTY_ID, 0)
    insertDirectRunMessage(db, run.id, 'Keep queued')
    runtime.deliverPendingMessagesForHandle(TERMINAL_HANDLE)
    await vi.advanceTimersByTimeAsync(6_000)
    expect(pointerCount(write)).toBe(0)
    db.close()
  })

  it.each(['zsh', 'codex', null, 'unavailable'])(
    'keeps mail queued when the foreground is %s',
    async (foreground) => {
      vi.useFakeTimers()
      const db = createDatabase('orca-trae-foreground-')
      const { runtime, write } = createRuntime(db, {
        agent: 'trae',
        getAgentStatusSnapshot: () => [hook()],
        confirmForegroundProcess: async () => {
          if (foreground === 'unavailable') {
            throw new Error('host disconnected')
          }
          return foreground
        }
      })
      const run = createBoundRun(db, 'No shell injection')
      await runtime.listTerminals()
      insertDirectRunMessage(db, run.id, 'Stay queued')
      runtime.deliverPendingMessagesForHandle(TERMINAL_HANDLE)
      await vi.advanceTimersByTimeAsync(600)
      expect(write).not.toHaveBeenCalled()
      expect((await checkBoundMailbox(runtime)).count).toBe(1)
      db.close()
    }
  )

  it('does not press Enter after Trae exits to a still-live shell', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-trae-shell-before-enter-')
    const confirm = vi.fn().mockResolvedValueOnce('traex').mockResolvedValue('zsh')
    const { runtime, write } = createRuntime(db, {
      agent: 'trae',
      getAgentStatusSnapshot: () => [hook()],
      confirmForegroundProcess: confirm
    })
    const run = createBoundRun(db, 'Exit before Enter')
    await runtime.listTerminals()
    insertDirectRunMessage(db, run.id, 'Never submit to shell')
    runtime.deliverPendingMessagesForHandle(TERMINAL_HANDLE)
    await vi.advanceTimersByTimeAsync(600)
    expect(pointerCount(write)).toBe(1)
    expect(write.mock.calls.filter(([, data]) => data === '\r')).toHaveLength(0)
    expect(confirm).toHaveBeenCalledTimes(2)
    db.close()
  })

  it('rechecks provider identity after the execution-host foreground probe', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-trae-probe-race-')
    let rows = [hook()]
    const { runtime, write } = createRuntime(db, {
      agent: 'trae',
      getAgentStatusSnapshot: () => rows,
      confirmForegroundProcess: async () => {
        rows = [hook({ providerSession: { key: 'session_id', id: 'replacement' } })]
        return 'traex'
      }
    })
    const run = createBoundRun(db, 'Identity changed during probe')
    await runtime.listTerminals()
    insertDirectRunMessage(db, run.id, 'Old session only')
    runtime.deliverPendingMessagesForHandle(TERMINAL_HANDLE)
    await vi.advanceTimersByTimeAsync(600)
    expect(write).not.toHaveBeenCalled()
    db.close()
  })

  it.each([1, 2])('rechecks mailbox authority during foreground probe %i', async (probeNumber) => {
    vi.useFakeTimers()
    const db = createDatabase('orca-trae-owner-race-')
    let probes = 0
    const { runtime, write } = createRuntime(db, {
      agent: 'trae',
      getAgentStatusSnapshot: () => [hook()],
      confirmForegroundProcess: async () => {
        if (++probes === probeNumber) {
          createBoundRun(db, 'Replacement owner')
        }
        return 'traex'
      }
    })
    const run = createBoundRun(db, 'Original owner')
    await runtime.listTerminals()
    insertDirectRunMessage(db, run.id, 'Never deliver to replacement owner')
    runtime.deliverPendingMessagesForHandle(TERMINAL_HANDLE)
    await vi.advanceTimersByTimeAsync(600)
    expect(pointerCount(write)).toBe(probeNumber - 1)
    expect(write.mock.calls.filter(([, data]) => data === '\r')).toHaveLength(0)
    db.close()
  })

  it.each([1, 2])('rechecks consumed mail during foreground probe %i', async (probeNumber) => {
    vi.useFakeTimers()
    const db = createDatabase('orca-trae-consumer-race-')
    let probes = 0
    let consume = () => {}
    const { runtime, write } = createRuntime(db, {
      agent: 'trae',
      getAgentStatusSnapshot: () => [hook()],
      confirmForegroundProcess: async () => {
        if (++probes === probeNumber) {
          consume()
        }
        return 'traex'
      }
    })
    const run = createBoundRun(db, 'Consumer race')
    await runtime.listTerminals()
    const message = insertDirectRunMessage(db, run.id, 'Already handled')
    consume = () => {
      db.markAsRead([message.id])
    }
    runtime.deliverPendingMessagesForHandle(TERMINAL_HANDLE)
    await vi.advanceTimersByTimeAsync(600)
    expect(pointerCount(write)).toBe(probeNumber - 1)
    expect(write.mock.calls.filter(([, data]) => data === '\r')).toHaveLength(0)
    db.close()
  })

  it.each([1, 2])(
    'fences a consumer rebound to the same pane during probe %i',
    async (probeNumber) => {
      vi.useFakeTimers()
      const db = createDatabase('orca-trae-generation-race-')
      let probes = 0
      let rebind = () => {}
      const { runtime, write } = createRuntime(db, {
        agent: 'trae',
        getAgentStatusSnapshot: () => [hook()],
        confirmForegroundProcess: async () => {
          if (++probes === probeNumber) {
            rebind()
          }
          return 'traex'
        }
      })
      const run = createBoundRun(db, 'Rebound consumer')
      rebind = () => {
        createBoundRun(db, 'Temporary owner')
        const rebound = db.bindRun({
          runId: run.id,
          coordinatorHandle: TERMINAL_HANDLE,
          coordinatorPaneKey: PANE_KEY
        })
        expect(rebound!.consumer_generation).toBeGreaterThan(run.consumer_generation)
      }
      await runtime.listTerminals()
      insertDirectRunMessage(db, run.id, 'Old generation only')
      runtime.deliverPendingMessagesForHandle(TERMINAL_HANDLE)
      await vi.advanceTimersByTimeAsync(600)
      expect(pointerCount(write)).toBe(probeNumber - 1)
      expect(write.mock.calls.filter(([, data]) => data === '\r')).toHaveLength(0)
      db.close()
    }
  )

  it.each([{ connectionId: 'ssh-host' }, { isWsl: true }])(
    'uses owning-host hooks and foreground probe for %j',
    async (placement) => {
      vi.useFakeTimers()
      const db = createDatabase('orca-trae-host-')
      const { runtime, write } = createRuntime(db, {
        ...placement,
        agent: 'trae',
        getAgentStatusSnapshot: () => [hook({ connectionId: placement.connectionId ?? null })]
      })
      const run = createBoundRun(db, 'Owning host')
      await runtime.listTerminals()
      insertDirectRunMessage(db, run.id, 'Host-scoped wake')
      runtime.deliverPendingMessagesForHandle(TERMINAL_HANDLE)
      await vi.advanceTimersByTimeAsync(600)
      expect(pointerCount(write)).toBe(1)
      expect(write.mock.calls.filter(([, data]) => data === '\r')).toHaveLength(1)
      db.close()
    }
  )

  it('rejects a Stop from before a provider generation reset', async () => {
    vi.useFakeTimers()
    const db = createDatabase('orca-trae-floor-')
    const old = hook()
    const { runtime, write } = createRuntime(db, {
      agent: 'trae',
      getAgentStatusSnapshot: () => [old]
    })
    const run = createBoundRun(db, 'Reset floor')
    await runtime.listTerminals()
    runtime.synchronizePtyOutputSequenceFromProvider(PTY_ID, {
      value: 0,
      generation: 'reset'
    })
    insertDirectRunMessage(db, run.id, 'Old Stop cannot wake')
    runtime.deliverPendingMessagesForHandle(TERMINAL_HANDLE)
    await vi.advanceTimersByTimeAsync(600)
    expect(write).not.toHaveBeenCalled()
    db.close()
  })
})

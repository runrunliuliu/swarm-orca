import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { EnrichedAgentHookEventPayload } from '../agent-hooks/server/server-types'
import type { LiveRunObservation } from '../task-records/task-records-live-runs'
import { createTaskRecordsLiveRunSubscription } from './task-records-live-run-subscription'

/**
 * Issue #68: the enriched-status → live-run projection used to exist only inside
 * `main-process-observers.ts`, which cannot load on the Node host. These cases drive
 * the shared assembly the headless entry now installs, and the second block pins the
 * entry wiring itself — a helper that returns a disposer proves nothing about an
 * entry point that never calls it.
 */

const WORKTREE_ID = 'repo-1::/repo/feature'
const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'

function enriched(
  overrides: Partial<EnrichedAgentHookEventPayload> = {}
): EnrichedAgentHookEventPayload {
  return {
    paneKey: PANE_KEY,
    connectionId: null,
    worktreeId: WORKTREE_ID,
    providerSession: { key: 'session_id', id: 'session-1', transcriptPath: '/tmp/s-1.jsonl' },
    payload: { state: 'working', prompt: 'run the tests' },
    receivedAt: 1_000,
    stateStartedAt: 1_000,
    ...overrides
  }
}

type Listener = (payload: EnrichedAgentHookEventPayload) => void

function harness(provider: 'claude' | undefined) {
  const listeners = new Set<Listener>()
  const record = vi.fn<(observation: LiveRunObservation) => void>()
  const providerForPaneKey = vi.fn(() => provider)
  const dispose = createTaskRecordsLiveRunSubscription({
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    providerForPaneKey,
    record
  })
  return {
    emit: (payload: EnrichedAgentHookEventPayload) => {
      for (const listener of listeners) {
        listener(payload)
      }
    },
    record,
    providerForPaneKey,
    dispose,
    listenerCount: () => listeners.size
  }
}

describe('createTaskRecordsLiveRunSubscription', () => {
  it('projects a real enriched row into the observation the ledger stores', () => {
    const { emit, record, providerForPaneKey } = harness('claude')

    emit(enriched())

    expect(providerForPaneKey).toHaveBeenCalledWith(PANE_KEY)
    expect(record).toHaveBeenCalledOnce()
    const observation = record.mock.calls[0][0]
    expect(observation.worktreeId).toBe(WORKTREE_ID)
    expect(observation.run).toMatchObject({
      key: 'claude|session_id:session-1',
      providerSession: { provider: 'claude', key: 'session_id', id: 'session-1' },
      transcriptPath: '/tmp/s-1.jsonl',
      startedAt: 1_000,
      source: 'live-observation'
    })
  })

  it('keeps absent facts absent instead of writing an undefined value', () => {
    const { emit, record } = harness('claude')

    emit(enriched({ payload: { state: 'working', prompt: '' } }))

    const run = record.mock.calls[0][0].run
    // A plain working row states no agent type, boundary, interrupt or main-agent
    // verdict; the ledger must not gain a key the hook server never sent.
    expect('agentType' in run).toBe(false)
    expect('sessionBoundary' in run).toBe(false)
    expect('interrupted' in run).toBe(false)
    expect('outcome' in run).toBe(false)
    expect('endedAt' in run).toBe(false)
  })

  it('skips a replay row instead of storing a prior runtime as a live run', () => {
    const { emit, record } = harness('claude')

    emit(enriched({ isReplay: true }))

    expect(record).not.toHaveBeenCalled()
  })

  it('writes once while the facts are unchanged and again when they move', () => {
    const { emit, record } = harness('claude')

    emit(enriched())
    emit(enriched({ receivedAt: 2_000 }))
    expect(record).toHaveBeenCalledOnce()

    emit(
      enriched({
        payload: {
          state: 'done',
          prompt: '',
          mainAgent: { state: 'done', outcome: 'success', stateStartedAt: 9_000 }
        },
        stateStartedAt: 9_000
      })
    )
    expect(record).toHaveBeenCalledTimes(2)
    expect(record.mock.calls[1][0].run.outcome).toBe('success')
  })

  it('stops observing once the disposer is called', () => {
    const { emit, record, dispose, listenerCount } = harness('claude')

    emit(enriched())
    dispose()
    emit(enriched({ stateStartedAt: 9_000, payload: { state: 'done', prompt: '' } }))

    expect(listenerCount()).toBe(0)
    expect(record).toHaveBeenCalledOnce()
  })

  it('leaves the provider absent when the pane has none', () => {
    const { emit, record } = harness(undefined)

    emit(enriched())

    const run = record.mock.calls[0][0].run
    expect('provider' in run.providerSession).toBe(false)
    expect(run.key).toBe('unknown|session_id:session-1')
  })

  it('skips a row it cannot attribute to a workspace', () => {
    const { emit, record } = harness('claude')

    emit(enriched({ worktreeId: undefined }))

    expect(record).not.toHaveBeenCalled()
  })
})

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), 'utf8')
}

describe('live run observation entry wiring', () => {
  it('loads on the Node host: the shared assembly never imports electron', () => {
    const source = readSource('src/main/startup/task-records-live-run-subscription.ts')

    expect(source).not.toMatch(/from ['"]electron['"]/)
    expect(source).not.toMatch(/from ['"]@electron-toolkit\//)
  })

  it('installs the observer on the orcad entry after Store readiness and before hooks', () => {
    const source = readSource('src/main/orcad/orcad-entry.ts')
    const storeReady = source.indexOf('createOrcadProfileStateStartup(runtimeUserDataPath,')
    const assembly = source.indexOf(
      'uninstallTaskRecordsLiveRun = installOrcadTaskRecordsLiveRuns('
    )
    const hookStart = source.indexOf('await agentHookServer.start(', storeReady)

    expect(storeReady).toBeGreaterThanOrEqual(0)
    expect(assembly).toBeGreaterThan(storeReady)
    expect(hookStart).toBeGreaterThan(assembly)
    // Exactly one assembly: a second call would subscribe the same feed twice and
    // leave one observer with no disposer.
    expect(source.match(/installOrcadTaskRecordsLiveRuns\(/g)).toHaveLength(1)
    // The call must hand its disposer to the entry, not drop it.
    expect(source.slice(assembly, hookStart)).toContain(
      'uninstallTaskRecordsLiveRun = installOrcadTaskRecordsLiveRuns({'
    )
    // The orcad assembly is the shared module's caller, not a second projection.
    expect(readSource('src/main/orcad/orcad-task-records-live-runs.ts')).toContain(
      "from '../startup/task-records-live-run-subscription'"
    )
  })

  it('stops live-run writes before the orcad persistence barrier and planned restart', () => {
    const source = readSource('src/main/orcad/orcad-entry.ts')
    const cleanup = source.indexOf('registerCleanup(async () => {')
    const disposeAtShutdown = source.indexOf('uninstallTaskRecordsLiveRun()', cleanup)
    const flush = source.indexOf(
      'flushOrcadProfileStoreForShutdown(profileStoreForShutdown)',
      cleanup
    )
    const freeze = source.indexOf('profileStoreForShutdown.freezeWritesAsync()', cleanup)
    const plannedRestart = source.indexOf('const handler = maintenance(async () => {')
    const disposeAtPlannedRestart = source.indexOf('uninstallTaskRecordsLiveRun()', plannedRestart)
    const plannedRestartFlush = source.indexOf(
      'flushOrcadProfileStoreForShutdown(profileStore)',
      plannedRestart
    )

    expect(cleanup).toBeGreaterThanOrEqual(0)
    expect(disposeAtShutdown).toBeGreaterThan(cleanup)
    expect(flush).toBeGreaterThan(disposeAtShutdown)
    expect(freeze).toBeGreaterThan(disposeAtShutdown)
    expect(disposeAtPlannedRestart).toBeGreaterThan(plannedRestart)
    expect(plannedRestartFlush).toBeGreaterThan(disposeAtPlannedRestart)
    // A launch that fails before the Store exists still runs this closure, so the
    // slot must be callable before the subscription is installed.
    expect(source).toContain('let uninstallTaskRecordsLiveRun = (): void => {}')
    // `registerCleanup` is a single slot: a second call would silently replace this
    // closure and drop the rpc/flush/daemon/hook teardown.
    expect(source.match(/registerCleanup\(/g)).toHaveLength(1)
  })

  it('wires the Electron entry through the same shared assembly', () => {
    const source = readSource('src/main/startup/main-process-observers.ts')
    const store = source.indexOf('const store = state.store')
    const assembly = source.indexOf('createTaskRecordsLiveRunSubscription(')

    expect(store).toBeGreaterThanOrEqual(0)
    expect(assembly).toBeGreaterThan(store)
    expect(source.match(/createTaskRecordsLiveRunSubscription\(/g)).toHaveLength(1)
    // The replay filter and the projection live in the shared module now; a local
    // copy is the drift this issue is about.
    expect(source).not.toContain('enriched.isReplay === true')
    expect(source).not.toContain('createTaskRecordsLiveRunObserver')
    expect(readSource('src/main/startup/task-records-live-run-subscription.ts')).toContain(
      'enriched.isReplay === true'
    )
  })
})

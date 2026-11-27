import { describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import type { EnrichedAgentHookEventPayload } from '../agent-hooks/server/server-types'
import type { LiveRunObservation } from '../task-records/task-records-live-runs'
import { installOrcadTaskRecordsLiveRuns } from './orcad-task-records-live-runs'

/**
 * The headless binding of issue #68. #57's writer was wired only in the Electron
 * observer initializer, whose module tree imports `electron`; `orcad` never observed
 * a run. These cases drive the binding the entry point installs, with the same two
 * collaborators the real one passes: the hook feed and the Store.
 *
 * The provider resolution is asserted against the archive source's expression
 * (`usageProviderForPaneKey(store.getWorkspaceSessionPartitions(), paneKey)`), because
 * a run's claim is derived from that provider: two resolutions would file one run
 * under two claims.
 */

const WORKTREE_ID = 'repo-1::/repo/feature'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'

type Listener = (payload: EnrichedAgentHookEventPayload) => void

function partitions() {
  return [
    {
      tabsByWorktree: {
        [WORKTREE_ID]: [
          { id: 'tab-claude', launchAgent: 'claude' },
          { id: 'tab-codex', launchAgent: 'codex' },
          { id: 'tab-plain' }
        ]
      }
    }
  ] as unknown as ReturnType<Store['getWorkspaceSessionPartitions']>
}

function harness() {
  const listeners = new Set<Listener>()
  const recordTaskRecordLiveRun = vi.fn<(observation: LiveRunObservation) => boolean>(() => true)
  const store = {
    getWorkspaceSessionPartitions: () => partitions(),
    recordTaskRecordLiveRun
  }
  const dispose = installOrcadTaskRecordsLiveRuns({
    hookServer: {
      subscribeEnrichedStatus: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    },
    store
  })
  return {
    emit: (payload: EnrichedAgentHookEventPayload) => {
      for (const listener of listeners) {
        listener(payload)
      }
    },
    recordTaskRecordLiveRun,
    dispose,
    listenerCount: () => listeners.size
  }
}

function enriched(tabId: string, overrides: Partial<EnrichedAgentHookEventPayload> = {}) {
  return {
    paneKey: `${tabId}:${LEAF_ID}`,
    connectionId: null,
    worktreeId: WORKTREE_ID,
    providerSession: { key: 'session_id', id: 'session-1' },
    payload: { state: 'working', prompt: 'run the tests' },
    receivedAt: 1_000,
    stateStartedAt: 1_000,
    ...overrides
  } satisfies EnrichedAgentHookEventPayload
}

describe('installOrcadTaskRecordsLiveRuns', () => {
  it('resolves the provider from the pane launch tab and writes through the Store', () => {
    const { emit, recordTaskRecordLiveRun } = harness()

    emit(enriched('tab-claude'))

    expect(recordTaskRecordLiveRun).toHaveBeenCalledOnce()
    const observation = recordTaskRecordLiveRun.mock.calls[0][0]
    expect(observation.worktreeId).toBe(WORKTREE_ID)
    expect(observation.run.providerSession).toEqual({
      provider: 'claude',
      key: 'session_id',
      id: 'session-1'
    })
    expect(observation.run.source).toBe('live-observation')
  })

  it('maps another launch agent to its own usage bucket', () => {
    const { emit, recordTaskRecordLiveRun } = harness()

    emit(enriched('tab-codex'))

    expect(recordTaskRecordLiveRun.mock.calls[0][0].run.providerSession).toEqual({
      provider: 'codex',
      key: 'session_id',
      id: 'session-1'
    })
  })

  it('leaves the provider absent for a pane Orca did not launch', () => {
    const { emit, recordTaskRecordLiveRun } = harness()

    emit(enriched('tab-plain'))
    emit(enriched('tab-not-open', { providerSession: { key: 'session_id', id: 'session-2' } }))

    expect(recordTaskRecordLiveRun).toHaveBeenCalledTimes(2)
    for (const [observation] of recordTaskRecordLiveRun.mock.calls) {
      expect('provider' in observation.run.providerSession).toBe(false)
    }
  })

  it('does not write a replay row the hook feed cached from a prior runtime', () => {
    const { emit, recordTaskRecordLiveRun } = harness()

    emit(enriched('tab-claude', { isReplay: true }))

    expect(recordTaskRecordLiveRun).not.toHaveBeenCalled()
  })

  it('stops writing once the entry disposes the subscription', () => {
    const { emit, recordTaskRecordLiveRun, dispose, listenerCount } = harness()

    emit(enriched('tab-claude'))
    dispose()
    emit(enriched('tab-claude', { stateStartedAt: 9_000, payload: { state: 'done', prompt: '' } }))

    expect(listenerCount()).toBe(0)
    expect(recordTaskRecordLiveRun).toHaveBeenCalledOnce()
  })
})

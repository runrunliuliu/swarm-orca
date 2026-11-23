import { describe, expect, it } from 'vitest'
import type {
  TaskRecordsUsageStoreSet,
  TaskRecordSessionIdentity
} from './task-records-worktree-usage'
import {
  buildTaskUsageSettlement,
  createTaskRecordsUsageSource,
  hookSessionFacts,
  withHookSessionFacts
} from './task-records-worktree-usage'

const ID = 'repo-1::/repo/feature'

function claudeRow(tokens: number, cost: number | null) {
  return {
    key: `worktree:${ID}`,
    inputTokens: tokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCostUsd: cost
  }
}

function codexRow(tokens: number, cost: number | null) {
  return {
    key: `worktree:${ID}`,
    totalTokens: tokens,
    estimatedCostUsd: cost
  }
}

function store<Row extends { key: string }>(rows: Row[], enabled = true) {
  return {
    getScanState: () => ({ enabled }),
    getSnapshot: () => ({ projectBreakdown: rows })
  }
}

function stores(overrides: {
  claude?: { enabled: boolean; rows: ReturnType<typeof claudeRow>[] }
  codex?: { enabled: boolean; rows: ReturnType<typeof codexRow>[] }
}): TaskRecordsUsageStoreSet {
  return {
    claude: store(overrides.claude?.rows ?? [], overrides.claude?.enabled ?? true),
    codex: store(overrides.codex?.rows ?? [], overrides.codex?.enabled ?? true),
    opencode: store([]),
    muse: store([])
  }
}

describe('worktree usage settlement', () => {
  it('keeps the per-provider rows and sums a fully priced figure', () => {
    const settlement = buildTaskUsageSettlement({
      worktreeId: ID,
      hostId: 'local',
      now: 100,
      enabled: true,
      providers: [
        { provider: 'claude', tokens: 900, costUsd: 0.1 },
        { provider: 'codex', tokens: 100, costUsd: 0.05 }
      ]
    })

    expect(settlement).toEqual({
      kind: 'known',
      collectedAt: 100,
      scope: 'worktree-rollup',
      worktreeId: ID,
      providers: [
        { provider: 'claude', tokens: 900, costUsd: 0.1 },
        { provider: 'codex', tokens: 100, costUsd: 0.05 }
      ],
      estimatedCostUsd: 0.15000000000000002
    })
  })

  it('reports an unpriced provider as an unknown total instead of a partial sum', () => {
    const settlement = buildTaskUsageSettlement({
      worktreeId: ID,
      hostId: 'local',
      now: 100,
      enabled: true,
      providers: [
        { provider: 'claude', tokens: 900, costUsd: 0.1 },
        { provider: 'muse', tokens: 100, costUsd: null }
      ]
    })

    expect(settlement).toMatchObject({ kind: 'known', estimatedCostUsd: null })
  })

  it.each([
    [
      'usage switched off',
      { enabled: false, providers: [], hostId: 'local' as const },
      'usage_not_enabled'
    ],
    [
      'a remote host',
      {
        enabled: true,
        providers: [{ provider: 'claude' as const, tokens: 1, costUsd: 1 }],
        hostId: 'ssh:box' as const
      },
      'remote_usage_unavailable'
    ],
    [
      'no matching row',
      { enabled: true, providers: [], hostId: 'local' as const },
      'no_matching_session'
    ]
  ])('records %s as unavailable, never as zero', (_label, input, reason) => {
    const settlement = buildTaskUsageSettlement({
      worktreeId: ID,
      now: 100,
      ...input
    })

    expect(settlement).toEqual({
      kind: 'unavailable',
      collectedAt: 100,
      scope: 'worktree-rollup',
      worktreeId: ID,
      reason
    })
    expect(settlement).not.toHaveProperty('providers')
  })
})

describe('task records usage source', () => {
  it('reads this worktree key from all four providers and keeps its own sessions', () => {
    const identities: TaskRecordSessionIdentity[] = [
      { paneKey: 'tab-1:leaf', sessionId: 'abc', key: 'session_id', worktreeId: ID },
      {
        paneKey: 'tab-2:leaf',
        sessionId: 'other',
        key: 'session_id',
        worktreeId: 'repo-2::/repo/x'
      }
    ]
    const source = createTaskRecordsUsageSource({
      stores: stores({
        claude: { enabled: true, rows: [claudeRow(900, 0.1)] },
        codex: { enabled: true, rows: [codexRow(100, 0.05)] }
      }),
      sessionIdentities: () => identities,
      providerForPaneKey: (paneKey) => (paneKey === 'tab-1:leaf' ? 'claude' : undefined)
    })

    const snapshot = source.snapshotForRemoval({ worktreeId: ID, hostId: 'local', now: 100 })

    expect(snapshot.settlement).toMatchObject({
      kind: 'known',
      providers: [
        { provider: 'claude', tokens: 900 },
        { provider: 'codex', tokens: 100 }
      ]
    })
    expect(snapshot.sessions).toEqual([
      {
        provider: 'claude',
        key: 'session_id',
        id: 'abc',
        firstSeenAt: 100,
        lastSeenAt: 100
      }
    ])
  })

  it('consumes a capture exactly once, then reads the live hook server again', () => {
    let identities: TaskRecordSessionIdentity[] = [
      { paneKey: 'tab-1:leaf', sessionId: 'abc', key: 'session_id', worktreeId: ID }
    ]
    const source = createTaskRecordsUsageSource({
      stores: stores({}),
      sessionIdentities: () => identities,
      providerForPaneKey: () => 'claude'
    })

    source.captureSessionsForRemoval(ID)
    // The sweep clears the hook server's pane state after the capture.
    identities = []

    expect(
      source.snapshotForRemoval({ worktreeId: ID, hostId: 'local', now: 100 }).sessions
    ).toEqual([expect.objectContaining({ id: 'abc' })])
    expect(
      source.snapshotForRemoval({ worktreeId: ID, hostId: 'local', now: 101 }).sessions
    ).toEqual([])
  })

  it('ignores a capture older than its TTL and reads the live hook server', () => {
    let identities: TaskRecordSessionIdentity[] = [
      { paneKey: 'tab-1:leaf', sessionId: 'abc', key: 'session_id', worktreeId: ID }
    ]
    const source = createTaskRecordsUsageSource({
      stores: stores({}),
      sessionIdentities: () => identities,
      providerForPaneKey: () => 'claude'
    })

    source.captureSessionsForRemoval(ID)
    // The occupant is gone by the time a later removal consumes the locator.
    identities = []

    // A removal that never dropped the row leaves a stale capture behind; a
    // later removal must not inherit it as the removed workspace's sessions.
    const staleNow = Date.now() + 11 * 60 * 1000
    expect(
      source.snapshotForRemoval({ worktreeId: ID, hostId: 'local', now: staleNow }).sessions
    ).toEqual([])
  })

  it('does not record a session whose provider field name is unknown', () => {
    const source = createTaskRecordsUsageSource({
      stores: stores({}),
      sessionIdentities: () => [{ paneKey: 'tab-1:leaf', sessionId: 'abc', worktreeId: ID }],
      providerForPaneKey: () => 'claude'
    })

    const snapshot = source.snapshotForRemoval({ worktreeId: ID, hostId: 'local', now: 100 })

    expect(snapshot.sessions).toEqual([])
    expect(snapshot.settlement).toMatchObject({
      kind: 'unavailable',
      reason: 'no_matching_session'
    })
  })

  /**
   * The four states one snapshot can be in, kept apart at the source:
   * not captured (`null`), measured-but-missing (`unavailable` + reason),
   * measured with an incomplete price (`known` + `estimatedCostUsd: null`), and
   * a measured number. A source with no store set used to answer
   * `usage_not_enabled`, which stated a setting the build does not have (G4).
   */
  describe('the four settlement states', () => {
    const deps = { sessionIdentities: () => [], providerForPaneKey: () => undefined }
    const at = { worktreeId: ID, hostId: 'local' as const, now: 100 }

    it('states no settlement at all when this build has no usage store', () => {
      const source = createTaskRecordsUsageSource(deps)

      // `null`, not `unavailable` + a reason: no enum reason is true of a build
      // that never measured, and the writer stores nothing for it.
      expect(source.snapshotForRemoval(at).settlement).toBeNull()
      expect(source.snapshotForArchive?.(at).settlement).toBeNull()
    })

    it('states the measured reason when the scan found nothing', () => {
      const source = createTaskRecordsUsageSource({ ...deps, stores: stores({}) })

      expect(source.snapshotForRemoval(at).settlement).toMatchObject({
        kind: 'unavailable',
        reason: 'no_matching_session'
      })
    })

    it('keeps a measured total whose price is missing distinct from a priced one', () => {
      const source = createTaskRecordsUsageSource({
        ...deps,
        // A priced provider plus an unpriced one: tokens are measured, the amount
        // is not, so the total is `known` with `estimatedCostUsd: null` — neither
        // an absence nor a partial sum.
        stores: stores({
          claude: { enabled: true, rows: [claudeRow(900, 0.1)] },
          codex: { enabled: true, rows: [codexRow(100, null)] }
        })
      })

      expect(source.snapshotForRemoval(at).settlement).toMatchObject({
        kind: 'known',
        providers: [
          { provider: 'claude', tokens: 900 },
          { provider: 'codex', tokens: 100 }
        ],
        estimatedCostUsd: null
      })
    })

    it('states the measured number when every contributing row is priced', () => {
      const source = createTaskRecordsUsageSource({
        ...deps,
        stores: stores({
          claude: { enabled: true, rows: [claudeRow(900, 0.1)] },
          codex: { enabled: true, rows: [codexRow(100, 0.05)] }
        })
      })

      expect(source.snapshotForRemoval(at).settlement).toMatchObject({
        kind: 'known',
        estimatedCostUsd: 0.15000000000000002
      })
    })
  })
})

/**
 * Issue #53 §4: the snapshot facts the hook status row states, and the
 * capture-free archive entry of the source.
 */
describe('hook session facts', () => {
  it('dates the two edges from the clock that actually states them', () => {
    // A running row: `stateStartedAt` is when this working stretch began, so it is
    // a start. The same value is never also the end.
    expect(
      hookSessionFacts({ paneKey: 'tab-1:leaf', state: 'working', stateStartedAt: 100 })
    ).toEqual({ startedAt: 100 })
    // A settled row: its `stateStartedAt` is when it became done — the end of the
    // run, not its start (a zero-length run would be the lie).
    expect(hookSessionFacts({ paneKey: 'tab-1:leaf', state: 'done', stateStartedAt: 200 })).toEqual(
      { endedAt: 200 }
    )
    // `done` as a session boundary means "connected idle", not a completed run.
    expect(
      hookSessionFacts({
        paneKey: 'tab-1:leaf',
        state: 'done',
        stateStartedAt: 200,
        sessionBoundary: true
      })
    ).toEqual({})
    // The hook server no longer holds the pane: nothing observed, nothing claimed.
    expect(hookSessionFacts(undefined)).toEqual({})
  })

  it('carries the agent type through but never invents a provider', () => {
    const [identity] = withHookSessionFacts(
      [{ paneKey: 'tab-1:leaf', sessionId: 'abc', key: 'session_id', worktreeId: ID }],
      [{ paneKey: 'tab-1:leaf', agentType: 'pi', state: 'done', stateStartedAt: 200 }]
    )

    // `pi` is a real agent type and not one of the four usage providers, which is
    // the provider lookup's decision, not this join's.
    expect(identity.agentType).toBe('pi')
    expect(identity.endedAt).toBe(200)
    expect(identity).not.toHaveProperty('startedAt')
  })

  it('takes the turn verdict the row stated and leaves a plain Stop unknown', () => {
    // The provider's own ruling on the turn, read off the main agent's row.
    expect(
      hookSessionFacts({
        paneKey: 'tab-1:leaf',
        state: 'done',
        stateStartedAt: 200,
        mainAgent: { state: 'done', outcome: 'failure' }
      })
    ).toEqual({ endedAt: 200, outcome: 'failure' })
    // The user's own interrupt, which the status row records as a cancellation.
    expect(
      hookSessionFacts({
        paneKey: 'tab-1:leaf',
        state: 'done',
        stateStartedAt: 200,
        interrupted: true
      })
    ).toEqual({ endedAt: 200, outcome: 'cancellation' })
    // A plain Stop states no verdict. `success` here would turn every cancel by an
    // older provider into a clean finish, so the field stays absent.
    const plainStop = hookSessionFacts({
      paneKey: 'tab-1:leaf',
      state: 'done',
      stateStartedAt: 200
    })
    expect(plainStop).not.toHaveProperty('outcome')
    // The main agent still works, so its latest finished turn says nothing about
    // the run that is open now.
    expect(
      hookSessionFacts({
        paneKey: 'tab-1:leaf',
        state: 'working',
        stateStartedAt: 100,
        mainAgent: { state: 'working' }
      })
    ).not.toHaveProperty('outcome')
  })
})

describe('archive snapshot entry', () => {
  const identities: TaskRecordSessionIdentity[] = [
    {
      paneKey: 'tab-1:leaf',
      sessionId: 'abc',
      key: 'session_id',
      worktreeId: ID,
      agentType: 'claude',
      startedAt: 100,
      endedAt: 200,
      messageCount: 7,
      title: 'Fix the snapshot'
    }
  ]

  function sourceWithFacts() {
    return createTaskRecordsUsageSource({
      stores: stores({}),
      sessionIdentities: () => identities,
      providerForPaneKey: () => 'claude'
    })
  }

  it('records the extended identity on the session row', () => {
    const snapshot = sourceWithFacts().snapshotForArchive?.({
      worktreeId: ID,
      hostId: 'local',
      now: 300
    })

    expect(snapshot?.sessions).toEqual([
      {
        provider: 'claude',
        key: 'session_id',
        id: 'abc',
        agentType: 'claude',
        startedAt: 100,
        endedAt: 200,
        messageCount: 7,
        title: 'Fix the snapshot',
        firstSeenAt: 300,
        lastSeenAt: 300
      }
    ])
  })

  it('does not consume a capture taken for a removal that has not happened yet', () => {
    const source = sourceWithFacts()
    source.captureSessionsForRemoval(ID)
    const live = identities.slice()

    // An archive must read the live server: taking the capture here would leave the
    // later removal to settle from a server whose panes are already gone.
    expect(
      source.snapshotForArchive?.({ worktreeId: ID, hostId: 'local', now: 300 }).sessions
    ).toHaveLength(1)
    expect(
      source.snapshotForRemoval({ worktreeId: ID, hostId: 'local', now: 400 }).sessions
    ).toHaveLength(1)
    expect(live).toHaveLength(1)
  })

  it('carries the verdict beside the session rows, keyed by the run claim', () => {
    const source = createTaskRecordsUsageSource({
      stores: stores({}),
      sessionIdentities: () => [
        { ...identities[0], outcome: 'cancellation' },
        // A second pane whose row stated no verdict: absent, not a default.
        {
          paneKey: 'tab-2:leaf',
          sessionId: 'def',
          key: 'session_id',
          worktreeId: ID
        }
      ],
      providerForPaneKey: () => 'claude'
    })

    const snapshot = source.snapshotForArchive?.({ worktreeId: ID, hostId: 'local', now: 300 })

    // The session row itself is unchanged (it has no field for a verdict), so the
    // vote travels under the same claim the run row is keyed by.
    expect(snapshot?.sessions).toHaveLength(2)
    expect(snapshot?.sessions[0]).not.toHaveProperty('outcome')
    expect([...(snapshot?.outcomes ?? new Map())]).toEqual([
      ['claude|session_id:abc', 'cancellation']
    ])
    // Nothing stated → no entry at all: an empty map would be a claim that the
    // verdict is "none", and the run row must be able to tell the difference.
    expect(snapshot?.outcomes?.has('claude|session_id:def')).toBe(false)
  })
})

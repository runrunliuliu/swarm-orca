import { describe, expect, it } from 'vitest'
import type {
  TaskRecordsUsageStoreSet,
  TaskRecordSessionIdentity
} from './task-records-worktree-usage'
import {
  buildTaskUsageSettlement,
  createTaskRecordsUsageSource
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
})

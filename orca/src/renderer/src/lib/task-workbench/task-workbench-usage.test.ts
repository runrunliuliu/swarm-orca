import { describe, expect, it } from 'vitest'
import type { UsageBreakdownRow, UsageSelectorInput } from './task-workbench-selector-types'
import { selectTaskWorkbenchUsage } from './task-workbench-usage'

/**
 * Hand-written expectations (00-contract.md rule 7): every figure below is a
 * literal from the spec's table, never a value read back from the selector.
 */

const WT_APP = 'repo-a::/w/app'
const WT_OTHER = 'repo-a::/w/other'

/** Spelled out so the fixtures do not derive their keys from `worktreeUsageKey`. */
function keyFor(worktreeId: string): string {
  return `worktree:${worktreeId}`
}

function row(key: string, tokens: number, costUsd: number | null, label = key): UsageBreakdownRow {
  return { key, label, tokens, costUsd }
}

function input(overrides: Partial<UsageSelectorInput> = {}): UsageSelectorInput {
  return {
    worktreeIds: [WT_APP],
    enabled: true,
    remote: false,
    providers: [],
    ...overrides
  }
}

/** One priced row for the task's only worktree. */
function appRows(): UsageSelectorInput['providers'] {
  return [{ provider: 'claude', rows: [row(keyFor(WT_APP), 1200, 1.25)] }]
}

describe('selectTaskWorkbenchUsage — task spend', () => {
  it('sums only the exact worktree key across providers (the projectBreakdown litmus)', () => {
    const result = selectTaskWorkbenchUsage(
      input({
        providers: [
          {
            provider: 'claude',
            rows: [
              row(keyFor(WT_APP), 1200, 1.25),
              // Large, and deliberately in the same provider: it must not leak.
              row(keyFor(WT_OTHER), 900_000, 7)
            ]
          },
          { provider: 'codex', rows: [row(keyFor(WT_APP), 300, 0.5)] },
          { provider: 'opencode', rows: [row(keyFor(WT_APP), 50, 0.25)] }
        ]
      })
    )

    // 1200 + 300 + 50 = 1550; 1.25 + 0.5 + 0.25 = 2.
    expect(result.spend).toEqual({
      kind: 'available',
      tokens: 1550,
      costUsd: 2,
      byProvider: [
        { provider: 'claude', tokens: 1200, costUsd: 1.25 },
        { provider: 'codex', tokens: 300, costUsd: 0.5 },
        { provider: 'opencode', tokens: 50, costUsd: 0.25 }
      ],
      unattributedSessions: 0
    })
    expect(result.workspaces).toEqual([
      {
        worktreeId: WT_APP,
        status: 'available',
        tokens: 1550,
        costUsd: 2,
        byProvider: [
          { provider: 'claude', tokens: 1200, costUsd: 1.25 },
          { provider: 'codex', tokens: 300, costUsd: 0.5 },
          { provider: 'opencode', tokens: 50, costUsd: 0.25 }
        ]
      }
    ])
  })

  it('never substring-matches, never sums a repo: sibling and never falls back to a label', () => {
    const result = selectTaskWorkbenchUsage(
      input({
        providers: [
          {
            provider: 'claude',
            rows: [
              row(keyFor(WT_APP), 100, 0.5),
              row(`${keyFor(WT_APP)}-extra`, 7000, 3),
              row(`${keyFor(WT_APP)}/child`, 8000, 4),
              row('repo:repo-a', 9000, 5),
              // Label matches the worktree display name; the key does not.
              row(keyFor(WT_OTHER), 6000, 2, 'app')
            ]
          }
        ]
      })
    )

    expect(result.spend).toEqual({
      kind: 'available',
      tokens: 100,
      costUsd: 0.5,
      byProvider: [{ provider: 'claude', tokens: 100, costUsd: 0.5 }],
      unattributedSessions: 0
    })
    expect(result.workspaces[0]).toEqual({
      worktreeId: WT_APP,
      status: 'available',
      tokens: 100,
      costUsd: 0.5,
      byProvider: [{ provider: 'claude', tokens: 100, costUsd: 0.5 }]
    })
  })

  it('applies the precedence in spec order: disabled, then remote, then ambiguous', () => {
    const allThree = selectTaskWorkbenchUsage(
      input({
        enabled: false,
        remote: true,
        attribution: { kind: 'ambiguous' },
        providers: appRows()
      })
    )
    expect(allThree.spend).toEqual({ kind: 'unavailable', reason: 'disabled' })

    const remoteAndAmbiguous = selectTaskWorkbenchUsage(
      input({ remote: true, attribution: { kind: 'ambiguous' }, providers: appRows() })
    )
    expect(remoteAndAmbiguous.spend).toEqual({ kind: 'unavailable', reason: 'remote_host' })
  })

  it('reports disabled even when stale rows are present', () => {
    const result = selectTaskWorkbenchUsage(input({ enabled: false, providers: appRows() }))

    expect(result.spend).toEqual({ kind: 'unavailable', reason: 'disabled' })
    expect(result.workspaces).toEqual([
      { worktreeId: WT_APP, status: 'disabled', tokens: null, costUsd: null, byProvider: [] }
    ])
  })

  it('reports remote_host at task and workspace level', () => {
    const result = selectTaskWorkbenchUsage(input({ remote: true, providers: appRows() }))

    expect(result.spend).toEqual({ kind: 'unavailable', reason: 'remote_host' })
    expect(result.workspaces).toEqual([
      { worktreeId: WT_APP, status: 'remote_host', tokens: null, costUsd: null, byProvider: [] }
    ])
  })

  it('reports ambiguous_session for an ambiguous attribution window', () => {
    const result = selectTaskWorkbenchUsage(
      input({ attribution: { kind: 'ambiguous' }, providers: appRows() })
    )

    expect(result.spend).toEqual({ kind: 'unavailable', reason: 'ambiguous_session' })
    // Attribution is a task-level question; the worktree total still exists.
    expect(result.workspaces[0]).toEqual({
      worktreeId: WT_APP,
      status: 'available',
      tokens: 1200,
      costUsd: 1.25,
      byProvider: [{ provider: 'claude', tokens: 1200, costUsd: 1.25 }]
    })
  })

  it('does not treat an explicit non-ambiguous attribution as unavailable', () => {
    const result = selectTaskWorkbenchUsage(
      input({ attribution: { kind: 'none' }, providers: appRows() })
    )

    expect(result.spend).toEqual({
      kind: 'available',
      tokens: 1200,
      costUsd: 1.25,
      byProvider: [{ provider: 'claude', tokens: 1200, costUsd: 1.25 }],
      unattributedSessions: 0
    })
  })

  it('reports no_matching_session — a value distinct from disabled — when no key matches', () => {
    const result = selectTaskWorkbenchUsage(
      input({ providers: [{ provider: 'codex', rows: [row(keyFor(WT_OTHER), 500, 1)] }] })
    )

    expect(result.spend).toEqual({ kind: 'unavailable', reason: 'no_matching_session' })
    expect(result.spend).not.toEqual({ kind: 'unavailable', reason: 'disabled' })
    expect(result.workspaces).toEqual([
      {
        worktreeId: WT_APP,
        status: 'no_matching_session',
        tokens: null,
        costUsd: null,
        byProvider: []
      }
    ])
  })

  it('keeps tokens but leaves cost unknown when any contributing row is unpriced', () => {
    const result = selectTaskWorkbenchUsage(
      input({
        providers: [
          { provider: 'claude', rows: [row(keyFor(WT_APP), 1000, 1.5)] },
          { provider: 'codex', rows: [row(keyFor(WT_APP), 200, null)] }
        ]
      })
    )

    expect(result.spend).toEqual({
      kind: 'available',
      tokens: 1200,
      costUsd: null,
      byProvider: [
        { provider: 'claude', tokens: 1000, costUsd: 1.5 },
        { provider: 'codex', tokens: 200, costUsd: null }
      ],
      unattributedSessions: 0
    })
    expect(result.workspaces[0]).toEqual({
      worktreeId: WT_APP,
      status: 'unpriced',
      tokens: 1200,
      costUsd: null,
      byProvider: [
        { provider: 'claude', tokens: 1000, costUsd: 1.5 },
        { provider: 'codex', tokens: 200, costUsd: null }
      ]
    })
  })

  it('keeps input provider order and omits a provider with no matched row', () => {
    const result = selectTaskWorkbenchUsage(
      input({
        providers: [
          { provider: 'muse', rows: [row(keyFor(WT_APP), 40, 0.2)] },
          { provider: 'codex', rows: [row(keyFor(WT_OTHER), 999, 9)] },
          { provider: 'claude', rows: [row(keyFor(WT_APP), 60, 0.3)] }
        ]
      })
    )

    expect(result.spend).toEqual({
      kind: 'available',
      tokens: 100,
      costUsd: 0.5,
      byProvider: [
        { provider: 'muse', tokens: 40, costUsd: 0.2 },
        { provider: 'claude', tokens: 60, costUsd: 0.3 }
      ],
      unattributedSessions: 0
    })
    expect(result.workspaces[0].byProvider).toEqual([
      { provider: 'muse', tokens: 40, costUsd: 0.2 },
      { provider: 'claude', tokens: 60, costUsd: 0.3 }
    ])
  })

  it('passes unattributedSessions through and reads an absent counter as 0', () => {
    const providers = appRows()

    const withCount = selectTaskWorkbenchUsage(input({ providers, unattributedSessions: 3 }))
    expect(withCount.spend).toEqual({
      kind: 'available',
      tokens: 1200,
      costUsd: 1.25,
      byProvider: [{ provider: 'claude', tokens: 1200, costUsd: 1.25 }],
      unattributedSessions: 3
    })

    const absent = selectTaskWorkbenchUsage(input({ providers }))
    expect(absent.spend).toEqual({
      kind: 'available',
      tokens: 1200,
      costUsd: 1.25,
      byProvider: [{ provider: 'claude', tokens: 1200, costUsd: 1.25 }],
      unattributedSessions: 0
    })
  })

  it('keeps a measured zero in an available state', () => {
    const result = selectTaskWorkbenchUsage(
      input({ providers: [{ provider: 'claude', rows: [row(keyFor(WT_APP), 0, 0)] }] })
    )

    expect(result.spend).toEqual({
      kind: 'available',
      tokens: 0,
      costUsd: 0,
      byProvider: [{ provider: 'claude', tokens: 0, costUsd: 0 }],
      unattributedSessions: 0
    })
  })
})

describe('selectTaskWorkbenchUsage — workspace totals', () => {
  it('returns an entry for every worktree, including one with no matching row', () => {
    const result = selectTaskWorkbenchUsage(
      input({
        worktreeIds: [WT_APP, WT_OTHER],
        providers: [{ provider: 'claude', rows: [row(keyFor(WT_APP), 500, 0.5)] }]
      })
    )

    expect(result.workspaces).toEqual([
      {
        worktreeId: WT_APP,
        status: 'available',
        tokens: 500,
        costUsd: 0.5,
        byProvider: [{ provider: 'claude', tokens: 500, costUsd: 0.5 }]
      },
      {
        worktreeId: WT_OTHER,
        status: 'no_matching_session',
        tokens: null,
        costUsd: null,
        byProvider: []
      }
    ])
  })

  it('keeps the task total equal to the sum of the workspace totals', () => {
    const result = selectTaskWorkbenchUsage(
      input({
        worktreeIds: [WT_APP, WT_OTHER],
        providers: [
          {
            provider: 'claude',
            rows: [row(keyFor(WT_APP), 120, 1), row(keyFor(WT_OTHER), 30, 0.25)]
          },
          {
            provider: 'codex',
            rows: [row(keyFor(WT_APP), 80, 0.5), row(keyFor(WT_OTHER), 20, 0.25)]
          }
        ]
      })
    )

    expect(result.spend.kind).toBe('available')
    if (result.spend.kind !== 'available') {
      throw new Error('expected an available spend')
    }
    // 120 + 80 = 200 and 30 + 20 = 50, so 200 + 50 = 250.
    expect(result.workspaces.map((workspace) => workspace.tokens)).toEqual([200, 50])
    expect(result.spend.tokens).toBe(250)
  })

  it('carries null, never 0, in the three non-numeric states', () => {
    const cases: UsageSelectorInput[] = [
      input({ enabled: false, providers: appRows() }),
      input({ remote: true, providers: appRows() }),
      input({ providers: [{ provider: 'claude', rows: [row(keyFor(WT_OTHER), 500, 1)] }] })
    ]

    for (const candidate of cases) {
      for (const workspace of selectTaskWorkbenchUsage(candidate).workspaces) {
        expect(workspace.tokens).toBeNull()
        expect(workspace.costUsd).toBeNull()
        expect(workspace.byProvider).toEqual([])
      }
    }
  })
})

describe('selectTaskWorkbenchUsage — agent tokens', () => {
  it('emits ai-vault tokens only for session-bearing agents', () => {
    const result = selectTaskWorkbenchUsage(
      input({
        agents: [
          { paneKey: 'pane-1', session: { tokens: 4200 } },
          { paneKey: 'pane-sessionless' },
          { paneKey: 'pane-3', session: { tokens: 7, caveat: 'retained session' } }
        ]
      })
    )

    expect(result.agentTokens).toEqual({
      'pane-1': { kind: 'ai-vault', tokens: 4200 },
      'pane-3': { kind: 'ai-vault', tokens: 7, caveat: 'retained session' }
    })
    expect(Object.keys(result.agentTokens)).toEqual(['pane-1', 'pane-3'])
    expect('pane-sessionless' in result.agentTokens).toBe(false)
    expect('caveat' in result.agentTokens['pane-1']).toBe(false)
    for (const view of Object.values(result.agentTokens)) {
      expect(view.kind).not.toBe('rollup')
    }
  })

  it('keeps per-agent AI Vault tokens independent of the usage scan state', () => {
    const result = selectTaskWorkbenchUsage(
      input({
        enabled: false,
        agents: [{ paneKey: 'pane-1', session: { tokens: 4200 } }]
      })
    )

    expect(result.spend).toEqual({ kind: 'unavailable', reason: 'disabled' })
    expect(result.agentTokens).toEqual({ 'pane-1': { kind: 'ai-vault', tokens: 4200 } })
  })
})

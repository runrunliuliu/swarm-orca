import { describe, expect, it } from 'vitest'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import type {
  TaskUsageSettlement,
  TaskWorkspaceBinding
} from '../../../../shared/task-records-types'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../../shared/execution-host'
import { archivedRowTokens, settlementsByWorktree } from './task-workbench-archived-settlement'

/**
 * The archived-workspace token lookup (issue #53 A1/A2 + N1).
 *
 * Two rules are pinned here and nowhere else: a settlement is keyed by worktree
 * *and* host, so two hosts cannot overwrite one worktree's figure, and a row whose
 * workspace never settled stays `unattributed` — never `0`.
 */

function settlement(worktreeId: string, tokens: number, collectedAt = 3_000): TaskUsageSettlement {
  return {
    kind: 'known',
    collectedAt,
    scope: 'worktree-rollup',
    worktreeId,
    providers: [{ provider: 'claude', tokens, costUsd: 0.1 }],
    estimatedCostUsd: 0.1
  }
}

function binding(
  worktreeId: string,
  hostId: ExecutionHostId,
  overrides: Partial<TaskWorkspaceBinding> = {}
): TaskWorkspaceBinding {
  return {
    worktreeId,
    repoId: 'repo-1',
    hostId,
    path: `/repo/${worktreeId}`,
    isArchived: true,
    boundAt: 1_000,
    boundBy: 'created',
    lastVerifiedAt: 2_000,
    sessions: [],
    ...overrides
  }
}

function card(paneKey: string, agentType = 'claude'): DashboardCard {
  return { paneKey, agentType } as DashboardCard
}

describe('settlementsByWorktree', () => {
  it('keeps two hosts apart and prefers the local host for one worktree', () => {
    const remote = binding('wt-1', 'ssh:remote', {
      usageSettlement: settlement('wt-1', 111, 9_000)
    })
    const local = binding('wt-1', LOCAL_EXECUTION_HOST_ID, {
      usageSettlement: settlement('wt-1', 222, 1_000)
    })

    // Both directions, because "last binding wins" is exactly the bug N1 names.
    for (const bindings of [
      [remote, local],
      [local, remote]
    ]) {
      const byWorktree = settlementsByWorktree(bindings)
      expect(byWorktree.size).toBe(1)
      expect(byWorktree.get('wt-1')).toEqual(settlement('wt-1', 222, 1_000))
    }
  })

  it('keeps the newer collection when neither host is local', () => {
    const older = binding('wt-1', 'ssh:a', { usageSettlement: settlement('wt-1', 100, 1_000) })
    const newer = binding('wt-1', 'ssh:b', { usageSettlement: settlement('wt-1', 200, 2_000) })

    expect(settlementsByWorktree([older, newer]).get('wt-1')).toEqual(
      settlement('wt-1', 200, 2_000)
    )
    expect(settlementsByWorktree([newer, older]).get('wt-1')).toEqual(
      settlement('wt-1', 200, 2_000)
    )
  })

  it('ignores a binding that never settled a figure', () => {
    expect(settlementsByWorktree([binding('wt-1', LOCAL_EXECUTION_HOST_ID)])).toEqual(new Map())
  })
})

describe('archivedRowTokens', () => {
  it("attributes an archived row to its workspace's settlement", () => {
    const tokens = archivedRowTokens({
      archivedWorktreeIds: ['wt-1'],
      cardsByWorktree: new Map([['wt-1', [card('pane-1')]]]),
      bindings: [
        binding('wt-1', LOCAL_EXECUTION_HOST_ID, { usageSettlement: settlement('wt-1', 700) })
      ]
    })

    expect(tokens.get('pane-1')).toEqual({ kind: 'rollup', tokens: 700 })
  })

  it('leaves a row whose workspace never settled unattributed, never 0', () => {
    const tokens = archivedRowTokens({
      archivedWorktreeIds: ['wt-1'],
      cardsByWorktree: new Map([['wt-1', [card('pane-1')]]]),
      bindings: [binding('wt-1', LOCAL_EXECUTION_HOST_ID)]
    })

    expect(tokens.get('pane-1')).toEqual({ kind: 'unavailable', reason: 'unattributed' })
  })

  it('reads the two hosts as two figures instead of one overwritten value', () => {
    const tokens = archivedRowTokens({
      archivedWorktreeIds: ['wt-1'],
      cardsByWorktree: new Map([['wt-1', [card('pane-1')]]]),
      bindings: [
        binding('wt-1', 'ssh:remote', { usageSettlement: settlement('wt-1', 999, 9_000) }),
        binding('wt-1', LOCAL_EXECUTION_HOST_ID, {
          usageSettlement: settlement('wt-1', 700, 1_000)
        })
      ]
    })

    // The page is read on the local host, so its own measurement is the figure;
    // the remote one stays in the record instead of being lost.
    expect(tokens.get('pane-1')).toEqual({ kind: 'rollup', tokens: 700 })
  })
})

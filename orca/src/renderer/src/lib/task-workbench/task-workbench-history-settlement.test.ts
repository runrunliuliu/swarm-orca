import { describe, expect, it } from 'vitest'
import type {
  TaskRecord,
  TaskRecordUsageUnavailableReason,
  TaskUsageSettlement
} from '../../../../shared/task-records-types'
import type { TaskWorkbenchHistory } from '@/components/task-workbench/task-workbench-view'
import { aggregateTaskUsageSettlements } from '../../../../shared/task-usage-settlement-aggregate'
import { mergeTaskRecordHistory } from './task-workbench-history-merge'
import { settleTokens } from './task-workbench-history-settlement'

/**
 * The four states a closed workspace's usage figure can be in (issue #31 G3):
 * not captured, measured-but-missing, partial, known. The fold that decides them
 * lives in `shared/task-usage-settlement-aggregate.ts` (its own test covers the
 * four arms); this file covers what the panel does with that answer — mapping it
 * onto the task total and onto the spend vocabulary it displays.
 */

function settlement(
  worktreeId: string,
  tokens = 420_000,
  costUsd: number | null = 0.7
): TaskUsageSettlement {
  return {
    kind: 'known',
    collectedAt: 3_000,
    scope: 'worktree-rollup',
    worktreeId,
    providers: [{ provider: 'claude', tokens, costUsd }],
    estimatedCostUsd: costUsd
  }
}

function unavailable(
  worktreeId: string,
  reason: TaskRecordUsageUnavailableReason
): TaskUsageSettlement {
  return { kind: 'unavailable', collectedAt: 3_000, scope: 'worktree-rollup', worktreeId, reason }
}

const liveAvailable: TaskWorkbenchHistory['tokens'] = { kind: 'available', tokens: 1_200 }

describe('settleTokens — mapping those states onto the task total', () => {
  it('keeps the live figure when no closed workspace contributed', () => {
    expect(settleTokens(liveAvailable, null, false)).toEqual(liveAvailable)
  })

  it('adds a live figure to a fully known settlement', () => {
    expect(
      settleTokens(liveAvailable, aggregateTaskUsageSettlements([settlement('a')]), false)
    ).toEqual({
      kind: 'available',
      tokens: 421_200
    })
  })

  it('states the settled number alone when there is no live workspace', () => {
    expect(
      settleTokens(liveAvailable, aggregateTaskUsageSettlements([settlement('a')]), true)
    ).toEqual({
      kind: 'available',
      tokens: 420_000
    })
  })

  it('does not add a live figure to a workspace nobody captured', () => {
    // "Total: every run" cannot be a number while one closed run was never
    // measured, however well the live rows were scanned — and it is not `0`.
    expect(settleTokens(liveAvailable, aggregateTaskUsageSettlements([undefined]), false)).toEqual({
      kind: 'unknown'
    })
  })

  it('adds the live figure to a partial subtotal and keeps the partial marker', () => {
    expect(
      settleTokens(
        liveAvailable,
        aggregateTaskUsageSettlements([settlement('a'), undefined]),
        false
      )
    ).toEqual({ kind: 'partial', tokens: 421_200 })
  })

  it('keeps a live figure that is missing rather than a subtotal that omits it', () => {
    // The live row exists and nobody measured it, so a partial subtotal would be
    // missing that half too; its own reason is the honest statement.
    expect(
      settleTokens(
        { kind: 'unavailable', reason: 'unattributed' },
        aggregateTaskUsageSettlements([settlement('a'), undefined]),
        false
      )
    ).toEqual({ kind: 'unavailable', reason: 'unattributed' })
  })

  it('lets a no_matching_session live figure stand in when there is no active row', () => {
    // The join says "no active row to sum" — it holds no missing figure, so the
    // record's measurement is the whole total (the archive + restart case, S11).
    expect(
      settleTokens(
        { kind: 'unavailable', reason: 'no_matching_session' },
        aggregateTaskUsageSettlements([settlement('a'), undefined]),
        false
      )
    ).toEqual({ kind: 'partial', tokens: 420_000 })
  })

  it("passes an unavailable settlement's own reason through", () => {
    expect(
      settleTokens(
        liveAvailable,
        aggregateTaskUsageSettlements([unavailable('a', 'scan_failed')]),
        false
      )
    ).toEqual({ kind: 'unavailable', reason: 'scan_failed' })
  })

  it('maps the two record-only reasons onto the panel vocabulary', () => {
    // The state is the shared fold's; only the word is the panel's, and this table
    // is the single place the record's vocabulary becomes the display vocabulary.
    expect(
      settleTokens(
        liveAvailable,
        aggregateTaskUsageSettlements([unavailable('a', 'usage_not_enabled')]),
        false
      )
    ).toEqual({ kind: 'unavailable', reason: 'disabled' })
    expect(
      settleTokens(
        liveAvailable,
        aggregateTaskUsageSettlements([unavailable('a', 'remote_usage_unavailable')]),
        false
      )
    ).toEqual({ kind: 'unavailable', reason: 'remote_host' })
  })

  it('never answers with a 0-token total for a workspace nobody captured', () => {
    const total = settleTokens(liveAvailable, aggregateTaskUsageSettlements([undefined]), false)
    expect(total).not.toEqual({ kind: 'available', tokens: 0 })
    expect(total).not.toEqual({ kind: 'partial', tokens: 0 })
  })
})

/**
 * The merge is where the aggregate meets a record. An archived workspace this
 * build never settled must reach the total as "not captured" — the case G3
 * reports — and not as `no_matching_session` and not as `0`.
 */
describe('mergeTaskRecordHistory — an archived workspace this build never settled', () => {
  const history: TaskWorkbenchHistory = {
    agents: null,
    wall: { kind: 'unknown' },
    tokens: { kind: 'unavailable', reason: 'no_matching_session' },
    archivedWorkspaces: 0,
    deletedWorkspaces: 0,
    tokensSource: 'live',
    workspaces: [],
    sessions: [],
    trace: 'none',
    runs: []
  }
  // The archive path stores no settlement when the runtime has no usage store, so
  // this is exactly what such an archive leaves behind: the workspace, no figure.
  const record: TaskRecord = {
    taskId: 'task:repo-1:issue:31',
    hostId: 'local',
    origin: { kind: 'external', provider: 'github', itemType: 'issue', number: 31 },
    bindings: [
      {
        worktreeId: 'wt-archived',
        repoId: 'repo-1',
        hostId: 'local',
        path: '/repo/wt-archived',
        isArchived: true,
        boundAt: 1_000,
        boundBy: 'created',
        lastVerifiedAt: 2_000,
        sessions: []
      }
    ],
    intent: {},
    createdAt: 1_000,
    updatedAt: 2_000,
    schemaVersion: 1
  }

  it('reaches the task total as not captured', () => {
    const merged = mergeTaskRecordHistory({
      history,
      // Archived, not removed: the store still has the worktree.
      existingWorktreeIds: ['wt-archived'],
      record
    })

    expect(merged.tokens).toEqual({ kind: 'unknown' })
    expect(merged.tokensSource).toBe('settled')
  })
})

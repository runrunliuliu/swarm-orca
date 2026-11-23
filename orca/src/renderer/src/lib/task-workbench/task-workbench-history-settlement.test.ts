import { describe, expect, it } from 'vitest'
import type {
  TaskRecord,
  TaskRecordUsageUnavailableReason,
  TaskUsageSettlement
} from '../../../../shared/task-records-types'
import type { TaskWorkbenchHistory } from '@/components/task-workbench/task-workbench-view'
import { mergeTaskRecordHistory } from './task-workbench-history-merge'
import { aggregateSettlement, settleTokens } from './task-workbench-history-settlement'

/**
 * The four states a closed workspace's usage figure can be in (issue #31 G3):
 * not captured, measured-but-missing, partial, known. The project puts them in
 * one union so neither the total nor its copy can turn two of them into one
 * sentence — and so none of them can become `0 tokens` / `$0`.
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

describe('aggregateSettlement — the four states of the closed workspaces', () => {
  it('returns null when no closed workspace contributed (nothing to fold)', () => {
    expect(aggregateSettlement([])).toBeNull()
  })

  it('is unknown when none of them was captured', () => {
    // `undefined` is a binding whose settlement field the record never wrote.
    expect(aggregateSettlement([undefined])).toEqual({ kind: 'unknown' })
    expect(aggregateSettlement([undefined, undefined])).toEqual({ kind: 'unknown' })
  })

  it('is partial with the settled subtotal when only some of them were captured', () => {
    // The 420 000 is real, but the second workspace is missing from it: the panel
    // must neither print it as the total nor drop it.
    expect(aggregateSettlement([settlement('a'), undefined])).toEqual({
      kind: 'partial',
      tokens: 420_000
    })
    expect(aggregateSettlement([undefined, settlement('a')])).toEqual({
      kind: 'partial',
      tokens: 420_000
    })
  })

  it("quotes a settlement's own reason when measured figures are missing", () => {
    // Measured and missing is a reason token, never `unknown`: a scan did run.
    expect(aggregateSettlement([unavailable('a', 'scan_failed')])).toEqual({
      kind: 'unavailable',
      reason: 'scan_failed'
    })
    expect(aggregateSettlement([unavailable('a', 'remote_usage_unavailable')])).toEqual({
      kind: 'unavailable',
      reason: 'remote_host'
    })
    expect(aggregateSettlement([unavailable('a', 'usage_not_enabled')])).toEqual({
      kind: 'unavailable',
      reason: 'disabled'
    })
  })

  it('prefers the measured reason over the absence when there is no known figure at all', () => {
    // Not captured + measured-but-missing: the sentence that states a real scan
    // is more useful than "this build did not capture", and both are absences.
    expect(aggregateSettlement([undefined, unavailable('b', 'scan_failed')])).toEqual({
      kind: 'unavailable',
      reason: 'scan_failed'
    })
  })

  it('is known when every one of them settled a number', () => {
    expect(aggregateSettlement([settlement('a'), settlement('b', 80_000)])).toEqual({
      kind: 'known',
      tokens: 500_000
    })
  })

  it('never turns a known row that holds no figure into a measured zero', () => {
    // A `known` settlement with no provider rows is a rollup with nothing in it,
    // not a workspace that spent 0: it becomes the measured "found nothing" state.
    const empty: TaskUsageSettlement = {
      kind: 'known',
      collectedAt: 3_000,
      scope: 'worktree-rollup',
      worktreeId: 'a',
      providers: [],
      estimatedCostUsd: 0
    }
    expect(aggregateSettlement([empty])).toEqual({
      kind: 'unavailable',
      reason: 'no_matching_session'
    })
  })
})

describe('settleTokens — mapping those states onto the task total', () => {
  it('keeps the live figure when no closed workspace contributed', () => {
    expect(settleTokens(liveAvailable, null, false)).toEqual(liveAvailable)
  })

  it('adds a live figure to a fully known settlement', () => {
    expect(settleTokens(liveAvailable, aggregateSettlement([settlement('a')]), false)).toEqual({
      kind: 'available',
      tokens: 421_200
    })
  })

  it('states the settled number alone when there is no live workspace', () => {
    expect(settleTokens(liveAvailable, aggregateSettlement([settlement('a')]), true)).toEqual({
      kind: 'available',
      tokens: 420_000
    })
  })

  it('does not add a live figure to a workspace nobody captured', () => {
    // "Total: every run" cannot be a number while one closed run was never
    // measured, however well the live rows were scanned — and it is not `0`.
    expect(settleTokens(liveAvailable, aggregateSettlement([undefined]), false)).toEqual({
      kind: 'unknown'
    })
  })

  it('adds the live figure to a partial subtotal and keeps the partial marker', () => {
    expect(
      settleTokens(liveAvailable, aggregateSettlement([settlement('a'), undefined]), false)
    ).toEqual({ kind: 'partial', tokens: 421_200 })
  })

  it('keeps a live figure that is missing rather than a subtotal that omits it', () => {
    // The live row exists and nobody measured it, so a partial subtotal would be
    // missing that half too; its own reason is the honest statement.
    expect(
      settleTokens(
        { kind: 'unavailable', reason: 'unattributed' },
        aggregateSettlement([settlement('a'), undefined]),
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
        aggregateSettlement([settlement('a'), undefined]),
        false
      )
    ).toEqual({ kind: 'partial', tokens: 420_000 })
  })

  it("passes an unavailable settlement's own reason through", () => {
    expect(
      settleTokens(liveAvailable, aggregateSettlement([unavailable('a', 'scan_failed')]), false)
    ).toEqual({ kind: 'unavailable', reason: 'scan_failed' })
  })

  it('never answers with a 0-token total for a workspace nobody captured', () => {
    const total = settleTokens(liveAvailable, aggregateSettlement([undefined]), false)
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

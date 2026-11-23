import { describe, expect, it } from 'vitest'
import type { TaskWorkbenchHistory } from '@/components/task-workbench/task-workbench-view'
import type {
  TaskRecord,
  TaskRecordUsageUnavailableReason,
  TaskUsageSettlement,
  TaskWorkspaceBinding
} from '../../../../shared/task-records-types'
import { buildHistoryTaskExport } from '../../../../cli/history-task-export'
import { mergeTaskRecordHistory } from './task-workbench-history-merge'

/**
 * One record, two readers (issue #31): the workbench history fold and the
 * read-only `orca history task` export. They used to disagree about a task nobody
 * settled — the panel said `unknown` ("this build did not capture it") while the
 * export said `no_matching_session` ("a scan ran and found nothing"), which is a
 * measurement that never happened. Both now fold the record through
 * `shared/task-usage-settlement-aggregate.ts`, and these cases are the contract:
 * same kind, same figure, same reason.
 *
 * The reason words differ in exactly one place: the panel translates two of the
 * record's tokens into the display vocabulary it already ships
 * (`usage_not_enabled` → `disabled`, `remote_usage_unavailable` → `remote_host`).
 * The case below pins that as a rename, not a second opinion.
 */

const TASK = { repo: { kind: 'auto' as const, value: 'repo-1' }, number: 31 }
const NOW = Date.UTC(2026, 10, 18, 12, 0)

/** What the live join answers for a task whose every workspace is closed: no
 *  active row to sum, so it contributes no figure of its own. */
const CLOSED_TASK_HISTORY: TaskWorkbenchHistory = {
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

function binding(worktreeId: string, usageSettlement?: TaskUsageSettlement): TaskWorkspaceBinding {
  return {
    worktreeId,
    repoId: 'repo-1',
    hostId: 'local',
    path: `/repos/${worktreeId}`,
    isArchived: true,
    boundAt: NOW - 10_000,
    boundBy: 'created',
    lastVerifiedAt: NOW,
    sessions: [],
    ...(usageSettlement === undefined ? {} : { usageSettlement })
  }
}

function settled(worktreeId: string, tokens = 1200, costUsd: number | null = 1.2) {
  return {
    kind: 'known' as const,
    collectedAt: NOW,
    scope: 'worktree-rollup' as const,
    worktreeId,
    providers: [{ provider: 'claude' as const, tokens, costUsd }],
    estimatedCostUsd: costUsd
  }
}

function unavailable(worktreeId: string, reason: TaskRecordUsageUnavailableReason) {
  return {
    kind: 'unavailable' as const,
    collectedAt: NOW,
    scope: 'worktree-rollup' as const,
    worktreeId,
    reason
  }
}

function record(bindings: TaskWorkspaceBinding[]): TaskRecord {
  return {
    taskId: 'task:github:repo-1:issue:31',
    hostId: 'local',
    origin: {
      kind: 'external',
      provider: 'github',
      providerIdentity: { provider: 'github', owner: 'acme', repo: 'web' },
      itemType: 'issue',
      number: 31
    },
    bindings,
    intent: {},
    createdAt: NOW - 20_000,
    updatedAt: NOW,
    schemaVersion: 3
  }
}

/** Both surfaces on the same record. Every workspace is closed (`existing` is
 *  empty), so the panel folds the record exactly as the export does and any
 *  difference in the answer is a difference in the rule, not in the inputs. */
function bothSurfaces(bindings: TaskWorkspaceBinding[]): {
  exported: ReturnType<typeof buildHistoryTaskExport>['tokens']
  workbench: TaskWorkbenchHistory['tokens']
} {
  const oneRecord = record(bindings)
  return {
    exported: buildHistoryTaskExport({
      record: oneRecord,
      repoId: 'repo-1',
      task: TASK,
      existingWorktreeIds: []
    }).tokens,
    workbench: mergeTaskRecordHistory({
      history: CLOSED_TASK_HISTORY,
      existingWorktreeIds: [],
      record: oneRecord
    }).tokens
  }
}

describe('history task export and the workbench agree on one record', () => {
  it('reports a settlement nobody captured as not captured on both surfaces', () => {
    const { exported, workbench } = bothSurfaces([binding('wt-a')])

    // Absence is neither `no_matching_session` nor `0`; both say they have nothing.
    expect(exported).toEqual({ kind: 'unknown' })
    expect(workbench).toEqual({ kind: 'unknown' })
  })

  it('reports a fully settled task as available with the same figure', () => {
    const { exported, workbench } = bothSurfaces([binding('wt-a', settled('wt-a'))])

    expect(exported).toEqual({ kind: 'available', tokens: 1200, estimatedCostUsd: 1.2 })
    expect(workbench).toEqual({ kind: 'available', tokens: 1200 })
    expect(exported.kind).toBe(workbench.kind)
  })

  it('reports a half-settled task as the same partial subtotal', () => {
    const { exported, workbench } = bothSurfaces([
      binding('wt-a', settled('wt-a')),
      binding('wt-b')
    ])

    expect(exported).toEqual({ kind: 'partial', tokens: 1200, estimatedCostUsd: 1.2 })
    expect(workbench).toEqual({ kind: 'partial', tokens: 1200 })
    expect(exported.kind).toBe(workbench.kind)
  })

  it('keeps the settlement’s own reason when a workspace was measured and is missing', () => {
    const { exported, workbench } = bothSurfaces([
      binding('wt-a', unavailable('wt-a', 'scan_failed'))
    ])

    expect(exported).toEqual({ kind: 'unavailable', reason: 'scan_failed' })
    expect(workbench).toEqual({ kind: 'unavailable', reason: 'scan_failed' })
  })

  it('renames, never re-decides, a reason the panel speaks differently', () => {
    const { exported, workbench } = bothSurfaces([
      binding('wt-a', unavailable('wt-a', 'usage_not_enabled'))
    ])

    // The export keeps the record's own word; the panel's badge says `disabled`.
    expect(exported).toEqual({ kind: 'unavailable', reason: 'usage_not_enabled' })
    expect(workbench).toEqual({ kind: 'unavailable', reason: 'disabled' })
    expect(exported.kind).toBe(workbench.kind)
  })
})

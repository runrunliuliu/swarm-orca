import { describe, expect, it } from 'vitest'
import type { TaskRecordUsageUnavailableReason, TaskUsageSettlement } from './task-records-types'
import { aggregateTaskUsageSettlements } from './task-usage-settlement-aggregate'

/**
 * The four states a task's usage figure can be in (issue #31 G3): not captured,
 * measured-but-missing, partial, known. They live in one shared union so no
 * reader — the workbench panel and the `orca history task` export alike — can
 * turn two of them into one answer, and so none of them can become `0 tokens` /
 * `$0`.
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

describe('aggregateTaskUsageSettlements — the four states', () => {
  it('returns null when there was nothing to fold', () => {
    expect(aggregateTaskUsageSettlements([])).toBeNull()
  })

  it('is unknown when none of them was captured', () => {
    // `undefined` is a binding whose settlement field the record never wrote.
    expect(aggregateTaskUsageSettlements([undefined])).toEqual({ kind: 'unknown' })
    expect(aggregateTaskUsageSettlements([undefined, undefined])).toEqual({ kind: 'unknown' })
  })

  it('is partial with the settled subtotal when only some of them were captured', () => {
    // The 420 000 is real, but the second workspace is missing from it: the
    // reader must neither print it as the total nor drop it.
    expect(aggregateTaskUsageSettlements([settlement('a'), undefined])).toEqual({
      kind: 'partial',
      tokens: 420_000,
      estimatedCostUsd: 0.7
    })
    expect(aggregateTaskUsageSettlements([undefined, settlement('a')])).toEqual({
      kind: 'partial',
      tokens: 420_000,
      estimatedCostUsd: 0.7
    })
  })

  it("quotes a settlement's own reason when measured figures are missing", () => {
    // Measured and missing is a reason token, never `unknown`: a scan did run.
    expect(aggregateTaskUsageSettlements([unavailable('a', 'scan_failed')])).toEqual({
      kind: 'unavailable',
      reason: 'scan_failed'
    })
    expect(aggregateTaskUsageSettlements([unavailable('a', 'remote_usage_unavailable')])).toEqual({
      kind: 'unavailable',
      reason: 'remote_usage_unavailable'
    })
    expect(aggregateTaskUsageSettlements([unavailable('a', 'usage_not_enabled')])).toEqual({
      kind: 'unavailable',
      reason: 'usage_not_enabled'
    })
  })

  it('prefers the measured reason over the absence when there is no known figure at all', () => {
    // Not captured + measured-but-missing: the sentence that states a real scan
    // is more useful than "this build did not capture", and both are absences.
    expect(aggregateTaskUsageSettlements([undefined, unavailable('b', 'scan_failed')])).toEqual({
      kind: 'unavailable',
      reason: 'scan_failed'
    })
  })

  it('is known when every one of them settled a number', () => {
    expect(aggregateTaskUsageSettlements([settlement('a'), settlement('b', 80_000, 0.3)])).toEqual({
      kind: 'known',
      tokens: 500_000,
      estimatedCostUsd: 1
    })
  })

  it('keeps a subtotal of an unpriced settlement unpriced', () => {
    expect(
      aggregateTaskUsageSettlements([settlement('a'), settlement('b', 1_000, null), undefined])
    ).toEqual({ kind: 'partial', tokens: 421_000, estimatedCostUsd: null })
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
    expect(aggregateTaskUsageSettlements([empty])).toEqual({
      kind: 'unavailable',
      reason: 'no_matching_session'
    })
  })
})

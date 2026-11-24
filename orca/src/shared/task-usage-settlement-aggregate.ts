import { taskUsageSettlementTokens } from './task-records'
import type { TaskRecordUsageUnavailableReason, TaskUsageSettlement } from './task-records-types'

/**
 * One task's usage figure folded from the settlements its workspaces froze, with
 * the four absences kept apart (issue #31 G3):
 *
 * - `known` — every contributing workspace settled a number (the sum);
 * - `partial` — some settled a number and at least one captured none, so the
 *   figure is a subtotal and must say so;
 * - `unavailable` — a workspace was measured and its figure is missing; the
 *   settlement's own reason is kept verbatim, because a scan did run;
 * - `unknown` — nothing was captured at all, so no reason token may claim a
 *   measurement. This is never `no_matching_session` and never `0`.
 *
 * It is shared because two readers fold the same record — the workbench history
 * panel and the read-only `orca history task` export — and one record must not get
 * two answers. The panel renames two of the reason tokens for its display
 * vocabulary (`usage_not_enabled` → `disabled`, `remote_usage_unavailable` →
 * `remote_host`); that renaming is the panel's, and everything decided here is
 * verbatim.
 */
export type TaskUsageSettlementAggregate =
  | { kind: 'known'; tokens: number; estimatedCostUsd: number | null }
  /** A subtotal: at least one contributing workspace was never captured. */
  | { kind: 'partial'; tokens: number; estimatedCostUsd: number | null }
  | { kind: 'unavailable'; reason: TaskRecordUsageUnavailableReason }
  | { kind: 'unknown' }

/**
 * `null` means there was nothing to fold (no workspace at all), which is a
 * different statement from `unknown` (workspaces exist, none was captured); a
 * caller that must answer with a figure decides which one it can say.
 *
 * Cost follows the same rule as the tokens: `null` when any contributing
 * settlement is unpriced, never `$0`.
 */
export function aggregateTaskUsageSettlements(
  settlements: readonly (TaskUsageSettlement | undefined)[]
): TaskUsageSettlementAggregate | null {
  if (settlements.length === 0) {
    return null
  }
  let tokens = 0
  let costUsd = 0
  let costKnown = true
  let settledCount = 0
  let absent = 0
  let reason: TaskRecordUsageUnavailableReason | null = null
  for (const settlement of settlements) {
    if (!settlement) {
      absent += 1
      continue
    }
    if (settlement.kind === 'unavailable') {
      reason ??= settlement.reason
      continue
    }
    const settled = taskUsageSettlementTokens(settlement)
    if (settled === null || settlement.providers.length === 0) {
      // Measured, but the rollup it kept has no figure in it: the same state as
      // `no_matching_session`, never a measured `0`.
      reason ??= 'no_matching_session'
      continue
    }
    tokens += settled
    if (settlement.estimatedCostUsd === null) {
      costKnown = false
    } else {
      costUsd += settlement.estimatedCostUsd
    }
    settledCount += 1
  }
  const figure = { tokens, estimatedCostUsd: costKnown ? costUsd : null }
  if (absent === 0) {
    return reason === null ? { kind: 'known', ...figure } : { kind: 'unavailable', reason }
  }
  if (settledCount > 0 && tokens > 0) {
    return { kind: 'partial', ...figure }
  }
  return reason === null ? { kind: 'unknown' } : { kind: 'unavailable', reason }
}

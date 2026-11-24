import {
  isTaskRecordUsageProvider,
  type TaskRecordUsageProvider,
  type TaskRecordUsageUnavailableReason,
  type TaskUsageSettlement
} from '../../../../shared/task-records-types'
import type { TaskUsageSettlementAggregate } from '../../../../shared/task-usage-settlement-aggregate'
import type {
  AgentTokenView,
  SpendReason,
  TaskWorkbenchHistory
} from '@/components/task-workbench/task-workbench-view'

/**
 * The per-row token figures of an archived workspace (issue #53 A2).
 *
 * The only figure the record froze for an archived workspace is its settlement:
 * one `worktree-rollup` total per provider, measured before the checkout stopped
 * being readable. This turns that split into the figures the Agents section can
 * print, and every arm that cannot be derived stays an absence:
 *
 * - no settlement: `unattributed` — the record never attributed a figure to this
 *   workspace, which is not the statement `0` tokens;
 * - an unavailable settlement: its own reason, so the row says why;
 * - a row whose agent is not one of the four usage providers: `unattributed`,
 *   because the split cannot cover a provider it never knew (pi, for one);
 * - exactly one row of that provider: the provider's rollup, labelled `rollup` so
 *   the row does not read as a per-agent measurement;
 * - more than one row of the same provider: `ambiguous_session`. The record
 *   states one figure and several rows match it, so there is no share to print;
 *   splitting it would invent a distribution nobody measured.
 *
 * Cost is deliberately not returned: a per-row `$` derived from a worktree
 * rollup would be the `$0`-style lie the record forbids.
 */
export function archivedRowsTokens(args: {
  agentTypes: readonly string[]
  settlement: TaskUsageSettlement | undefined
}): AgentTokenView[] {
  const settlement = args.settlement
  if (!settlement) {
    return args.agentTypes.map(() => UNATTRIBUTED_ROW)
  }
  if (settlement.kind === 'unavailable') {
    const reason = SETTLEMENT_REASON[settlement.reason]
    return args.agentTypes.map(() => ({ kind: 'unavailable', reason }))
  }
  const counts = new Map<TaskRecordUsageProvider, number>()
  for (const agentType of args.agentTypes) {
    if (isTaskRecordUsageProvider(agentType)) {
      counts.set(agentType, (counts.get(agentType) ?? 0) + 1)
    }
  }
  return args.agentTypes.map((agentType) => {
    if (!isTaskRecordUsageProvider(agentType)) {
      return UNATTRIBUTED_ROW
    }
    if ((counts.get(agentType) ?? 0) > 1) {
      return AMBIGUOUS_ROW
    }
    const slice = settlement.providers.find((provider) => provider.provider === agentType)
    return slice ? { kind: 'rollup', tokens: slice.tokens } : UNATTRIBUTED_ROW
  })
}

/** A row the record never attributed. A shared constant so every such row reads
 *  identically and none of them is a `0`. */
const UNATTRIBUTED_ROW: AgentTokenView = { kind: 'unavailable', reason: 'unattributed' }

/** Several rows of one provider against one settled figure: no share exists. */
const AMBIGUOUS_ROW: AgentTokenView = { kind: 'unavailable', reason: 'ambiguous_session' }

/**
 * The task total for a record that spans live and closed workspaces.
 *
 * The join's figure covers the *active* workspaces; each settlement covers one
 * frozen workspace (archived or removed), which is why the join must not also
 * count an archived row's figure — it would be the same tokens twice. Adding
 * them is the whole total only when both are known. If either is unknown the
 * total is unknown in the state that says why — a number computed from half the
 * task would be printed under "Total: every run".
 *
 * `no_matching_session` on the live side is the one unknown that carries no
 * missing figure: it is what the join reports when there is no active row to
 * sum, so the record's measurement is the whole total (the archive + restart
 * case, S11). Every other reason means a live row exists whose figure nobody
 * measured, and then half a total stays unknown.
 *
 * The four states stay apart all the way through:
 *
 * - `available` — every contributing figure is a measured number;
 * - `partial` — some closed workspaces settled a number and at least one did not,
 *   so the figure is a *subtotal* and says so (mirrors the wall clock's partial
 *   span, never printed as if it were the whole total);
 * - `unavailable` — a workspace was measured and its figure is missing, or the
 *   live side is missing; the reason is kept;
 * - `unknown` — no contributing closed workspace was captured at all, so there is
 *   no figure and no reason for one: this build did not measure.
 */
export function settleTokens(
  live: TaskWorkbenchHistory['tokens'],
  settled: TaskUsageSettlementAggregate | null,
  noLiveWorkspace: boolean
): TaskWorkbenchHistory['tokens'] {
  if (settled === null) {
    return live
  }
  if (settled.kind === 'unavailable') {
    // The one place the record's reason vocabulary becomes the panel's; the
    // state itself is decided by the shared fold, not here.
    return { kind: 'unavailable', reason: SETTLEMENT_REASON[settled.reason] }
  }
  if (settled.kind === 'unknown') {
    // Nothing was captured for the closed workspaces. A live figure cannot fill
    // that in, and the total claims to cover every run, so it stays unknown.
    return { kind: 'unknown' }
  }
  if (settled.kind === 'partial') {
    // A partial subtotal is still a number, but only a lower bound: keep the
    // partial marker instead of promoting the subtotal to a total. Cost is the
    // export's business; the panel prints provider spend, not a settled total.
    const subtotal: TaskWorkbenchHistory['tokens'] = { kind: 'partial', tokens: settled.tokens }
    if (noLiveWorkspace) {
      return subtotal
    }
    if (live.kind === 'available') {
      return { kind: 'partial', tokens: live.tokens + settled.tokens }
    }
    // A live row exists whose figure nobody measured: keep its reason rather
    // than a subtotal that omits it. A `no_matching_session` live figure holds no
    // missing number (there is no active row to sum), so the subtotal can stand
    // in for it — the same rule the known arm applies.
    return live.kind === 'unavailable' && live.reason === 'no_matching_session' ? subtotal : live
  }
  const settledTotal: TaskWorkbenchHistory['tokens'] = { kind: 'available', tokens: settled.tokens }
  if (noLiveWorkspace) {
    return settledTotal
  }
  if (live.kind === 'available') {
    return { kind: 'available', tokens: live.tokens + settled.tokens }
  }
  return live.kind === 'unavailable' && live.reason === 'no_matching_session' ? settledTotal : live
}

/** The settlement vocabulary is written in main's words (`usage_not_enabled`,
 *  `remote_usage_unavailable`); the panel speaks the spend vocabulary it already
 *  translates. One table, so the two can never drift into a badge with no word. */
const SETTLEMENT_REASON: Record<TaskRecordUsageUnavailableReason, SpendReason> = {
  usage_not_enabled: 'disabled',
  remote_usage_unavailable: 'remote_host',
  scan_failed: 'scan_failed',
  no_matching_session: 'no_matching_session',
  ambiguous_session: 'ambiguous_session'
}

// The four-state fold itself is shared with the read-only `orca history task`
// export (`shared/task-usage-settlement-aggregate.ts`), so one record cannot get
// two answers about whether its spend was captured. This module only maps that
// answer onto the panel's vocabulary and adds the live half.

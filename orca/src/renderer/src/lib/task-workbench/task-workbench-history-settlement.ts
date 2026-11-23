import { taskUsageSettlementTokens } from '../../../../shared/task-records'
import {
  isTaskRecordUsageProvider,
  type TaskRecordUsageProvider,
  type TaskRecordUsageUnavailableReason,
  type TaskUsageSettlement
} from '../../../../shared/task-records-types'
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
  settled: SettlementAggregate | null,
  noLiveWorkspace: boolean
): TaskWorkbenchHistory['tokens'] {
  if (settled === null) {
    return live
  }
  if (settled.kind === 'unavailable') {
    return { kind: 'unavailable', reason: settled.reason }
  }
  if (settled.kind === 'unknown') {
    // Nothing was captured for the closed workspaces. A live figure cannot fill
    // that in, and the total claims to cover every run, so it stays unknown.
    return { kind: 'unknown' }
  }
  if (settled.kind === 'partial') {
    // A partial subtotal is still a number, but only a lower bound: keep the
    // partial marker instead of promoting the subtotal to a total.
    if (noLiveWorkspace) {
      return settled
    }
    if (live.kind === 'available') {
      return { kind: 'partial', tokens: live.tokens + settled.tokens }
    }
    // A live row exists whose figure nobody measured: keep its reason rather
    // than a subtotal that omits it. A `no_matching_session` live figure holds no
    // missing number (there is no active row to sum), so the subtotal can stand
    // in for it — the same rule the known arm applies.
    return live.kind === 'unavailable' && live.reason === 'no_matching_session' ? settled : live
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

export type SettlementAggregate =
  | { kind: 'known'; tokens: number }
  /** Some closed workspaces settled a number and at least one did not: the tokens
   *  are a lower bound, never this task's total. */
  | { kind: 'partial'; tokens: number }
  /** A closed workspace was measured and its figure is missing. */
  | { kind: 'unavailable'; reason: SpendReason }
  /** No contributing closed workspace recorded a settlement: this build did not
   *  measure, which is not a reason token and not `0`. */
  | { kind: 'unknown' }

/**
 * One figure for the closed workspaces, with the four absences kept apart.
 *
 * The rule is decided once here so two readers cannot disagree:
 *
 * - every closed workspace settled a number → `known` (the sum);
 * - some settled a number, at least one captured none → `partial` (the subtotal
 *   of the settled ones, marked as partial: the workspaces nobody measured are
 *   missing from it);
 * - some were measured and their figure is missing (never captured is not the
 *   same as measured-and-empty) → that settlement's own reason, so the panel
 *   says what happened (`no_matching_session` here means the scan ran and found
 *   nothing — never "this build did not measure");
 * - none was captured → `unknown`: no settlement exists, so no reason token may
 *   claim a measurement. A `known` row with no provider rows is in this same
 *   position — it holds no figure, and printing `0` from it would be the fake
 *   zero this domain forbids.
 */
export function aggregateSettlement(
  settlements: readonly (TaskUsageSettlement | undefined)[]
): SettlementAggregate | null {
  if (settlements.length === 0) {
    return null
  }
  let tokens = 0
  let settledCount = 0
  let absent = 0
  let reason: SpendReason | null = null
  for (const settlement of settlements) {
    if (!settlement) {
      absent += 1
      continue
    }
    if (settlement.kind === 'unavailable') {
      reason ??= SETTLEMENT_REASON[settlement.reason]
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
    settledCount += 1
  }
  if (absent === 0) {
    return reason === null ? { kind: 'known', tokens } : { kind: 'unavailable', reason }
  }
  if (settledCount > 0 && tokens > 0) {
    return { kind: 'partial', tokens }
  }
  return reason === null ? { kind: 'unknown' } : { kind: 'unavailable', reason }
}

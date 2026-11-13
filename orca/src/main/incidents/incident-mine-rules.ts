// Mining policy: stable source identity, thresholds, and the low-information judgement
// (issue-sedimentation.md v2.8 §10; simplify S3).
//
// This module answers "is this cluster worth a human's time, and from how many DISTINCT ENTITIES".
// It never touches the database and never writes: `incident-mine-build.ts` reads rows and
// `incident-mine-apply.ts` records decisions.
//
// Why the entity question is separated out here: `source_id` CONTAINS THE EPOCH, so counting distinct
// `source_id` measures repetitions of one entity, not reproduction across entities (M6 review C1). A
// pane that stalls three times has three `source_id`s (`<paneKey>:<stateStartedAt>`), and a session
// with three turns of one tool error has three more. Cross-source reproduction therefore needs a
// STABLE source key with the epoch removed (`stableSourceIdentity`), and a row whose stable key cannot
// be derived is counted as `unknownStableSource` — never as a fresh source (in the build module).

import type {
  IncidentClass,
  IncidentSourceKind,
  IncidentStatus
} from './incident-types'
import { parseExitCause } from './incident-store-rows'

export const MINE_MIN_ROWS = 3
export const MINE_MIN_DISTINCT_SOURCE_IDS = 2
/** `crash+signaled` and same-invariant `acceptance_failed` may qualify on two rows (§10.2). */
export const MINE_SMALL_CLUSTER_MIN_ROWS = 2

export const MINE_RULE_REPEAT_FINGERPRINT = 'repeat_fingerprint'
export const MINE_RULE_CRASH_SIGNALED = 'crash_signaled'
export const MINE_RULE_ACCEPTANCE_INVARIANT = 'acceptance_invariant'
export const MINE_RULE_NAMES = [
  MINE_RULE_REPEAT_FINGERPRINT,
  MINE_RULE_CRASH_SIGNALED,
  MINE_RULE_ACCEPTANCE_INVARIANT
] as const
export type MineRuleName = (typeof MINE_RULE_NAMES)[number]

/** Default window: §10's "7 days". */
export const DEFAULT_MINE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
export const DEFAULT_MINE_MAX_GROUPS = 20
export const DEFAULT_MINE_MAX_CANDIDATES = 20
export const DEFAULT_MINE_TIME_BUDGET_MS = 2_000
/**
 * Hard scan cap (M6 review C4). The window query is bounded here because no time budget can interrupt
 * it; 20k rows is well inside §11.5's 50k active-row limit, and a window that reaches it is a signal in
 * itself (`truncated.scan`).
 */
export const DEFAULT_MINE_MAX_SCAN_ROWS = 20_000
/** Low-information candidates get their own small budget so noise cannot fill the queue (C5). */
export const MINE_MAX_LOW_INFORMATION_CANDIDATES = 5
export const MINE_MAX_WORKTREES_REPORTED = 3
export const MINE_MAX_RUNS_REPORTED = 3

/**
 * Rows that no longer describe an untriaged pattern (§10.3 / §11.5).
 *
 * Kept as a list, not a boolean query, so the exclusion is explainable in the output: the report says
 * how many of each were set aside.
 */
export const MINE_EXCLUDED_STATUSES: readonly IncidentStatus[] = ['duplicate', 'invalid', 'closed']

/** What `--apply` may set. `confirmed` is deliberately absent: that needs R1 (§10.3). */
export const MINER_TARGETS = ['watch', 'duplicate', 'needs_archive'] as const
export type MinerTarget = (typeof MINER_TARGETS)[number]
export const DEFAULT_MINER_TARGET: MinerTarget = 'watch'
export const MINER_ACTOR = 'miner'

export function isMinerTarget(value: unknown): value is MinerTarget {
  return typeof value === 'string' && (MINER_TARGETS as readonly string[]).includes(value)
}

/** The row shape the rules read. Exported so the rule tests can build one without a database. */
export type MineRuleRow = {
  id: string
  class: IncidentClass
  sourceKind: IncidentSourceKind
  sourceId: string
  facet: string
  fingerprint: string
  createdAt: number
  worktreeId: string | null
  runId: string | null
  agentSessionId: string | null
  dispatchId: string | null
  effectiveStatus: IncidentStatus
  lastDecisionAt: number | null
  exitCause: ReturnType<typeof parseExitCause>
}

/**
 * The stable dimension a stable source belongs to, and how many distinct values the cluster holds.
 *
 * `dimension` names the entity the key was derived from, so a report can say "3 sources, all panes"
 * rather than implying a worktree-level pattern.
 */
export type MineSourceDimension = 'pane' | 'session' | 'dispatch' | 'worktree' | 'run'

export type MineStableSource = {
  dimension: MineSourceDimension
  /** Entity identity with the epoch removed. Never built by concatenating a raw `source_id`. */
  key: string
}

/**
 * The pane key inside a stall's `source_id` (`<tab>:<leaf>:<stateStartedAt>`).
 *
 * Splitting on the LAST separator is what keeps the pane key composite and the epoch out: the writer's
 * pane key itself contains one `:` (§6.2.1), so a naive split would produce `tab`.
 */
export function paneKeyFromStallSourceId(sourceId: string): string | null {
  const cut = sourceId.lastIndexOf(':')
  if (cut <= 0) {
    return null
  }
  const paneKey = sourceId.slice(0, cut)
  const parts = paneKey.split(':')
  if (parts.length !== 2 || parts.some((part) => part.length === 0)) {
    return null
  }
  return paneKey
}

/** `sessionId:turn:code:windowStart` -> session + code, the two parts that identify the culprit. */
export function toolErrorSourceParts(sourceId: string): { sessionId: string; code: string } | null {
  const parts = sourceId.split(':')
  if (parts.length !== 4 || parts.some((part) => part.length === 0)) {
    return null
  }
  const [sessionId, , code] = parts
  return { sessionId, code }
}

/** `dispatchId:attempt` -> the dispatch. The attempt is the epoch. */
export function dispatchIdFromAcceptanceSourceId(sourceId: string): string | null {
  const parts = sourceId.split(':')
  if (parts.length !== 2 || parts.some((part) => part.length === 0)) {
    return null
  }
  return parts[0]
}

/**
 * The stable source of one row: identity with the epoch removed, or null when the row does not carry
 * one.
 *
 * Mapping (M6 review C1), each chosen from what the writer actually encodes:
 *   * `status_stall`  -> `pane:<paneKey>` — the epoch is `stateStartedAt`;
 *   * `tool_error`    -> `session:<sessionId>:code:<code>` — the epoch is turn + window start; the tool
 *                        name is not in `source_id`, so code is the second discriminator available;
 *   * `acceptance`    -> `dispatch:<dispatchId>:<facet>` — the epoch is the attempt, the facet is the
 *                        rule id, so two rules on one dispatch stay distinct and one rule re-evaluated
 *                        on one dispatch does not mint a source;
 *   * `pty_exit`      -> `session:<agentSessionId>`, else `worktree:<worktreeId>`, else `run:<runId>` —
 *                        the incarnation id is the epoch; the columns are the surviving entities;
 *   * `self_report`   -> null. Self-reports are declared out of mining (M6 review C5): their key is a
 *                        request id, so they cannot form a cluster, and pretending otherwise would put
 *                        a fabricated source in the report.
 */
export function stableSourceIdentity(row: {
  sourceKind: IncidentSourceKind
  sourceId: string
  facet: string
  agentSessionId?: string | null
  dispatchId?: string | null
  worktreeId?: string | null
  runId?: string | null
}): MineStableSource | null {
  switch (row.sourceKind) {
    case 'status_stall': {
      const paneKey = paneKeyFromStallSourceId(row.sourceId)
      return paneKey === null ? null : { dimension: 'pane', key: `pane:${paneKey}` }
    }
    case 'tool_error': {
      const parts = toolErrorSourceParts(row.sourceId)
      return parts === null
        ? null
        : { dimension: 'session', key: `session:${parts.sessionId}:code:${parts.code}` }
    }
    case 'acceptance': {
      const dispatchId = row.dispatchId ?? dispatchIdFromAcceptanceSourceId(row.sourceId)
      return dispatchId === null || dispatchId === undefined || dispatchId.length === 0
        ? null
        : { dimension: 'dispatch', key: `dispatch:${dispatchId}:${row.facet}` }
    }
    case 'pty_exit': {
      if (row.agentSessionId) {
        return { dimension: 'session', key: `session:${row.agentSessionId}` }
      }
      if (row.worktreeId) {
        return { dimension: 'worktree', key: `worktree:${row.worktreeId}` }
      }
      if (row.runId) {
        return { dimension: 'run', key: `run:${row.runId}` }
      }
      return null
    }
    case 'dispatch_settle': {
      // Reserved vocabulary with no writer yet; if one lands, the dispatch column is its entity.
      const dispatchId = row.dispatchId ?? null
      return dispatchId === null || dispatchId.length === 0
        ? null
        : { dimension: 'dispatch', key: `dispatch:${dispatchId}` }
    }
    case 'self_report':
      return null
  }
}

/** Distinct stable sources, counting only rows whose key could be derived. */
export function countStableSources(rows: readonly MineRuleRow[]): number {
  const keys = new Set<string>()
  for (const row of rows) {
    const identity = stableSourceIdentity(row)
    if (identity !== null) {
      keys.add(identity.key)
    }
  }
  return keys.size
}

/**
 * Which rules a cluster satisfies (§10.2), with the epoch removed from "how many sources".
 *
 * `repeat_fingerprint` is the general one: enough rows from enough distinct ENTITIES that it is not one
 * flaky attempt. The two small-cluster rules exist because a signalled crash and a failed acceptance
 * rule are each strong on their own — but they too require two entities (M6 review C2): the same pane
 * crashing twice, or one dispatch failing the same rule twice, is `singleEntityRecurrence`, not a
 * cross-source pattern.
 *
 * `MINE_MIN_DISTINCT_SOURCE_IDS` is named for the store's column; the value it is applied to is now the
 * stable-source count, which is the only reading of "distinct source" that the epoched key supports.
 */
export function mineRulesFor(rows: readonly MineRuleRow[]): MineRuleName[] {
  const rules: MineRuleName[] = []
  const stableSources = countStableSources(rows)
  const enoughSources = stableSources >= MINE_MIN_DISTINCT_SOURCE_IDS
  if (rows.length >= MINE_MIN_ROWS && enoughSources) {
    rules.push(MINE_RULE_REPEAT_FINGERPRINT)
  }
  if (
    rows.length >= MINE_SMALL_CLUSTER_MIN_ROWS &&
    enoughSources &&
    rows.every((row) => row.class === 'crash') &&
    rows.some((row) => row.exitCause?.kind === 'signaled')
  ) {
    rules.push(MINE_RULE_CRASH_SIGNALED)
  }
  if (
    rows.length >= MINE_SMALL_CLUSTER_MIN_ROWS &&
    enoughSources &&
    rows.every((row) => row.class === 'acceptance_failed')
  ) {
    // "Same invariant" = one acceptance rule id, which is the cluster's facet (`rule:<id>`).
    const facets = new Set(rows.map((row) => row.facet))
    if (facets.size === 1) {
      rules.push(MINE_RULE_ACCEPTANCE_INVARIANT)
    }
  }
  return rules
}

/**
 * Does the cluster meet a rule's ROW threshold while only ever hitting one entity? (M6 review C2)
 *
 * Kept separate from `mineRulesFor` so the report can say *why* an otherwise-qualifying cluster was not
 * promoted, instead of leaving it unexplained in the table.
 */
export function isSingleEntityRecurrence(rows: readonly MineRuleRow[]): boolean {
  if (rows.length < MINE_SMALL_CLUSTER_MIN_ROWS) {
    return false
  }
  const stableSources = countStableSources(rows)
  const rowsQualify =
    rows.length >= MINE_MIN_ROWS ||
    (rows.every((row) => row.class === 'crash') &&
      rows.some((row) => row.exitCause?.kind === 'signaled')) ||
    rows.every((row) => row.class === 'acceptance_failed')
  // `stableSources === 0` is "we could not tell", not "one entity"; that case is surfaced separately
  // as `unknownStableSource` and also never promoted.
  return rowsQualify && stableSources === 1
}

/**
 * Low-information clusters (M6 review C5).
 *
 * A fingerprint built only from `tool:unknown` or a generic `tool:non_zero_exit` says "some command
 * failed", which is true of almost any session; left unmarked they would fill a triage queue. They are
 * reported (the counts are real) but marked, sorted last, and held to their own small candidate budget.
 */
/** Why a cluster is considered low-information (M6 review C5). */
export type MineLowInformationReason = 'unknown_code' | 'generic_non_zero_exit' | 'unknown_class' | null

export function lowInformationFor(
  rows: readonly MineRuleRow[]
): MineLowInformationReason {
  if (rows.every((row) => row.class === 'unknown_state')) {
    return 'unknown_class'
  }
  if (rows.every((row) => row.sourceKind === 'tool_error')) {
    const code = rows[0].facet.startsWith('tool:') ? rows[0].facet.slice('tool:'.length) : ''
    if (code === 'unknown') {
      return 'unknown_code'
    }
    if (code === 'non_zero_exit') {
      return 'generic_non_zero_exit'
    }
  }
  return null
}

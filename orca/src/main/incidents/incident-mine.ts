// `orca incident mine`: read-only clustering into triage candidates (issue-sedimentation.md v2.7 §10, M6-1).
//
// One SQL read over `incidents` joined with the projected `incident_state`, grouped by `fingerprint`.
// Nothing here writes: the miner's decisions land in M6-2, behind `--apply`, and this module only
// answers "which clusters look worth a human's time, and why".
//
// Three decisions worth stating because they are easy to get wrong:
//
//   * Terminal rows are not evidence of a pattern. A row already `duplicate`/`invalid`/`closed` has
//     been triaged; counting it would let a cluster grow on incidents a human already dismissed. They
//     are counted separately and reported as `excluded`, never silently dropped.
//   * `fingerprint` is a clustering aid, not identity (§11.3): the unique key is
//     `(source_kind, source_id, facet)` with its own epoch. So a cluster is a *reading* of the data,
//     and the rule that promoted it is printed with it.
//   * `source_id` CONTAINS THE EPOCH, so counting distinct `source_id` measures repetitions of one
//     entity, not reproduction across entities (M6 review C1). A pane that stalls three times has
//     three `source_id`s (`<paneKey>:<stateStartedAt>`), and a session with three turns of one tool
//     error has three more. Cross-source reproduction therefore needs a STABLE source key with the
//     epoch removed (`stableSourceIdentity`), and a row whose stable key cannot be derived is counted
//     as `unknownStableSource` — never as a fresh source.
//   * A candidate is an untriaged incident, not a cluster: a human triages rows. A cluster whose rows
//     are already triaged still appears in the report (with `hasUntriaged: false`) so the numbers do
//     not shrink mysteriously between two runs.
//
// Bounded by construction (§10.4): group and candidate caps plus a wall-clock budget, and every cap
// that fires is reported rather than applied quietly.

import type Database from '../sqlite/sync-database'
import type {
  IncidentClass,
  IncidentCoverage,
  IncidentSourceKind,
  IncidentStatus
} from './incident-types'
import { buildIncidentDigest, type IncidentDigest } from './incident-digest'
import { parseExitCause } from './incident-store-rows'
import { sanitizeText } from './incident-sanitize'

/**
 * The candidate rules, in one place so a reviewer can see the whole policy (§10.2).
 *
 * These are deliberately conservative: a miner that guesses too eagerly hands a human a queue nobody
 * trusts. They are constants, not configuration, because a threshold nobody can find is a threshold
 * nobody can reason about; changing one is a code change with a test.
 */
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

export type MineCluster = {
  fingerprint: string
  /** Rows in the window that count toward this cluster (terminal rows excluded). */
  count: number
  /** One row is one epoch occurrence. Same number as `count`, named for the distinction below. */
  epochRows: number
  /**
   * Distinct entities after the epoch is removed (M6 review C1). THIS is what "≥2 sources" means.
   * It is 0 when no row's stable key could be derived, so an unknown key never inflates diversity.
   */
  stableSources: number
  /** Rows whose stable key could not be derived. They never count as a source. */
  unknownStableSource: number
  /** Which dimension the stable keys came from, so "3 sources" cannot be read as 3 worktrees. */
  sourceDimensions: { dimension: MineSourceDimension; count: number }[]
  /** Distinct non-null identities per column/dimension (M6 review C7). */
  distinctPanes: number
  distinctSessions: number
  distinctDispatches: number
  distinctWorktrees: number
  distinctRuns: number
  byClass: { value: IncidentClass; count: number }[]
  bySourceKind: { value: IncidentSourceKind; count: number }[]
  firstSeen: number
  lastSeen: number
  /** Distinct worktrees, first-seen order, capped at MINE_MAX_WORKTREES_REPORTED. */
  worktrees: string[]
  worktreeCount: number
  runs: string[]
  runCount: number
  /** Rule names that put this cluster in the candidate set; empty means "reported, not promoted". */
  rules: MineRuleName[]
  /**
   * The row count a rule would need is met, but every row is the SAME entity (M6 review C2).
   *
   * Reported, never promoted: one pane crashing three times is a real fact but not the cross-entity
   * pattern a triage queue is for, and `--apply` cannot touch these.
   */
  singleEntityRecurrence: boolean
  /** `unknown` / generic `non_zero_exit` codes and self-report-shaped clusters (M6 review C5). */
  lowInformation: boolean
  lowInformationReason: 'unknown_code' | 'generic_non_zero_exit' | 'unknown_class' | null
  /** Short human summary: dominant class + source kind (M6 review C7). */
  summary: string
  statusCounts: { status: IncidentStatus; count: number }[]
  latestDecisionAt: number | null
  /** What a person should do next with this cluster (M6 review C7). */
  ownerAction: 'triage' | 'reviewed' | 'archive-candidate'
  /** Oldest untriaged row, else the oldest row: what a human would open first. */
  representativeId: string
  hasUntriaged: boolean
  untriagedCount: number
}

export type MineCandidateStats = {
  count: number
  /** Entity count with the epoch removed (M6 review C1). */
  stableSources: number
  unknownStableSource: number
  firstSeen: number
  lastSeen: number
}

export type MineCandidate = {
  incidentId: string
  fingerprint: string
  rule: MineRuleName
  fromStatus: IncidentStatus
  /** The cluster statistics behind the rule — the reason quotes them, the JSON exposes them. */
  stats: MineCandidateStats
}

export type MineExcluded = {
  total: number
  byStatus: { status: IncidentStatus; count: number }[]
  /** Why rows were set aside, so "excluded" can be read without guessing (M6 review C5). */
  byReason: { terminal: number; selfReport: number }
}

export type MineTotals = {
  /** Every row the SCAN returned, before exclusions. Equals `scan.rows`. */
  rowsInWindow: number
  /** Clusters after excluded statuses and self-reports are removed. */
  clusters: number
  /** Clusters that satisfied at least one rule. */
  candidateClusters: number
  /** Untriaged incidents inside those clusters (what `--max-candidates` bounds). */
  candidates: number
  /** Clusters marked low-information (M6 review C5). */
  lowInformationClusters: number
}

export type MineTruncation = {
  groups: boolean
  candidates: boolean
  timeBudget: boolean
  /** The scan hit its hard row cap; clusters and totals describe only the rows read (M6 review C4). */
  scan: boolean
  /** The separate low-information candidate budget was reached (M6 review C5). */
  lowInformation: boolean
}

export type MineLimits = {
  maxGroups: number
  maxCandidates: number
  timeBudgetMs: number
  maxScanRows: number
}

/**
 * What the pass actually cost (M6 review C4).
 *
 * `timeBudgetMs` cannot bound the SQL read or the grouping — both complete before the first budget
 * check — so the cost is measured and published instead of implied. `truncated.scan` is the only field
 * that means "these numbers cover only part of the window".
 */
export type MineScan = {
  rows: number
  ms: number
  /** The embedded digest runs its own aggregate query; its cost is reported here, not hidden. */
  digestMs: number
  truncated: boolean
  limit: number
}

export type IncidentMine = {
  /** Stable JSON shape for automations (M6-4): bump only for a breaking change. */
  version: 1
  now: number
  since: number
  windowMs: number
  apply: boolean
  /** Null in a dry run without `--target`: the miner has no default target (M6 review C6). */
  target: MinerTarget | null
  scan: MineScan
  totals: MineTotals
  excluded: MineExcluded
  truncated: MineTruncation
  limits: MineLimits
  clusters: MineCluster[]
  candidates: MineCandidate[]
  /**
   * The SAME object `orca incident digest` returns, built by the same function over the same window.
   *
   * M6-3 asks that the two commands never disagree about the store: this is the mechanism, not a
   * convention. It rides inside `mine` so one automation invocation carries both the counting view
   * (totals/coverage/capacity/replay) and the triage view (clusters/candidates) and cannot be reading
   * two different moments.
   */
  digest: IncidentDigest
  /** Present only when `--apply` ran; dry runs omit it rather than reporting an empty summary. */
  applied?: MineApplySummary
}

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

type MineRow = MineRuleRow

function toRow(row: Record<string, unknown>): MineRow {
  return {
    id: String(row.id),
    class: String(row.class) as IncidentClass,
    sourceKind: String(row.source_kind) as IncidentSourceKind,
    sourceId: String(row.source_id),
    facet: String(row.facet),
    fingerprint: String(row.fingerprint),
    createdAt: Number(row.created_at),
    worktreeId: row.worktree_id === null ? null : String(row.worktree_id),
    runId: row.run_id === null ? null : String(row.run_id),
    agentSessionId: row.agent_session_id === null ? null : String(row.agent_session_id),
    dispatchId: row.dispatch_id === null ? null : String(row.dispatch_id),
    effectiveStatus: String(row.effective_status) as IncidentStatus,
    lastDecisionAt:
      row.last_decision_at === null || row.last_decision_at === undefined
        ? null
        : Number(row.last_decision_at),
    exitCause: parseExitCause(row.exit_cause)
  }
}

/**
 * Read the window, newest first, with a HARD row cap (M6 review C4).
 *
 * `timeBudgetMs` can only stop the selection loop; the query and the grouping happen before it is ever
 * consulted. A limit on the statement is the only thing that bounds them, so the cap lives here and is
 * reported (`scan.rows` / `scan.truncated`) separately from the candidate truncation.
 *
 * Newest-first because a weekly review of a very large window is better served by the most recent rows
 * than by the oldest; the slice is reversed afterwards so downstream ordering stays ascending.
 */
function readRows(
  db: Database.Database,
  since: number,
  limit: number
): { rows: MineRow[]; truncated: boolean; ms: number } {
  const startedAt = Date.now()
  const fetched = db
    .prepare(
      `SELECT i.id AS id, i.class AS class, i.source_kind AS source_kind,
              i.source_id AS source_id, i.facet AS facet, i.fingerprint AS fingerprint,
              i.created_at AS created_at, i.worktree_id AS worktree_id, i.run_id AS run_id,
              i.agent_session_id AS agent_session_id, i.dispatch_id AS dispatch_id,
              i.exit_cause AS exit_cause, s.status AS effective_status,
              s.last_decision_at AS last_decision_at
         FROM incidents i
         JOIN incident_state s ON s.incident_id = i.id
        WHERE i.created_at >= ?
        ORDER BY i.created_at DESC, i.rowid DESC
        LIMIT ?`
    )
    .all(since, limit + 1) as Record<string, unknown>[]
  const ms = Date.now() - startedAt
  const truncated = fetched.length > limit
  const rows = (truncated ? fetched.slice(0, limit) : fetched).map(toRow).reverse()
  return { rows, truncated, ms }
}

function counted<T extends string>(values: readonly T[]): { value: T; count: number }[] {
  const counts = new Map<T, number>()
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value))
}

function distinct(values: (string | null)[], limit: number): { values: string[]; total: number } {
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const value of values) {
    if (value !== null && !seen.has(value)) {
      seen.add(value)
      ordered.push(value)
    }
  }
  return { values: ordered.slice(0, limit), total: seen.size }
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

function buildCluster(fingerprint: string, rows: MineRow[]): MineCluster {
  const untriaged = rows.filter((row) => row.effectiveStatus === 'untriaged')
  const representative = untriaged[0] ?? rows[0]
  const worktrees = distinct(
    rows.map((row) => row.worktreeId),
    MINE_MAX_WORKTREES_REPORTED
  )
  const runs = distinct(
    rows.map((row) => row.runId),
    MINE_MAX_RUNS_REPORTED
  )
  const identities = rows.map((row) => stableSourceIdentity(row))
  const stableKeys = new Set<string>()
  const dimensions = new Map<MineSourceDimension, number>()
  let unknownStableSource = 0
  for (const identity of identities) {
    if (identity === null) {
      unknownStableSource += 1
      continue
    }
    if (!stableKeys.has(identity.key)) {
      stableKeys.add(identity.key)
      dimensions.set(identity.dimension, (dimensions.get(identity.dimension) ?? 0) + 1)
    }
  }
  const panes = new Set<string>()
  for (const row of rows) {
    const paneKey =
      row.sourceKind === 'status_stall' ? paneKeyFromStallSourceId(row.sourceId) : null
    if (paneKey !== null) {
      panes.add(paneKey)
    }
  }
  const sessions = new Set<string>()
  for (const row of rows) {
    if (row.agentSessionId !== null) {
      sessions.add(row.agentSessionId)
    } else if (row.sourceKind === 'tool_error') {
      const parts = toolErrorSourceParts(row.sourceId)
      if (parts !== null) {
        sessions.add(parts.sessionId)
      }
    }
  }
  const dispatches = new Set<string>()
  for (const row of rows) {
    if (row.dispatchId !== null) {
      dispatches.add(row.dispatchId)
    } else if (row.sourceKind === 'acceptance') {
      const parsed = dispatchIdFromAcceptanceSourceId(row.sourceId)
      if (parsed !== null) {
        dispatches.add(parsed)
      }
    }
  }
  const rules = mineRulesFor(rows)
  const lowInformationReason = lowInformationFor(rows)
  const latestDecisionAt = rows.reduce<number | null>(
    (latest, row) =>
      row.lastDecisionAt === null ? latest : latest === null ? row.lastDecisionAt : Math.max(latest, row.lastDecisionAt),
    null
  )
  const statusCounts = counted(rows.map((row) => row.effectiveStatus)).map((entry) => ({
    status: entry.value,
    count: entry.count
  }))
  const dominantClass = counted(rows.map((row) => row.class))[0]
  const dominantKind = counted(rows.map((row) => row.sourceKind))[0]
  return {
    fingerprint,
    count: rows.length,
    epochRows: rows.length,
    stableSources: stableKeys.size,
    unknownStableSource,
    sourceDimensions: [...dimensions.entries()]
      .map(([dimension, count]) => ({ dimension, count }))
      .sort((left, right) => right.count - left.count || left.dimension.localeCompare(right.dimension)),
    distinctPanes: panes.size,
    distinctSessions: sessions.size,
    distinctDispatches: dispatches.size,
    distinctWorktrees: worktrees.total,
    distinctRuns: runs.total,
    byClass: counted(rows.map((row) => row.class)),
    bySourceKind: counted(rows.map((row) => row.sourceKind)),
    firstSeen: rows[0].createdAt,
    lastSeen: rows[rows.length - 1].createdAt,
    worktrees: worktrees.values,
    worktreeCount: worktrees.total,
    runs: runs.values,
    runCount: runs.total,
    rules,
    singleEntityRecurrence: isSingleEntityRecurrence(rows),
    lowInformation: lowInformationReason !== null,
    lowInformationReason,
    // "crash/pty_exit" — enough for a meeting row, and the dominant value is named first.
    summary: `${dominantClass?.value ?? 'unknown'}/${dominantKind?.value ?? 'unknown'}`,
    statusCounts,
    latestDecisionAt,
    ownerAction:
      untriaged.length > 0
        ? 'triage'
        : rows.every(
              (row) =>
                row.effectiveStatus === 'duplicate' ||
                row.effectiveStatus === 'invalid' ||
                row.effectiveStatus === 'closed'
            )
          ? 'archive-candidate'
          : 'reviewed',
    representativeId: representative.id,
    hasUntriaged: untriaged.length > 0,
    untriagedCount: untriaged.length
  }
}

/**
 * Low-information clusters (M6 review C5).
 *
 * A fingerprint built only from `tool:unknown` or a generic `tool:non_zero_exit` says "some command
 * failed", which is true of almost any session; left unmarked they would fill a triage queue. They are
 * reported (the counts are real) but marked, sorted last, and held to their own small candidate budget.
 */
function lowInformationFor(
  rows: readonly MineRuleRow[]
): MineCluster['lowInformationReason'] {
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

export type BuildIncidentMineOptions = {
  now: number
  /** The store's own coverage report; the embedded digest quotes it rather than recomputing it. */
  coverage: IncidentCoverage
  windowMs?: number
  maxGroups?: number
  maxCandidates?: number
  timeBudgetMs?: number
  maxScanRows?: number
  /** Recorded in the payload; this function never writes (M6-2 applies). */
  apply?: boolean
  target?: MinerTarget | null
  /** Test seam: a deterministic clock for the budget. Production reads Date.now. */
  clock?: () => number
}

/**
 * Read-only mining pass.
 *
 * The caps are applied at the END of the analysis, never by limiting the query: the totals must
 * describe the whole window even when the output is truncated, otherwise "truncated" would be
 * indistinguishable from "that is all there is".
 */
export function buildIncidentMine(
  db: Database.Database,
  options: BuildIncidentMineOptions
): IncidentMine {
  const clock = options.clock ?? Date.now
  const startedAt = clock()
  const windowMs = options.windowMs ?? DEFAULT_MINE_WINDOW_MS
  const since = options.now - windowMs
  const maxGroups = options.maxGroups ?? DEFAULT_MINE_MAX_GROUPS
  const maxCandidates = options.maxCandidates ?? DEFAULT_MINE_MAX_CANDIDATES
  const timeBudgetMs = options.timeBudgetMs ?? DEFAULT_MINE_TIME_BUDGET_MS

  const maxScanRows = options.maxScanRows ?? DEFAULT_MINE_MAX_SCAN_ROWS
  const scan = readRows(db, since, maxScanRows)
  const allRows = scan.rows
  const excludedCounts = new Map<IncidentStatus, number>()
  const liveRows: MineRow[] = []
  let selfReportRows = 0
  for (const row of allRows) {
    if (MINE_EXCLUDED_STATUSES.includes(row.effectiveStatus)) {
      excludedCounts.set(row.effectiveStatus, (excludedCounts.get(row.effectiveStatus) ?? 0) + 1)
    } else if (row.sourceKind === 'self_report') {
      // Declared out of mining (M6 review C5): a self-report's key is a request id, so it cannot form
      // a cluster. Counting it as an excluded row is honest; inventing a source for it would not be.
      selfReportRows += 1
    } else {
      liveRows.push(row)
    }
  }
  const excludedTotal = allRows.length - liveRows.length

  const grouped = new Map<string, MineRow[]>()
  for (const row of liveRows) {
    const bucket = grouped.get(row.fingerprint)
    if (bucket === undefined) {
      grouped.set(row.fingerprint, [row])
    } else {
      bucket.push(row)
    }
  }

  // Rank, then size, then age: a promoted cluster with real cross-entity evidence first, low-information
  // clusters last (they are still reported, but they must not head the queue), single-entity
  // recurrences after every promotable cluster. Deterministic tie-break on the fingerprint.
  const rank = (cluster: MineCluster): number =>
    cluster.rules.length > 0 ? (cluster.lowInformation ? 1 : 0) : cluster.singleEntityRecurrence ? 2 : 3
  const allClusters = [...grouped.entries()]
    .map(([fingerprint, rows]) => buildCluster(fingerprint, rows))
    .sort(
      (left, right) =>
        rank(left) - rank(right) ||
        right.count - left.count ||
        left.firstSeen - right.firstSeen ||
        left.fingerprint.localeCompare(right.fingerprint)
    )

  const candidateClusters = allClusters.filter((cluster) => cluster.rules.length > 0)
  const lowInformationClusters = candidateClusters.filter((cluster) => cluster.lowInformation)
  const totalCandidates = candidateClusters.reduce(
    (sum, cluster) => sum + cluster.untriagedCount,
    0
  )

  const candidates: MineCandidate[] = []
  let budgetExhausted = false
  let lowInformationCandidates = 0
  let lowInformationTrimmed = false
  for (const cluster of candidateClusters) {
    if (budgetExhausted) {
      break
    }
    if (cluster.lowInformation && lowInformationCandidates >= MINE_MAX_LOW_INFORMATION_CANDIDATES) {
      // Capped by its own budget, and said so: a noise cluster must not consume the real candidates'
      // slots, and must not silently disappear either.
      lowInformationTrimmed = lowInformationTrimmed || cluster.untriagedCount > 0
      continue
    }
    const untriaged = (grouped.get(cluster.fingerprint) ?? []).filter(
      (row) => row.effectiveStatus === 'untriaged'
    )
    for (const row of untriaged) {
      if (candidates.length >= maxCandidates) {
        break
      }
      if (cluster.lowInformation && lowInformationCandidates >= MINE_MAX_LOW_INFORMATION_CANDIDATES) {
        lowInformationTrimmed = true
        break
      }
      if (clock() - startedAt >= timeBudgetMs) {
        budgetExhausted = true
        break
      }
      if (cluster.lowInformation) {
        lowInformationCandidates += 1
      }
      candidates.push({
        incidentId: row.id,
        fingerprint: cluster.fingerprint,
        // The first rule that promoted the cluster is the one a human is asked to weigh.
        rule: cluster.rules[0],
        fromStatus: row.effectiveStatus,
        stats: {
          count: cluster.count,
          stableSources: cluster.stableSources,
          unknownStableSource: cluster.unknownStableSource,
          firstSeen: cluster.firstSeen,
          lastSeen: cluster.lastSeen
        }
      })
    }
  }

  const digestStartedAt = clock()
  const digest = buildIncidentDigest(db, {
    now: options.now,
    windowMs,
    coverage: options.coverage
  })
  const digestMs = clock() - digestStartedAt

  return {
    version: 1,
    now: options.now,
    since,
    windowMs,
    digest,
    apply: options.apply === true,
    target: options.target ?? null,
    scan: {
      rows: scan.rows.length,
      ms: scan.ms,
      digestMs,
      truncated: scan.truncated,
      limit: maxScanRows
    },
    totals: {
      rowsInWindow: allRows.length,
      clusters: allClusters.length,
      candidateClusters: candidateClusters.length,
      candidates: totalCandidates,
      lowInformationClusters: lowInformationClusters.length
    },
    excluded: {
      total: excludedTotal,
      byStatus: [...excludedCounts.entries()]
        .map(([status, count]) => ({ status, count }))
        .sort((left, right) => right.count - left.count || left.status.localeCompare(right.status)),
      byReason: { terminal: allRows.length - liveRows.length - selfReportRows, selfReport: selfReportRows }
    },
    truncated: {
      groups: allClusters.length > maxGroups,
      candidates: totalCandidates > maxCandidates,
      timeBudget: budgetExhausted,
      scan: scan.truncated,
      lowInformation: lowInformationTrimmed
    },
    limits: { maxGroups, maxCandidates, timeBudgetMs, maxScanRows },
    clusters: allClusters.slice(0, maxGroups),
    candidates
  }
}

/**
 * What a miner decision did, one row per candidate (M6-2).
 *
 * `skipped_*` is not a failure: it is the idempotency contract. An incident already in the target
 * state, or already terminal, is left alone so a repeated run cannot append a second decision.
 */
export type MineApplyOutcome =
  | 'applied'
  | 'skipped_already_target'
  | 'skipped_terminal'
  | 'skipped_invalid_transition'
  | 'skipped_not_found'
  | 'skipped_read_only'
  /** Another writer changed the status between mining and applying (M6 review C3). */
  | 'skipped_status_changed'
  /**
   * The row is no longer `untriaged`: a human (or another triage step) decided while the miner was
   * running. The miner never replaces that decision, even when the transition table would allow it.
   */
  | 'skipped_human_decided'

export type MineApplyResult = {
  incidentId: string
  fingerprint: string
  rule: MineRuleName
  fromStatus: IncidentStatus
  toStatus: MinerTarget
  outcome: MineApplyOutcome
  decisionId: string | null
}

export type MineApplySummary = {
  attempted: number
  appended: number
  skipped: number
  results: MineApplyResult[]
}

/**
 * The reason string written on every miner decision.
 *
 * It must let a human re-derive the decision: which rule fired, on how many rows, from how many
 * distinct ENTITIES, over what span. It never touches a summary, an evidence body or an output text —
 * those are already sanitized at write time and re-quoting them here would be a second copy of
 * something that may contain anything.
 */
export function mineDecisionReason(candidate: MineCandidate): string {
  const stats = candidate.stats
  return sanitizeText(
    `miner rule=${candidate.rule} fingerprint=${candidate.fingerprint.slice(0, 16)} ` +
      `count=${stats.count} stable_sources=${stats.stableSources} ` +
      `unknown_stable_source=${stats.unknownStableSource} ` +
      `first=${new Date(stats.firstSeen).toISOString()} last=${new Date(stats.lastSeen).toISOString()}`,
    500
  )
}

export type ApplyMineOptions = {
  /** Required: there is no default target (M6 review C6). */
  target: MinerTarget
  actor?: string
  /** Test seam; the CLI uses the store's own clock. */
  now?: () => number
}

export type MineStore = {
  getIncident: (id: string) => { effectiveStatus: IncidentStatus } | null
  appendDecision: (input: {
    incidentId: string
    toStatus: IncidentStatus
    actor: string
    reason: string
    createdAt?: number
    /** The in-transaction guard: only act if the current status is exactly this one. */
    requireFromStatus?: IncidentStatus
  }) => { outcome: string; decisionId?: string; fromStatus?: IncidentStatus }
  /** Mirrors `IncidentStore.readOnly`: a store opened for a newer schema refuses every write. */
  readOnly: boolean
}

/**
 * Apply the miner's suggestions — append-only, one decision per candidate, nothing else.
 *
 * The guard that matters (M6 review C3) is `requireFromStatus: 'untriaged'`, evaluated by the store
 * inside the SAME `BEGIN IMMEDIATE` transaction that inserts the decision. The pre-read below only
 * chooses the reported outcome; it cannot make a decision that arrived in between safe, so it is not
 * what protects the human's judgement.
 *
 * Not transaction-wrapped across candidates: each append is its own IMMEDIATE transaction, so a failure
 * on candidate 7 leaves the first six applied and readable rather than rolling back work a human can
 * already see. The count is returned either way.
 */
export function applyMineCandidates(
  store: MineStore,
  mine: IncidentMine,
  options: ApplyMineOptions
): MineApplySummary {
  const actor = options.actor ?? MINER_ACTOR
  const now = options.now
  const target = options.target
  const results: MineApplyResult[] = []
  let appended = 0
  for (const candidate of mine.candidates) {
    const base = {
      incidentId: candidate.incidentId,
      fingerprint: candidate.fingerprint,
      rule: candidate.rule,
      fromStatus: candidate.fromStatus,
      toStatus: target
    }
    if (store.readOnly) {
      results.push({ ...base, outcome: 'skipped_read_only', decisionId: null })
      continue
    }
    const view = store.getIncident(candidate.incidentId)
    if (view === null) {
      results.push({ ...base, outcome: 'skipped_not_found', decisionId: null })
      continue
    }
    // §11.5: terminal decisions are never reopened by automated tooling — a miner that could move a
    // `duplicate` would quietly make prunable rows reappear as candidates.
    if (MINE_EXCLUDED_STATUSES.includes(view.effectiveStatus)) {
      results.push({
        ...base,
        fromStatus: view.effectiveStatus,
        outcome: 'skipped_terminal',
        decisionId: null
      })
      continue
    }
    if (view.effectiveStatus === target) {
      results.push({
        ...base,
        fromStatus: view.effectiveStatus,
        outcome: 'skipped_already_target',
        decisionId: null
      })
      continue
    }
    // A candidate is minted from an untriaged row. Anything else means someone decided in between, and
    // the miner is not allowed to replace that — not even with the transition table's permission.
    if (view.effectiveStatus !== candidate.fromStatus) {
      results.push({
        ...base,
        fromStatus: view.effectiveStatus,
        outcome: 'skipped_human_decided',
        decisionId: null
      })
      continue
    }
    const decision = store.appendDecision({
      incidentId: candidate.incidentId,
      toStatus: target,
      actor,
      reason: mineDecisionReason(candidate),
      requireFromStatus: candidate.fromStatus,
      ...(now === undefined ? {} : { createdAt: now() })
    })
    if (decision.outcome === 'appended') {
      appended += 1
      results.push({
        ...base,
        fromStatus: decision.fromStatus ?? view.effectiveStatus,
        outcome: 'applied',
        decisionId: decision.decisionId ?? null
      })
      continue
    }
    results.push({
      ...base,
      fromStatus: decision.fromStatus ?? view.effectiveStatus,
      outcome:
        decision.outcome === 'status_unchanged'
          ? 'skipped_already_target'
          : decision.outcome === 'status_changed'
            ? MINE_EXCLUDED_STATUSES.includes(decision.fromStatus as IncidentStatus)
              ? 'skipped_terminal'
              : 'skipped_status_changed'
            : decision.outcome === 'invalid_transition'
              ? 'skipped_invalid_transition'
              : 'skipped_not_found',
      decisionId: null
    })
  }
  return {
    attempted: mine.candidates.length,
    appended,
    skipped: results.length - appended,
    results
  }
}

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
//   * A candidate is an untriaged incident, not a cluster: a human triages rows. A cluster whose rows
//     are already triaged still appears in the report (with `hasUntriaged: false`) so the numbers do
//     not shrink mysteriously between two runs.
//
// Bounded by construction (§10.4): group and candidate caps plus a wall-clock budget, and every cap
// that fires is reported rather than applied quietly.

import type Database from '../sqlite/sync-database'
import type {
  IncidentClass,
  IncidentSourceKind,
  IncidentStatus
} from './incident-types'
import { parseExitCause } from './incident-store-rows'

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
  distinctSourceIds: number
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
  /** Oldest untriaged row, else the oldest row: what a human would open first. */
  representativeId: string
  hasUntriaged: boolean
  untriagedCount: number
}

export type MineCandidate = {
  incidentId: string
  fingerprint: string
  rule: MineRuleName
  fromStatus: IncidentStatus
}

export type MineExcluded = {
  total: number
  byStatus: { status: IncidentStatus; count: number }[]
}

export type MineTotals = {
  /** Every row in the window, before exclusions. */
  rowsInWindow: number
  /** Clusters after terminal rows are excluded. */
  clusters: number
  /** Clusters that satisfied at least one rule. */
  candidateClusters: number
  /** Untriaged incidents inside those clusters (what `--max-candidates` bounds). */
  candidates: number
}

export type MineTruncation = {
  groups: boolean
  candidates: boolean
  timeBudget: boolean
}

export type MineLimits = {
  maxGroups: number
  maxCandidates: number
  timeBudgetMs: number
}

export type IncidentMine = {
  /** Stable JSON shape for automations (M6-4): bump only for a breaking change. */
  version: 1
  now: number
  since: number
  windowMs: number
  apply: boolean
  target: MinerTarget
  totals: MineTotals
  excluded: MineExcluded
  truncated: MineTruncation
  limits: MineLimits
  clusters: MineCluster[]
  candidates: MineCandidate[]
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
  effectiveStatus: IncidentStatus
  exitCause: ReturnType<typeof parseExitCause>
}

type MineRow = MineRuleRow

function readRows(db: Database.Database, since: number): MineRow[] {
  const rows = db
    .prepare(
      `SELECT i.id AS id, i.class AS class, i.source_kind AS source_kind,
              i.source_id AS source_id, i.facet AS facet, i.fingerprint AS fingerprint,
              i.created_at AS created_at, i.worktree_id AS worktree_id, i.run_id AS run_id,
              i.exit_cause AS exit_cause, s.status AS effective_status
         FROM incidents i
         JOIN incident_state s ON s.incident_id = i.id
        WHERE i.created_at >= ?
        ORDER BY i.created_at ASC, i.rowid ASC`
    )
    .all(since) as Record<string, unknown>[]
  return rows.map((row) => ({
    id: String(row.id),
    class: String(row.class) as IncidentClass,
    sourceKind: String(row.source_kind) as IncidentSourceKind,
    sourceId: String(row.source_id),
    facet: String(row.facet),
    fingerprint: String(row.fingerprint),
    createdAt: Number(row.created_at),
    worktreeId: row.worktree_id === null ? null : String(row.worktree_id),
    runId: row.run_id === null ? null : String(row.run_id),
    effectiveStatus: String(row.effective_status) as IncidentStatus,
    exitCause: parseExitCause(row.exit_cause)
  }))
}

function counted<T extends string>(values: T[]): { value: T; count: number }[] {
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

/**
 * Which rules a cluster satisfies (§10.2).
 *
 * `repeat_fingerprint` is the general one: enough rows from enough distinct sources that it is not one
 * flaky attempt. The two small-cluster rules exist because a signalled crash and a failed acceptance
 * rule are each strong on their own — repeating one three times is not the evidence a human needs.
 */
export function mineRulesFor(rows: readonly MineRuleRow[]): MineRuleName[] {
  const rules: MineRuleName[] = []
  const distinctSourceIds = new Set(rows.map((row) => row.sourceId)).size
  if (rows.length >= MINE_MIN_ROWS && distinctSourceIds >= MINE_MIN_DISTINCT_SOURCE_IDS) {
    rules.push(MINE_RULE_REPEAT_FINGERPRINT)
  }
  if (
    rows.length >= MINE_SMALL_CLUSTER_MIN_ROWS &&
    rows.every((row) => row.class === 'crash') &&
    rows.some((row) => row.exitCause?.kind === 'signaled')
  ) {
    rules.push(MINE_RULE_CRASH_SIGNALED)
  }
  if (rows.length >= MINE_SMALL_CLUSTER_MIN_ROWS && rows.every((row) => row.class === 'acceptance_failed')) {
    // "Same invariant" = one acceptance rule id, which is the cluster's facet (`rule:<id>`).
    const facets = new Set(rows.map((row) => row.facet))
    if (facets.size === 1) {
      rules.push(MINE_RULE_ACCEPTANCE_INVARIANT)
    }
  }
  return rules
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
  return {
    fingerprint,
    count: rows.length,
    distinctSourceIds: new Set(rows.map((row) => row.sourceId)).size,
    byClass: counted(rows.map((row) => row.class)),
    bySourceKind: counted(rows.map((row) => row.sourceKind)),
    firstSeen: rows[0].createdAt,
    lastSeen: rows[rows.length - 1].createdAt,
    worktrees: worktrees.values,
    worktreeCount: worktrees.total,
    runs: runs.values,
    runCount: runs.total,
    rules: mineRulesFor(rows),
    representativeId: representative.id,
    hasUntriaged: untriaged.length > 0,
    untriagedCount: untriaged.length
  }
}

export type BuildIncidentMineOptions = {
  now: number
  windowMs?: number
  maxGroups?: number
  maxCandidates?: number
  timeBudgetMs?: number
  /** Recorded in the payload; this function never writes (M6-2 applies). */
  apply?: boolean
  target?: MinerTarget
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

  const allRows = readRows(db, since)
  const excludedCounts = new Map<IncidentStatus, number>()
  const liveRows: MineRow[] = []
  for (const row of allRows) {
    if (MINE_EXCLUDED_STATUSES.includes(row.effectiveStatus)) {
      excludedCounts.set(row.effectiveStatus, (excludedCounts.get(row.effectiveStatus) ?? 0) + 1)
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

  // Biggest first, then earliest: the cluster that has been repeating longest is the one to read.
  const allClusters = [...grouped.entries()]
    .map(([fingerprint, rows]) => buildCluster(fingerprint, rows))
    .sort(
      (left, right) =>
        right.count - left.count ||
        left.firstSeen - right.firstSeen ||
        left.fingerprint.localeCompare(right.fingerprint)
    )

  const candidateClusters = allClusters.filter((cluster) => cluster.rules.length > 0)
  const totalCandidates = candidateClusters.reduce(
    (sum, cluster) => sum + cluster.untriagedCount,
    0
  )

  const candidates: MineCandidate[] = []
  let budgetExhausted = false
  for (const cluster of candidateClusters) {
    if (budgetExhausted) {
      break
    }
    const untriaged = (grouped.get(cluster.fingerprint) ?? []).filter(
      (row) => row.effectiveStatus === 'untriaged'
    )
    for (const row of untriaged) {
      if (candidates.length >= maxCandidates) {
        break
      }
      if (clock() - startedAt >= timeBudgetMs) {
        budgetExhausted = true
        break
      }
      candidates.push({
        incidentId: row.id,
        fingerprint: cluster.fingerprint,
        // The first rule that promoted the cluster is the one a human is asked to weigh.
        rule: cluster.rules[0],
        fromStatus: row.effectiveStatus
      })
    }
  }

  return {
    version: 1,
    now: options.now,
    since,
    windowMs,
    apply: options.apply === true,
    target: options.target ?? DEFAULT_MINER_TARGET,
    totals: {
      rowsInWindow: allRows.length,
      clusters: allClusters.length,
      candidateClusters: candidateClusters.length,
      candidates: totalCandidates
    },
    excluded: {
      total: excludedTotal,
      byStatus: [...excludedCounts.entries()]
        .map(([status, count]) => ({ status, count }))
        .sort((left, right) => right.count - left.count || left.status.localeCompare(right.status))
    },
    truncated: {
      groups: allClusters.length > maxGroups,
      candidates: totalCandidates > maxCandidates,
      timeBudget: budgetExhausted
    },
    limits: { maxGroups, maxCandidates, timeBudgetMs },
    clusters: allClusters.slice(0, maxGroups),
    candidates
  }
}

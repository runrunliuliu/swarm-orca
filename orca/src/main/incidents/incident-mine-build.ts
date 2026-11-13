// Mining read path: one window query, grouping, cluster statistics, and the bounded report
// (issue-sedimentation.md v2.8 §10; simplify S3).
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
// Bounded by construction (§10.4): group and candidate caps, a wall-clock budget for the selection
// loop, and a HARD row cap on the query itself (M6 review C4 — a time budget cannot interrupt SQL).
// Every cap that fires is reported rather than applied quietly.

import type Database from '../sqlite/sync-database'
import type {
  IncidentClass,
  IncidentCoverage,
  IncidentSourceKind,
  IncidentStatus
} from './incident-types'
import { buildIncidentDigest, type IncidentDigest } from './incident-digest'
import { parseExitCause } from './incident-store-rows'
import {
  DEFAULT_MINE_MAX_CANDIDATES,
  DEFAULT_MINE_MAX_GROUPS,
  DEFAULT_MINE_MAX_SCAN_ROWS,
  DEFAULT_MINE_TIME_BUDGET_MS,
  DEFAULT_MINE_WINDOW_MS,
  MINE_EXCLUDED_STATUSES,
  MINE_MAX_LOW_INFORMATION_CANDIDATES,
  MINE_MAX_RUNS_REPORTED,
  MINE_MAX_WORKTREES_REPORTED,
  dispatchIdFromAcceptanceSourceId,
  isSingleEntityRecurrence,
  lowInformationFor,
  mineRulesFor,
  paneKeyFromStallSourceId,
  stableSourceIdentity,
  toolErrorSourceParts,
  type MineLowInformationReason,
  type MineRuleName,
  type MineRuleRow,
  type MineSourceDimension,
  type MinerTarget
} from './incident-mine-rules'
import type { MineApplySummary } from './incident-mine-apply'

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
  lowInformationReason: MineLowInformationReason
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

// The store's public vocabulary: limits, outcomes and the object the rest of the app holds (§6, §11.5).
//
// Separate from incident-store.ts so the write path, the query path, prune and the CLI can agree on
// result shapes without importing each other's implementation.

import type Database from '../sqlite/sync-database'
import type { IncidentCoverage, IncidentStatus, IncidentView } from './incident-types'
import type {
  IncidentClass,
  IncidentRecord,
  IncidentSourceKind
} from './incident-types'

/** §11.5: 50k rows or 500MB, whichever comes first. */
export const DEFAULT_INCIDENT_STORE_LIMITS = {
  maxRows: 50_000,
  maxBytes: 500 * 1024 * 1024
} as const

/** §11.5: only rows older than this may be pruned. */
export const DEFAULT_INCIDENT_RETENTION_DAYS = 90

export type IncidentStoreLimits = {
  maxRows: number
  maxBytes: number
}

export type InsertIncidentOutcome =
  | 'inserted'
  | 'duplicate'
  | 'capacity_limited'
  | 'read_only'
  | 'invalid_record'

export type InsertIncidentResult = {
  outcome: InsertIncidentOutcome
  /** The row's id, on `inserted` and on `duplicate` (the row that already existed). */
  id: string | null
  /** Which limit stopped the write, when `outcome` is `capacity_limited`. */
  limitedBy?: 'rows' | 'bytes'
  reason?: string
}

export type AppendDecisionOutcome =
  | 'appended'
  | 'not_found'
  | 'invalid_transition'
  | 'status_unchanged'
  /**
   * The row was not in the status the caller required (M6 review C3).
   *
   * Distinct from `invalid_transition`: the move may be legal for a human, but this caller is only
   * allowed to act on one starting state. The check runs inside the same IMMEDIATE transaction as the
   * insert, so a decision that lands between a caller's read and its write cannot be overwritten.
   */
  | 'status_changed'
  | 'actor_required'
  | 'reason_required'
  | 'invalid_status'
  | 'read_only'

export type AppendDecisionResult = {
  outcome: AppendDecisionOutcome
  decisionId?: string
  fromStatus?: IncidentStatus
  toStatus?: IncidentStatus
}

export type AppendDecisionInput = {
  incidentId: string
  toStatus: IncidentStatus
  actor: string
  reason: string
  createdAt?: number
  /**
   * Optimistic guard: apply only if the effective status is exactly this value at write time.
   *
   * The miner uses `untriaged` so it can never replace a human or R1 decision it did not see, even
   * though the generic transition table would allow `confirmed -> duplicate`.
   */
  requireFromStatus?: IncidentStatus
}

export type IncidentListItem = {
  id: string
  class: IncidentClass
  sourceKind: IncidentSourceKind
  facet: string
  hostId: string
  worktreeId: string | null
  status: IncidentStatus
  effectiveStatus: IncidentStatus
  exitCause: unknown
  fingerprint: string
  summary: string
  createdAt: number
  decisionCount: number
}

export type IncidentListResult = {
  incidents: IncidentListItem[]
  total: number
  coverage: IncidentCoverage
}

export type IncidentListOptions = {
  limit?: number
  status?: IncidentStatus
  class?: IncidentClass
}

/**
 * How many ids prune reports. Decisions outlive the row they describe (§11.5), so after a delete the
 * only way to find "why was this removed" is the id itself — but a 50k-row prune must not print 50k
 * ids, so the list is capped and its truncation is stated explicitly.
 */
export const PRUNE_ID_REPORT_LIMIT = 200

export type PruneResult = {
  dryRun: boolean
  olderThanDays: number
  cutoff: number
  /** Rows that the same call would delete (dry run) or did delete. */
  candidates: number
  deleted: number
  byStatus: Partial<Record<IncidentStatus, number>>
  /** Up to `PRUNE_ID_REPORT_LIMIT` eligible ids, so kept decisions stay locatable. */
  candidateIds: string[]
  candidateIdsTruncated: boolean
  /** Ids this run deleted (empty on a dry run). */
  deletedIds: string[]
  deletedIdsTruncated: boolean
}

export type PruneOptions = {
  dryRun?: boolean
  olderThanDays?: number
  now?: number
  /** Test seam; production callers keep the default. */
  idReportLimit?: number
}

export type IncidentStore = {
  insertIncident: (record: IncidentRecord) => InsertIncidentResult
  appendDecision: (input: AppendDecisionInput) => AppendDecisionResult
  getIncident: (id: string) => IncidentView | null
  listIncidents: (options?: IncidentListOptions) => IncidentListResult
  coverage: () => IncidentCoverage
  countIncidents: () => number
  pruneIncidents: (options?: PruneOptions) => PruneResult
  readonly readOnly: boolean
}

export type CreateIncidentStoreOptions = {
  db: Database.Database
  fileSizeBytes?: () => number
  limits?: Partial<IncidentStoreLimits>
  readOnly?: boolean
  /** Injectable clock so retention and ordering are testable. */
  now?: () => number
  /** Injectable id minting for deterministic tests. */
  idFactory?: (prefix: 'inc' | 'dec') => string
}

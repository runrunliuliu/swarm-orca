// `orca incident export`: the machine seam between the store and an agent-side triage skill
// (issue-sedimentation m8-subtraction.md §5).
//
// This module contains no judgement. It selects rows from `incident_triage_rows` and parses the two
// JSON columns; clustering, thresholds, candidate rules and tool-error normalisation deliberately
// live outside the main process (M8-1..M8-3). Keeping the projection in the database means the same
// shape is available to a documented SQL read, so the CLI and a skill cannot disagree about a row.
//
// Bounded by construction: a hard `--limit` and a window filter, with the truncation stated in the
// `end` record rather than applied quietly. Coverage is part of the payload for the reason the whole
// feature exists: an empty window plus an incomplete store is not "nothing happened".

import type Database from '../sqlite/sync-database'
import type {
  IncidentClass,
  IncidentCoverage,
  IncidentEvidence,
  IncidentSourceKind,
  IncidentStatus
} from './incident-types'
import { parseEvidence, parseExitCause, type IncidentRow } from './incident-store-rows'
import {
  readEvidenceArchiveState,
  summarizeArchive,
  type ArchiveSummary,
  type EvidenceArchiveRow
} from './incident-archive'

/** Bump only when a column's meaning changes; the row set is the view's, not this module's. */
export const INCIDENT_EXPORT_VERSION = 1
export const INCIDENT_EXPORT_VIEW = 'incident_triage_rows'
export const DEFAULT_EXPORT_LIMIT = 2000
export const MAX_EXPORT_LIMIT = 20_000
export const DEFAULT_EXPORT_WINDOW_MS = 24 * 60 * 60 * 1000

/** `24h` / `7d` / `90m` / `3600s`; null for anything unrecognised (the caller turns that into an error). */
export function parseExportWindow(value: string): number | null {
  const match = /^(\d{1,5})([smhd])$/.exec(value.trim())
  if (!match) {
    return null
  }
  const amount = Number(match[1])
  const unit = match[2]
  const unitMs = unit === 's' ? 1_000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000
  return amount * unitMs
}

export function clampExportLimit(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_EXPORT_LIMIT
  }
  return Math.max(1, Math.min(Math.floor(value), MAX_EXPORT_LIMIT))
}

/** One incident as the export prints it. Every field comes from a stored column; none is computed. */
export type IncidentExportRow = {
  id: string
  sourceKind: IncidentSourceKind
  sourceId: string
  facet: string
  hostId: string
  worktreeId: string | null
  runId: string | null
  taskId: string | null
  dispatchId: string | null
  agentSessionId: string | null
  ptyIncarnationId: string | null
  class: IncidentClass
  /** Entry status (the immutable column). `effectiveStatus` is the projection. */
  status: IncidentStatus
  effectiveStatus: IncidentStatus
  exitCause: unknown
  fingerprint: string
  evidence: IncidentEvidence
  summary: string
  createdAt: number
  decisionCount: number
  lastDecisionAt: number | null
  /** Latest archive state per evidence pointer. `durable` is true only when every pointer is archived. */
  archive: ArchiveSummary
}

export type IncidentExport = {
  rows: IncidentExportRow[]
  /** True when the limit cut the window; `total` then describes the whole window, not `rows`. */
  truncated: boolean
  total: number
  since: number
  windowMs: number
  coverage: IncidentCoverage
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function rowToExport(row: IncidentRow, archiveStates: readonly EvidenceArchiveRow[]): IncidentExportRow {
  return {
    id: String(row.id),
    sourceKind: row.source_kind as IncidentSourceKind,
    sourceId: String(row.source_id),
    facet: String(row.facet),
    hostId: String(row.host_id),
    worktreeId: text(row.worktree_id),
    runId: text(row.run_id),
    taskId: text(row.task_id),
    dispatchId: text(row.dispatch_id),
    agentSessionId: text(row.agent_session_id),
    ptyIncarnationId: text(row.pty_incarnation_id),
    class: row.class as IncidentClass,
    status: row.status as IncidentStatus,
    effectiveStatus: String(row.effective_status) as IncidentStatus,
    exitCause: parseExitCause(row.exit_cause),
    fingerprint: String(row.fingerprint),
    evidence: parseEvidence(row.evidence),
    summary: String(row.summary),
    createdAt: Number(row.created_at),
    decisionCount: Number(row.decision_count ?? 0),
    lastDecisionAt: row.last_decision_at === null ? null : Number(row.last_decision_at),
    archive: summarizeArchive(archiveStates)
  }
}

export function readIncidentExport(
  db: Database.Database,
  options: { now: number; windowMs?: number; limit?: number; coverage: IncidentCoverage }
): IncidentExport {
  const windowMs = options.windowMs ?? DEFAULT_EXPORT_WINDOW_MS
  const since = options.now - windowMs
  const limit = clampExportLimit(options.limit ?? DEFAULT_EXPORT_LIMIT)
  // One extra row decides `truncated` without a second full scan of the window.
  const rows = db
    .prepare(
      `SELECT * FROM ${INCIDENT_EXPORT_VIEW}
        WHERE created_at >= ?
        ORDER BY created_at DESC, id ASC
        LIMIT ?`
    )
    .all(since, limit + 1) as IncidentRow[]
  const truncated = rows.length > limit
  const visible = truncated ? rows.slice(0, limit) : rows
  const total = Number(
    (
      db
        .prepare(`SELECT COUNT(*) AS n FROM ${INCIDENT_EXPORT_VIEW} WHERE created_at >= ?`)
        .get(since) as { n?: number } | undefined
    )?.n ?? 0
  )
  const archiveByIncident = new Map<string, EvidenceArchiveRow[]>()
  for (const state of readEvidenceArchiveState(db)) {
    const list = archiveByIncident.get(state.incidentId)
    if (list === undefined) {
      archiveByIncident.set(state.incidentId, [state])
    } else {
      list.push(state)
    }
  }
  return {
    rows: visible.map((row) =>
      rowToExport(row, archiveByIncident.get(String(row.id)) ?? [])
    ),
    truncated,
    total,
    since,
    windowMs,
    coverage: options.coverage
  }
}

// The incident store: insert, decide, read (§6, §11.5).
//
// Invariants this file is responsible for:
//   * one row per `(source_kind, source_id, facet)` — repeats are no-ops, not duplicates (§6.2.1);
//   * nothing mutates an incident row: status lives in an append-only decision log (§6.2);
//   * the summary is redacted before it lands, and evidence is pointers only (§6.3);
//   * capacity stops the *noise*, never a crash, and the stop stays visible in the read model;
//   * the store is not a fact source — no settlement, authorization or retry path may consult it.
//
// Capacity, prune and row mapping live in their own modules; this one only assembles the surface and
// owns the two write paths.

import { randomUUID } from 'node:crypto'
import { redactString } from '../observability/redactor'
import { sanitizeIncidentRecord } from './incident-sanitize'
import {
  canTransition,
  isIncidentClass,
  isIncidentStatus,
  type IncidentRecord,
  type IncidentStatus,
  type IncidentView
} from './incident-types'
import {
  DEFAULT_INCIDENT_STORE_LIMITS,
  type AppendDecisionInput,
  type AppendDecisionResult,
  type CreateIncidentStoreOptions,
  type IncidentListItem,
  type IncidentListOptions,
  type IncidentListResult,
  type IncidentStore,
  type InsertIncidentResult
} from './incident-store-contract'
import { createCapacityGate } from './incident-store-capacity'
import { emitIncidentStoreChange } from './incident-store-changes'
import { pruneIncidents } from './incident-store-prune'
import {
  rowToDecision,
  rowToRecord,
  SELECT_COLUMNS,
  SELECT_COLUMN_LIST,
  type IncidentRow
} from './incident-store-rows'

export * from './incident-store-contract'

const MAX_SUMMARY_CHARS = 2000
const MAX_LIMIT = 1000
const DEFAULT_LIMIT = 50

function defaultIdFactory(prefix: 'inc' | 'dec'): string {
  return `${prefix}_${Date.now().toString(36)}_${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

export function createIncidentStore(options: CreateIncidentStoreOptions): IncidentStore {
  const { db } = options
  const limits = { ...DEFAULT_INCIDENT_STORE_LIMITS, ...options.limits }
  const readOnly = options.readOnly ?? false
  const now = options.now ?? (() => Date.now())
  const idFactory = options.idFactory ?? defaultIdFactory

  /**
   * One IMMEDIATE transaction whose COMMIT sits inside the failure boundary: SQLite can leave a
   * transaction open after a failed COMMIT, and this connection is shared with the caller.
   */
  function runImmediate<T>(run: () => T): T {
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = run()
      db.exec('COMMIT')
      return result
    } catch (error) {
      if (db.isTransaction) {
        try {
          db.exec('ROLLBACK')
        } catch {
          // The original error is what the caller needs.
        }
      }
      throw error
    }
  }

  const capacity = createCapacityGate({
    db,
    limits,
    fileSizeBytes: options.fileSizeBytes ?? (() => 0),
    runImmediate
  })

  function countIncidents(): number {
    const row = db.prepare('SELECT COUNT(*) AS n FROM incidents').get()
    return row ? Number(row.n ?? 0) : 0
  }

  function effectiveStatusOf(incidentId: string): IncidentStatus | null {
    const row = db.prepare('SELECT status FROM incident_state WHERE incident_id = ?').get(incidentId)
    return row ? (String(row.status) as IncidentStatus) : null
  }

  function insertIncident(record: IncidentRecord): InsertIncidentResult {
    if (readOnly) {
      return { outcome: 'read_only', id: null }
    }
    if (
      !isIncidentClass(record.class) ||
      !isIncidentStatus(record.status) ||
      record.id.length === 0 ||
      record.sourceId.length === 0 ||
      record.facet.length === 0
    ) {
      return { outcome: 'invalid_record', id: null, reason: 'invalid_incident_record' }
    }
    // M2-C2: one sanitize pass before anything lands, so repro/boundary/path fields cannot smuggle a
    // secret just because the writer forgot.
    const safe = sanitizeIncidentRecord(record)
    const state = capacity.state()
    if (state.limitedBy !== null && record.class !== 'crash') {
      // §11.5: noise stops first; a crash row is still worth its bytes.
      capacity.latch()
      return { outcome: 'capacity_limited', id: null, limitedBy: state.limitedBy }
    }
    let inserted = false
    try {
      const result = db
        .prepare(
          `INSERT INTO incidents (id, source_kind, source_id, facet, host_id, worktree_id, run_id,
             task_id, dispatch_id, agent_session_id, pty_incarnation_id, class, status, exit_cause,
             fingerprint, evidence, summary, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(source_kind, source_id, facet) DO NOTHING`
        )
        .run(
          record.id,
          record.sourceKind,
          record.sourceId,
          record.facet,
          record.hostId,
          record.worktreeId,
          record.runId,
          record.taskId,
          record.dispatchId,
          record.agentSessionId,
          record.ptyIncarnationId,
          record.class,
          record.status,
          safe.exitCause === null ? null : JSON.stringify(safe.exitCause),
          safe.fingerprint,
          JSON.stringify(safe.evidence),
          safe.summary,
          safe.createdAt
        )
      inserted = Number(result.changes) > 0
    } catch (error) {
      // A concurrent insert of the same key is the duplicate case, not a failure.
      if (!/UNIQUE|constraint/i.test(String(error))) {
        throw error
      }
    }
    if (inserted) {
      // A duplicate changed nothing, so only a real insert announces itself (see incident-store-changes).
      emitIncidentStoreChange({ kind: 'insert', rows: 1 })
      return { outcome: 'inserted', id: record.id }
    }
    const existing = db
      .prepare('SELECT id FROM incidents WHERE source_kind = ? AND source_id = ? AND facet = ?')
      .get(record.sourceKind, record.sourceId, record.facet)
    return { outcome: 'duplicate', id: existing ? String(existing.id) : null }
  }

  function appendDecision(input: AppendDecisionInput): AppendDecisionResult {
    if (readOnly) {
      return { outcome: 'read_only' }
    }
    if (!isIncidentStatus(input.toStatus)) {
      return { outcome: 'invalid_status' }
    }
    const actor = input.actor.trim()
    const reason = input.reason.trim()
    // §19.1: `confirmed` must name who did it; an empty actor is refused rather than invented here.
    if (actor.length === 0) {
      return { outcome: 'actor_required' }
    }
    if (reason.length === 0) {
      return { outcome: 'reason_required' }
    }
    return runImmediate(() => {
      const fromStatus = effectiveStatusOf(input.incidentId)
      if (fromStatus === null) {
        return { outcome: 'not_found' as const }
      }
      if (input.requireFromStatus !== undefined && fromStatus !== input.requireFromStatus) {
        // Checked BEFORE the transition table on purpose: a caller that may only act on one state must
        // not be described as an invalid move, and must not depend on what else the table allows.
        return { outcome: 'status_changed' as const, fromStatus, toStatus: input.toStatus }
      }
      if (fromStatus === input.toStatus) {
        return { outcome: 'status_unchanged' as const, fromStatus, toStatus: input.toStatus }
      }
      if (!canTransition(fromStatus, input.toStatus)) {
        return { outcome: 'invalid_transition' as const, fromStatus, toStatus: input.toStatus }
      }
      const decisionId = idFactory('dec')
      db.prepare(
        `INSERT INTO incident_decisions (id, incident_id, from_status, to_status, actor, reason,
           created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        decisionId,
        input.incidentId,
        fromStatus,
        input.toStatus,
        actor.slice(0, 200),
        redactString(reason).slice(0, MAX_SUMMARY_CHARS),
        input.createdAt ?? now()
      )
      // The decision only moves the *projected* status, which is exactly what the counts read.
      emitIncidentStoreChange({ kind: 'decision', rows: 1 })
      return {
        outcome: 'appended' as const,
        decisionId,
        fromStatus,
        toStatus: input.toStatus
      }
    })
  }

  function getIncident(id: string): IncidentView | null {
    const row = db.prepare(`SELECT ${SELECT_COLUMNS} FROM incidents WHERE id = ?`).get(id)
    if (!row) {
      return null
    }
    const record = rowToRecord(row)
    const decisions = db
      .prepare(
        `SELECT id, incident_id, from_status, to_status, actor, reason, created_at
         FROM incident_decisions WHERE incident_id = ? ORDER BY created_at ASC, rowid ASC`
      )
      .all(id)
      .map(rowToDecision)
    return {
      ...record,
      effectiveStatus: effectiveStatusOf(id) ?? record.status,
      decisionCount: decisions.length,
      lastDecisionAt: decisions.at(-1)?.createdAt ?? null,
      decisions
    }
  }

  function listIncidents(listOptions: IncidentListOptions = {}): IncidentListResult {
    const limit = Math.max(1, Math.min(listOptions.limit ?? DEFAULT_LIMIT, MAX_LIMIT))
    const filters: string[] = []
    const bind: string[] = []
    if (listOptions.status !== undefined) {
      filters.push('s.status = ?')
      bind.push(listOptions.status)
    }
    if (listOptions.class !== undefined) {
      filters.push('i.class = ?')
      bind.push(listOptions.class)
    }
    const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : ''
    const rows = db
      .prepare(
        `SELECT ${SELECT_COLUMN_LIST.map((column) => `i.${column}`).join(', ')},
           s.status AS effective_status, s.decision_count
         FROM incidents i JOIN incident_state s ON s.incident_id = i.id
         ${where}
         ORDER BY i.created_at DESC, i.id ASC LIMIT ?`
      )
      .all(...bind, limit)
    const incidents: IncidentListItem[] = rows.map((row: IncidentRow) => {
      const record = rowToRecord(row)
      return {
        id: record.id,
        class: record.class,
        sourceKind: record.sourceKind,
        facet: record.facet,
        hostId: record.hostId,
        worktreeId: record.worktreeId,
        agentSessionId: record.agentSessionId,
        status: record.status,
        effectiveStatus: String(row.effective_status) as IncidentStatus,
        exitCause: record.exitCause,
        fingerprint: record.fingerprint,
        summary: record.summary,
        createdAt: record.createdAt,
        decisionCount: Number(row.decision_count ?? 0)
      }
    })
    const totalRow = db
      .prepare(
        `SELECT COUNT(*) AS n FROM incidents i JOIN incident_state s ON s.incident_id = i.id ${where}`
      )
      .get(...bind)
    return {
      incidents,
      total: totalRow ? Number(totalRow.n ?? 0) : 0,
      coverage: capacity.coverage()
    }
  }

  return {
    insertIncident,
    appendDecision,
    getIncident,
    listIncidents,
    coverage: capacity.coverage,
    countIncidents,
    pruneIncidents: (requested) => {
      const result = pruneIncidents({ db, readOnly, now, runImmediate, requested })
      // A dry run and a zero-row prune both leave the store exactly as it was: nothing to announce.
      if (!result.dryRun && result.deleted > 0) {
        emitIncidentStoreChange({ kind: 'prune', rows: result.deleted })
      }
      return result
    },
    readOnly
  }
}

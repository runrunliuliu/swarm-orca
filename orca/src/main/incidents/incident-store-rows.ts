// Row ↔ object mapping for the incident store (§6.2).
//
// Kept apart from the store's behaviour so a column list and a JSON body parser cannot be mistaken
// for policy, and so the read path and the write path agree on exactly one mapping.

import type { IncidentClass, IncidentDecision, IncidentEvidence, IncidentRecord, IncidentSourceKind, IncidentStatus } from './incident-types'

/** Named so a projection can prefix each column without re-parsing a SQL string. */
export const SELECT_COLUMN_LIST = [
  'id',
  'source_kind',
  'source_id',
  'facet',
  'host_id',
  'worktree_id',
  'run_id',
  'task_id',
  'dispatch_id',
  'agent_session_id',
  'pty_incarnation_id',
  'class',
  'status',
  'exit_cause',
  'fingerprint',
  'evidence',
  'summary',
  'created_at'
] as const

export const SELECT_COLUMNS = SELECT_COLUMN_LIST.join(', ')

export type IncidentRow = Record<string, unknown>

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

export function parseExitCause(value: unknown): IncidentRecord['exitCause'] {
  if (typeof value !== 'string' || value.length === 0) {
    return null
  }
  try {
    return JSON.parse(value) as IncidentRecord['exitCause']
  } catch {
    return null
  }
}

export function parseEvidence(value: unknown): IncidentEvidence {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      if (typeof parsed === 'object' && parsed !== null) {
        const record = parsed as Record<string, unknown>
        const pointers = Array.isArray(record.pointers) ? record.pointers : []
        const unknownBoundaries = Array.isArray(record.unknownBoundaries)
          ? record.unknownBoundaries.filter((entry): entry is string => typeof entry === 'string')
          : []
        return {
          pointers: pointers as IncidentEvidence['pointers'],
          unknownBoundaries,
          ...(typeof record.agentIdentityDigest === 'string'
            ? { agentIdentityDigest: record.agentIdentityDigest }
            : {})
        }
      }
    } catch {
      // A truncated or hand-edited body must not make the whole row unreadable.
    }
  }
  return { pointers: [], unknownBoundaries: [] }
}

export function rowToRecord(row: IncidentRow): IncidentRecord {
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
    exitCause: parseExitCause(row.exit_cause),
    fingerprint: String(row.fingerprint),
    evidence: parseEvidence(row.evidence),
    summary: String(row.summary),
    createdAt: Number(row.created_at)
  }
}

export function rowToDecision(row: IncidentRow): IncidentDecision {
  return {
    id: String(row.id),
    incidentId: String(row.incident_id),
    fromStatus: row.from_status as IncidentStatus,
    toStatus: row.to_status as IncidentStatus,
    actor: String(row.actor),
    reason: String(row.reason),
    createdAt: Number(row.created_at)
  }
}

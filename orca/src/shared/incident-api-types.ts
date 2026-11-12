// Shared incident read-model shapes (issue-sedimentation.md v2.3 §12, M2).
//
// These are the wire shapes for the IPC/preload surface, and they mirror what the CLI already
// prints: a list item, a detail view with its decisions, and the coverage gaps. Keeping one shape
// for both surfaces is what stops `orca incident list` and any future UI from disagreeing about
// what "currently limited" means.
//
// They are intentionally not the store's row types: the store's `IncidentRecord` is an internal
// shape with fields the UI must never rely on, and importing it into shared code would drag the
// SQLite layer into the renderer build graph.

export type IncidentClassDto =
  | 'crash'
  | 'no_progress'
  | 'tool_error'
  | 'acceptance_failed'
  | 'unknown_state'

export type IncidentStatusDto =
  | 'untriaged'
  | 'confirmed'
  | 'duplicate'
  | 'invalid'
  | 'watch'
  | 'needs_archive'
  | 'acceptance_pending'
  | 'closed'

/** The replay's own state (M2-C4): an unfinished replay is not "no incidents". */
export type IncidentShadowReplayDto = {
  lastSeq: number
  incomplete: boolean
  lastStopReason: string | null
  failures: number
  lastError: string | null
  dropped: number
  lastDroppedReason: string | null
  lastRun: { lines: number; bytes: number; ms: number } | null
}

/** §11.5: never collapse these two into one boolean again. */
export type IncidentCoverageDto = {
  remoteIncidentCapture: 'unsupported'
  /** This host's store has refused a write at some point; history, not a current fault. */
  capacityLatchSet: boolean
  /** A write right now would be refused. */
  currentlyLimited: boolean
  capacity: {
    rows: number
    bytes: number
    maxRows: number
    maxBytes: number
  }
  shadowReplay: IncidentShadowReplayDto
}

export type IncidentEvidencePointerDto = {
  kind: 'transcript' | 'status_snapshot' | 'events' | 'command_output' | 'other'
  path: string
  sha256?: string
  bytes?: number
  startOffset?: number
  endOffset?: number
  lineWindow?: number
  truncated?: boolean
}

export type IncidentEvidenceDto = {
  pointers: IncidentEvidencePointerDto[]
  unknownBoundaries: string[]
  agentIdentityDigest?: string
  code?: string
  repro?: string
}

export type IncidentDecisionDto = {
  id: string
  incidentId: string
  fromStatus: IncidentStatusDto
  toStatus: IncidentStatusDto
  actor: string
  reason: string
  createdAt: number
}

export type IncidentListItemDto = {
  id: string
  class: IncidentClassDto
  sourceKind: string
  facet: string
  hostId: string
  worktreeId: string | null
  /** Entry status (the immutable row's value). */
  status: IncidentStatusDto
  /** Projected from the decision log; what the UI shows. */
  effectiveStatus: IncidentStatusDto
  exitCause: unknown
  fingerprint: string
  summary: string
  createdAt: number
  decisionCount: number
}

export type IncidentDetailDto = {
  id: string
  sourceKind: string
  sourceId: string
  facet: string
  hostId: string
  worktreeId: string | null
  runId: string | null
  taskId: string | null
  dispatchId: string | null
  agentSessionId: string | null
  ptyIncarnationId: string | null
  class: IncidentClassDto
  status: IncidentStatusDto
  effectiveStatus: IncidentStatusDto
  exitCause: unknown
  fingerprint: string
  evidence: IncidentEvidenceDto
  summary: string
  createdAt: number
  decisionCount: number
  lastDecisionAt: number | null
  decisions: IncidentDecisionDto[]
}

export type IncidentListRequest = {
  limit?: number
  status?: IncidentStatusDto
  class?: IncidentClassDto
}

export type IncidentSnapshotDto = {
  incidents: IncidentListItemDto[]
  total: number
  coverage: IncidentCoverageDto
}

export type IncidentDetailRequest = { incidentId: string }

export type IncidentDecideRequest = {
  incidentId: string
  toStatus: IncidentStatusDto
  /** Self-reported and unverified (§19.1). Required for `confirmed`, optional otherwise. */
  actor?: string
  reason: string
}

export type IncidentDecideResultDto = {
  outcome: 'appended'
  incidentId: string
  decisionId: string
  fromStatus: IncidentStatusDto
  toStatus: IncidentStatusDto
  actor: string
}

export type IncidentDecideFailureDto = {
  outcome:
    | 'not_found'
    | 'invalid_transition'
    | 'status_unchanged'
    | 'actor_required'
    | 'reason_required'
    | 'invalid_status'
    | 'read_only'
  detail: string
}

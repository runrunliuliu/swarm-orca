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
  | 'acceptance_overridden'
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

/** The pane-clock sampler's last pass (M8-2). Facts only: no threshold and no verdict. */
export type IncidentPaneClockDto = {
  sampledAt: number | null
  panes: number
  declaredWaits: number
  /** Observations skipped because the epoch was not a finite number. Counted, never written as 0. */
  skipped: number
  errors: number
  lastError: string | null
}

/**
 * The remote mirror's own coverage (M7-C read model; consumed, never computed here).
 *
 * `capture` is the mirror's answer about *this* host's view of the peer's incidents, which is a
 * different claim from `remoteIncidentCapture: 'unsupported'` (that one says the peer's own facts are
 * never captured locally). Keeping them apart means a mirrored deployment does not have to rewrite
 * the permanent-scope line, and an unprobed mirror cannot be rendered as "mirrored".
 *
 * Optional on purpose: absence means "this build/host has no mirror read", which a reader must treat
 * as *not reported*, never as "nothing is missing".
 */
export type IncidentRemoteMirrorDto = {
  capture: 'unsupported' | 'not_probed' | 'mirrored'
  /**
   * Incidents the mirror knows about but has not synchronised yet.
   *
   * `null` is "the mirror never stated a count", which is not zero: §11.5's rule for every other
   * coverage fact applies here too. A monitored mirror whose count is unstated is incomplete (the
   * peer may be behind and we cannot say by how much), never "caught up".
   */
  unsynced: number | null
  /**
   * Whether this host has ever mirrored successfully, or the user explicitly put the peer in the
   * monitored scope. A remote gap only counts when this is true: a peer that was never set up is
   * "not configured", not "broken".
   */
  monitored?: boolean
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
  paneClock: IncidentPaneClockDto
  /**
   * Remote-mirror coverage, when the host has a mirror read (M7-C). Absent = not reported by this
   * build; the renderer prints it as a stated fact and does not fold it into `currentlyLimited`.
   */
  remoteMirror?: IncidentRemoteMirrorDto
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
  /**
   * The agent session this row was observed from, when the source carried one (M7-B). The list needs
   * it for the `agent` column: a crash row without it is a pane-level fact, not an agent fact, and
   * the panel says so rather than inventing a name.
   */
  agentSessionId: string | null
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

/**
 * The badge's whole input (§12, M7-A): how many rows are still untriaged, how they split, and whether
 * that number is trustworthy right now.
 *
 * Two rules shaped this shape:
 *   * `untriaged` is a *floor*, not a total, whenever `coverage.gap` is true — a stopped write path and
 *     an empty store must never look the same (§11.5);
 *   * `byClass` and `byWorktree` break down the same untriaged set, so a badge, the panel and the CLI
 *     cannot disagree about what "3 untriaged" means.
 */
export type IncidentCountsDto = {
  /** Rows whose effective status is `untriaged`. Always equal to the sum of `byClass`. */
  untriaged: number
  /** Every row in this host's store, whatever its status. */
  total: number
  /** Untriaged per class; every class key is present, so a caller never has to test for absence. */
  byClass: Record<IncidentClassDto, number>
  /**
   * Untriaged per worktree, biggest first, at most `IncidentCountsRequest.topWorktrees` entries.
   * Rows with no worktree binding are counted in `untriaged` but are not listed here.
   */
  byWorktree: IncidentWorktreeCountDto[]
  coverage: IncidentCoverageSummaryDto
  /** When this reading was taken (ms since epoch). */
  readAt: number
}

export type IncidentWorktreeCountDto = {
  worktreeId: string
  untriaged: number
}

/**
 * The coverage facts a count depends on, and nothing else (§11.5).
 *
 * `gap` is the one field a badge should branch on: is the *local* count complete? It includes
 * `currentlyLimited`, an unfinished shadow replay, and `capacityLatchSet` — a past refusal still means
 * rows may be missing, so it is a lower-bound fact, not cosmetics. `remoteIncidentCapture` and the
 * mirror stay out of it: a remote hole is graded separately (secondary) because it says the global
 * view is incomplete, not that this host's own count is doubtful.
 */
export type IncidentCoverageSummaryDto = {
  /** A write right now would be refused, so new incidents are not being recorded. */
  currentlyLimited: boolean
  /** This host's store refused a write at some point. History, not a current fault. */
  capacityLatchSet: boolean
  /** The shadow replay did not reach the end, so hint lines may not have landed yet. */
  shadowReplayIncomplete: boolean
  /** Hint lines the replay dropped for capacity; those incidents will never appear. */
  shadowReplayDropped: number
  /** Counts are this host's only; SSH/WSL incidents are not captured (never will be). */
  remoteIncidentCapture: 'unsupported'
  /** Any *current* hole above: render `untriaged` as a lower bound. Local holes only. */
  gap: boolean
  /**
   * Remote-mirror coverage, when the host reports it (M7-C). Never folded into `gap`: a remote hole
   * means the global picture is incomplete, not that this host's own records are in doubt.
   */
  remoteMirror?: IncidentRemoteMirrorDto
}

export type IncidentCountsRequest = {
  /** How many worktrees `byWorktree` may list. Bounded by the main process. */
  topWorktrees?: number
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
    /** The row was not in the status this caller required (M6 review C3). */
    | 'status_changed'
    | 'actor_required'
    | 'reason_required'
    | 'invalid_status'
    | 'read_only'
  detail: string
}

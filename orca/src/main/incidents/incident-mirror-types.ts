// Vocabulary for the remote incident mirror (issue-sedimentation.md §11.1, M7-C).
//
// WHY THIS FILE EXISTS SEPARATELY
// The mirror is a new read-model axis, and M7-C was deliberately not allowed to edit the shared
// coverage/DTO types while another agent worked on the same surface. So every new type lives here, and
// the wiring landed at merge time as one registration call (see the block at the bottom of this file for
// where it attaches and what it must not touch). `orca incident mirror --json` remains the authoritative
// row-level read of this axis; the coarse `remote_incident_capture` field on `incident list` keeps its M1
// value, because that field is a permanent scope statement, not the mirror's state.
//
// THE BOUNDARY
//   * the host that holds the PTY writes its own incident facts (§11.1). Its store and its own shadow
//     NDJSON are the fact;
//   * this host only *mirrors* what the origin exported. It never invents a remote fact, never files
//     one host's record under another host's id, and never rewrites the origin's `host_id` to itself
//     — the incident row always carries the origin's `host_id`, so the store stays partitioned by
//     origin;
//   * the only facts this client asserts on its own are facts about the *link*: "connection
//     unavailable", "cursor is here", "the last probe failed", "origin says N rows are still
//     unmirrored". Those live in `incident_mirror_links` and are what `readIncidentMirrorCoverage`
//     reports — never a fabricated incident row.

/**
 * Where a mirrored row came from.
 *
 * The incident row's `host_id` answers "whose fact is this"; this answers "which link delivered it".
 * They are usually equal, and they are allowed to differ: two origins can export the same fact.
 */
export type MirrorProvenance = {
  incidentId: string
  /** The origin whose feed delivered this row. */
  hostId: string
  /** The origin's monotonic export position (`seq`) when it was pulled. */
  originSeq: number
  pulledAt: number
}

/**
 * The three-state answer the read model must not flatten (§11.1).
 *
 *   * `unsupported` — no origin host is registered with this store. Nothing about any remote host is
 *     captured here, and the read model says so instead of implying a quiet week;
 *   * `not_probed` — at least one origin is registered but no pull has ever completed. This is
 *     "unknown", never "nothing happened";
 *   * `mirrored` — at least one origin has been read to a cursor. A host that has since become
 *     unreachable is still `mirrored` and shows up as an error plus a retained `unsynced` count.
 *
 * Derived, never stored: an empty link table is `unsupported`, a link table with no successful probe
 * is `not_probed`, and only a real `last_success_at` makes it `mirrored`.
 */
export type MirrorCaptureState = 'unsupported' | 'not_probed' | 'mirrored'

export type MirrorHostCoverage = {
  hostId: string
  state: 'not_probed' | 'mirrored'
  /** The origin seq this link has applied up to. */
  lastCursor: number
  firstProbeAt: number | null
  lastProbeAt: number | null
  lastSuccessAt: number | null
  lastError: string | null
  failureCount: number
  /**
   * Origin-stated rows still past the cursor, kept from the last time the origin spoke. NULL means
   * nobody said — it is never rendered as 0 (§11.5: missing evidence is not zero).
   */
  unsynced: number | null
  unsyncedAsOf: number | null
  /** Rows this link inserted, cumulatively (includes rows later pruned). */
  mirroredRows: number
  /** Rows this link re-offered that were already here. */
  duplicateRows: number
  /** Rows refused because this host already owned the fact key (one fact, one row). */
  rejectedRows: number
  /** Rows that were mirrored before and pruned locally; not resurrected. */
  prunedRows: number
  /** Non-crash rows the capacity gate refused; counted on the link, not inserted. */
  droppedRows: number
  lastRejectedReason: string | null
  /** Rows currently in this store with provenance from this host. */
  rowsPresent: number
  /**
   * Rows the origin declared it did not export, and how many such ranges it declared (C3). A range
   * the origin did not explain is never skipped: the pull stops instead (`page_mismatch`).
   */
  skippedRows: number
  skippedRanges: number
  lastSkippedReason: string | null
  lastRun: { lines: number; ms: number } | null
}

export type MirrorCoverage = {
  capture: MirrorCaptureState
  hosts: MirrorHostCoverage[]
  /** Sum over hosts; NULL when any registered host's count is unknown. */
  unsynced: number | null
  unsyncedAsOf: number | null
  /** Hosts whose most recent probe failed. */
  unreachable: number
  /** Rows refused across hosts (see the per-host reasons). */
  rejected: number
  /** Rows a previous mirror had, then an operator pruned; never resurrected. */
  pruned: number
  /** Newest probe error across hosts, for a one-line read. */
  lastError: string | null
  /** Rows currently in this store with mirror provenance, any host. */
  mirroredRowsPresent: number
  /** Rows origins declared they did not export (see the per-host reasons). */
  skippedRows: number
  /**
   * Fact keys with more than one provenance row. Non-zero means the provenance table predates its
   * UNIQUE constraint or was edited outside this code; writes for such a key fail-stop (C2).
   */
  provenanceConflicts: number
}

/** What one mirrored insert produced. Every outcome is countable and visible; none is a silent skip. */
export type MirrorInsertOutcome =
  | 'inserted'
  /** This link (or another origin) already delivered this exact fact. */
  | 'duplicate'
  /** Same fact key, but the row here was observed on this host. One fact, one row; refused. */
  | 'local_owner_conflict'
  /** Mirrored before, then pruned by an operator: a mirror must not undo a triage deletion. */
  | 'pruned_locally'
  /** The feed offered a record whose `host_id` is not this feed's host. Refused, not re-filed. */
  | 'host_mismatch'
  | 'capacity_limited'
  | 'read_only'
  | 'invalid_record'
  /**
   * The incident row was written but its provenance row was not. Visible instead of silent: the sync
   * stops without advancing, and the next pull recognises the row by its origin `host_id` and heals
   * the provenance (see `insertMirroredIncident`).
   */
  | 'provenance_failed'
  /**
   * Two provenance rows already exist for one fact key (C2). That cannot happen on a healthy store —
   * the key is UNIQUE — so it means the file was written by a build that lacked the constraint or was
   * edited outside this code. Reported, never guessed at: the pull stops instead of picking a row.
   */
  | 'provenance_conflict'

export type MirrorInsertResult = {
  outcome: MirrorInsertOutcome
  /** The row's id when it exists (`inserted`, or the row that already held the key). */
  id: string | null
  /** Which link first delivered the fact, when the answer is `duplicate`. */
  mirroredByHostId?: string | null
  /** The origin seq of the first delivery, when the answer is `duplicate`/`pruned_locally`. */
  existingOriginSeq?: number | null
  limitedBy?: 'rows' | 'bytes'
  reason?: string
}

/*
 * ── Where the mirror axis attaches, and where it must not ─────────────────────────────────────────
 *
 * M7-C could not edit the shared coverage/IPC surface, so the mirror is read through
 * `readIncidentMirrorCoverage(db)` and attached by the merge seam
 * (`main/ipc/incident-mirror-coverage.ts` + `incident-mirror-coverage-install.ts`, registered once from
 * `main/startup/main-process-ready-foundation.ts`). That is the ONE wiring, and it keeps two questions
 * apart:
 *
 *   * LOCAL coverage (`IncidentCoverage`, `IncidentCoverageSummaryDto.gap`): the capacity latch, a
 *     current refusal, an unfinished shadow replay. These make `untriaged` a lower bound on *this* host,
 *     and they own the badge's tone.
 *   * REMOTE coverage (`IncidentRemoteMirrorDto`, `coverage.remoteMirror`): `capture`, `unsynced`,
 *     `monitored`. Attached beside the local facts and graded as a secondary hint.
 *
 * A remote hole is NEVER folded into `coverage.gap` and NEVER changes `untriaged`. An earlier draft of
 * this checklist recommended the opposite ("`gap` should include the remote hole, with `remoteGap` as
 * the explanation"); that was rejected because `gap` is the answer to "is this host's own count
 * complete?", and an unreachable peer says nothing about this host's records. Folding it in would make
 * every deployment with one configured peer permanently amber, teach people to ignore the tone, and
 * hand the badge a number it cannot justify. Two facts, two fields: the mirror's own `capture` and
 * `unsynced` are the explanation, so no second boolean is needed.
 *
 * Also not part of the seam: `IncidentCoverage.remoteIncidentCapture` keeps its M1 value
 * (`'unsupported'`) as a permanent scope statement — "this host never captures a peer's own facts" —
 * which stays true whether or not a mirror is wired. Widening it to `MirrorCaptureState` would give the
 * same word two meanings, so the mirror's state lives only on `remoteMirror.capture`.
 *
 * The row-level detail (per-host cursors, failure counts, rejected/pruned/skipped rows) stays on
 * `orca incident mirror --json`: a badge input must not become a second mirror read model.
 */

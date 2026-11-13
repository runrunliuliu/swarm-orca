// Vocabulary for the remote incident mirror (issue-sedimentation.md §11.1, M7-C).
//
// WHY THIS FILE EXISTS SEPARATELY
// The mirror is a new read-model axis, and M7-C is deliberately not allowed to edit the shared
// coverage/DTO types while another agent works on the same surface. So every new type lives here and
// the wiring is a single line the integrator adds (see the block at the bottom of this file). Until
// that line lands, `orca incident mirror --json` is the authoritative read of this axis; the coarse
// `remote_incident_capture` field on `incident list` keeps its M1 value.
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

/**
 * `remoteIncidentCapture` and `remoteMirror` as the coverage object should carry them.
 *
 * MIRROR TYPES ARE ADDITIVE ON PURPOSE: a consumer that only knows `capture` keeps working, and a
 * consumer that wants the detail reads `remoteMirror.hosts`.
 */
export type MirrorCoverageFields = {
  remoteIncidentCapture: MirrorCaptureState
  remoteMirror: MirrorCoverage
}

/*
 * ── Integration checklist for the coverage wiring (NOT a one-line change) ─────────────────────────
 *
 * M7-C is not allowed to edit the shared coverage/IPC surface, so the mirror axis is read through
 * `readIncidentMirrorCoverage(db)` until the integrator wires it in. The reading itself is one call;
 * the type/plumbing changes around it are several, and they must land together or not at all:
 *
 *   1. `src/main/incidents/incident-store-capacity.ts` in `coverage()`:
 *          const remote = readIncidentMirrorCoverage(db)      // + import
 *          return { remoteIncidentCapture: remote.capture, remoteMirror: remote, ... }
 *   2. `IncidentCoverage` (`incident-types.ts`): widen `remoteIncidentCapture` to
 *      `MirrorCaptureState` and add `remoteMirror: MirrorCoverage`.
 *   3. `IncidentCoverageDto` + `IncidentCoverageSummaryDto` (`shared/incident-api-types.ts`): mirror
 *      those two fields; the summary needs `remoteUnsynced`/`remoteUnreachable`/`remoteGap` because
 *      `gap` alone cannot say *why* the count is a floor.
 *   4. `readIncidentCounts` (`incident-counts.ts`): pass those through and decide whether
 *      `gap` includes the remote hole. Recommendation: yes, with `remoteGap` as the explanation —
 *      an unreachable origin means `untriaged` is a lower bound for the combined set.
 *   5. `IncidentListItemDto`/`IncidentDetailDto` + `main/ipc/incidents.ts` if the UI must distinguish
 *      a mirrored row from a locally observed one: the row's `hostId` already differs, but a
 *      `capture` flag would not require the UI to know the local host id.
 *
 * Until step 1 lands, `incident list`'s `remote_incident_capture` keeps its M1 value even when link
 * rows exist; `orca incident mirror` is the surface that is already truthful.
 */

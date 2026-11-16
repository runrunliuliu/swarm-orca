// The seam between the panel's read models and the remote mirror's coverage read (M7-C).
//
// WHY ONE DIRECT ADAPTER
// This file imports `readIncidentMirrorCoverage` directly. An earlier version registered the reader
// from a startup hook instead, to keep this module free of the mirror import "so a build without
// remote support still renders a list". No such build target exists: the startup path installed the
// reader unconditionally, including on headless `orca serve`, so the indirection cost process-global
// mutable state, a startup ordering rule and a test-only reset while buying nothing. The import
// direction is `main/ipc -> main/incidents` (one way; nothing under `main/incidents` imports this
// module), so there is no cycle.
//
// What the old seam did buy is kept, in one line: a mirror read must never fail the list. `readIncidentRemoteMirror`
// is the ONE try/catch boundary, and it returns `undefined` — "not reported" — for any failure. All
// three readers (snapshot, explicit counts, the coalesced push) attach through it, so they cannot
// disagree about a failure, and a failed read can only ever cost the optional `remoteMirror` field.
//
// It is also why the renderer never computes this: `capture` and `unsynced` are the mirror's claims
// about its own completeness (§11.1, §11.5), and a second computation here would be a second answer.

import type Database from '../sqlite/sync-database'
import type { MirrorCoverage } from '../incidents/incident-mirror-types'
import { readIncidentMirrorCoverage } from '../incidents/incident-mirror-store'
import type { IncidentCoverage } from '../incidents/incident-types'
import type { IncidentCountsDto, IncidentRemoteMirrorDto } from '../../shared/incident-api-types'

/**
 * `MirrorCoverage` → `IncidentRemoteMirrorDto`.
 *
 * The two sides answer different questions and are deliberately not the same shape:
 *
 *   * `MirrorCoverage` is the mirror's own read model: per host cursors, failure counts,
 *     rejected/pruned/skipped rows, the last run. It is what `orca incident mirror` prints and what an
 *     operator debugs a link with.
 *   * `IncidentRemoteMirrorDto` is what a badge and a banner may branch on: three fields, no protocol
 *     details. This file is the only place both are known.
 *
 * Field by field:
 *   * `capture` — copied verbatim; both sides use the same three states and the same meaning
 *     (`unsupported` = no origin registered here, `not_probed` = registered but never read,
 *     `mirrored` = a pull reached a cursor). Copying instead of re-deriving is the point: this is the
 *     mirror's claim about its own completeness (§11.1), never a second computation.
 *   * `unsynced` — copied, including `null`. `null` is "the origin never stated a count", which is
 *     *not* zero (§11.5); the renderer treats an unstated count on a monitored mirror as incomplete
 *     rather than as caught up.
 *   * `monitored` — derived from `capture`: a link row exists for at least one origin
 *     (`not_probed`/`mirrored`), so the peer is in this host's scope. Only `unsupported` says "nothing
 *     was ever set up here", which the panel words as `not_configured` and never counts as a gap. A
 *     peer that was never configured is not broken.
 *
 * Dropped on purpose: cursors, failure counts, rejected/pruned/skipped rows, `lastRun`. A renderer that
 * wants the link's detail reads `orca incident mirror --json`; shipping protocol depth over the counts
 * channel would be a second read model to keep in sync, for no badge.
 *
 * Nothing here folds a remote hole into the local coverage verdict. `coverage.gap` stays local
 * (capacity latch, current refusal, unfinished replay) and `untriaged` keeps its local meaning; a
 * remote hole is reported beside it as `remoteMirror` and graded separately as a secondary hint. Two
 * questions, two fields: an unreachable peer says the *global* picture is incomplete, not that this
 * host's own count is doubtful.
 */
export function toIncidentRemoteMirrorDto(mirror: MirrorCoverage): IncidentRemoteMirrorDto {
  return {
    capture: mirror.capture,
    unsynced: mirror.unsynced,
    monitored: mirror.capture !== 'unsupported'
  }
}

/**
 * Read the mirror's coverage, or `undefined` when it cannot be reported.
 *
 * The only failure boundary on this seam. A throw here is a diagnostics failure, not a read-model
 * failure: the caller keeps its local coverage and its counts, and `undefined` is the DTO's own word
 * for "not reported" (never `false` or `0`, which would be a claim no mirror made).
 */
export function readIncidentRemoteMirror(
  db: Database.Database
): IncidentRemoteMirrorDto | undefined {
  try {
    return toIncidentRemoteMirrorDto(readIncidentMirrorCoverage(db))
  } catch {
    return undefined
  }
}

/**
 * Attach the mirror's coverage to the snapshot's coverage object, or return it untouched.
 *
 * One helper for all three readers (snapshot, counts, the coalesced push) so the three cannot drift:
 * a push that omitted the mirror would make a badge's secondary hint blink off between writes.
 *
 * It touches only `remoteMirror`. `gap`, `untriaged` and the local coverage fields are copied through
 * untouched — a remote hole must never re-grade the local count or the local tone.
 */
export function attachIncidentRemoteMirrorToCoverage(
  db: Database.Database,
  coverage: IncidentCoverage
): IncidentCoverage & { remoteMirror?: IncidentRemoteMirrorDto } {
  const remoteMirror = readIncidentRemoteMirror(db)
  return remoteMirror === undefined ? coverage : { ...coverage, remoteMirror }
}

/**
 * The same attachment for the counts push: `counts.coverage.remoteMirror` and nothing else.
 *
 * A second signature rather than a generic one: this destination is `IncidentCoverageSummaryDto`, not
 * the snapshot's `IncidentCoverage`, and a cast that let one stand in for the other is how the two
 * read models would start disagreeing. Both still go through the one read and the one failure
 * boundary above, so neither can start folding the mirror into `coverage.gap` or re-counting
 * `untriaged`.
 */
export function attachIncidentRemoteMirrorToCounts(
  db: Database.Database,
  counts: IncidentCountsDto
): IncidentCountsDto {
  const remoteMirror = readIncidentRemoteMirror(db)
  return remoteMirror === undefined
    ? counts
    : { ...counts, coverage: { ...counts.coverage, remoteMirror } }
}

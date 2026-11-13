// The composition point: the mirror's coverage read (M7-C) → the panel's small DTO (M7-B), registered
// once at startup (M7 merge seam).
//
// WHY AN ADAPTER AND NOT A SHARED TYPE
// The two sides answer different questions and are deliberately not the same shape:
//
//   * `MirrorCoverage` (`main/incidents/incident-mirror-types.ts`) is the mirror's own read model: per
//     host cursors, failure counts, rejected/pruned/skipped rows, the last run. It is what
//     `orca incident mirror` prints and what an operator debugs a link with.
//   * `IncidentRemoteMirrorDto` (`shared/incident-api-types.ts`) is what a badge and a banner may
//     branch on: three fields, no protocol details. The DTO does not import the mirror module, and the
//     mirror module does not import the DTO — this file is the only place both are known.
//
// `registry` (`ipc/incident-mirror-coverage.ts`) stays free of the mirror import so a build without
// remote support still renders a list; this installer is the one module that decides there *is* a
// mirror read, and it is called from the startup path, not from a snapshot.
//
// WHAT THIS ADAPTER IS NOT ALLOWED TO DO
// It never folds a remote hole into the local coverage verdict. `coverage.gap` stays local (capacity
// latch, current refusal, unfinished replay) and `untriaged` keeps its local meaning; a remote hole is
// reported beside it as `remoteMirror` and graded separately as a secondary hint. Two questions, two
// fields: an unreachable peer says the *global* picture is incomplete, not that this host's own count
// is doubtful.

import type { MirrorCoverage } from '../incidents/incident-mirror-types'
import { readIncidentMirrorCoverage } from '../incidents/incident-mirror-store'
import type { IncidentRemoteMirrorDto } from '../../shared/incident-api-types'
import { registerIncidentMirrorCoverageReader } from './incident-mirror-coverage'

/**
 * `MirrorCoverage` → `IncidentRemoteMirrorDto`.
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
 */
export function toIncidentRemoteMirrorDto(mirror: MirrorCoverage): IncidentRemoteMirrorDto {
  return {
    capture: mirror.capture,
    unsynced: mirror.unsynced,
    monitored: mirror.capture !== 'unsupported'
  }
}

/**
 * Register the real mirror read. Call once from the main-process startup path.
 *
 * Once, and not in `registerIncidentHandlers`/`readIncidentSnapshot`: the reader is host-wide state, so
 * a per-window or per-snapshot registration would be a re-registration on every read, and the headless
 * `orca serve` host (which never runs the window-only handler registration) would report no mirror at
 * all. Registration touches no database: a host with no mirror tables still answers `unsupported`, and
 * a host with no feeds never creates a store (the mirror's startup sync short-circuits first, see
 * `incidents-startup.ts`'s `no_feeds`).
 */
export function installIncidentMirrorCoverageReader(): void {
  registerIncidentMirrorCoverageReader((db) =>
    toIncidentRemoteMirrorDto(readIncidentMirrorCoverage(db))
  )
}

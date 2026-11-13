// Grading the two coverage families (§11.5, §12; M7-B, per the codex-ark/trae arbitration).
//
// The arbitration chose "count it, but grade it":
//
//   * LOCAL holes (unfinished shadow replay, capacity latch, this page's bound, a current write
//     refusal) make the *local* untriaged number a lower bound. They are primary: solid amber on the
//     badge, a warning line in the panel.
//   * REMOTE holes (no remote capture, mirror not probed, mirror unsynced rows) are secondary: the
//     local number is still exactly what it says. They get an outline marker, a quieter line, and never
//     change the badge's tone.
//   * A remote gap only counts when this host has mirrored before or the peer is explicitly in the
//     monitored scope. A peer that was never configured is `not_configured`: stated in the detail, not
//     counted as a gap.
//   * An unstated `unsynced` count on a monitored mirror is a gap, not a zero (§11.5: missing evidence
//     is not a zero).
//
// Why a separate module: the badge, the banner and the drawer must agree, and they live in three files.
// One function per question keeps the grading from being re-derived (and drifting) per surface.

import type { IncidentRemoteMirrorDto } from '../../../../../shared/incident-api-types'

export type IncidentRemoteCoverageState =
  /** No mirror read reported: say nothing. Absence is not completeness. */
  | 'absent'
  /** A peer exists in some sense but was never mirrored / never put in scope. Detail only. */
  | 'not_configured'
  /** Monitored and fully synchronised. */
  | 'complete'
  /** Monitored, and the global view is currently incomplete. Secondary gap. */
  | 'gap'

export function incidentRemoteCoverageState(
  mirror: IncidentRemoteMirrorDto | undefined
): IncidentRemoteCoverageState {
  if (mirror === undefined) {
    return 'absent'
  }
  // Never configured is not a fault: the copy says "not configured", and it is not counted.
  if (mirror.monitored !== true) {
    return 'not_configured'
  }
  if (mirror.capture !== 'mirrored') {
    return 'gap'
  }
  // An unstated count is not zero (§11.5). A monitored mirror that has not told us how far behind it is
  // leaves the global view incomplete; rendering it as `complete` would be the "caught up" claim the
  // mirror module refuses to make, arriving through the UI instead.
  if (mirror.unsynced === null) {
    return 'gap'
  }
  return mirror.unsynced > 0 ? 'gap' : 'complete'
}

/** The only question the badge asks: is the *global* view incomplete? */
export function incidentRemoteCoverageIsGap(mirror: IncidentRemoteMirrorDto | undefined): boolean {
  return incidentRemoteCoverageState(mirror) === 'gap'
}

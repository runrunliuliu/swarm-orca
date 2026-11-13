// Which coverage facts the panel states, and how they are graded (§11.5, §12; M7-B).
//
// Grading was decided outside this panel (codex-ark + trae, option C: count it, but grade it), and it
// is implemented here once so the badge, the banner and the drawer cannot disagree:
//
//   * LOCAL holes — an unfinished shadow replay, a capacity latch, this page's own bound, a current
//     write refusal — make the *local* untriaged number a lower bound. They are primary: solid amber
//     on the badge and a warning line in the panel.
//   * REMOTE holes — no remote capture, a mirror that has not been probed, unsynchronised mirror rows
//     — mean the global picture is incomplete. They are secondary: an outline marker, a quieter line,
//     and the badge tone never changes because of them.
//   * A remote hole is only a hole when this host has mirrored before or the peer is in the monitored
//     scope. A peer that was never configured is `not_configured`, which the detail renders as such
//     and which is never counted.
//
// The permanent `remoteIncidentCapture: 'unsupported'` fact therefore no longer shouts in the banner:
// it is the default state of every host without a mirror, and §11.1's requirement is that it be
// *visible*, which the drawer's Remote view section satisfies without turning a normal setup into a
// warning.

import type { IncidentCoverageDto } from '../../../../../shared/incident-api-types'
import {
  incidentRemoteCoverageIsGap,
  incidentRemoteCoverageState,
  type IncidentRemoteCoverageState
} from './incident-remote-coverage'

export type IncidentLocalCoverageGap =
  | { kind: 'currently_limited' }
  | { kind: 'replay_incomplete'; dropped: number }
  | { kind: 'capacity_latch' }
  | { kind: 'scan_truncated'; shown: number; total: number }

export type IncidentCoverageGapInput = {
  coverage: IncidentCoverageDto
  /** Rows this panel actually holds. */
  shown: number
  /** Rows the store reported for the same filter. */
  total: number
}

/**
 * The local, primary gaps, ordered by "what should I do about it": a current refusal first, then an
 * unfinished replay, then the page bound, then history.
 */
export function incidentLocalCoverageGaps(
  input: IncidentCoverageGapInput
): IncidentLocalCoverageGap[] {
  const { coverage, shown, total } = input
  const gaps: IncidentLocalCoverageGap[] = []
  if (coverage.currentlyLimited) {
    gaps.push({ kind: 'currently_limited' })
  }
  if (coverage.shadowReplay.incomplete || coverage.shadowReplay.dropped > 0) {
    gaps.push({ kind: 'replay_incomplete', dropped: coverage.shadowReplay.dropped })
  }
  if (coverage.capacityLatchSet && !coverage.currentlyLimited) {
    gaps.push({ kind: 'capacity_latch' })
  }
  if (total > shown) {
    gaps.push({ kind: 'scan_truncated', shown, total })
  }
  return gaps
}

/** True while at least one *local* gap makes the current list a lower bound rather than a total. */
export function incidentCoverageIsCurrentGap(
  gaps: readonly IncidentLocalCoverageGap[]
): boolean {
  return gaps.length > 0
}

export type IncidentRemoteCoverageLine = {
  state: Exclude<IncidentRemoteCoverageState, 'absent'>
  capture: 'unsupported' | 'not_probed' | 'mirrored'
  unsynced: number
  /** True only for `state === 'gap'`: the one case the banner may show and the badge may mark. */
  gap: boolean
}

/**
 * The single remote line, or `null` when the host has no mirror read at all.
 *
 * One line, not one per fact: the mirror reports a single capture state, and splitting it into
 * "unsupported" + "unsynced" rows would suggest two independent problems.
 */
export function incidentRemoteCoverageLine(
  coverage: IncidentCoverageDto
): IncidentRemoteCoverageLine | null {
  const mirror = coverage.remoteMirror
  const state = incidentRemoteCoverageState(mirror)
  if (mirror === undefined || state === 'absent') {
    return null
  }
  return {
    state,
    capture: mirror.capture,
    unsynced: mirror.unsynced,
    gap: incidentRemoteCoverageIsGap(mirror)
  }
}

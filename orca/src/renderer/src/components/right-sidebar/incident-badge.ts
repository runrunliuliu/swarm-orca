// The incident badge's one mapping (§12, M7-A): counts → what the activity bar draws.
//
// A pure function, matching `active-checks-status.ts`: the visual rules live where a component test
// can call them directly, and the hook (`use-incident-counts.ts`) only owns the pull/push plumbing.
//
// The rule that matters: a count taken while the store has a *current* coverage gap is drawn in amber,
// not red. Red says "this many need triage"; amber says "this many are known, and there may be more".
// A badge that always looks urgent because a replay is unfinished teaches people to ignore both.

import type { IncidentCountsDto } from '../../../../shared/incident-api-types'
import { incidentRemoteCoverageIsGap } from './incidents/incident-remote-coverage'

export type IncidentBadge = {
  count: number
  /** `alert` = red count, `caution` = amber count because *local* coverage is currently incomplete. */
  tone: 'alert' | 'caution'
  /**
   * A monitored remote view is behind (M7-C arbitration). Secondary: the count stays red and is still
   * exactly what this host recorded, so this draws an outline marker rather than changing the tone.
   */
  remoteGap: boolean
  /** Accessible/tooltip text: the number never renders without its qualifier. */
  label: string
}

/** Above this the badge shows a cap, so a 50k-row store cannot widen the activity bar. */
export const INCIDENT_BADGE_MAX_COUNT = 99

/**
 * `null` means "draw no badge": no counts yet (pull in flight or store unavailable) or nothing
 * untriaged. Zero is deliberately invisible — an activity bar that shows "0" is noise.
 */
export function incidentBadgeFromCounts(
  counts: IncidentCountsDto | null | undefined
): IncidentBadge | null {
  if (!counts || counts.untriaged <= 0) {
    return null
  }
  const tone = counts.coverage.gap ? 'caution' : 'alert'
  const capped =
    counts.untriaged > INCIDENT_BADGE_MAX_COUNT
      ? `${INCIDENT_BADGE_MAX_COUNT}+`
      : String(counts.untriaged)
  const qualifiers: string[] = []
  if (counts.coverage.gap) {
    qualifiers.push('count may be incomplete')
  } else if (counts.coverage.capacityLatchSet) {
    // History, not a current fault: stated because the number is still a lower bound, but a past
    // stop does not make today's rows doubtful the way an unfinished replay does.
    qualifiers.push('a past capacity stop may have dropped incidents')
  }
  // Secondary and additive: a remote hole never changes the local count's trustworthiness, so it is a
  // second qualifier rather than an amber tone (codex-ark/trae arbitration, option C).
  const remoteGap = incidentRemoteCoverageIsGap(counts.coverage.remoteMirror)
  if (remoteGap) {
    qualifiers.push('remote view incomplete')
  }
  return {
    count: counts.untriaged,
    tone,
    remoteGap,
    label:
      qualifiers.length === 0
        ? `${capped} untriaged`
        : `${capped} untriaged (${qualifiers.join('; ')})`
  }
}

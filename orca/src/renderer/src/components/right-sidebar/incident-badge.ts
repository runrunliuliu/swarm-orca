// The incident badge's one mapping (§12, M7-A/M7-B): counts → what the activity bar draws.
//
// A pure function, matching `active-checks-status.ts`: the visual rules live where a component test
// can call them directly, and the hook (`use-incident-counts.ts`) only owns the pull/push plumbing.
//
// The rule that matters: a count taken while the store has a *local* hole is drawn in amber, not red.
// Red says "this many need triage"; amber says "this many are known, and there may be more". A local
// hole is any fact that can make today's rows a lower bound: a current write refusal, an unfinished
// shadow replay, or a capacity latch that already refused a write (§11.5's two capacity fields are
// one hole seen at two times — the latch keeps the amber tone and only the wording changes). Remote
// holes are graded differently: they mark the global view, not this host's count, so they add an
// outline marker and a qualifier without ever re-toning the number.
//
// A badge that always looks urgent for a permanent condition teaches people to ignore both tones.

import type { IncidentCountsDto } from '../../../../shared/incident-api-types'
import { incidentRemoteCoverageIsGap } from './incidents/incident-remote-coverage'

export type IncidentBadge = {
  count: number
  /** `alert` = red count, `caution` = amber count because *local* coverage is currently incomplete. */
  tone: 'alert' | 'caution'
  /**
   * A *local* hole makes the count a lower bound: a current write refusal, an unfinished replay, or a
   * capacity latch that already dropped a write. This is what `tone` is derived from — the capacity
   * latch counts, because "the store once refused a write" is a local completeness fact, not history
   * that only deserves a footnote (§11.5's two capacity fields describe the same hole at two times).
   */
  localGap: boolean
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
  // Split the summary's single `gap` into an explicit local verdict and fold the latch in: a store
  // that has *ever* refused a write may already be missing rows, so the number is a lower bound and the
  // amber tone is correct. The two capacity fields still word themselves differently below — "is
  // refusing now" vs "a past stop may have dropped incidents" — because only the first is a live fault.
  const localGap = counts.coverage.gap || counts.coverage.capacityLatchSet
  const tone = localGap ? 'caution' : 'alert'
  const capped =
    counts.untriaged > INCIDENT_BADGE_MAX_COUNT
      ? `${INCIDENT_BADGE_MAX_COUNT}+`
      : String(counts.untriaged)
  const qualifiers: string[] = []
  if (counts.coverage.gap) {
    qualifiers.push('count may be incomplete')
  } else if (counts.coverage.capacityLatchSet) {
    // Same tone as a current hole, different wording: the latch is a past refusal, so saying "the
    // store is refusing writes right now" would be a different (and false) claim.
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
    localGap,
    remoteGap,
    label:
      qualifiers.length === 0
        ? `${capped} untriaged`
        : `${capped} untriaged (${qualifiers.join('; ')})`
  }
}

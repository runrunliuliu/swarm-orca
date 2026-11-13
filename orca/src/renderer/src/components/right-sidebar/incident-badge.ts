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
//
// FOURTH STATE, ADDED BY THE M7 PRE-MERGE REVIEW: "no data" is not "no incidents". The count is read
// asynchronously, so there are two ways to have no number — the read failed, or the number we hold is
// too old to cite — and both used to render as *nothing*, which is pixel-identical to a complete and
// empty store. `incidentBadgeFromState` therefore answers three questions instead of one: draw nothing
// (nothing has arrived yet), draw the muted unavailable/stale marker (no trustworthy number), or draw
// the count with its tone. The marker carries no digits at all: it must not be able to restate or
// contradict `untriaged`, because there is no current `untriaged` to state.

import type { IncidentCountsDto } from '../../../../shared/incident-api-types'
import { translate } from '@/i18n/i18n'
import { incidentRemoteCoverageIsGap } from './incidents/incident-remote-coverage'
import type { IncidentCountsState } from './use-incident-counts'

export type IncidentBadge = IncidentCountBadge | IncidentUnavailableBadge

export type IncidentCountBadge = {
  kind: 'count'
  count: number
  /** `alert` = red count, `caution` = amber count because *local* coverage is currently incomplete. */
  tone: 'alert' | 'caution'
  /**
   * A *local* hole makes the count a lower bound. Taken from the DTO's `gap`, which the main process
   * computes (include a live refusal, an unfinished replay and a capacity latch). The badge no longer
   * re-derives it: one question, one answer.
   */
  localGap: boolean
  /**
   * A monitored remote view is behind (M7-C arbitration). Secondary: the count stays red and is still
   * exactly what this host recorded, so this draws an outline marker rather than changing the tone.
   */
  remoteGap: boolean
  /**
   * False when the count is zero but a gap exists: there is nothing to number, yet silence would read
   * as "no incidents". The activity bar then draws an indicator with no digits.
   */
  showCount: boolean
  /** Accessible/tooltip text: the number never renders without its qualifier. */
  label: string
}

/**
 * The marker for "this badge cannot state a count": the read failed (`'unavailable'`) or the newest
 * reading is past its citable age (`'stale'`).
 *
 * No `count` field on purpose — not even `0`. A zero here would be a claim ("nothing needs triage"),
 * and the whole point of this state is that we do not know whether that is true.
 */
export type IncidentUnavailableBadge = {
  kind: 'unavailable'
  reason: 'unavailable' | 'stale'
  label: string
}

/** Above this the badge shows a cap, so a 50k-row store cannot widen the activity bar. */
export const INCIDENT_BADGE_MAX_COUNT = 99

/**
 * `null` means "draw no badge": no counts yet (pull in flight or store unavailable), or nothing
 * untriaged *and* nothing incomplete. Zero-with-a-gap is not null: it returns a badge with
 * `showCount: false`, because silence there reads as "no incidents" while the truth is "the count is
 * not complete" (the failure mode this feature exists to prevent). A permanent "0" with no gap stays
 * invisible — that really is noise.
 *
 * This is the *count* half of the answer. Readers should call `incidentBadgeFromState`, which decides
 * whether a count may be drawn at all; this function is kept separate so the visual rules for a count
 * (tones, cap, qualifiers) are one pure function that a test can call without a clock.
 */
export function incidentBadgeFromCounts(
  counts: IncidentCountsDto | null | undefined
): IncidentCountBadge | null {
  if (!counts) {
    return null
  }
  // The main process owns the verdict; the badge only consumes it. `capacityLatchSet` used to be
  // OR'd in here as well, which meant the DTO and the UI could disagree about the same fact.
  const localGap = counts.coverage.gap
  const remoteGap = incidentRemoteCoverageIsGap(counts.coverage.remoteMirror)
  if (counts.untriaged <= 0) {
    if (!localGap && !remoteGap) {
      // Zero and complete: stay silent, as before. A permanent "0" is noise.
      return null
    }
    // Zero but incomplete: an indicator with no digits, because "0" would be a false claim of
    // completeness while the label carries the caveat. Exactly the trap this project keeps banning.
    const qualifiers: string[] = []
    if (localGap) {
      qualifiers.push(
        counts.coverage.capacityLatchSet && !counts.coverage.currentlyLimited
          ? 'a past capacity stop may have dropped incidents'
          : 'count may be incomplete'
      )
    }
    if (remoteGap) {
      qualifiers.push('remote view incomplete')
    }
    return {
      kind: 'count',
      count: 0,
      tone: localGap ? 'caution' : 'alert',
      localGap,
      remoteGap,
      showCount: false,
      label: qualifiers.join('; ')
    }
  }
  const tone = localGap ? 'caution' : 'alert'
  const capped =
    counts.untriaged > INCIDENT_BADGE_MAX_COUNT
      ? `${INCIDENT_BADGE_MAX_COUNT}+`
      : String(counts.untriaged)
  const qualifiers: string[] = []
  if (counts.coverage.currentlyLimited || counts.coverage.shadowReplayIncomplete) {
    qualifiers.push('count may be incomplete')
  } else if (counts.coverage.capacityLatchSet) {
    // Same tone as a current hole, different wording: the latch is a past refusal, so saying "the
    // store is refusing writes right now" would be a different (and false) claim.
    qualifiers.push('a past capacity stop may have dropped incidents')
  }
  // Secondary and additive: a remote hole never changes the local count's trustworthiness, so it is a
  // second qualifier rather than an amber tone (codex-ark/trae arbitration, option C).
  if (remoteGap) {
    qualifiers.push('remote view incomplete')
  }
  return {
    kind: 'count',
    count: counts.untriaged,
    tone,
    localGap,
    remoteGap,
    showCount: true,
    label:
      qualifiers.length === 0
        ? `${capped} untriaged`
        : `${capped} untriaged (${qualifiers.join('; ')})`
  }
}

/**
 * The label for a marker, in the reader's language. One producer, like the count labels above.
 *
 * Both sentences say what is *not* claimed. "Counts unavailable" is not "no incidents"; "stale" is not
 * "went quiet". That is the distinction the pre-merge review asked for, in words.
 */
function unavailableLabel(reason: IncidentUnavailableBadge['reason']): string {
  return reason === 'stale'
    ? translate(
        'auto.components.right.sidebar.incident.badge.5f9928ae9c',
        'Incident counts are stale: the last reading is over 10 minutes old, so it may be out of date.'
      )
    : translate(
        'auto.components.right.sidebar.incident.badge.5986792da9',
        'Incident counts are unavailable: the store could not be read, so this is not a statement that nothing needs triage.'
      )
}

/**
 * The whole question the activity bar asks: counts → badge, or nothing.
 *
 *   * `idle` — nothing has arrived yet. Draw nothing: a first paint is not a failure, and an error
 *     marker during the first few milliseconds of every launch would be a lie about the store.
 *   * `unavailable` — no reading at all. Always draws the marker: this is exactly the "no data read as
 *     no problem" case the review flagged.
 *   * `stale` — a reading exists but is past `INCIDENT_COUNTS_STALE_MS`. Draws the marker too, *unless*
 *     the stale reading is complete and empty: a quiet host that never had an incident would otherwise
 *     carry a permanent marker whose only content is "nothing happened, and nothing was written since",
 *     which is the same sentence a healthy quiet host legitimately says.
 *   * `ok` — the count rules above, unchanged.
 */
export function incidentBadgeFromState(state: IncidentCountsState): IncidentBadge | null {
  const { counts, availability } = state
  if (availability === 'stale' && counts !== null) {
    const countBadge = incidentBadgeFromCounts(counts)
    if (countBadge === null) {
      // Complete and empty; see the doc comment. Nothing to distrust and nothing to draw.
      return null
    }
    return { kind: 'unavailable', reason: 'stale', label: unavailableLabel('stale') }
  }
  if (availability === 'unavailable') {
    return { kind: 'unavailable', reason: 'unavailable', label: unavailableLabel('unavailable') }
  }
  if (availability === 'ok') {
    return incidentBadgeFromCounts(counts)
  }
  // `idle`, or a `stale` state that somehow carries no reading: draw nothing rather than guess.
  return null
}

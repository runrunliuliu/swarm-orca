// How the two grayscale tables decide what is "observed" and what is "recorded" (§7.2, §7.3; M7-B).
//
// This is the requirement with teeth: by default neither collector writes an incident, so a table full
// of rows must not look like a store full of accidents. The distinction is made here, once, as data
// instead of a class string duplicated in two JSX files:
//
//   * `observed` — the host saw this and did not record it. Dashed border, muted, and the copy says so;
//   * `recorded` — an incident row exists for it (`written: true`). Solid border, normal tone.
//
// `wouldWriteIfEnabled` never upgrades a row to `recorded`: "a write-enabled collector would record
// this now" is still an observation. Collapsing those two is exactly the misreading this module exists
// to prevent.

import type {
  IncidentStallRowDto,
  IncidentToolErrorWindowDto,
  IncidentToolErrorsViewDto
} from '../../../../../shared/incident-gray-types'

export type IncidentGrayRowKind = 'observed' | 'recorded'

/**
 * A stall sample is always an observation: the sampler's stored sample is the decision input, and the
 * incident (if any) is a separate row in the store. There is no `written` flag on a sample, so this
 * function exists to say that out loud rather than leaving the UI to assume symmetry with tool errors.
 */
export function stallRowKind(_row: IncidentStallRowDto): IncidentGrayRowKind {
  return 'observed'
}

/** The only row that may render as recorded: the collector marks a window once it wrote its incident. */
export function toolErrorWindowKind(window: Pick<IncidentToolErrorWindowDto, 'written'>): IncidentGrayRowKind {
  return window.written ? 'recorded' : 'observed'
}

export type IncidentToolErrorTruncation = {
  /** The published payload is smaller than what the collector held. */
  payloadTruncated: boolean
  /** Windows were evicted by the in-process bound: those counts are gone, not merely unpublished. */
  evicted: boolean
}

export function toolErrorTruncation(view: IncidentToolErrorsViewDto): IncidentToolErrorTruncation {
  return {
    payloadTruncated: view.total > view.published,
    evicted: view.evicted > 0
  }
}

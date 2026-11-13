// Shared shapes for the two grayscale read-only tables (§7.2, §7.3; M7-B).
//
// Both datasets already had a CLI view (`orca incident stalls`, `orca incident tool-errors`) that
// reads them from this host's store. The panel needs the same rows over IPC, and the important part of
// the shape is what it *carries about itself*:
//
//   * the tool-error view carries its own provider coverage. Silence from an uncovered agent must
//     never read as "no tool errors" (§7.3 M4-C3);
//
// No field here lets the renderer decide anything: it projects what the host already decided.

import type { IncidentCoverageDto } from './incident-api-types'

/** One pane-clock fact. There is deliberately no verdict, threshold or "would write" field. */
export type IncidentPaneClockRowDto = {
  paneKey: string
  terminalHandle: string | null
  state: string
  stateStartedAt: number
  turnStartedAt: number | null
  lastSemanticEventAt: number | null
  /** Age of the last semantic event (or `stateStartedAt` when `ageBasis` says so). */
  ageMs: number
  ageBasis: 'event' | 'state_fallback'
  observedAt: number
  /** An operator's "expected to be quiet" declaration, shown as context, never as a suppressor. */
  declaredWait: string | null
}

export type IncidentPaneClocksViewDto = {
  rows: IncidentPaneClockRowDto[]
  coverage: IncidentCoverageDto
}

/** One recorded tool-call failure. Raw facts: no normalized code, no window, no severity. */
export type IncidentToolFailureRowDto = {
  sessionId: string
  /** Stable journal item id; `(session, item, ordinal)` is the store's dedupe key. */
  itemKey: string
  ordinal: number
  turn: string
  toolName: string
  /** Provider-stamped refusal kind, when the provider supplied one. */
  errorKind: string | null
  /** Structured exit status, when the provider supplied one. */
  exitCode: number | null
  observedAt: number
}

export type IncidentToolFailuresViewDto = {
  since: number
  rows: IncidentToolFailureRowDto[]
  /** Rows in the window, before the read limit. */
  total: number
  truncated: boolean
  /** Rows refused by the hard cap or lost to an insert failure; a non-zero value means facts are missing. */
  dropped: number
  /** Providers whose structured session events reach this collector. */
  coveredProviders: string[]
  /** Providers that never reach it — a declared gap, not an absence of tool errors. */
  uncoveredProviders: string[]
}

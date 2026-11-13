// Shared shapes for the two grayscale read-only tables (§7.2, §7.3; M7-B).
//
// Both datasets already had a CLI view (`orca incident stalls`, `orca incident tool-errors`) that
// reads them from this host's store. The panel needs the same rows over IPC, and the important part of
// the shape is what it *carries about itself*:
//
//   * `writeEnabled` is the host process's switch, reported as-is. The default is off, so the tables
//     show observations, not accidents;
//   * the tool-error view carries its own provider coverage. Silence from an uncovered agent must
//     never read as "no tool errors" (§7.3 M4-C3);
//   * `wouldWriteIfEnabled` and `written` stay separate fields rather than one boolean: "a write would
//     happen" and "a record exists" are different claims and the UI renders them differently.
//
// No field here lets the renderer decide anything: it projects what the host already decided.

import type { IncidentCoverageDto } from './incident-api-types'

/** One row of the stall sampler's last pass. Never "confirmed stuck". */
export type IncidentStallRowDto = {
  paneKey: string
  terminalHandle: string | null
  state: string
  /** Age of the last semantic event (or `stateStartedAt` when `ageBasis` says so). */
  ageMs: number
  ageBasis: 'event' | 'state_fallback'
  thresholdMs: number
  wouldWriteIfEnabled: boolean
  reason: string
  declaredWait: string | null
}

export type IncidentStallsViewDto = {
  rows: IncidentStallRowDto[]
  coverage: IncidentCoverageDto
}

/** One in-process tool-error window (§7.3). `windowStart` is the idempotency epoch. */
export type IncidentToolErrorWindowDto = {
  sessionId: string
  turn: string
  toolName: string
  code: string
  count: number
  windowStart: number
  lastAt: number
  highSeverity: boolean
  wouldWriteIfEnabled: boolean
  /** True once this window's incident was actually written; the only "recorded" row. */
  written: boolean
}

export type IncidentToolErrorsViewDto = {
  /** When the host last published its window snapshot; `null` means nothing observed yet. */
  updatedAt: number | null
  writeEnabled: boolean
  /** Windows in this payload (the host caps it). */
  published: number
  /** Windows the collector held; greater than `published` means payload truncation. */
  total: number
  /** Windows dropped by the in-process LRU bound; their counts are lost, not merely unpublished. */
  evicted: number
  windows: IncidentToolErrorWindowDto[]
  /** Providers whose structured session events reach this collector. */
  coveredProviders: string[]
  /** Providers that never reach it — a declared gap, not an absence of tool errors. */
  uncoveredProviders: string[]
}

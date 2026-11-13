// One pane-clock sampling pass (M8-2; formerly the stall sampler).
//
// What is left after the subtraction: read the hook server's status snapshot, convert it to facts,
// replace the `incident_pane_clocks` table and publish coverage counters. There is no threshold, no
// observation-cycle counter, no `wouldWriteIfEnabled` verdict and no incident write — "is this pane
// stuck?" is a triage question now (m8-subtraction.md §4 M8-2).
//
// The one thing this module still owns carefully is the age basis (M3-C1): the age is measured from
// the status row's `evidenceObservedAt`, never from PTY bytes (a TUI spinner repaints forever) and
// never from `receivedAt` (a relay replay restamps it). When the host never reported a semantic
// clock, the row is stored with `state_fallback` so the weaker basis is visible, not silent.

import type Database from '../sqlite/sync-database'
import {
  PANE_CLOCK_LAST_ERROR_META,
  PANE_CLOCK_ERRORS_META,
  bumpPaneClockSkipped,
  publishPaneClockCoverage,
  replacePaneClocks,
  type PaneClockFact
} from './incident-pane-clocks'
import { bumpMetaNumber, writeMeta } from './incident-store-meta'
import { listActiveWaits, pruneExpiredWaits } from './incident-wait'

/** The facts the sampler needs from a status row; kept narrow so a source is easy to fake. */
export type PaneClockSourceRow = PaneClockFact

export type PaneClockSampleSummary = {
  sampledAt: number
  panes: number
  declaredWaits: number
  skipped: number
}

/**
 * Adapt the hook server's status snapshot to the sampler's narrow row shape.
 *
 * Kept pure and exported so the adapter is tested without a hook server, and so the sampler's view of
 * a pane is one place: state, its epoch, the turn epoch when reported, and the semantic event clock.
 *
 * `lastSemanticEventAt` is the row's `evidenceObservedAt` and nothing else (M3-C1). It is optional,
 * and its absence is preserved as `null` so the stored row says `state_fallback` instead of
 * pretending the semantic clock said zero.
 */
export function stallRowsFromStatusSnapshot(
  snapshot: readonly {
    paneKey: string
    terminalHandle?: string
    state: string
    stateStartedAt: number
    turnStartedAt?: number
    evidenceObservedAt?: number
    receivedAt: number
    providerSessionOnly?: boolean
  }[]
): PaneClockSourceRow[] {
  return snapshot
    .filter((entry) => entry.providerSessionOnly !== true)
    .map((entry) => ({
      paneKey: entry.paneKey,
      terminalHandle: entry.terminalHandle ?? null,
      state: entry.state,
      stateStartedAt: entry.stateStartedAt,
      turnStartedAt: entry.turnStartedAt ?? null,
      lastSemanticEventAt: entry.evidenceObservedAt ?? null
    }))
}

/**
 * One sampling pass. Pure inputs (rows, now) so tests drive it directly; the timer is the only caller
 * that resolves them from the process.
 */
export function samplePaneClocks(options: {
  db: Database.Database
  now?: number
  rows?: readonly PaneClockSourceRow[]
}): PaneClockSampleSummary {
  const { db } = options
  const now = options.now ?? Date.now()
  const rows = options.rows ?? []

  pruneExpiredWaits(db, now)
  const active = listActiveWaits(db, { now })
  const { skipped } = replacePaneClocks(db, rows, now)
  bumpPaneClockSkipped(db, skipped)
  publishPaneClockCoverage(db, { sampledAt: now, panes: rows.length - skipped, declaredWaits: active.length })

  return { sampledAt: now, panes: rows.length - skipped, declaredWaits: active.length, skipped }
}

/** The sampler's own failure counter, visible in coverage (M3-C3's lesson: a failing sampler is not quiet). */
export function recordPaneClockSamplerError(db: Database.Database, error: unknown): void {
  try {
    bumpMetaNumber(db, PANE_CLOCK_ERRORS_META)
    writeMeta(
      db,
      PANE_CLOCK_LAST_ERROR_META,
      (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 300)
    )
  } catch {
    // Nothing left to do.
  }
}

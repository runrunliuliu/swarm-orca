// One stall sampling pass (issue-sedimentation.md v2.4 §7.2; M3-2/M3-3).
//
// The evaluation is split in three: `incident-stall-decision.ts` is the pure predicate,
// `incident-stall-evaluate.ts` turns status rows into sample rows + write candidates, and this module
// owns the one side effect — replacing the sample table and publishing the grayscale counters. The
// timer itself lives in `incidents-stall-sampler-timer.ts`, so a test can run a pass without a clock.
//
// Age basis (M3-C1): the predicate measures `now - lastSemanticEventAt`, where the field is the status
// row's `evidenceObservedAt`. This module's job is to carry that value through unchanged — including
// `null`, which is what makes the fallback visible instead of silent.

import type Database from '../sqlite/sync-database'
import type { IncidentStallSampleCoverage } from './incident-types'
import type { IncidentStore } from './incident-store'
import { mainProcessUserDataPath } from './incidents-paths'
import { writeMeta } from './incident-store-meta'
import { bumpMetaNumber } from './incident-store-meta'
import {
  normalizeThresholds,
  type StallPaneFacts,
  type StallThresholds
} from './incident-stall-decision'
import {
  STALL_LAST_SAMPLE_AT_META,
  STALL_LAST_WRITE_AT_META,
  STALL_SAMPLE_PANES_META,
  STALL_SAMPLE_STALLED_META,
  STALL_SAMPLE_WOULD_META,
  STALL_KEY_REJECTED_META,
  STALL_LAST_KEY_REJECTED_META,
  STALL_WRITE_ENABLED_META,
  STALL_WRITES_META,
  readStallSampleCoverage
} from './incident-stall-coverage'
import { stallWriteEnabled, writeStallIncident } from './incident-stall-write'
import { writeStallSamples, type StallSampleRow } from './incident-stall-samples'
import { evaluateStallRows } from './incident-stall-evaluate'
import {
  listActiveWaits,
  pruneExpiredWaits,
  publishDeclaredWaitCount
} from './incident-wait'

/** The facts the sampler needs from a status row; kept narrow so a source is easy to fake. */
export type StallSampleSourceRow = StallPaneFacts & {
  terminalHandle: string | null
}

export type StallSampleSummary = {
  sampledAt: number
  panes: number
  /** Panes the predicate would write for if the switch were on. Not "confirmed stuck". */
  wouldWrite: number
  /** Panes whose age crossed the threshold with no semantic event. */
  noEvent: number
  declaredWaits: number
  writeEnabled: boolean
  writes: number
  rows: StallSampleRow[]
}

/**
 * Consecutive samples in which one epoch was seen. In-memory on purpose: "≥2 independent cycles" is
 * about this process's observation cadence, so a restart legitimately starts the count again.
 */
const cyclesByEpoch = new Map<string, number>()

/** Clear the in-memory cycle counts (the timer module resets its own state). */
export function resetStallSamplerCycles(): void {
  cyclesByEpoch.clear()
}

/**
 * Adapt the hook server's status snapshot to the sampler's narrow row shape.
 *
 * Kept pure and exported so the adapter is tested without a hook server, and so the sampler's view of
 * a pane is one place: state, its epoch, the turn epoch when reported, and the *semantic event* clock.
 *
 * `lastSemanticEventAt` is the row's `evidenceObservedAt` and nothing else (M3-C1). It is optional,
 * and its absence is preserved as `null` so the decision falls back to `stateStartedAt` and says so —
 * `receivedAt` is deliberately not used, because it is a delivery clock that a relay replay restamps.
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
): StallSampleSourceRow[] {
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
 * One sampling pass. Pure inputs (rows, now, thresholds, switch) so tests drive it directly; the
 * timer is the only caller that resolves them from the process.
 */
export function sampleStallState(options: {
  db: Database.Database
  store: IncidentStore | null
  now?: number
  rows?: StallSampleSourceRow[]
  thresholds?: Partial<StallThresholds>
  writeEnabled?: boolean
  userDataPath?: string | null
}): StallSampleSummary {
  const { db, store } = options
  const now = options.now ?? Date.now()
  const thresholds = normalizeThresholds(options.thresholds)
  const writeEnabled = options.writeEnabled ?? stallWriteEnabled()
  const rows = options.rows ?? []

  pruneExpiredWaits(db, now)
  const active = listActiveWaits(db, { now })
  const seenEpochs = new Set<string>()

  const evaluation = evaluateStallRows({
    rows,
    waits: active,
    thresholds,
    now,
    cyclesObserved: (paneKey, epoch) => {
      const key = `${paneKey}\u0000${epoch}`
      const next = (cyclesByEpoch.get(key) ?? 0) + 1
      cyclesByEpoch.set(key, next)
      return next
    },
    rememberSeen: (paneKey, epoch) => seenEpochs.add(`${paneKey}\u0000${epoch}`)
  })
  const samples = evaluation.rows
  // Forget epochs no longer observed, so the map cannot grow with every pane respawn.
  for (const key of cyclesByEpoch.keys()) {
    if (!seenEpochs.has(key)) {
      cyclesByEpoch.delete(key)
    }
  }

  writeStallSamples(db, samples)

  const userDataPath =
    options.userDataPath === undefined ? mainProcessUserDataPath() : options.userDataPath
  let writes = 0
  let lastWriteAt: number | null = null
  if (writeEnabled) {
    for (const entry of evaluation.candidates) {
      const result = writeStallIncident({
        store,
        facts: entry.facts,
        decision: entry.decision,
        now,
        userDataPath
      })
      if (result.outcome === 'inserted') {
        writes += 1
        lastWriteAt = now
      } else if (result.outcome === 'key_rejected') {
        // Visible, not silent: a rejected key means the pane/epoch pair cannot be keyed, and that
        // must show up in coverage rather than disappear (M3-C2).
        bumpMetaNumber(db, STALL_KEY_REJECTED_META)
        writeMeta(db, STALL_LAST_KEY_REJECTED_META, result.reason ?? 'status_stall_key_rejected')
      }
    }
  }

  writeMeta(db, STALL_LAST_SAMPLE_AT_META, String(now))
  writeMeta(db, STALL_SAMPLE_PANES_META, String(samples.length))
  writeMeta(db, STALL_SAMPLE_WOULD_META, String(evaluation.wouldWrite))
  writeMeta(db, STALL_SAMPLE_STALLED_META, String(evaluation.noEvent))
  writeMeta(db, STALL_WRITE_ENABLED_META, writeEnabled ? '1' : '0')
  publishDeclaredWaitCount(db, active.length)
  if (writes > 0) {
    bumpMetaNumber(db, STALL_WRITES_META, writes)
  }
  if (lastWriteAt !== null) {
    writeMeta(db, STALL_LAST_WRITE_AT_META, String(lastWriteAt))
  }

  return {
    sampledAt: now,
    panes: samples.length,
    wouldWrite: evaluation.wouldWrite,
    noEvent: evaluation.noEvent,
    declaredWaits: active.length,
    writeEnabled,
    writes,
    rows: samples
  }
}

export { readStallSampleCoverage }
export type { IncidentStallSampleCoverage }

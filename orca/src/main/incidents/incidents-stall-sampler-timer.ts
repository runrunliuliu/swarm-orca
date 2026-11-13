// The pane-clock sampler's timer lifecycle (M8-2; formerly the stall sampler timer).
//
// Why this is the one new timer in the design, and what was rejected:
//   * `server-status-application` is event-driven — there is no tick to hang "has this been quiet for
//     N minutes" on;
//   * `server-reaping` is a one-shot startup sweep for restored Claude subagents, not a cadence;
//   * the hook server's only interval is the OpenCode binder, which is provider-specific.
// So a single `setInterval(60s)` with `unref()` is the smallest honest mechanism: it does zero work
// when the store is unavailable, it is never on the PTY or status write path, and it dies with the
// process.
//
// It records FACTS only. The judgement that used to run here (threshold, cycles, would-write) moved
// out of Orca in M8-2, so this file no longer resolves the incident store or writes incidents.

import type Database from '../sqlite/sync-database'
import { incidentRuntimeStore, resetIncidentStoreCache } from './incident-writer'
import { PANE_CLOCK_SAMPLE_INTERVAL_MS } from './incident-pane-clocks'
import {
  recordPaneClockSamplerError,
  samplePaneClocks,
  type PaneClockSampleSummary,
  type PaneClockSourceRow
} from './incidents-stall-sampler'

let source: (() => PaneClockSourceRow[]) | null = null
let timer: ReturnType<typeof setInterval> | null = null

export function configureStallSamplerSource(read: (() => PaneClockSourceRow[]) | null): void {
  source = read
}

/** The single interval. Returns false when one is already running (idempotent mount). */
export function startStallSampler(options: { intervalMs?: number } = {}): boolean {
  if (timer !== null) {
    return false
  }
  const intervalMs = Math.max(1_000, options.intervalMs ?? PANE_CLOCK_SAMPLE_INTERVAL_MS)
  timer = setInterval(() => {
    runStallSamplerTick()
  }, intervalMs)
  // Why unref: the sampler must not keep the app alive, and it must stop when the process ends.
  timer.unref?.()
  return true
}

export function stopStallSampler(): void {
  if (timer !== null) {
    clearInterval(timer)
    timer = null
  }
}

export function stallSamplerRunning(): boolean {
  return timer !== null
}

/** Record one sampler failure where the read model can see it. Never throws (M3-C3). */
export function recordStallSamplerError(db: Database.Database, error: unknown): void {
  recordPaneClockSamplerError(db, error)
}

/**
 * One timer tick, exported so a test can inject a failure without waiting a minute.
 *
 * A diagnostics timer must never take the process down, so every throw lands in the meta counter that
 * the CLI and the panel print.
 */
export function runStallSamplerTick(
  options: { db?: Database.Database; now?: number } = {}
): PaneClockSampleSummary | null {
  try {
    if (options.db !== undefined) {
      return samplePaneClocks({
        db: options.db,
        ...(options.now === undefined ? {} : { now: options.now })
      })
    }
    return sampleOnce(options.now)
  } catch (error) {
    const db = options.db ?? incidentRuntimeStore()?.db
    if (db !== undefined) {
      recordStallSamplerError(db, error)
    }
    return null
  }
}

let lastOpenRetryAt = 0
/** Retry a failed store open at most every 5 minutes: a diagnostics timer must not hammer the disk. */
const REOPEN_RETRY_MS = 5 * 60 * 1000

function sampleOnce(now: number = Date.now()): PaneClockSampleSummary | null {
  let runtime = incidentRuntimeStore()
  if (runtime === null && now - lastOpenRetryAt >= REOPEN_RETRY_MS) {
    lastOpenRetryAt = now
    resetIncidentStoreCache()
    runtime = incidentRuntimeStore()
  }
  if (runtime === null) {
    return null
  }
  return samplePaneClocks({
    db: runtime.db,
    now,
    ...(source === null ? {} : { rows: source() })
  })
}

export function __resetStallSamplerForTests(): void {
  stopStallSampler()
  source = null
  lastOpenRetryAt = 0
}

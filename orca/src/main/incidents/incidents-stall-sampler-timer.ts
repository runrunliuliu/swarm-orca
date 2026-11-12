// The stall sampler's timer lifecycle (M3-3): one interval, its source, and its failure surface.
//
// Why this is the one new timer in the design, and what was rejected:
//   * `server-status-application` is event-driven — there is no tick to hang "45 minutes later" on,
//     and inventing a per-event deadline would mean one timer per status row;
//   * `server-reaping` is a one-shot startup sweep for restored Claude subagents, not a cadence;
//   * the hook server's only interval is the OpenCode binder, which is provider-specific.
// So a single `setInterval(60s)` with `unref()` is the smallest honest mechanism: it does zero work
// when the store is unavailable, it is never on the PTY or status write path, and it dies with the
// process.
//
// Split from `incidents-stall-sampler.ts` (one sampling pass) so the cadence decision, the store
// resolution and the error counters live in one readable place. Everything here is process-global by
// design: exactly one sampler per process, started once at startup.

import type Database from '../sqlite/sync-database'
import type { IncidentStore } from './incident-store'
import { incidentRuntimeStore, resetIncidentStoreCache } from './incident-writer'
import { STALL_SAMPLE_INTERVAL_MS } from './incident-stall-decision'
import {
  STALL_LAST_SAMPLER_ERROR_META,
  STALL_SAMPLER_ERRORS_META
} from './incident-stall-coverage'
import { bumpMetaNumber } from './incident-shadow-coverage'
import { writeMeta } from './incident-store-capacity'
import {
  resetStallSamplerCycles,
  sampleStallState,
  type StallSampleSourceRow,
  type StallSampleSummary
} from './incidents-stall-sampler'

let source: (() => StallSampleSourceRow[]) | null = null
let timer: ReturnType<typeof setInterval> | null = null

export function configureStallSamplerSource(read: (() => StallSampleSourceRow[]) | null): void {
  source = read
}

/** The single interval. Returns false when one is already running (idempotent mount). */
export function startStallSampler(options: { intervalMs?: number } = {}): boolean {
  if (timer !== null) {
    return false
  }
  const intervalMs = Math.max(1_000, options.intervalMs ?? STALL_SAMPLE_INTERVAL_MS)
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

/**
 * Record one sampler failure where the read model can see it (M3-C3).
 *
 * Never throws: this already runs inside the failure path, and a diagnostics surface that can throw
 * while reporting a failure is worse than the failure.
 */
export function recordStallSamplerError(db: Database.Database, error: unknown): void {
  try {
    bumpMetaNumber(db, STALL_SAMPLER_ERRORS_META)
    writeMeta(
      db,
      STALL_LAST_SAMPLER_ERROR_META,
      (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 300)
    )
  } catch {
    // Nothing left to do.
  }
}

/**
 * One timer tick, exported so a test can inject a failure without waiting a minute.
 *
 * A diagnostics timer must never take the process down, so every throw lands in the meta counter that
 * `stalls`/coverage print.
 */
export function runStallSamplerTick(
  options: {
    db?: Database.Database
    store?: IncidentStore | null
    now?: number
  } = {}
): StallSampleSummary | null {
  try {
    if (options.db !== undefined && options.store !== undefined) {
      return sampleStallState({
        db: options.db,
        store: options.store,
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

function sampleOnce(now: number = Date.now()): StallSampleSummary | null {
  let runtime = incidentRuntimeStore()
  if (runtime === null && now - lastOpenRetryAt >= REOPEN_RETRY_MS) {
    lastOpenRetryAt = now
    resetIncidentStoreCache()
    runtime = incidentRuntimeStore()
  }
  if (runtime === null) {
    return null
  }
  return sampleStallState({
    db: runtime.db,
    store: runtime.store,
    now,
    ...(source === null ? {} : { rows: source() })
  })
}

export function __resetStallSamplerForTests(): void {
  stopStallSampler()
  source = null
  resetStallSamplerCycles()
  lastOpenRetryAt = 0
}

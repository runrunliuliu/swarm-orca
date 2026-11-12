// The stall sampler: one sample a minute, read-only unless the grayscale switch is on
// (issue-sedimentation.md v2.4 §7.2, M3-3).
//
// Why this is the one new timer in the design, and what was rejected:
//   * `server-status-application` is event-driven — there is no tick to hang "45 minutes later" on,
//     and inventing a per-event deadline would mean one timer per status row;
//   * `server-reaping` is a one-shot startup sweep for restored Claude subagents, not a cadence;
//   * the hook server's only interval is the OpenCode binder, which is provider-specific.
// So a single `setInterval(60s)` with `unref()` is the smallest honest mechanism. It does zero work
// when the store is unavailable, it is never on the PTY or status write path, and it dies with the
// process. §13's M3 acceptance is explicitly "observe first, write later", which needs a cadence.
//
// The sampler evaluates every pane, persists the sample for `orca incident stalls`, publishes the
// grayscale counters, and (only with `INCIDENT_STALL_WRITE=on`) writes a `no_progress` incident for a
// pane whose decision is `stalled`. It never throws: a throwing timer is a crash generator.

import type Database from '../sqlite/sync-database'
import type { IncidentStallSampleCoverage } from './incident-types'
import type { IncidentStore } from './incident-store'
import { incidentRuntimeStore, resetIncidentStoreCache } from './incident-writer'
import { mainProcessUserDataPath } from './incidents-paths'
import { writeMeta } from './incident-store-capacity'
import { bumpMetaNumber } from './incident-shadow-coverage'
import {
  decideStall,
  normalizeThresholds,
  type StallDecision,
  type StallPaneFacts,
  type StallThresholds
} from './incident-stall-decision'
import {
  STALL_LAST_SAMPLE_AT_META,
  STALL_LAST_WRITE_AT_META,
  STALL_SAMPLE_PANES_META,
  STALL_SAMPLE_STALLED_META,
  STALL_SAMPLE_WOULD_META,
  STALL_SAMPLER_ERRORS_META,
  STALL_LAST_SAMPLER_ERROR_META,
  STALL_WRITE_ENABLED_META,
  STALL_WRITES_META,
  readStallSampleCoverage
} from './incident-stall-coverage'
import { stallWriteEnabled, writeStallIncident } from './incident-stall-write'
import {
  STALL_SAMPLE_INTERVAL_MS,
  STALL_THRESHOLDS
} from './incident-stall-decision'
import { writeStallSamples, type StallSampleRow } from './incident-stall-samples'
import {
  listActiveWaits,
  pruneExpiredWaits,
  publishDeclaredWaitCount,
  type WaitDeclaration
} from './incident-wait'

/** The facts the sampler needs from a status row; kept narrow so a source is easy to fake. */
export type StallSampleSourceRow = StallPaneFacts & {
  terminalHandle: string | null
}

export type StallSampleSummary = {
  sampledAt: number
  panes: number
  wouldStall: number
  stalled: number
  declaredWaits: number
  writeEnabled: boolean
  writes: number
  rows: StallSampleRow[]
}

let source: (() => StallSampleSourceRow[]) | null = null
let timer: ReturnType<typeof setInterval> | null = null
/**
 * Consecutive samples in which one epoch was seen. In-memory on purpose: "≥2 independent cycles"
 * is about this process's observation cadence, so a restart legitimately starts the count again.
 */
const cyclesByEpoch = new Map<string, number>()

export function configureStallSamplerSource(read: (() => StallSampleSourceRow[]) | null): void {
  source = read
}

/**
 * Adapt the hook server's status snapshot to the sampler's narrow row shape.
 *
 * Kept pure and exported so the adapter is tested without a hook server, and so the sampler's view of
 * a pane is one place: state plus its epoch, the turn epoch when reported, and the *evidence* clock
 * (`evidenceObservedAt`) as the observation time — `receivedAt` restamps on relay replay and would
 * make an old row look freshly observed.
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
      observedAt: entry.evidenceObservedAt ?? entry.receivedAt
    }))
}

/** The single interval. Returns false when one is already running (idempotent mount). */
export function startStallSampler(options: { intervalMs?: number } = {}): boolean {
  if (timer !== null) {
    return false
  }
  const intervalMs = Math.max(1_000, options.intervalMs ?? STALL_SAMPLE_INTERVAL_MS)
  timer = setInterval(() => {
    try {
      sampleOnce()
    } catch (error) {
      // A diagnostics timer must never take the process down; the counter keeps it visible.
      try {
        const runtime = incidentRuntimeStore()
        if (runtime !== null) {
          bumpMetaNumber(runtime.db, STALL_SAMPLER_ERRORS_META)
          writeMeta(
            runtime.db,
            STALL_LAST_SAMPLER_ERROR_META,
            error instanceof Error ? error.name : 'sampler_failed'
          )
        }
      } catch {
        // Nothing left to do from inside the failure path.
      }
    }
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

export function __resetStallSamplerForTests(): void {
  stopStallSampler()
  source = null
  cyclesByEpoch.clear()
}

export function stallSamplerRunning(): boolean {
  return timer !== null
}

function declarationFor(
  waits: Map<string, WaitDeclaration>,
  paneKey: string,
  epoch: number
): WaitDeclaration | null {
  return waits.get(`${paneKey}\u0000${epoch}`) ?? null
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
  const rows = options.rows ?? source?.() ?? []

  pruneExpiredWaits(db, now)
  const active = listActiveWaits(db, { now })
  const waits = new Map<string, WaitDeclaration>()
  for (const declaration of active) {
    waits.set(`${declaration.paneKey}\u0000${declaration.epoch}`, declaration)
  }

  const seenEpochs = new Set<string>()
  const samples: StallSampleRow[] = []
  const decisions: { facts: StallPaneFacts; decision: StallDecision; declaration: WaitDeclaration | null }[] = []
  let wouldStall = 0
  let stalled = 0
  let writes = 0
  let lastWriteAt: number | null = null

  for (const row of rows) {
    const epochKey = `${row.paneKey}\u0000${row.stateStartedAt}`
    seenEpochs.add(epochKey)
    const cyclesObserved = (cyclesByEpoch.get(epochKey) ?? 0) + 1
    cyclesByEpoch.set(epochKey, cyclesObserved)
    const declaration = declarationFor(waits, row.paneKey, row.stateStartedAt)
    const decision = decideStall({
      facts: row,
      now,
      thresholds,
      declaration: declaration
        ? { reason: declaration.reason, expiresAt: declaration.expiresAt, epoch: declaration.epoch }
        : null,
      cyclesObserved
    })
    if (decision.wouldStall) {
      wouldStall += 1
    }
    if (decision.reason === 'stalled') {
      stalled += 1
    }
    decisions.push({ facts: row, decision, declaration })
    samples.push({
      paneKey: row.paneKey,
      terminalHandle: row.terminalHandle,
      state: row.state,
      stateStartedAt: row.stateStartedAt,
      turnStartedAt: row.turnStartedAt ?? null,
      observedAt: row.observedAt,
      ageMs: decision.ageMs,
      thresholdMs: thresholds.stallMs,
      wouldStall: decision.wouldStall,
      reason: decision.reason,
      declaredWait: declaration?.reason ?? null
    })
  }
  // Forget epochs no longer observed, so the map cannot grow with every pane respawn.
  for (const key of cyclesByEpoch.keys()) {
    if (!seenEpochs.has(key)) {
      cyclesByEpoch.delete(key)
    }
  }

  writeStallSamples(db, samples)

  const userDataPath =
    options.userDataPath === undefined ? mainProcessUserDataPath() : options.userDataPath
  if (writeEnabled) {
    for (const entry of decisions) {
      if (entry.decision.reason !== 'stalled') {
        continue
      }
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
      }
    }
  }

  writeMeta(db, STALL_LAST_SAMPLE_AT_META, String(now))
  writeMeta(db, STALL_SAMPLE_PANES_META, String(samples.length))
  writeMeta(db, STALL_SAMPLE_WOULD_META, String(wouldStall))
  writeMeta(db, STALL_SAMPLE_STALLED_META, String(stalled))
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
    wouldStall,
    stalled,
    declaredWaits: active.length,
    writeEnabled,
    writes,
    rows: samples
  }
}

/**
 * The timer body. Zero work when there is no store (a host that never crashed), and it retries the
 * open so fixing the user-data directory does not require two restarts.
 */
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
  return sampleStallState({ db: runtime.db, store: runtime.store, now })
}

export { readStallSampleCoverage, STALL_THRESHOLDS }
export type { IncidentStallSampleCoverage }

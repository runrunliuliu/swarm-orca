// The one function `onPtyExit` calls (issue-sedimentation.md v2.2 §7.1, §14).
//
// §14 names this as the highest-risk touch point in the whole design: `onPtyExit` already carries
// authority retirement, mobile surface teardown, liveness verdicts and dispatch failure in a fixed
// order. So the wiring is exactly one call whose arguments were collected before any of that ran,
// and everything else — resolution, opening, redaction, insertion, error handling — happens here.
//
// Contract: this function NEVER throws and never blocks on anything slower than a local SQLite
// insert. A diagnostics store must not be able to break a terminal teardown.

import { randomUUID } from 'node:crypto'
import { openIncidentsDatabase, type OpenIncidentsDatabase } from './incidents-database'
import {
  assessPtyExit,
  buildPtyExitIncidentRecord,
  type PtyExitIncidentFacts
} from './incident-pty-exit'
import { createIncidentStore, type IncidentStore } from './incident-store'
import {
  incidentsDatabaseFileFor,
  resolveLocalHostId,
  resolveMainProcessIncidentsDatabaseFile
} from './incidents-paths'

export type RecordPtyExitIncidentInput = PtyExitIncidentFacts

export type PtyExitIncidentWriteOutcome =
  | 'inserted'
  | 'duplicate'
  | 'capacity_limited'
  | 'skipped'
  | 'failed'

export type PtyExitIncidentWriteResult = {
  outcome: PtyExitIncidentWriteOutcome
  reason?: string
  id?: string
}

type WriterDiagnostics = {
  attempts: number
  inserted: number
  duplicates: number
  capacityLimited: number
  skipped: number
  failures: number
  lastSkipReason: string | null
  lastFailureReason: string | null
}

const diagnostics: WriterDiagnostics = {
  attempts: 0,
  inserted: 0,
  duplicates: 0,
  capacityLimited: 0,
  skipped: 0,
  failures: 0,
  lastSkipReason: null,
  lastFailureReason: null
}

/** `undefined` = not resolved yet, `null` = resolved and unavailable (retried at most per start). */
let cachedStore: IncidentStore | null | undefined
let cachedDatabase: OpenIncidentsDatabase | null = null

function mintIncidentId(): string {
  return `inc_${Date.now().toString(36)}_${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

function isStore(value: IncidentStore | null | undefined): value is IncidentStore {
  return value !== null && value !== undefined
}

/**
 * Resolve the process-wide store once.
 *
 * A failed open is cached as well: retrying on every PTY exit would turn a broken/missing user-data
 * directory into a per-exit filesystem storm, and the failure is reported through the diagnostics
 * counter instead.
 */
function defaultIncidentStore(): IncidentStore | null {
  if (cachedStore !== undefined) {
    return cachedStore
  }
  const path = resolveMainProcessIncidentsDatabaseFile()
  if (path === null) {
    cachedStore = null
    return null
  }
  try {
    cachedDatabase = openIncidentsDatabase(path)
    cachedStore = createIncidentStore({
      db: cachedDatabase.db,
      fileSizeBytes: cachedDatabase.fileSizeBytes,
      readOnly: cachedDatabase.readOnly
    })
  } catch (error) {
    cachedStore = null
    diagnostics.failures += 1
    diagnostics.lastFailureReason = `incident_store_open_failed:${error instanceof Error ? error.name : 'unknown'}`
  }
  return cachedStore
}

/**
 * The write path, with the store passed in.
 *
 * Split out so tests can drive the exact production logic against an in-memory database, and so the
 * single production call site stays a one-liner.
 */
export function recordPtyExitIncidentTo(
  store: IncidentStore | null,
  input: RecordPtyExitIncidentInput,
  options: { hostId?: string; now?: number } = {}
): PtyExitIncidentWriteResult {
  const assessed = assessPtyExit(input)
  if (!assessed.write) {
    diagnostics.skipped += 1
    diagnostics.lastSkipReason = assessed.reason
    return { outcome: 'skipped', reason: assessed.reason }
  }
  if (!isStore(store)) {
    diagnostics.skipped += 1
    diagnostics.lastSkipReason = 'incident_store_unavailable'
    return { outcome: 'skipped', reason: 'incident_store_unavailable' }
  }
  const built = buildPtyExitIncidentRecord(input, {
    id: mintIncidentId(),
    hostId: options.hostId ?? resolveLocalHostId(),
    createdAt: options.now ?? Date.now()
  })
  if (!built.ok) {
    diagnostics.skipped += 1
    diagnostics.lastSkipReason = built.reason
    return { outcome: 'skipped', reason: built.reason }
  }
  const result = store.insertIncident(built.record)
  switch (result.outcome) {
    case 'inserted':
      diagnostics.inserted += 1
      return { outcome: 'inserted', id: result.id ?? built.record.id }
    case 'duplicate':
      diagnostics.duplicates += 1
      return { outcome: 'duplicate', id: result.id ?? undefined }
    case 'capacity_limited':
      diagnostics.capacityLimited += 1
      return { outcome: 'capacity_limited', reason: result.limitedBy }
    case 'read_only':
      diagnostics.skipped += 1
      diagnostics.lastSkipReason = 'incident_store_read_only'
      return { outcome: 'skipped', reason: 'incident_store_read_only' }
    default:
      diagnostics.failures += 1
      diagnostics.lastFailureReason = result.reason ?? result.outcome
      return { outcome: 'failed', reason: result.reason ?? result.outcome }
  }
}

/**
 * `onPtyExit`'s only call.
 *
 * Arguments must already be collected: see `orca-runtime-on-pty-exit.ts`, which reads the pane key
 * and worktree binding before `retirePtyAgentLaunchAuthority` deletes the receipt they come from.
 */
export function recordPtyExitIncident(input: RecordPtyExitIncidentInput): void {
  diagnostics.attempts += 1
  try {
    recordPtyExitIncidentTo(defaultIncidentStore(), input)
  } catch (error) {
    // Even an unexpected failure here must not escape into the PTY teardown.
    diagnostics.failures += 1
    diagnostics.lastFailureReason =
      error instanceof Error ? `incident_write_threw:${error.name}` : 'incident_write_threw'
  }
}

export function incidentWriterDiagnostics(): Readonly<WriterDiagnostics> {
  return { ...diagnostics }
}

/** Test seam (house pattern: `__configure…ForTests`), never called from production paths. */
export function __configureIncidentStoreForTests(store: IncidentStore | null): void {
  cachedStore = store
}

export function __resetIncidentWriterForTests(): void {
  cachedStore = undefined
  if (cachedDatabase !== null) {
    try {
      cachedDatabase.db.close()
    } catch {
      // Already closed by the test's own teardown.
    }
    cachedDatabase = null
  }
  diagnostics.attempts = 0
  diagnostics.inserted = 0
  diagnostics.duplicates = 0
  diagnostics.capacityLimited = 0
  diagnostics.skipped = 0
  diagnostics.failures = 0
  diagnostics.lastSkipReason = null
  diagnostics.lastFailureReason = null
}

/** Exported for the path test; production code resolves through the two functions above. */
export { incidentsDatabaseFileFor }

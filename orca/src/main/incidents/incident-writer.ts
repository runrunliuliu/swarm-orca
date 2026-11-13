// The one function `onPtyExit` calls, plus the process-wide store it writes through
// (issue-sedimentation.md v2.3 §7.1, §11.2, §14).
//
// §14 names `onPtyExit` as the highest-risk touch point in the whole design: it already carries
// authority retirement, mobile surface teardown, liveness verdicts and dispatch failure in a fixed
// order. So the wiring is exactly one call whose arguments were collected before any of that ran,
// and everything else — resolution, opening, shadow, redaction, insertion, error handling — happens
// here.
//
// Contract: this file NEVER throws into a terminal teardown, and never blocks on anything slower
// than a local SQLite insert plus one flushed NDJSON line.

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import type Database from '../sqlite/sync-database'
import { stageIncidentEvidence } from './incident-archive'
import { openIncidentsDatabase, type OpenIncidentsDatabase } from './incidents-database'
import {
  assessPtyExit,
  buildPtyExitIncidentRecord,
  type PtyExitIncidentFacts
} from './incident-pty-exit'
import type { InsertIncidentResult } from './incident-store'
import { createIncidentStore, type IncidentStore } from './incident-store'
import {
  incidentsDatabaseFileFor,
  mainProcessUserDataPath,
  resolveLocalHostId,
  resolveMainProcessIncidentsDatabaseFile
} from './incidents-paths'
import { appendShadowRecord, appendShadowRecordFromCli } from './incident-shadow'

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
  shadowWritten: number
  shadowFailed: number
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
  shadowWritten: 0,
  shadowFailed: 0,
  lastSkipReason: null,
  lastFailureReason: null
}

/** `undefined` = not resolved yet, `null` = resolved and unavailable (retried per start). */
let cached: RuntimeIncidentStore | null | undefined

export type RuntimeIncidentStore = {
  store: IncidentStore
  db: OpenIncidentsDatabase['db']
  path: string
}

export function mintIncidentId(): string {
  return `inc_${Date.now().toString(36)}_${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

function isStore(value: IncidentStore | null | undefined): value is IncidentStore {
  return value !== null && value !== undefined
}

/**
 * Resolve the process-wide store once.
 *
 * A failed open is cached too: retrying on every PTY exit would turn a broken user-data directory
 * into a per-exit filesystem storm. Unlike M1, the failure is now recoverable without a restart —
 * `resetIncidentStoreCache()` is called by the startup reconcile, so fixing the directory and
 * restarting Orca retries the open (see §12's M1 note).
 */
export function incidentRuntimeStore(): RuntimeIncidentStore | null {
  if (cached !== undefined) {
    return cached
  }
  const path = resolveMainProcessIncidentsDatabaseFile()
  if (path === null) {
    cached = null
    return null
  }
  return openAndCache(path)
}

/**
 * Resolve the store WITHOUT creating it (M5 review C4).
 *
 * The acceptance gate runs on every local `worker_done`, including on a host that never declared a
 * rule. Going through `incidentRuntimeStore()` there would create `<userData>/incidents/` and run the
 * schema migration as a side effect of *not* using the feature, which is not a "no declaration is a
 * no-op" regression path.
 *
 * Absence is deliberately NOT cached: the first real incident write may create the store later in the
 * same process, and a cached "absent" would hide it. A failed open *is* cached, exactly like
 * `incidentRuntimeStore()`, so a broken directory is not re-probed on every settlement.
 */
export function incidentRuntimeStoreIfPresent(): RuntimeIncidentStore | null {
  if (cached !== undefined) {
    return cached
  }
  const path = resolveMainProcessIncidentsDatabaseFile()
  if (path === null) {
    return null
  }
  try {
    if (!existsSync(path)) {
      return null
    }
  } catch {
    return null
  }
  return openAndCache(path)
}

/** Shared open+construct step; caching is what makes a failed open cheap to re-check. */
function openAndCache(path: string): RuntimeIncidentStore | null {
  try {
    const opened: OpenIncidentsDatabase = openIncidentsDatabase(path)
    cached = {
      store: createIncidentStore({
        db: opened.db,
        fileSizeBytes: opened.fileSizeBytes,
        readOnly: opened.readOnly
      }),
      db: opened.db,
      path
    }
  } catch (error) {
    cached = null
    diagnostics.failures += 1
    diagnostics.lastFailureReason = `incident_store_open_failed:${error instanceof Error ? error.name : 'unknown'}`
  }
  return cached
}

/** Drop the cached open so the next call retries. Used by startup reconcile and tests. */
export function resetIncidentStoreCache(): void {
  if (cached !== undefined && cached !== null) {
    try {
      cached.db.close()
    } catch {
      // Already closed.
    }
  }
  cached = undefined
}

/**
 * The shared write path for every incident source: shadow first, then the idempotent insert.
 *
 * Shadow first on purpose (§11.2): if the process dies between the two, the next start has the hint
 * and replaying it produces the row. The reverse order would lose the fact silently. A duplicate
 * insert therefore still leaves a shadow line, which just replays into the same no-op.
 */
export function persistIncidentRecord(
  store: IncidentStore,
  record: Parameters<IncidentStore['insertIncident']>[0],
  options: {
    userDataPath?: string | null
    shadow?: boolean
    shadowMode?: 'sink' | 'append'
    /** Present when the caller owns the connection: evidence staging needs it to append its events. */
    db?: Database.Database
  } = {}
): { result: InsertIncidentResult; shadow: 'written' | 'failed' | 'skipped' } {
  let shadow: 'written' | 'failed' | 'skipped' = 'skipped'
  const userDataPath =
    options.userDataPath === undefined ? mainProcessUserDataPath() : options.userDataPath
  if (options.shadow !== false && userDataPath !== null) {
    const written =
      options.shadowMode === 'append'
        ? appendShadowRecordFromCli(userDataPath, record)
        : appendShadowRecord(userDataPath, record)
    if (written.written) {
      shadow = 'written'
      diagnostics.shadowWritten += 1
    } else {
      shadow = 'failed'
      diagnostics.shadowFailed += 1
    }
  }
  const result = store.insertIncident(record)
  // Evidence staging belongs to the shared write contract, not to one CLI command (M8 review): any
  // writer that has a connection and pointers gets the same `staged -> archive_pending` rows. It is
  // local and bounded, and a failure becomes `archive_incomplete` instead of failing the write.
  if (
    result.outcome === 'inserted' &&
    result.id !== null &&
    options.db !== undefined &&
    userDataPath !== null &&
    record.evidence.pointers.length > 0
  ) {
    try {
      stageIncidentEvidence({
        db: options.db,
        incidentId: result.id,
        pointers: record.evidence.pointers,
        userDataPath,
        now: Date.now()
      })
    } catch {
      // The incident row is already durable; staging failure must not turn an insert into a failure.
    }
  }
  return { result, shadow }
}

/**
 * The write path, with the store passed in.
 *
 * Split out so tests can drive the exact production logic against a real database file, and so the
 * single production call site stays a one-liner.
 */
export function recordPtyExitIncidentTo(
  store: IncidentStore | null,
  input: RecordPtyExitIncidentInput,
  options: {
    hostId?: string
    now?: number
    userDataPath?: string | null
    shadow?: boolean
    db?: Database.Database
  } = {}
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
  const { result } = persistIncidentRecord(store, built.record, {
    userDataPath: options.userDataPath,
    shadow: options.shadow,
    ...(options.db === undefined ? {} : { db: options.db })
  })
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
    const runtime = incidentRuntimeStore()
    recordPtyExitIncidentTo(runtime?.store ?? null, input, runtime === null ? {} : { db: runtime.db })
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
export function __configureIncidentStoreForTests(
  store: IncidentStore | null,
  db?: RuntimeIncidentStore['db']
): void {
  cached =
    store === null
      ? null
      : { store, db: db ?? (null as unknown as RuntimeIncidentStore['db']), path: ':test:' }
}

export function __resetIncidentWriterForTests(): void {
  cached = undefined
  diagnostics.attempts = 0
  diagnostics.inserted = 0
  diagnostics.duplicates = 0
  diagnostics.capacityLimited = 0
  diagnostics.skipped = 0
  diagnostics.failures = 0
  diagnostics.shadowWritten = 0
  diagnostics.shadowFailed = 0
  diagnostics.lastSkipReason = null
  diagnostics.lastFailureReason = null
}

/** Exported for the path test; production code resolves through the functions above. */
export { incidentsDatabaseFileFor }

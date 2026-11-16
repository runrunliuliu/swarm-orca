// Evidence body externalisation (M8-4).
//
// The incident row keeps POINTERS (`path` + `sha256` + `offset` + `size`); it never holds a body. What
// M8-4 adds is a durable copy of the bounded excerpt on the archive filesystem (NAS in deployment), so
// evidence survives the workspace that produced it.
//
// Two rules shape the implementation:
//   * the write path must not block PTY teardown or settlement. Staging is a bounded local write;
//     moving to the archive is an asynchronous drain, and the incident row is never updated;
//   * a failed archive is not "archived". State lives in an append-only event table, and `archived`
//     is written only after a read-back hash matches. Until then the row reads `archive_pending` and
//     `durable=false`;
//   * local staging is reclaimed only AFTER that pointer's `archived` event is committed, because
//     before it the staged excerpt may be the only copy left (see `reclaimStagingCopy`). A cleanup
//     failure leaves the bytes and is logged; it never retracts `archived` and never turns a
//     successful archive into a failure.
//
// The drain only selects `archive_pending`, so an `archive_incomplete` row (mismatch, missing staging)
// is terminal for it. `retryIncompleteArchive` is the one explicit way back: it appends a new
// `archive_pending` event for a still-readable staging excerpt and lets the drain republish. It never
// updates or deletes a row — the appended event is the audit trail.
//
// The archive root is deployment input (`ORCA_INCIDENT_ARCHIVE_ROOT`). Unset means "this host has no
// archive": staging still happens, state stays pending, and the CLI says so — it never pretends.

import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  closeSync,
  readSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
  fsyncSync
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { durableWriteTempPath, renameDurableSync } from '../durable-file-write'
import type Database from '../sqlite/sync-database'
import { runIncidentsTransaction } from './incidents-database'
import type { IncidentEvidencePointer } from './incident-types'

export const ARCHIVE_ROOT_ENV = 'ORCA_INCIDENT_ARCHIVE_ROOT'
/** Bounded excerpt: the point is a reviewable window, not a second copy of a GB transcript. */
export const EVIDENCE_EXCERPT_BYTES = 64 * 1024

export type EvidenceArchiveState = 'staged' | 'archive_pending' | 'archived' | 'archive_incomplete'

export type EvidenceArchiveRow = {
  incidentId: string
  pointerIndex: number
  state: EvidenceArchiveState
  stagingPath: string | null
  archivePath: string | null
  sha256: string | null
  bytes: number | null
  error: string | null
  createdAt: number
}

export function resolveArchiveRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env[ARCHIVE_ROOT_ENV]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function stagingDirectory(userDataPath: string, incidentId: string): string {
  return join(userDataPath, 'incidents', 'evidence-staging', incidentId)
}

/**
 * Incident ids whose latest archive state still owns the only local copy of an excerpt.
 *
 * SQL rather than a TypeScript loop because the one consumer is prune's candidate query: it must decide
 * "may this row go?" inside the same statement that selects and deletes rows, not with a second read
 * that could drift from the delete. Exported (not duplicated there) so the state vocabulary keeps one
 * owner.
 *
 * Every listed state means "deleting the staging file would destroy evidence we have not published":
 *   * `staged` — the crash boundary between the `staged` and `archive_pending` appends; the excerpt is
 *     on disk but no drain will pick it up;
 *   * `archive_pending` — the drain's own queue, and the retry copy a later tick publishes from;
 *   * `archive_incomplete` **with a staging path** — a failed publish whose local copy is still the
 *     material `incident archive --retry-incomplete` re-publishes. One with no staging path has no
 *     bytes to protect and must not pin the row forever.
 */
export const INCIDENT_IDS_WITH_RETRY_BYTES_SQL = `SELECT DISTINCT e.incident_id
     FROM incident_evidence_archive_state e
    WHERE e.state IN ('staged', 'archive_pending')
       OR (e.state = 'archive_incomplete' AND e.staging_path IS NOT NULL)`

function appendEvent(
  db: Database.Database,
  row: Omit<EvidenceArchiveRow, 'createdAt'> & { createdAt: number }
): void {
  db.prepare(
    `INSERT INTO incident_evidence_archive_events
       (incident_id, pointer_index, state, staging_path, archive_path, sha256, bytes, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.incidentId,
    row.pointerIndex,
    row.state,
    row.stagingPath,
    row.archivePath,
    row.sha256,
    row.bytes,
    row.error,
    row.createdAt
  )
}

/**
 * Read the bounded excerpt a pointer describes. A missing/unreadable source is an `archive_incomplete`
 * fact, not silence: an operator must not read "no archive row" as "nothing to archive".
 */
function readExcerpt(pointer: IncidentEvidencePointer): Buffer {
  const start = Math.max(0, pointer.startOffset ?? 0)
  const end =
    pointer.endOffset !== undefined ? Math.max(start, pointer.endOffset) : start + EVIDENCE_EXCERPT_BYTES
  const length = Math.min(EVIDENCE_EXCERPT_BYTES, end - start)
  const fd = openSync(pointer.path, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const read = readSync(fd, buffer, 0, length, start)
    return buffer.subarray(0, read)
  } finally {
    closeSync(fd)
  }
}

export type StageEvidenceResult = {
  staged: number
  incomplete: number
}

/**
 * Copy each pointer's bounded excerpt to local staging and append `staged` + `archive_pending`.
 *
 * Local, small and synchronous on purpose: this is the only evidence write that happens on the report
 * path. Moving it to the archive is never awaited here.
 */
export function stageIncidentEvidence(options: {
  db: Database.Database
  incidentId: string
  pointers: readonly IncidentEvidencePointer[]
  userDataPath: string
  now: number
}): StageEvidenceResult {
  const { db, incidentId, pointers, userDataPath, now } = options
  if (pointers.length === 0) {
    return { staged: 0, incomplete: 0 }
  }
  const directory = stagingDirectory(userDataPath, incidentId)
  let staged = 0
  let incomplete = 0
  pointers.forEach((pointer, pointerIndex) => {
    let bytes: Buffer
    try {
      bytes = readExcerpt(pointer)
    } catch (error) {
      incomplete += 1
      appendEvent(db, {
        incidentId,
        pointerIndex,
        state: 'archive_incomplete',
        stagingPath: null,
        archivePath: null,
        sha256: pointer.sha256 ?? null,
        bytes: pointer.bytes ?? null,
        error: error instanceof Error ? error.message.slice(0, 300) : 'source_unreadable',
        createdAt: now
      })
      return
    }
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      const stagingPath = join(directory, `${pointerIndex}.bin`)
      writeFileSync(stagingPath, bytes, { mode: 0o600 })
      const digest = sha256(bytes)
      appendEvent(db, {
        incidentId,
        pointerIndex,
        state: 'staged',
        stagingPath,
        archivePath: null,
        sha256: digest,
        bytes: bytes.length,
        error: null,
        createdAt: now
      })
      appendEvent(db, {
        incidentId,
        pointerIndex,
        state: 'archive_pending',
        stagingPath,
        archivePath: null,
        sha256: digest,
        bytes: bytes.length,
        error: null,
        createdAt: now
      })
      staged += 1
    } catch (error) {
      incomplete += 1
      appendEvent(db, {
        incidentId,
        pointerIndex,
        state: 'archive_incomplete',
        stagingPath: null,
        archivePath: null,
        sha256: null,
        bytes: null,
        error: error instanceof Error ? error.message.slice(0, 300) : 'staging_failed',
        createdAt: now
      })
    }
  })
  return { staged, incomplete }
}

/** Archive layout: `<root>/<run or _unattributed/<host>>/incidents/<id>/<index>-<name>`. */
function archiveTarget(root: string, bucket: string, incidentId: string, pointerIndex: number, name: string): string {
  return join(root, bucket, 'incidents', incidentId, `${pointerIndex}-${name}`)
}

function bucketFor(row: Record<string, unknown>): string {
  const run = typeof row.run_id === 'string' && row.run_id.length > 0 ? row.run_id : null
  if (run !== null) {
    return run
  }
  const host = typeof row.host_id === 'string' && row.host_id.length > 0 ? row.host_id : 'local'
  return join('_unattributed', host)
}

/** Below the archive root every directory this writer names stays private; the excerpt file too. */
const ARCHIVE_DIRECTORY_MODE = 0o700
const ARCHIVE_FILE_MODE = 0o600

function looseModeBits(path: string): number {
  return statSync(path).mode & 0o077
}

/**
 * fsync a directory so a created entry or a rename inside it survives a crash.
 *
 * Best effort on purpose, the same trade the shared durable-write helper makes: Windows cannot open a
 * directory for fsync and some filesystems reject it, while the file fsync below is the load-bearing
 * part. What this mount actually does is measured, not assumed (M8 finish report, task E).
 */
function syncDirectoryBestEffort(path: string): void {
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    fsyncSync(fd)
  } catch {
    // Unsupported platform or filesystem: the rename and the file fsync still happened.
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        // The fsync already happened or the open failed; nothing actionable.
      }
    }
  }
}

/**
 * Directories between the archive root (exclusive) and `directory` (inclusive), deepest first.
 *
 * The root is the boundary on purpose: it is deployment input and may be a shared tree whose mode was
 * chosen deliberately, so this writer never creates it under its own policy and never chmods it.
 */
function archiveOwnedDirectories(root: string, directory: string): string[] {
  const owned: string[] = []
  const stop = resolve(root)
  let current = resolve(directory)
  for (;;) {
    const rel = relative(stop, current)
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      break
    }
    owned.push(current)
    const parent = dirname(current)
    if (parent === current) {
      break
    }
    current = parent
  }
  return owned
}

/**
 * Create the evidence directory chain private, and keep the whole owned chain private.
 *
 * Why: `mkdirSync(..., { recursive: true })` with no `mode` inherits the process umask, so under the
 * common 022 the archive directories landed 0755 — run ids, host ids and incident ids sitting in
 * world-traversable path components even though the excerpt itself was 0600 (real-filesystem drill
 * finding F1). Two things fix that: the created chain is requested at 0700, and then every owned
 * directory is *verified*, because a `mode` argument is only an upper bound on a create — a directory
 * left wide by an earlier build, or widened by an inherited ACL, must not silently receive evidence.
 * If a directory cannot be made private the call throws, so the pointer stays `archive_pending` (a
 * visible non-durable state) instead of putting an excerpt in a leaking path.
 *
 * Returns the directories this call created so the caller can fsync their parent entries.
 */
function ensurePrivateArchiveDirectories(root: string, directory: string): string[] {
  const owned = archiveOwnedDirectories(root, directory)
  const created = owned.filter((path) => !existsSync(path))
  if (created.length > 0) {
    mkdirSync(directory, { recursive: true, mode: ARCHIVE_DIRECTORY_MODE })
  }
  for (const path of owned) {
    if (looseModeBits(path) === 0) {
      continue
    }
    chmodSync(path, ARCHIVE_DIRECTORY_MODE)
    const remaining = looseModeBits(path)
    if (remaining !== 0) {
      throw new Error(`archive_directory_mode:${path}:${remaining.toString(8)}`)
    }
  }
  return created
}

/**
 * Publish one excerpt durably: temp file 0600 in the target directory, fsync the file, rename it into
 * place, fsync the containing directory. The hash read-back that can set `archived` runs after this,
 * in the caller, so a same-process read can never stand in for the write having reached the filesystem.
 *
 * Why the temp file is created here instead of through `writeFileDurableSync`: that helper writes its
 * payload with the process default mode, which would briefly expose an excerpt as 0644 under umask
 * 022. The platform-specific tail (rename with the Windows retry, then the directory fsync) is the
 * shared helper, so there is no second implementation of that part.
 *
 * What this does NOT prove: that a different NFS client sees the bytes, or that the server committed
 * them to stable storage. See the M8 finish report for the measured behaviour of this mount.
 */
function writeArchiveEvidenceFile(options: {
  root: string
  target: string
  bytes: Buffer
  write?: (path: string, bytes: Buffer) => void
  sync?: (path: string) => void
}): void {
  const { root, target, bytes } = options
  const created = ensurePrivateArchiveDirectories(root, dirname(target))
  const tmpPath = durableWriteTempPath(target)
  let published = false
  try {
    // `wx` with 0600: the excerpt is never group/other-readable, not even as a temp file.
    const fd = openSync(tmpPath, 'wx', ARCHIVE_FILE_MODE)
    closeSync(fd)
    if (options.write === undefined) {
      writeFileSync(tmpPath, bytes)
    } else {
      options.write(tmpPath, bytes)
    }
    if (options.sync === undefined) {
      const syncFd = openSync(tmpPath, 'r+')
      try {
        fsyncSync(syncFd)
      } finally {
        closeSync(syncFd)
      }
    } else {
      options.sync(tmpPath)
    }
    renameDurableSync(tmpPath, target)
    published = true
  } finally {
    if (!published) {
      try {
        rmSync(tmpPath, { force: true })
      } catch {
        // The next tick retries the pointer; a leftover temp is inert and unpublishable.
      }
    }
    // Entry durability for a newly created bucket/incidents/<id> chain. Only the first pointer of a
    // drain pays for it; later pointers find the directories already present.
    for (const path of created) {
      syncDirectoryBestEffort(dirname(path))
    }
  }
}

export type DrainResult = {
  configured: boolean
  archived: number
  incomplete: number
  failed: number
  remaining: number
}

/**
 * Reclaim the local retry copy of a pointer whose `archived` event is already committed.
 *
 * Why only after `archived`: that event exists only after the excerpt was published under the archive
 * root and read back with a matching SHA-256, so the local staging file is by then a second copy of
 * durable evidence. In every earlier state the staging file can be the ONLY copy (see
 * `INCIDENT_IDS_WITH_RETRY_BYTES_SQL`), and deleting it there would destroy the material the audit
 * claim depends on.
 *
 * Order: unlink this pointer's file, then remove the incident's staging directory only if it is empty.
 * Another pointer of the same incident may still be pending, and then the directory must stay.
 *
 * A cleanup failure is retryable leakage, never an archive outcome: the bytes stay, the committed
 * `archived` event stands, and the pointer is reported archived. It must not be retracted because a
 * directory was busy, and a leftover file is inert — a later drain of a sibling pointer in the same
 * incident retries the directory removal, and the orphaned bytes are only reachable by an operator
 * inspecting the tree.
 */
function reclaimStagingCopy(options: {
  stagingPath: string
  remove: (path: string) => void
}): void {
  const { stagingPath, remove } = options
  try {
    remove(stagingPath)
  } catch (error) {
    console.warn(
      `[incidents] staging cleanup failed for ${stagingPath}:`,
      error instanceof Error ? error.message : String(error)
    )
    return
  }
  try {
    // `rmdirSync` and not `rmSync`: removing only an empty directory is the rule, and ENOTEMPTY is the
    // expected answer while a sibling pointer is still pending.
    rmdirSync(dirname(stagingPath))
  } catch {
    // Not empty, or already gone. Both are correct and neither is an archive failure.
  }
}

/**
 * Move pending excerpts to the archive, verifying each by reading it back.
 *
 * A transient failure (NAS down, permission, full disk) leaves the row `archive_pending` so the next
 * tick retries; a read-back mismatch is written as `archive_incomplete` and never as success.
 */
export function drainEvidenceArchive(options: {
  db: Database.Database
  root: string | null
  now: number
  limit?: number
  /** Test seam: replace the archive write to inject a read-back mismatch or an I/O failure. */
  write?: (path: string, bytes: Buffer) => void
  /** Test seam: replace the file fsync, so a failing barrier can be observed without a bad disk. */
  sync?: (path: string) => void
  /** Test seam: replace the staging unlink, so a cleanup failure can be observed without a bad disk. */
  remove?: (path: string) => void
}): DrainResult {
  const { db, root, now } = options
  const limit = options.limit ?? 50
  const remove = options.remove ?? ((path: string) => rmSync(path, { force: true }))
  if (root === null) {
    return { configured: false, archived: 0, incomplete: 0, failed: 0, remaining: pendingCount(db) }
  }
  const pending = db
    .prepare(
      `SELECT s.incident_id, s.pointer_index, s.staging_path, s.sha256, i.run_id, i.host_id
         FROM incident_evidence_archive_state s
         JOIN incidents i ON i.id = s.incident_id
        WHERE s.state = 'archive_pending'
        ORDER BY s.created_at ASC
        LIMIT ?`
    )
    .all(limit) as Record<string, unknown>[]
  let archived = 0
  let incomplete = 0
  let failed = 0
  for (const row of pending) {
    const incidentId = String(row.incident_id)
    const pointerIndex = Number(row.pointer_index)
    const stagingPath = row.staging_path === null ? null : String(row.staging_path)
    if (stagingPath === null || !existsSync(stagingPath)) {
      incomplete += 1
      appendEvent(db, {
        incidentId,
        pointerIndex,
        state: 'archive_incomplete',
        stagingPath,
        archivePath: null,
        sha256: row.sha256 === null ? null : String(row.sha256),
        bytes: null,
        error: 'staging_missing',
        createdAt: now
      })
      continue
    }
    const bytes = readFileSync(stagingPath)
    const target = archiveTarget(
      root,
      bucketFor(row),
      incidentId,
      pointerIndex,
      'excerpt.bin'
    )
    try {
      writeArchiveEvidenceFile({
        root,
        target,
        bytes,
        ...(options.write === undefined ? {} : { write: options.write }),
        ...(options.sync === undefined ? {} : { sync: options.sync })
      })
    } catch (error) {
      // Transient: leave it pending. The next tick retries and the CLI keeps saying "pending".
      failed += 1
      void error
      continue
    }
    let readBack: Buffer
    try {
      readBack = readFileSync(target)
    } catch {
      failed += 1
      continue
    }
    const expected = row.sha256 === null ? sha256(bytes) : String(row.sha256)
    if (sha256(readBack) !== expected) {
      incomplete += 1
      appendEvent(db, {
        incidentId,
        pointerIndex,
        state: 'archive_incomplete',
        stagingPath,
        archivePath: target,
        sha256: expected,
        bytes: bytes.length,
        error: 'sha256_mismatch',
        createdAt: now
      })
      continue
    }
    archived += 1
    appendEvent(db, {
      incidentId,
      pointerIndex,
      state: 'archived',
      stagingPath,
      archivePath: target,
      sha256: expected,
      bytes: bytes.length,
      error: null,
      createdAt: now
    })
    // After the committed `archived`, never before: see `reclaimStagingCopy`.
    reclaimStagingCopy({ stagingPath, remove })
  }
  return { configured: true, archived, incomplete, failed, remaining: pendingCount(db) }
}

function pendingCount(db: Database.Database): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM incident_evidence_archive_state WHERE state = 'archive_pending'")
    .get()
  return row ? Number(row.n ?? 0) : 0
}

/** Latest state per pointer, for one incident or all of them. */
export function readEvidenceArchiveState(db: Database.Database, incidentId?: string): EvidenceArchiveRow[] {
  const rows = (
    incidentId === undefined
      ? db
          .prepare(
            `SELECT incident_id, pointer_index, state, staging_path, archive_path, sha256, bytes, error, created_at
               FROM incident_evidence_archive_state
              ORDER BY incident_id ASC, pointer_index ASC`
          )
          .all()
      : db
          .prepare(
            `SELECT incident_id, pointer_index, state, staging_path, archive_path, sha256, bytes, error, created_at
               FROM incident_evidence_archive_state
              WHERE incident_id = ?
              ORDER BY pointer_index ASC`
          )
          .all(incidentId)
  ) as Record<string, unknown>[]
  return rows.map((row) => ({
    incidentId: String(row.incident_id),
    pointerIndex: Number(row.pointer_index),
    state: row.state as EvidenceArchiveState,
    stagingPath: row.staging_path === null ? null : String(row.staging_path),
    archivePath: row.archive_path === null ? null : String(row.archive_path),
    sha256: row.sha256 === null ? null : String(row.sha256),
    bytes: row.bytes === null ? null : Number(row.bytes),
    error: row.error === null ? null : String(row.error),
    createdAt: Number(row.created_at)
  }))
}

/**
 * Why an explicit retry of an `archive_incomplete` pointer was accepted or refused.
 *
 * `retried` is the only code that appends anything; every other code is a refusal that leaves the
 * event log and the latest state exactly as they were. The codes are machine-readable on purpose:
 * the CLI prints them and `--json` emits them, so a script can tell "nothing to repair" from
 * "cannot be repaired".
 */
export type ArchiveRetryCode =
  | 'retried'
  | 'no_incomplete_pointer'
  | 'unknown_pointer'
  | 'already_pending'
  | 'already_archived'
  | 'not_staged'
  | 'staging_missing'

export type ArchiveRetryEntry = {
  incidentId: string
  pointerIndex: number
  code: ArchiveRetryCode
  /** The latest state this call saw; null when the pointer has no archive event yet. */
  state: EvidenceArchiveState | null
  stagingPath: string | null
  sha256: string | null
  bytes: number | null
}

export type ArchiveRetryResult = {
  incidentId: string
  /** The batch verdict: `retried` if anything was appended, else the no-op reason. */
  code: 'retried' | 'no_incomplete_pointer' | 'unknown_pointer'
  retried: number
  refused: number
  pointers: ArchiveRetryEntry[]
}

function retryEntry(
  row: Pick<EvidenceArchiveRow, 'incidentId' | 'pointerIndex' | 'stagingPath' | 'sha256' | 'bytes'>,
  state: EvidenceArchiveState | null,
  code: ArchiveRetryCode
): ArchiveRetryEntry {
  return {
    incidentId: row.incidentId,
    pointerIndex: row.pointerIndex,
    code,
    state,
    stagingPath: row.stagingPath,
    sha256: row.sha256,
    bytes: row.bytes
  }
}

/**
 * Classify one latest state, and append the re-queueing event only for `archive_incomplete` whose
 * staging excerpt is still readable. The one write this function can perform is the append.
 */
function retryOnePointer(options: {
  db: Database.Database
  row: EvidenceArchiveRow
  now: number
  readStaging: (path: string) => Buffer
  append: boolean
}): ArchiveRetryEntry {
  const { db, row, now, readStaging, append } = options
  if (row.state !== 'archive_incomplete') {
    const code: ArchiveRetryCode =
      row.state === 'archived'
        ? 'already_archived'
        : row.state === 'archive_pending'
          ? 'already_pending'
          : 'not_staged'
    return retryEntry(row, row.state, code)
  }
  if (row.stagingPath === null) {
    return retryEntry(row, row.state, 'staging_missing')
  }
  try {
    // A real read, not an exists() guess: an unreadable excerpt cannot be published, so re-queueing it
    // would promise a publish no drain can perform.
    readStaging(row.stagingPath)
  } catch {
    return retryEntry(row, row.state, 'staging_missing')
  }
  if (append) {
    appendEvent(db, {
      incidentId: row.incidentId,
      pointerIndex: row.pointerIndex,
      state: 'archive_pending',
      stagingPath: row.stagingPath,
      archivePath: null,
      sha256: row.sha256,
      bytes: row.bytes,
      error: null,
      createdAt: now
    })
  }
  return retryEntry(row, 'archive_pending', 'retried')
}

/**
 * Explicit, append-only repair for a pointer whose latest state is `archive_incomplete`.
 *
 * Why this exists: the drain only selects latest-state `archive_pending`, so a `sha256_mismatch` (or a
 * `staging_missing`) is terminal — no amount of draining retries it. The review's option A was to give
 * an operator one explicit way back instead of a silent re-drain, so this appends a NEW
 * `archive_pending` event and lets the ordinary drain republish. Nothing is ever UPDATEd or DELETEd:
 * the appended event IS the audit trail, and the state vocabulary is unchanged.
 *
 * Deliberately narrow:
 * * only `archive_incomplete` may be retried (`staged`/`archive_pending`/`archived` are refused with
 *   their own code, so a second call after a successful retry cannot double-append);
 * * the local staging excerpt must still be readable — a real `readFileSync`, not an exists() guess —
 *   because a missing staging file cannot be repaired by any drain;
 * * the appended event carries the same `staging_path`, `sha256` and `bytes` as the event it replaces,
 *   with `error: null`. It does not re-baseline the hash: if the staging bytes changed since the failed
 *   attempt, the next drain records a fresh `sha256_mismatch` rather than silently accepting new bytes.
 *
 * No target cleanup is needed: the drain publishes through a 0600 temp file, fsync and rename, so it
 * overwrites the bad file. If that publication fails the row stays `archive_pending`, as before.
 */
export function retryIncompleteArchive(options: {
  db: Database.Database
  incidentId: string
  /** Retry only this pointer index; omitted means every latest `archive_incomplete` pointer. */
  pointerIndex?: number
  now: number
  /** Test seam: replace the staging read, so an unreadable excerpt can be injected. */
  readStaging?: (path: string) => Buffer
}): ArchiveRetryResult {
  const { db, incidentId, now } = options
  const pointerIndex = options.pointerIndex
  const readStaging =
    options.readStaging === undefined ? (path: string) => readFileSync(path) : options.readStaging
  const considered = (rows: EvidenceArchiveRow[], append: boolean): ArchiveRetryEntry[] =>
    rows.map((row) => retryOnePointer({ db, row, now, readStaging, append }))
  const summarise = (entries: ArchiveRetryEntry[]): ArchiveRetryResult => {
    const retried = entries.filter((entry) => entry.code === 'retried').length
    return {
      incidentId,
      code: retried > 0 ? 'retried' : 'no_incomplete_pointer',
      retried,
      refused: entries.length - retried,
      pointers: entries
    }
  }

  const latest = readEvidenceArchiveState(db, incidentId).filter(
    (row) => pointerIndex === undefined || row.pointerIndex === pointerIndex
  )
  if (pointerIndex !== undefined && latest.length === 0) {
    // An index the incident never had is a different answer from "it exists and is not incomplete".
    return {
      incidentId,
      code: 'unknown_pointer',
      retried: 0,
      refused: 1,
      pointers: [
        {
          incidentId,
          pointerIndex,
          code: 'unknown_pointer',
          state: null,
          stagingPath: null,
          sha256: null,
          bytes: null
        }
      ]
    }
  }
  if (!latest.some((row) => row.state === 'archive_incomplete')) {
    // Nothing can be appended, so no write transaction is opened — and the per-pointer reasons are
    // still reported (pending / archived / never staged) instead of a single opaque no-op.
    return summarise(considered(latest, false))
  }

  return runIncidentsTransaction(db, () => {
    // Re-read INSIDE the transaction: `BEGIN IMMEDIATE` serialises writers, so a second call sees the
    // first call's committed `archive_pending` instead of the stale `archive_incomplete` it queued on.
    const rechecked = readEvidenceArchiveState(db, incidentId).filter(
      (row) => pointerIndex === undefined || row.pointerIndex === pointerIndex
    )
    return summarise(considered(rechecked, true))
  })
}

export type ArchiveSummary = {
  /** Pointers the incident row carries. 0 means "no evidence was ever offered", not "not staged". */
  pointers: number
  staged: number
  pending: number
  archived: number
  incomplete: number
  /** True only when every pointer on the row is archived. Never inferred from an empty set. */
  durable: boolean
}

/** Compact per-incident summary. An incident with no evidence pointers has no rows and is not durable. */
export function summarizeArchive(
  states: readonly EvidenceArchiveRow[],
  pointerCount: number = states.length
): ArchiveSummary {
  const summary: ArchiveSummary = {
    pointers: pointerCount,
    staged: 0,
    pending: 0,
    archived: 0,
    incomplete: 0,
    durable: false
  }
  for (const state of states) {
    if (state.state === 'staged') summary.staged += 1
    else if (state.state === 'archive_pending') summary.pending += 1
    else if (state.state === 'archived') summary.archived += 1
    else summary.incomplete += 1
  }
  summary.durable = pointerCount > 0 && summary.archived === pointerCount
  return summary
}

/**
 * The archive truth a reader may state for one incident: the compact summary plus the per-pointer
 * state, so `show` names `archived` per pointer instead of asserting one flat verdict.
 */
export type IncidentArchiveDetail = {
  summary: ArchiveSummary
  /** Latest state per pointer index; a pointer with no row here was never staged. */
  states: readonly EvidenceArchiveRow[]
}

export function readIncidentArchiveDetail(
  db: Database.Database,
  incidentId: string,
  pointerCount: number
): IncidentArchiveDetail {
  const states = readEvidenceArchiveState(db, incidentId)
  return { summary: summarizeArchive(states, pointerCount), states }
}

/**
 * The label both renderers print for one pointer.
 *
 * Why it lives here: the plain view and `--md` each normalized the state names themselves once, and
 * they disagreed (`archive_incomplete` stayed verbatim in one and became `incomplete` in the other).
 */
export function evidenceArchiveStateLabel(state: EvidenceArchiveState | undefined): string {
  if (state === undefined) {
    return 'not staged'
  }
  if (state === 'archive_pending') {
    return 'pending'
  }
  if (state === 'archive_incomplete') {
    return 'incomplete'
  }
  return state
}

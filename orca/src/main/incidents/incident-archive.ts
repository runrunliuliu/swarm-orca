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
//     `durable=false`.
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
  statSync,
  writeFileSync,
  fsyncSync
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { durableWriteTempPath, renameDurableSync } from '../durable-file-write'
import type Database from '../sqlite/sync-database'
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
}): DrainResult {
  const { db, root, now } = options
  const limit = options.limit ?? 50
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


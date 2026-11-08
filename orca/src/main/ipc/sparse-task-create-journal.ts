// M4 (minimum durable half): a task create records what it is about to do before it does it.
//
// Why before the first Git side effect: `git worktree add` can outlive the request that started it
// (timeout, abort, lost response). Afterwards the caller holds an error and nothing else, so "did
// this create touch the disk?" becomes guesswork. An intent written first — and settled after —
// turns that guess into a readable state, without inventing a second source of truth: the journal
// never claims a workspace is ready, it only says which attempt may have left one behind.
//
// Nothing here deletes, repairs or re-runs a create. Reading is read-only by construction.

import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { getOrcaUserDataPath } from '../codex/codex-home-paths'

export const SPARSE_TASK_CREATE_JOURNAL_VERSION = 1 as const

/** `pending` is the only non-terminal state; a stale one is reported as needs_reconciliation. */
export type SparseTaskCreateState = 'pending' | 'created' | 'failed' | 'needs_reconciliation'

/** What a later reader saw on disk for one attempt. Never changes the attempt's own state. */
export type SparseTaskCreateObservation = {
  /** `exited` = the attempt left nothing behind; `live` = it left a usable workspace. */
  state: 'live' | 'exited' | 'unverifiable'
  at: number
  reasons: string[]
}

export type SparseTaskCreateRecord = {
  recordVersion: typeof SPARSE_TASK_CREATE_JOURNAL_VERSION
  /** Client-side identity of this attempt, stable across a retry that reuses it. */
  requestId: string
  repoId: string
  repoPath: string
  worktreePath: string
  branch: string
  pinnedSha: string
  requestedSparseCone: string[]
  requiredPaths: string[]
  state: SparseTaskCreateState
  reasons: string[]
  createdAt: number
  updatedAt: number
  /** Annotated by a read-only inspection; absent until something asked. */
  observation?: SparseTaskCreateObservation
}

/** Entries kept per repo: enough to explain recent attempts, bounded so the directory cannot grow. */
const MAX_RECORDS_PER_REPO = 50
/** A `pending` record older than this can no longer be assumed to be in flight. */
const PENDING_STALE_MS = 15 * 60_000

function journalDir(): string {
  // Why an override: tests must not write into the real userData, and support needs a way to point
  // the journal at a readable copy.
  return process.env.ORCA_SPARSE_TASK_JOURNAL_DIR || join(getOrcaUserDataPath(), 'sparse-task-creates')
}

function sanitizeComponent(value: string, fallback: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128)
  return safe.length > 0 && safe !== '.' && safe !== '..' ? safe : fallback
}

function repoDir(repoId: string): string {
  return join(journalDir(), sanitizeComponent(repoId, 'unknown-repo'))
}

/**
 * Why one file per attempt instead of one file per repo: recording an intent is a read-merge-write
 * on a shared file otherwise, and two creates starting at the same time would each write the whole
 * set — the later one silently dropping the earlier one's `pending`, which is exactly the trace that
 * must survive. Per-attempt files have no merge step to lose.
 */
function recordPath(repoId: string, requestId: string): string {
  return join(repoDir(repoId), `${sanitizeComponent(requestId, 'unknown-request')}.json`)
}

function isRecord(value: unknown): value is SparseTaskCreateRecord {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const record = value as Partial<SparseTaskCreateRecord>
  return (
    typeof record.requestId === 'string' &&
    typeof record.repoId === 'string' &&
    typeof record.state === 'string'
  )
}

/**
 * Read every attempt for a repo, oldest first.
 *
 * Why skip unparsable files instead of failing: a corrupt record is a diagnostics problem, not a
 * reason to refuse later creates. The file stays where it is — nothing rewrites it — and the caller
 * simply does not see a record it cannot trust.
 */
async function readJournal(repoId: string): Promise<SparseTaskCreateRecord[]> {
  let names: string[]
  try {
    names = await readdir(repoDir(repoId))
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') {
      return []
    }
    throw error
  }
  const records: SparseTaskCreateRecord[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) {
      continue
    }
    try {
      const parsed: unknown = JSON.parse(await readFile(join(repoDir(repoId), name), 'utf8'))
      if (isRecord(parsed)) {
        records.push(parsed)
      }
    } catch {
      continue
    }
  }
  return records.sort((left, right) => left.createdAt - right.createdAt)
}

async function writeRecord(record: SparseTaskCreateRecord): Promise<void> {
  const target = recordPath(record.repoId, record.requestId)
  await mkdir(repoDir(record.repoId), { recursive: true })
  // Why a random suffix: two settles of the same attempt can overlap, and a shared temp name would
  // let one rename the other's half-written file into place.
  const temp = `${target}.${randomUUID()}.tmp`
  await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  await rename(temp, target)
}

/** Best-effort trim: drop the oldest settled attempts beyond the cap, never an unsettled one. */
async function pruneSettled(repoId: string): Promise<void> {
  const records = await readJournal(repoId)
  if (records.length <= MAX_RECORDS_PER_REPO) {
    return
  }
  const settled = records.filter(
    (record) => record.state === 'created' || record.state === 'failed'
  )
  const excess = records.length - MAX_RECORDS_PER_REPO
  for (const record of settled.slice(0, excess)) {
    try {
      await unlink(recordPath(repoId, record.requestId))
    } catch {
      // Why ignore: the record is already settled and bounded elsewhere; failing a create over a
      // cosmetic cleanup would be worse than one extra file.
    }
  }
}

/** What the stopped create path needs to record; everything but these four is derived. */
export type SparseTaskCreateIntent = {
  repoId: string
  repoPath: string
  worktreePath: string
  branch: string
  pinnedSha: string
  requestedSparseCone: readonly string[]
  requiredPaths: readonly string[]
  /** Reused by a retry so both attempts show under one identity. */
  requestId?: string
}

/**
 * Record the intent. Callers must run this **before** the first side effect and abort the create if
 * it throws: a create nobody can trace afterwards is exactly what this journal exists to prevent.
 */
export async function beginSparseTaskCreate(
  intent: SparseTaskCreateIntent
): Promise<SparseTaskCreateRecord> {
  const now = Date.now()
  const record: SparseTaskCreateRecord = {
    recordVersion: SPARSE_TASK_CREATE_JOURNAL_VERSION,
    requestId: intent.requestId ?? randomUUID(),
    repoId: intent.repoId,
    repoPath: intent.repoPath,
    worktreePath: intent.worktreePath,
    branch: intent.branch,
    pinnedSha: intent.pinnedSha.toLowerCase(),
    requestedSparseCone: [...intent.requestedSparseCone],
    requiredPaths: [...intent.requiredPaths],
    state: 'pending',
    reasons: [],
    createdAt: now,
    updatedAt: now
  }
  await writeRecord(record)
  await pruneSettled(intent.repoId).catch(() => undefined)
  return record
}

/**
 * Settle a pending record. Never throws into a create that already produced side effects — the
 * attempt stays `pending` and later reads report it as `needs_reconciliation`, which is the honest
 * answer for "we no longer know whether this finished".
 */
export async function settleSparseTaskCreate(args: {
  repoId: string
  requestId: string
  state: Exclude<SparseTaskCreateState, 'pending'>
  reasons?: readonly string[]
}): Promise<void> {
  try {
    const records = await readJournal(args.repoId)
    const existing = records.find((record) => record.requestId === args.requestId)
    if (!existing) {
      // Why not invent one: without an intent there was no side effect to explain, and fabricating a
      // record would make the journal claim an attempt that never started.
      console.warn(`[sparse-task] no intent recorded for create ${args.requestId}; not settling it`)
      return
    }
    await writeRecord({
      ...existing,
      state: args.state,
      reasons: [...(args.reasons ?? [])],
      updatedAt: Date.now()
    })
  } catch (error) {
    console.warn(
      `[sparse-task] could not settle create ${args.requestId} as ${args.state}:`,
      error
    )
  }
}

/**
 * Read the history for a repo. A `pending` entry that can no longer be in flight is reported as
 * `needs_reconciliation` — computed at read time, never rewritten, so the file stays what was
 * actually observed.
 */
export async function readSparseTaskCreates(repoId: string): Promise<SparseTaskCreateRecord[]> {
  const records = await readJournal(repoId)
  const now = Date.now()
  return records.map((record) =>
    record.state === 'pending' && now - record.updatedAt > PENDING_STALE_MS
      ? {
          ...record,
          state: 'needs_reconciliation' as const,
          reasons: [
            ...record.reasons,
            'the create never settled; check the workspace before retrying'
          ]
        }
      : record
  )
}

/**
 * Annotate one attempt with what a read-only inspection saw.
 *
 * Why not settle it: the attempt's own state is what the create path recorded; a later observation is
 * a different fact (the workspace may be fixed, or destroyed, after the fact). Keeping them separate
 * means a settled attempt cannot be rewritten by a probe, and an unsettled one cannot be marked done
 * by one either.
 */
export async function recordSparseTaskCreateObservation(args: {
  repoId: string
  requestId: string
  observation: SparseTaskCreateObservation
}): Promise<void> {
  try {
    const records = await readJournal(args.repoId)
    const existing = records.find((record) => record.requestId === args.requestId)
    if (!existing) {
      return
    }
    await writeRecord({ ...existing, observation: args.observation, updatedAt: Date.now() })
  } catch (error) {
    // Why swallow: this runs on the read path; failing a status query over an annotation would make
    // the diagnostic worse than the thing it diagnoses.
    console.warn(`[sparse-task] could not annotate create ${args.requestId}:`, error)
  }
}

/** The records still worth a human's attention, newest last. */
export async function readUnsettledSparseTaskCreates(
  repoId: string
): Promise<SparseTaskCreateRecord[]> {
  return (await readSparseTaskCreates(repoId)).filter(
    (record) => record.state === 'pending' || record.state === 'needs_reconciliation'
  )
}

// M4 (minimum durable half): a task create records what it is about to do before it does it.
//
// Why before the first Git side effect: `git worktree add` can outlive the request that started it
// (timeout, abort, lost response). Afterwards the caller holds an error and nothing else, so "did
// this create touch the disk?" becomes guesswork. An intent written first — and settled after —
// turns that guess into a readable state, without inventing a second source of truth: the journal
// never claims a workspace is ready, it only says which attempt may have left one behind.
//
// Nothing here deletes, repairs or re-runs a create. Reading is read-only by construction.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { getOrcaUserDataPath } from '../codex/codex-home-paths'

export const SPARSE_TASK_CREATE_JOURNAL_VERSION = 1 as const

/** `pending` is the only non-terminal state; a stale one is reported as needs_reconciliation. */
export type SparseTaskCreateState = 'pending' | 'created' | 'failed' | 'needs_reconciliation'

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
}

/** Entries kept per repo: enough to explain recent attempts, bounded so the file cannot grow. */
const MAX_RECORDS_PER_REPO = 50
/** A `pending` record older than this can no longer be assumed to be in flight. */
const PENDING_STALE_MS = 15 * 60_000

function journalDir(): string {
  // Why an override: tests must not write into the real userData, and support needs a way to point
  // the journal at a readable copy.
  return process.env.ORCA_SPARSE_TASK_JOURNAL_DIR || join(getOrcaUserDataPath(), 'sparse-task-creates')
}

function journalPath(repoId: string): string {
  // Why sanitize: a repo id reaches a file name, and an id is not a path component by contract.
  const safe = repoId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128) || 'unknown-repo'
  return join(journalDir(), `${safe}.json`)
}

type JournalFile = { version: number; records: SparseTaskCreateRecord[] }

async function readJournal(repoId: string): Promise<SparseTaskCreateRecord[]> {
  let raw: string
  try {
    raw = await readFile(journalPath(repoId), 'utf8')
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') {
      return []
    }
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Why not throw: a corrupt journal is a diagnostics problem, not a reason to refuse every later
    // create. The caller sees an empty history and the file stays for inspection.
    return []
  }
  const records = (parsed as Partial<JournalFile>)?.records
  if (!Array.isArray(records)) {
    return []
  }
  return records.filter(
    (record): record is SparseTaskCreateRecord =>
      typeof record === 'object' && record !== null && typeof (record as { requestId?: unknown }).requestId === 'string'
  )
}

async function writeJournal(repoId: string, records: SparseTaskCreateRecord[]): Promise<void> {
  const target = journalPath(repoId)
  await mkdir(dirname(target), { recursive: true })
  const bounded = records.slice(-MAX_RECORDS_PER_REPO)
  const body: JournalFile = { version: SPARSE_TASK_CREATE_JOURNAL_VERSION, records: bounded }
  // Why tmp + rename: a killed write must not truncate the history it is appending to.
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temp, `${JSON.stringify(body, null, 2)}\n`, 'utf8')
  await rename(temp, target)
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
  const existing = await readJournal(intent.repoId)
  await writeJournal(intent.repoId, [...existing, record])
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
    const next = records.map((record) =>
      record.requestId === args.requestId
        ? {
            ...record,
            state: args.state,
            reasons: [...(args.reasons ?? [])],
            updatedAt: Date.now()
          }
        : record
    )
    await writeJournal(args.repoId, next)
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

/** The records still worth a human's attention, newest last. */
export async function readUnsettledSparseTaskCreates(
  repoId: string
): Promise<SparseTaskCreateRecord[]> {
  return (await readSparseTaskCreates(repoId)).filter(
    (record) => record.state === 'pending' || record.state === 'needs_reconciliation'
  )
}

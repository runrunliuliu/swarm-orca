import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync
} from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { z } from 'zod'
import Database from '../../../../sqlite/sync-database'
import type { OrchestrationDb } from '../orchestration-db'
import { LEGACY_RUN_ID } from '../contract-constants'
import { RESET_ALL_HISTORY_SQL } from './orchestration-reset'

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const Strings = z.array(z.string())
export const HistoryCleanupReview = z
  .object({
    operation: z.literal('archive-all-orchestration-history'),
    reason: z.string().min(1).max(2000),
    stateSHA256: z.string().regex(/^[a-f0-9]{64}$/),
    runIds: Strings,
    workers: z.array(
      z
        .object({
          dispatchId: z.string().min(1),
          verdict: z.enum(['exited', 'unverifiable'])
        })
        .strict()
    ),
    acknowledgeUnverifiable: Strings,
    evidenceSHA256: z.string().regex(/^[a-f0-9]{64}$/)
  })
  .strict()

function sameIds(actual: string[], expected: string[]): boolean {
  return (
    new Set(expected).size === expected.length &&
    JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort())
  )
}

// Content pin covers every table, including receipts, ownership and evidence, not just counts.
export function historyStateSHA256(database: Database.Database): string {
  const digest = createHash('sha256')
  const tables = z
    .array(z.object({ name: z.string() }))
    .parse(
      database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
    )
  for (const { name } of tables) {
    const rows = database.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all()
    const serialized = rows.map((row) => JSON.stringify(row, Object.keys(row).sort())).sort()
    digest.update(JSON.stringify([name, serialized]))
  }
  return digest.digest('hex')
}

export function inspectHistoryCleanup(db: OrchestrationDb) {
  const runIds = z
    .array(z.object({ id: z.string() }))
    .parse(db.db.prepare('SELECT id FROM runs WHERE legacy = 0 ORDER BY id').all())
    .map((row) => row.id)
  const dispatchIds = z
    .array(z.object({ id: z.string() }))
    .parse(db.db.prepare('SELECT id FROM dispatch_contexts ORDER BY id').all())
    .map((row) => row.id)
  return { stateSHA256: historyStateSHA256(db.db), runIds, dispatchIds }
}

function assertReview(db: OrchestrationDb, review: z.infer<typeof HistoryCleanupReview>): void {
  const inventory = inspectHistoryCleanup(db)
  if (
    inventory.stateSHA256 !== review.stateSHA256 ||
    !sameIds(inventory.runIds, review.runIds) ||
    !sameIds(
      inventory.dispatchIds,
      review.workers.map((worker) => worker.dispatchId)
    ) ||
    !sameIds(
      review.workers
        .filter((worker) => worker.verdict === 'unverifiable')
        .map((worker) => worker.dispatchId),
      review.acknowledgeUnverifiable
    )
  ) {
    throw new Error('administrative_history_review_mismatch')
  }
  if (
    db.db
      .prepare(
        "SELECT 1 FROM dispatch_contexts WHERE status NOT IN ('completed', 'failed', 'circuit_broken') LIMIT 1"
      )
      .get()
  ) {
    throw new Error('administrative_history_unsettled_dispatch')
  }
  if (
    db.db.prepare('SELECT 1 FROM federated_dispatches LIMIT 1').get() ||
    db.db.prepare('SELECT 1 FROM remote_dispatch_attachments LIMIT 1').get()
  ) {
    throw new Error('administrative_history_remote_cleanup_unsupported')
  }
}

function fenceHistory(db: OrchestrationDb, receiptId: string): void {
  const insert = db.db.prepare(
    'INSERT OR IGNORE INTO administrative_history_fences (kind, identity, receipt_id) VALUES (?, ?, ?)'
  )
  const address = (id: string | null, prefix = '') => {
    if (id) {
      insert.run('address', id, receiptId)
      if (prefix) {
        insert.run('address', `${prefix}:${id}`, receiptId)
      }
    }
  }
  const pane = (id: string | null) => {
    if (id) {
      insert.run('pane', id, receiptId)
    }
  }
  const owner = z.object({
    handle: z.string().nullable(),
    pane: z.string().nullable(),
    session: z.string().nullable()
  })
  for (const row of z.array(owner).parse(
    db.db
      .prepare(`
    SELECT coordinator_handle AS handle, coordinator_pane_key AS pane, coordinator_orca_session_id AS session FROM runs
    UNION SELECT assignee_handle, assignee_pane_key, assignee_orca_session_id FROM dispatch_contexts
    UNION SELECT creator_handle, creator_pane_key, creator_orca_session_id FROM dispatch_contexts
    UNION SELECT terminal_handle, pane_key, NULL FROM worker_terminal_resources
    UNION SELECT terminal_handle, NULL, NULL FROM run_coordinator_handles
  `)
      .all()
  )) {
    address(row.handle)
    address(row.session, 'session')
    pane(row.pane)
  }
  const pins = z
    .array(z.object({ authority: z.string() }))
    .parse(db.db.prepare('SELECT authority FROM strict_run_coordinators').all())
  for (const pin of pins) {
    const identity = z
      .object({ terminalHandle: z.string(), paneKey: z.string() })
      .parse(JSON.parse(pin.authority))
    address(identity.terminalHandle)
    pane(identity.paneKey)
  }
  for (const table of ['runs', 'tasks', 'dispatch_contexts'] as const) {
    const prefix = table === 'runs' ? 'run' : table === 'tasks' ? 'task' : 'dispatch'
    for (const row of z
      .array(z.object({ id: z.string() }))
      .parse(db.db.prepare(`SELECT id FROM ${table}`).all())) {
      if (row.id !== LEGACY_RUN_ID) {
        address(row.id, prefix)
      }
    }
  }
}

// Only the offline administrator entry imports this; never register it as an RPC or DB prototype method.
export async function cleanupAdministrativeHistory(
  db: OrchestrationDb,
  input: unknown,
  backupPath: string,
  assertMaintenanceStopped: () => void
) {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) {
    throw new Error('administrative_history_requires_local_root')
  }
  const review = HistoryCleanupReview.parse(input)
  assertMaintenanceStopped()
  assertReview(db, review)
  const parent = dirname(backupPath)
  if (
    !isAbsolute(backupPath) ||
    realpathSync(parent) !== parent ||
    existsSync(backupPath) ||
    (statSync(parent).mode & 0o077) !== 0
  ) {
    throw new Error('administrative_history_private_new_backup_required')
  }
  await db.db.backup(backupPath)
  chmodSync(backupPath, 0o600)
  for (const path of [backupPath, parent]) {
    const fd = openSync(path, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  }
  const backupSHA256 = hash(readFileSync(backupPath))
  const snapshot = new Database(backupPath, { readonly: true, fileMustExist: true })
  try {
    if (
      snapshot.pragma('integrity_check', { simple: true }) !== 'ok' ||
      historyStateSHA256(snapshot) !== review.stateSHA256
    ) {
      throw new Error('administrative_history_backup_verification_failed')
    }
  } finally {
    snapshot.close()
  }
  assertMaintenanceStopped()
  const receipt = {
    id: randomUUID(),
    completedAt: new Date().toISOString(),
    ...review,
    backupPath,
    backupSHA256,
    processExitProvenByCleanup: false,
    effect: 'history_removed_identities_quarantined' as const
  }
  db.db.pragma('synchronous = FULL')
  db.db.exec('BEGIN IMMEDIATE')
  try {
    assertReview(db, review)
    db.db
      .prepare('INSERT INTO administrative_history_receipts (id, receipt) VALUES (?, ?)')
      .run(receipt.id, JSON.stringify(receipt))
    fenceHistory(db, receipt.id)
    db.db
      .prepare(`INSERT INTO administrative_history_permits (run_id, receipt_id)
      SELECT run_id, ? FROM strict_run_coordinators`)
      .run(receipt.id)
    db.db.exec(
      `DELETE FROM strict_run_retirements; DELETE FROM strict_run_coordinators; ${RESET_ALL_HISTORY_SQL}`
    )
    db.db.prepare('DELETE FROM administrative_history_permits WHERE receipt_id = ?').run(receipt.id)
    assertMaintenanceStopped()
    db.db.exec('COMMIT')
  } catch (error) {
    if (db.db.isTransaction) {
      db.db.exec('ROLLBACK')
    }
    throw error
  }
  db.hasStrictCoordinatorRunsCache = false
  db.hasAdministrativeHistoryFences = true
  db.hasAnyDispatchContextsCache = undefined
  return receipt
}

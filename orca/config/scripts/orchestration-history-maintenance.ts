import { createHash } from 'node:crypto'
import {
  chownSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { OrchestrationDb } from '../../src/main/runtime/orchestration/db/orchestration-db'
import Database from '../../src/main/sqlite/sync-database'
import {
  cleanupAdministrativeHistory,
  inspectHistoryCleanup
} from '../../src/main/runtime/orchestration/db/reset/administrative-history-cleanup'
import {
  assertServerMaintenanceStopped,
  serverPidFromMaintenanceEvidence
} from '../../src/main/runtime/orchestration/db/reset/administrative-maintenance-guard'

// Deliberately offline and host-specific; never exposed through the ordinary CLI/RPC.
const profile = '/example/orca-server/config/orca'
const dbPath = join(profile, 'orchestration.db')
const servicePath = '/etc/service/orca-server'
const lock = '/run/orca-history-maintenance'
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

function privateFile(path: string): Buffer {
  const info = lstatSync(path)
  if (!info.isFile() || info.uid !== 0 || (info.mode & 0o077) !== 0) {
    throw new Error('administrative_history_private_root_file_required')
  }
  return readFileSync(path)
}

function writeNew(path: string, value: unknown): void {
  const fd = openSync(path, 'wx', 0o600)
  try {
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function restoreOwnership(uid: number, gid: number): void {
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (!existsSync(path)) {
      continue
    }
    if (!lstatSync(path).isFile()) {
      throw new Error('administrative_history_unsafe_database_file')
    }
    chownSync(path, uid, gid)
  }
}

async function main(): Promise<void> {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) {
    throw new Error('administrative_history_requires_local_root')
  }
  const [action, directory, reviewSHA256, ...extra] = process.argv.slice(2)
  if (
    !directory ||
    !['inspect', 'apply'].includes(action ?? '') ||
    extra.length ||
    (action === 'apply' ? !/^[a-f0-9]{64}$/.test(reviewSHA256 ?? '') : reviewSHA256 !== undefined)
  ) {
    throw new Error('usage: maintenance.cjs inspect PRIVATE_DIR | apply PRIVATE_DIR REVIEW_SHA256')
  }
  const dirInfo = lstatSync(directory)
  if (
    realpathSync(directory) !== directory ||
    !dirInfo.isDirectory() ||
    dirInfo.uid !== 0 ||
    (dirInfo.mode & 0o077) !== 0
  ) {
    throw new Error('administrative_history_private_root_directory_required')
  }
  const dbInfo = lstatSync(dbPath)
  if (
    !dbInfo.isFile() ||
    dbInfo.uid !== 1000 ||
    dbInfo.gid !== 1000 ||
    (dbInfo.mode & 0o077) !== 0
  ) {
    throw new Error('administrative_history_unexpected_database_owner')
  }
  const evidenceBytes = privateFile(join(directory, 'evidence.json'))
  const serverPid = serverPidFromMaintenanceEvidence(JSON.parse(evidenceBytes.toString()))
  const stopped = () => assertServerMaintenanceStopped(servicePath, serverPid)
  stopped()
  mkdirSync(lock, { mode: 0o700 })
  let db: OrchestrationDb | undefined
  try {
    stopped()
    if (action === 'inspect') {
      const rawBackup = join(directory, 'before-open.db')
      if (existsSync(rawBackup)) {
        throw new Error('administrative_history_backup_already_exists')
      }
      const original = new Database(dbPath, { readonly: true, fileMustExist: true })
      try {
        await original.backup(rawBackup)
      } finally {
        original.close()
      }
    }
    db = new OrchestrationDb(dbPath)
    stopped()
    if (action === 'inspect') {
      writeNew(join(directory, 'inventory.json'), inspectHistoryCleanup(db))
      console.log(JSON.stringify({ inspected: true, directory }))
    } else {
      const reviewBytes = privateFile(join(directory, 'review.json'))
      if (hash(reviewBytes) !== reviewSHA256) {
        throw new Error('administrative_history_review_hash_mismatch')
      }
      const review: unknown = JSON.parse(reviewBytes.toString())
      const evidenceSHA256 = hash(evidenceBytes)
      if (
        !review ||
        typeof review !== 'object' ||
        !('evidenceSHA256' in review) ||
        review.evidenceSHA256 !== evidenceSHA256
      ) {
        throw new Error('administrative_history_evidence_hash_mismatch')
      }
      const receipt = await cleanupAdministrativeHistory(
        db,
        review,
        join(directory, 'orchestration-before.db'),
        stopped
      )
      writeNew(join(directory, 'receipt.json'), receipt)
      console.log(JSON.stringify(receipt))
    }
  } finally {
    db?.close()
    restoreOwnership(dbInfo.uid, dbInfo.gid)
    rmdirSync(lock)
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})

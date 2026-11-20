import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TASK_RECORDS_MAX_RECORD_BYTES } from '../../../shared/task-records-types'
import {
  closeTestStores,
  createSqliteTestStore,
  readPersistedStateJson,
  writePersistedStateJson
} from '../../persistence-test-harness'

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
    getName: () => 'orca-test',
    getVersion: () => '0.0.0-test',
    isPackaged: false,
    on: () => {},
    whenReady: () => Promise.resolve()
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`enc:${value}`),
    decryptString: (value: Buffer) => value.toString().slice(4)
  },
  ipcMain: { on: () => {}, handle: () => {} },
  BrowserWindow: { getAllWindows: () => [] }
}))

const { Store } = await import('./store')

const ID = 'repo-1::/repo/feature'
const QUERY = { repoId: 'repo-1', itemType: 'issue' as const, number: 31 }

const stores: InstanceType<typeof Store>[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) {
    store.freezeWrites()
  }
  await closeTestStores()
  vi.restoreAllMocks()
})

function openStore(file: string): InstanceType<typeof Store> {
  const store = createSqliteTestStore(Store, { dataFile: file })
  stores.push(store)
  return store
}

function newDataFile(): string {
  return join(realpathSync(mkdtempSync(join(tmpdir(), 'orca-task-records-'))), 'orca-data.json')
}

function ledgerWithOneOverflowingRow() {
  return {
    version: 1,
    records: [
      {
        repoId: 'repo-1',
        itemType: 'issue',
        number: 31,
        worktreeId: ID,
        path: '/repo/feature',
        state: 'active',
        firstSeenAt: 50,
        updatedAt: 60
      },
      {
        repoId: 'repo-1',
        itemType: 'issue',
        number: 32,
        worktreeId: 'repo-1::/repo/overflow',
        path: `/${'x'.repeat(TASK_RECORDS_MAX_RECORD_BYTES)}`,
        state: 'active',
        firstSeenAt: 50,
        updatedAt: 60
      }
    ]
  }
}

describe('task records profile round trip', () => {
  it('does not persist a partial domain while the legacy seed defers', () => {
    const file = newDataFile()
    writePersistedStateJson(file, JSON.stringify({ taskRunHistory: ledgerWithOneOverflowingRow() }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const store = openStore(file)
    // A metadata write carrying a task link is the first thing that could create
    // the domain; it must not while the seed is deferred (issue #36 review B4).
    store.setWorktreeMeta(ID, { linkedIssue: 31 })
    store.flush()

    const onDisk = JSON.parse(readPersistedStateJson(file))
    expect(onDisk.taskRecords).toBeUndefined()
    expect(onDisk.taskRunHistory.records).toHaveLength(2)
    expect(store.getTaskRecordForTask(QUERY)).toBeNull()

    // The next start still attempts the seed: the domain was never committed, so
    // the deferred ledger remains the source of truth instead of a partial one.
    warn.mockClear()
    openStore(file)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('legacy migration deferred'))
  })

  it('preserves a newer-schema domain through a metadata write, save and reopen', () => {
    const file = newDataFile()
    const newer = {
      recordsVersion: 1,
      byId: {
        'task:github:repo-1:issue:31': {
          taskId: 'task:github:repo-1:issue:31',
          hostId: 'local',
          origin: { kind: 'external', provider: 'github', itemType: 'issue', number: 31 },
          bindings: [],
          createdAt: 1,
          updatedAt: 2,
          schemaVersion: 2
        }
      },
      externalIndex: {}
    }
    writePersistedStateJson(file, JSON.stringify({ taskRecords: newer }))

    const store = openStore(file)
    store.setWorktreeMeta(ID, { linkedIssue: 31 })
    store.flush()

    const onDisk = JSON.parse(readPersistedStateJson(file))
    // The payload this build cannot read survives byte-for-byte, and the writer
    // refused to add a binding under it (issue #36 review B5).
    expect(onDisk.taskRecords).toEqual(newer)
    expect(store.getTaskRecordForTask(QUERY)).toBeNull()

    openStore(file)
    expect(JSON.parse(readPersistedStateJson(file)).taskRecords).toEqual(newer)
  })
})

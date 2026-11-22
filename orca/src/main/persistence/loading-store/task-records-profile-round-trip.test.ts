import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  TASK_RECORD_SCHEMA_VERSION,
  TASK_RECORDS_MAX_RECORD_BYTES,
  type TaskRecord,
  type TaskWorkspaceBinding
} from '../../../shared/task-records-types'
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

function bindingFixture(): TaskWorkspaceBinding {
  return {
    worktreeId: ID,
    repoId: 'repo-1',
    hostId: 'local' as const,
    path: '/repo/feature',
    isArchived: true,
    boundAt: 100,
    boundBy: 'user' as const,
    lastVerifiedAt: 100,
    resolvedVia: 'locator' as const,
    sessions: []
  }
}

function taskRecordFixture(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: 'task:github:repo-1:issue:31',
    hostId: 'local',
    origin: { kind: 'external', provider: 'github', itemType: 'issue', number: 31 },
    bindings: [bindingFixture()],
    intent: {},
    createdAt: 100,
    updatedAt: 100,
    schemaVersion: TASK_RECORD_SCHEMA_VERSION,
    ...overrides
  }
}

function domainWith(record: TaskRecord) {
  return {
    recordsVersion: 1,
    byId: { [record.taskId]: record },
    externalIndex: { 'github:repo-1:issue:31': record.taskId }
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
          schemaVersion: TASK_RECORD_SCHEMA_VERSION + 1
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
  it("keeps a v2 record's runs and gaps through a metadata write, save and reopen", () => {
    const file = newDataFile()
    const record = taskRecordFixture({
      schemaVersion: TASK_RECORD_SCHEMA_VERSION,
      bindings: [
        {
          ...bindingFixture(),
          // A v1-era locator that was never confirmed: the metadata write below
          // resolves it, which is what forces the domain through a save.
          lastVerifiedAt: null,
          sessions: [
            {
              provider: 'claude',
              key: 'session_id',
              id: 'session-1',
              transcriptPath: '/home/u/session-1.jsonl',
              agentType: 'claude',
              title: 'Resume the trace',
              resumeCommand: 'claude --resume session-1',
              startedAt: 50,
              endedAt: 60,
              messageCount: 12,
              source: 'archive-snapshot',
              recordedAt: 70,
              transcriptCheck: {
                checkedAt: 70,
                presence: 'present',
                dev: 2_049,
                ino: 99,
                mtimeMs: 66,
                size: 1_234
              },
              firstSeenAt: 70,
              lastSeenAt: 70
            }
          ],
          runs: [
            {
              key: 'claude|session_id:session-1',
              providerSession: { provider: 'claude', key: 'session_id', id: 'session-1' },
              title: 'Resume the trace',
              agentType: 'claude',
              resumeCommand: 'claude --resume session-1',
              startedAt: 50,
              endedAt: 60,
              messageCount: 12,
              outcome: 'success',
              transcriptPath: '/home/u/session-1.jsonl',
              transcriptCheck: {
                checkedAt: 70,
                presence: 'present',
                dev: 2_049,
                ino: 99,
                mtimeMs: 66,
                size: 1_234
              },
              source: 'archive-snapshot',
              recordedAt: 70,
              firstSeenAt: 70,
              lastSeenAt: 70
            }
          ],
          gaps: [
            {
              kind: 'ambiguous_match',
              candidateCount: 2,
              observedAt: 70,
              detail: 'two sessions matched the path'
            }
          ]
        }
      ]
    })
    writePersistedStateJson(file, JSON.stringify({ taskRecords: domainWith(record) }))

    const store = openStore(file)
    // The write refreshes the binding and saves the normalized domain; the rows
    // this build just learned about must be in the saved payload, or the issue
    // #53 snapshot would vanish on the next start.
    store.setWorktreeMeta(ID, { linkedIssue: 31, isArchived: true })
    store.flush()

    const onDisk = JSON.parse(readPersistedStateJson(file))
    expect(onDisk.taskRecords.byId[record.taskId].schemaVersion).toBe(TASK_RECORD_SCHEMA_VERSION)
    expect(onDisk.taskRecords.byId[record.taskId].bindings[0].runs).toEqual(record.bindings[0].runs)
    expect(onDisk.taskRecords.byId[record.taskId].bindings[0].gaps).toEqual(record.bindings[0].gaps)
    expect(onDisk.taskRecords.byId[record.taskId].bindings[0].sessions).toEqual(
      record.bindings[0].sessions
    )

    // And a restart still reads them (the load boundary did not drop the rows).
    const reopened = openStore(file)
    expect(reopened.getTaskRecordForTask(QUERY)?.bindings[0].runs).toEqual(record.bindings[0].runs)
  })

  it('leaves a v1 record at schemaVersion 1 and adds no runs key on save', () => {
    const file = newDataFile()
    const record = taskRecordFixture({
      schemaVersion: 1,
      bindings: [{ ...bindingFixture(), lastVerifiedAt: null }]
    })
    writePersistedStateJson(file, JSON.stringify({ taskRecords: domainWith(record) }))

    const store = openStore(file)
    store.setWorktreeMeta(ID, { linkedIssue: 31, isArchived: true })
    store.flush()

    const onDisk = JSON.parse(readPersistedStateJson(file))
    const saved = onDisk.taskRecords.byId[record.taskId]
    // No silent upgrade on read: the record this build never enriched stays a v1
    // record, and an absent `runs` stays absent instead of becoming `[]`.
    expect(saved.schemaVersion).toBe(1)
    expect(saved.bindings[0]).not.toHaveProperty('runs')
    expect(store.getTaskRecordForTask(QUERY)?.schemaVersion).toBe(1)
  })
})

describe('task records live run ledger', () => {
  it('keeps a run observed while it ran across save and reopen', () => {
    const file = newDataFile()
    const store = openStore(file)
    // The metadata write that binds this live workspace to its issue is what
    // gives the observation somewhere to land; before issue #36's ledger a live
    // workspace had no record at all.
    store.setWorktreeMeta(ID, { linkedIssue: 31 })
    const run = {
      key: 'claude|session_id:run-1',
      providerSession: { provider: 'claude' as const, key: 'session_id', id: 'run-1' },
      agentType: 'claude',
      startedAt: 10,
      endedAt: 20,
      outcome: 'success' as const,
      source: 'live-observation' as const,
      recordedAt: 20,
      firstSeenAt: 10,
      lastSeenAt: 20
    }

    expect(store.recordTaskRecordLiveRun({ worktreeId: ID, run })).toBe(true)
    // The same facts again are not a second write: the observer already filters
    // them, and the transition must agree (no save, no change).
    expect(store.recordTaskRecordLiveRun({ worktreeId: ID, run })).toBe(false)
    store.flush()

    const onDisk = JSON.parse(readPersistedStateJson(file))
    const saved = onDisk.taskRecords.byId['task:github:repo-1:issue:31']
    expect(saved.bindings[0].runs).toEqual([run])
    // A v2 build cannot read this source value, so the record may not keep
    // claiming v2 (it would rebuild it without the row).
    expect(saved.schemaVersion).toBe(TASK_RECORD_SCHEMA_VERSION)

    const reopened = openStore(file)
    expect(reopened.getTaskRecordForTask(QUERY)?.bindings[0].runs).toEqual([run])
  })

  it('writes nothing for a workspace no task binds', () => {
    const file = newDataFile()
    const store = openStore(file)

    expect(
      store.recordTaskRecordLiveRun({
        worktreeId: 'repo-1::/repo/unknown',
        run: {
          key: 'claude|session_id:run-1',
          providerSession: { key: 'session_id', id: 'run-1' },
          source: 'live-observation',
          recordedAt: 20,
          firstSeenAt: 10,
          lastSeenAt: 20
        }
      })
    ).toBe(false)
    store.flush()

    expect(JSON.parse(readPersistedStateJson(file)).taskRecords).toBeUndefined()
  })
})

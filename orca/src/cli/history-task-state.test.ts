import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { HistoryBackfillTask } from '../shared/history-backfill-command'
import { profileStateDatabaseFile } from '../shared/profile-state-storage-paths'
import type { TaskRecord, TaskRecordsState } from '../shared/task-records-types'
import {
  openProfileStateDatabase,
  openProfileStateDatabaseReadOnly
} from '../main/persistence/profile-state/profile-state-database'
import { importProfileStateJson } from '../main/persistence/profile-state/profile-state-documents'
import { readProfileStateRevision } from '../main/persistence/profile-state/profile-state-revision'
import { readHistoryTaskExport } from './history-task-state'

const PROFILE_ID = 'profile-history-task'
const TASK: HistoryBackfillTask = {
  repo: { kind: 'auto', value: 'repo-1' },
  number: 53
}
const NOW = Date.UTC(2026, 10, 18, 12, 0)
const TASK_ID = 'task:github:repo-1:issue:53'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function record(): TaskRecord {
  return {
    taskId: TASK_ID,
    hostId: 'local',
    origin: {
      kind: 'external',
      provider: 'github',
      itemType: 'issue',
      number: 53
    },
    bindings: [
      {
        worktreeId: 'wt-archived',
        repoId: 'repo-1',
        hostId: 'local',
        path: '/repos/app',
        isArchived: true,
        boundAt: NOW - 10_000,
        boundBy: 'created',
        lastVerifiedAt: NOW,
        sessions: [
          {
            provider: 'codex',
            key: 'session_id',
            id: 'def',
            agentType: 'codex',
            transcriptPath: '/home/u/.codex/def.jsonl',
            transcriptCheck: { checkedAt: NOW, presence: 'present' },
            source: 'archive-snapshot',
            recordedAt: NOW,
            firstSeenAt: NOW - 1000,
            lastSeenAt: NOW
          }
        ],
        runs: [
          {
            key: 'claude|session_id:abc',
            providerSession: { provider: 'claude', key: 'session_id', id: 'abc' },
            title: 'Wire JWT',
            agentType: 'claude',
            startedAt: NOW - 3600_000,
            endedAt: NOW,
            messageCount: 12,
            source: 'archive-snapshot',
            recordedAt: NOW,
            firstSeenAt: NOW - 3600_000,
            lastSeenAt: NOW
          }
        ],
        usageSettlement: {
          kind: 'known',
          collectedAt: NOW,
          scope: 'worktree-rollup',
          worktreeId: 'wt-archived',
          providers: [{ provider: 'claude', tokens: 1200, costUsd: 1.2 }],
          estimatedCostUsd: 1.2
        }
      }
    ],
    intent: {},
    createdAt: NOW - 20_000,
    updatedAt: NOW,
    schemaVersion: 3
  }
}

function state(): TaskRecordsState {
  return {
    recordsVersion: 1,
    byId: { [TASK_ID]: record() },
    externalIndex: { 'github:repo-1:issue:53': TASK_ID }
  }
}

function domains(): Record<string, unknown> {
  return {
    taskRecords: state(),
    repos: [{ id: 'repo-1', path: '/repos/app' }],
    worktreeMeta: { 'wt-archived': { hostId: 'local', isArchived: true } }
  }
}

function profile(database: boolean): {
  userDataPath: string
  dataFile: string
  databaseFile: string
} {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-history-task-'))
  temporaryDirectories.push(userDataPath)
  const profileDirectory = join(userDataPath, 'profiles', PROFILE_ID)
  mkdirSync(profileDirectory, { recursive: true })
  writeFileSync(
    join(userDataPath, 'orca-profile-index.json'),
    JSON.stringify({ activeProfileId: PROFILE_ID, profiles: [{ id: PROFILE_ID }] }),
    'utf8'
  )
  const result = {
    userDataPath,
    dataFile: join(profileDirectory, 'orca-data.json'),
    databaseFile: profileStateDatabaseFile(profileDirectory)
  }
  if (database) {
    const opened = openProfileStateDatabase(result.databaseFile, PROFILE_ID)
    try {
      importProfileStateJson(opened.db, JSON.stringify(domains()))
    } finally {
      opened.db.close()
    }
  } else {
    writeFileSync(result.dataFile, JSON.stringify(domains()), 'utf8')
  }
  return result
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function revision(databaseFile: string): number {
  const opened = openProfileStateDatabaseReadOnly(databaseFile, PROFILE_ID)
  try {
    return readProfileStateRevision(opened.db)
  } finally {
    opened.db.close()
  }
}

describe('history task read-only profile access', () => {
  it('reads a SQLite profile without changing its bytes, mtime or revision', () => {
    const profilePaths = profile(true)
    const beforeHash = sha256(profilePaths.databaseFile)
    const beforeMtime = statSync(profilePaths.databaseFile).mtimeMs
    const beforeRevision = revision(profilePaths.databaseFile)

    const result = readHistoryTaskExport({ userDataPath: profilePaths.userDataPath, task: TASK })

    expect(result.task.taskId).toBe(TASK_ID)
    expect(result.trace).toBe('archived')
    expect(result.bindings[0]!.runs[0]!.title).toBe('Wire JWT')
    expect(result.bindings[0]!.sessions[0]!.transcriptCheck?.presence).toBe('present')
    expect(result.tokens).toEqual({
      kind: 'available',
      tokens: 1200,
      estimatedCostUsd: 1.2
    })
    expect(sha256(profilePaths.databaseFile)).toBe(beforeHash)
    expect(statSync(profilePaths.databaseFile).mtimeMs).toBe(beforeMtime)
    expect(revision(profilePaths.databaseFile)).toBe(beforeRevision)
  })

  it('reads the legacy JSON profile without writing it or creating a database', () => {
    const profilePaths = profile(false)
    const before = readFileSync(profilePaths.dataFile, 'utf8')

    const result = readHistoryTaskExport({ userDataPath: profilePaths.userDataPath, task: TASK })

    expect(result.task.number).toBe(53)
    expect(result.trace).toBe('archived')
    expect(readFileSync(profilePaths.dataFile, 'utf8')).toBe(before)
    expect(existsSync(profilePaths.databaseFile)).toBe(false)
  })

  it('fails closed when the profile holds no record for the task', () => {
    const profilePaths = profile(true)
    expect(() =>
      readHistoryTaskExport({
        userDataPath: profilePaths.userDataPath,
        task: { ...TASK, number: 99 }
      })
    ).toThrow(/No task record for repo-1#99/)
  })
})

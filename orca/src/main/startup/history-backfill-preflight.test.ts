import type * as NodeFs from 'node:fs'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import {
  HISTORY_BACKFILL_FLAG,
  HISTORY_BACKFILL_RESULT_PREFIX,
  historyBackfillResponseSchema
} from '../../shared/history-backfill-command'
import type { TaskRecordsState } from '../../shared/task-records-types'
import type * as SessionIndexLookupModule from '../task-records/task-records-session-index-lookup'
import { upsertTaskRecordBinding } from '../../shared/task-records-updates'
import { EMPTY_TASK_RECORDS } from '../../shared/task-records-types'
import { acquireProfileStateRuntimeAdmission } from '../persistence/profile-state/profile-state-access'
import {
  openProfileStateDatabase,
  openProfileStateDatabaseReadOnly
} from '../persistence/profile-state/profile-state-database'
import {
  exportProfileStateJson,
  importProfileStateJson
} from '../persistence/profile-state/profile-state-documents'
import { runHistoryBackfillPreflight } from './history-backfill-preflight'

const REPO_ID = 'repo-1'
const WORKTREE_PATH = '/repos/app'
const TASK_ID = 'task:github:repo-1:issue:53'
const BOUND_AT = 1_000

const mocks = vi.hoisted(() => ({
  setPath: vi.fn(),
  requestSingleInstanceLock: vi.fn(),
  on: vi.fn(),
  exit: vi.fn(),
  background: vi.fn(),
  output: vi.fn(),
  sessions: [] as AiVaultSession[]
}))

vi.mock('electron', () => ({ app: mocks }))
vi.mock('../window/foreground-activation-policy', () => ({
  applyBackgroundActivationPolicy: mocks.background
}))
// Only the index factory is replaced: the resolver rules, row builders and gap text
// stay the real ones, so this test exercises the resolver the snapshot also uses.
vi.mock('../task-records/task-records-session-index-lookup', async (original) => ({
  ...(await original<typeof SessionIndexLookupModule>()),
  createAiVaultSessionIndexLookup: () => async () => mocks.sessions
}))
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof NodeFs>()
  return {
    ...fs,
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
      if (args[0] === 1) {
        mocks.output(args[1])
        return
      }
      return fs.writeFileSync(...args)
    }
  }
})

const roots: string[] = []
beforeEach(() => {
  vi.clearAllMocks()
  mocks.requestSingleInstanceLock.mockReturnValue(true)
  mocks.sessions = []
  vi.stubEnv('ORCA_USER_DATA_PATH', '/stale/inherited/root')
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

type ProfileFixture = {
  root: string
  profileId: string
  databaseFile: string
  transcriptPath: string
  argv: string[]
}

function stateWithArchivedBinding(): TaskRecordsState {
  const written = upsertTaskRecordBinding(EMPTY_TASK_RECORDS, {
    taskId: TASK_ID,
    hostId: 'local',
    repoId: REPO_ID,
    worktreeId: `${REPO_ID}::${WORKTREE_PATH}`,
    path: WORKTREE_PATH,
    isArchived: true,
    origin: { kind: 'external', provider: 'github', itemType: 'issue', number: 53 },
    now: BOUND_AT,
    boundBy: 'user'
  })
  if (!written.ok) {
    throw new Error('fixture could not bind the workspace')
  }
  const record = written.state.byId[TASK_ID]
  return {
    ...written.state,
    byId: { ...written.state.byId, [TASK_ID]: { ...record, schemaVersion: 1 } }
  }
}

/** The real profile layout the app uses: an index file, then `<root>/profiles/<id>/`. */
function profileFixture(
  task: { repo: { kind: 'auto' | 'id' | 'path'; value: string }; number: number } = {
    repo: { kind: 'auto', value: REPO_ID },
    number: 53
  }
): ProfileFixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-history-backfill-preflight-')))
  roots.push(root)
  const profileId = 'backfill-profile'
  const directory = join(root, 'profiles', profileId)
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(root, 'orca-profile-index.json'),
    JSON.stringify({ activeProfileId: profileId, profiles: [{ id: profileId }] })
  )
  const databaseFile = join(directory, 'profile-state.db')
  const transcriptPath = join(directory, 'sess-1.jsonl')
  writeFileSync(transcriptPath, '{"type":"user"}\n')
  const opened = openProfileStateDatabase(databaseFile, profileId)
  try {
    importProfileStateJson(
      opened.db,
      JSON.stringify({
        repos: [{ id: REPO_ID, path: WORKTREE_PATH }],
        taskRecords: stateWithArchivedBinding()
      })
    )
  } finally {
    opened.db.close()
  }
  return {
    root,
    profileId,
    databaseFile,
    transcriptPath,
    argv: ['Orca', '--serve', HISTORY_BACKFILL_FLAG, JSON.stringify({ userDataPath: root, task })]
  }
}

function response(): unknown {
  const output: unknown = mocks.output.mock.calls[0]?.[0]
  expect(typeof output).toBe('string')
  if (typeof output !== 'string') {
    throw new Error('Missing response')
  }
  const parsed: unknown = JSON.parse(output.slice(HISTORY_BACKFILL_RESULT_PREFIX.length))
  return historyBackfillResponseSchema.parse(parsed)
}

function storedPayload(file: string, profileId: string): string {
  const opened = openProfileStateDatabaseReadOnly(file, profileId)
  try {
    return exportProfileStateJson(opened.db)
  } finally {
    opened.db.close()
  }
}

async function settle(): Promise<void> {
  await vi.waitFor(() => expect(mocks.exit).toHaveBeenCalled())
}

describe('history backfill preflight', () => {
  it('leaves ordinary startup untouched', () => {
    expect(runHistoryBackfillPreflight(['Orca', '--serve'])).toBe(false)
    expect(mocks.background).not.toHaveBeenCalled()
    expect(mocks.setPath).not.toHaveBeenCalled()
    expect(mocks.exit).not.toHaveBeenCalled()
  })

  it('runs before CLI redirect and ordinary startup admission', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/main/startup/main-process-preflight.ts'),
      'utf8'
    )
    const start = source.indexOf('export function runMainProcessPreflight(')
    const recovery = source.indexOf('if (runProfileStateRecoveryPreflight())', start)
    const backfill = source.indexOf('if (runHistoryBackfillPreflight())', start)
    const redirect = source.indexOf('const cliLaunchRedirect = maybeRedirectCliLaunch(', start)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(backfill).toBeGreaterThan(recovery)
    expect(redirect).toBeGreaterThan(backfill)
    expect(source.slice(backfill, redirect)).toContain('return false')
  })

  it('backfills the archived workspace under the maintenance lock (T1 through the verb)', async () => {
    const item = profileFixture()
    mocks.sessions = [
      {
        id: 'row-1',
        executionHostId: 'local',
        agent: 'pi',
        sessionId: 'sess-1',
        title: 'Refactor the ledger',
        cwd: WORKTREE_PATH,
        branch: null,
        model: null,
        filePath: item.transcriptPath,
        codexHome: null,
        createdAt: new Date(1_500).toISOString(),
        updatedAt: new Date(1_900).toISOString(),
        modifiedAt: new Date(1_900).toISOString(),
        messageCount: 7,
        totalTokens: 12_345,
        previewMessages: [],
        queuedMessageCount: 0,
        subagentTranscriptCount: 0,
        resumeCommand: 'pi --resume sess-1',
        subagent: null
      }
    ]
    mocks.requestSingleInstanceLock.mockImplementation(() => {
      expect(mocks.setPath).toHaveBeenCalledWith('userData', item.root)
      // The maintenance owner is what stops a racing app from publishing its revision
      // over this write, so ordinary admission must be refused while it is held.
      expect(() => acquireProfileStateRuntimeAdmission(item.root)).toThrow()
      return true
    })

    expect(runHistoryBackfillPreflight(item.argv)).toBe(true)
    await settle()

    expect(process.env.ORCA_USER_DATA_PATH).toBe(item.root)
    expect(process.env.ORCA_BACKGROUND_LAUNCH).toBe('1')
    expect(mocks.background).toHaveBeenCalledOnce()
    expect(mocks.exit).toHaveBeenCalledWith(0)
    expect(response()).toMatchObject({
      ok: true,
      result: {
        taskId: TASK_ID,
        examined: 1,
        resolved: 1,
        rowsWritten: { sessions: 1, runs: 1 },
        // The preflight carries the load-boundary counters into the wire result, so
        // the CLI never has to infer "nothing was trimmed" from a missing field.
        discarded: {
          sessions: 0,
          runs: 0,
          gaps: 0,
          providers: 0,
          fields: 0,
          transcriptChecks: 0
        },
        writeRefusedReason: null,
        outcomes: [
          {
            worktreeId: `${REPO_ID}::${WORKTREE_PATH}`,
            outcome: 'resolved',
            sessionRows: 1,
            runRows: 1
          }
        ]
      }
    })

    const payload = JSON.parse(storedPayload(item.databaseFile, item.profileId)) as {
      taskRecords: TaskRecordsState
    }
    const binding = payload.taskRecords.byId[TASK_ID]?.bindings[0]
    expect(binding?.sessions).toHaveLength(1)
    expect(binding?.sessions[0]).toMatchObject({
      source: 'backfill',
      agentType: 'pi',
      messageCount: 7
    })
    expect(binding?.runs).toHaveLength(1)
    expect(binding?.runs?.[0]).toMatchObject({ source: 'backfill', agentType: 'pi' })
    // Unknown usage stays an absence, and the index's own token total is not promoted.
    expect(binding?.usageSettlement).toBeUndefined()
    expect(JSON.stringify(binding)).not.toContain('12345')
  })

  it('refuses an old singleton owner and writes nothing', async () => {
    const item = profileFixture()
    const before = storedPayload(item.databaseFile, item.profileId)
    mocks.requestSingleInstanceLock.mockReturnValue(false)

    expect(runHistoryBackfillPreflight(item.argv)).toBe(true)
    await settle()

    expect(response()).toMatchObject({
      ok: false,
      code: 'runtime_error',
      message: expect.stringContaining('Stop Orca')
    })
    expect(storedPayload(item.databaseFile, item.profileId)).toBe(before)
    expect(mocks.exit).toHaveBeenCalledWith(1)
  })

  it.each([
    {
      label: 'no --serve',
      argv: (item: ProfileFixture) => item.argv.filter((a) => a !== '--serve')
    },
    {
      label: 'a duplicated flag',
      argv: (item: ProfileFixture) => [
        item.argv[0],
        '--serve',
        ...item.argv.slice(2),
        ...item.argv.slice(2)
      ]
    },
    {
      label: 'no payload',
      argv: (item: ProfileFixture) => [item.argv[0], '--serve', HISTORY_BACKFILL_FLAG]
    },
    {
      label: 'bad JSON',
      argv: (item: ProfileFixture) => [item.argv[0], '--serve', HISTORY_BACKFILL_FLAG, '{']
    }
  ])('refuses an invalid launch: $label', async ({ argv }) => {
    const item = profileFixture()
    expect(runHistoryBackfillPreflight(argv(item))).toBe(true)
    await settle()
    expect(response()).toMatchObject({ ok: false, code: 'invalid_argument' })
    expect(mocks.requestSingleInstanceLock).not.toHaveBeenCalled()
  })

  it('reports a task that does not resolve and writes nothing', async () => {
    const item = profileFixture()
    const before = storedPayload(item.databaseFile, item.profileId)
    item.argv[3] = JSON.stringify({
      userDataPath: item.root,
      task: { repo: { kind: 'auto', value: REPO_ID }, number: 99 }
    })

    expect(runHistoryBackfillPreflight(item.argv)).toBe(true)
    await settle()

    expect(response()).toMatchObject({
      ok: false,
      code: 'invalid_argument',
      message: expect.stringContaining('No task record for repo-1#99')
    })
    expect(storedPayload(item.databaseFile, item.profileId)).toBe(before)
  })
})

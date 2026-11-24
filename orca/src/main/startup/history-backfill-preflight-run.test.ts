import type * as NodeFs from 'node:fs'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import {
  HISTORY_BACKFILL_FLAG,
  HISTORY_BACKFILL_RESULT_PREFIX,
  historyBackfillResponseSchema,
  type HistoryBackfillResponse
} from '../../shared/history-backfill-command'
import {
  createAiVaultServiceEntryMissingError,
  createAiVaultWorkerEntryMissingError
} from '../../shared/ai-vault-scan-unavailable'
import { EMPTY_TASK_RECORDS, type TaskRecordsState } from '../../shared/task-records-types'
import { upsertTaskRecordBinding } from '../../shared/task-records-updates'
import {
  AI_VAULT_SERVICE_READY_TIMEOUT_MS,
  AI_VAULT_SERVICE_SCAN_TIMEOUT_MS
} from '../ai-vault/session-scanner-service-client-state'
import {
  openProfileStateDatabase,
  openProfileStateDatabaseReadOnly
} from '../persistence/profile-state/profile-state-database'
import {
  exportProfileStateJson,
  importProfileStateJson
} from '../persistence/profile-state/profile-state-documents'
import {
  HISTORY_BACKFILL_PREFLIGHT_DEADLINE_MS,
  runHistoryBackfillPreflightOnHost,
  type HistoryBackfillPreflightHost,
  type HistoryBackfillPreflightOptions
} from './history-backfill-preflight-run'

const REPO_ID = 'repo-1'
const WORKTREE_PATH = '/repos/app'
const TASK_ID = 'task:github:repo-1:issue:53'
const BOUND_AT = 1_000

const mocks = vi.hoisted(() => ({ output: vi.fn() }))
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
})
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

type Fixture = {
  root: string
  profileId: string
  databaseFile: string
  transcriptPath: string
  argv: string[]
  /** The stored payload before the run, so "wrote nothing" is provable byte-for-byte. */
  before: string
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

const TASK = { repo: { kind: 'auto' as const, value: REPO_ID }, number: 53 }

/** The real profile layout, in a throwaway directory: an index file, then
 *  `<root>/profiles/<id>/` with the SQLite profile state the command writes. */
function fixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-backfill-run-')))
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
    before: storedPayload(databaseFile, profileId),
    argv: [
      'Orca',
      '--serve',
      HISTORY_BACKFILL_FLAG,
      JSON.stringify({ userDataPath: root, task: TASK })
    ]
  }
}

function storedPayload(file: string, profileId: string): string {
  const opened = openProfileStateDatabaseReadOnly(file, profileId)
  try {
    return exportProfileStateJson(opened.db)
  } finally {
    opened.db.close()
  }
}

type FixtureHost = HistoryBackfillPreflightHost & {
  exit: ReturnType<typeof vi.fn<(exitCode: number) => void>>
  setUserDataPath: ReturnType<typeof vi.fn<(path: string) => void>>
  acquireSingleInstanceLock: ReturnType<typeof vi.fn<() => boolean>>
}

function fixtureHost(): FixtureHost {
  return {
    setUserDataPath: vi.fn<(path: string) => void>(),
    acquireSingleInstanceLock: vi.fn<() => boolean>(() => true),
    exit: vi.fn<(exitCode: number) => void>()
  }
}

function sessionRow(filePath: string): AiVaultSession {
  return {
    id: 'row-1',
    executionHostId: 'local',
    agent: 'pi',
    sessionId: 'sess-1',
    title: 'Refactor the ledger',
    cwd: WORKTREE_PATH,
    branch: null,
    model: null,
    filePath,
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
}

/** The one result line, parsed. Asserts the `[history-backfill] ` prefix is intact. */
function response(): HistoryBackfillResponse {
  const raw: unknown = mocks.output.mock.calls.at(-1)?.[0]
  expect(typeof raw).toBe('string')
  if (typeof raw !== 'string') {
    throw new Error('Missing response')
  }
  expect(raw.startsWith(HISTORY_BACKFILL_RESULT_PREFIX)).toBe(true)
  return historyBackfillResponseSchema.parse(
    JSON.parse(raw.slice(HISTORY_BACKFILL_RESULT_PREFIX.length))
  )
}

async function settle(host: Pick<FixtureHost, 'exit'>): Promise<void> {
  await vi.waitFor(() => expect(host.exit).toHaveBeenCalled())
}

function run(
  item: Fixture,
  host: HistoryBackfillPreflightHost,
  options: HistoryBackfillPreflightOptions = {}
): void {
  expect(runHistoryBackfillPreflightOnHost(item.argv, host, options)).toBe(true)
}

describe('history backfill preflight runner', () => {
  it('writes the index hit into a throwaway userData copy', async () => {
    const item = fixture()
    const host = fixtureHost()
    const asked: { path: string }[] = []
    run(item, host, {
      sessionIndexLookup: async ({ path }) => {
        asked.push({ path })
        return [sessionRow(item.transcriptPath)]
      }
    })
    await settle(host)

    // The real resolver ran: it asked for the binding's own absolute path.
    expect(asked).toEqual([{ path: WORKTREE_PATH }])
    expect(host.setUserDataPath).toHaveBeenCalledWith(item.root)
    expect(host.exit).toHaveBeenCalledWith(0)
    expect(response()).toMatchObject({
      ok: true,
      result: {
        taskId: TASK_ID,
        examined: 1,
        resolved: 1,
        rowsWritten: { sessions: 1, runs: 1 },
        revision: expect.any(Number),
        outcomes: [
          { worktreeId: `${REPO_ID}::${WORKTREE_PATH}`, outcome: 'resolved', sessionRows: 1 }
        ]
      }
    })

    const payload = JSON.parse(storedPayload(item.databaseFile, item.profileId)) as {
      taskRecords: TaskRecordsState
    }
    const binding = payload.taskRecords.byId[TASK_ID]?.bindings[0]
    expect(binding?.sessions).toHaveLength(1)
    expect(binding?.sessions[0]).toMatchObject({ source: 'backfill', agentType: 'pi' })
    expect(binding?.runs).toHaveLength(1)
  })

  it.each([
    [
      'the forked service entry is missing',
      () =>
        createAiVaultServiceEntryMissingError('/install/out/main/session-scanner-service-entry.js')
    ],
    [
      'the legacy worker entry is missing',
      () =>
        createAiVaultWorkerEntryMissingError('/install/out/main/session-scanner-worker-entry.js')
    ]
  ])('refuses instead of writing a gap when %s', async (_label, makeError) => {
    const item = fixture()
    const host = fixtureHost()
    const error = makeError()
    run(item, host, {
      sessionIndexLookup: async () => {
        throw error
      }
    })
    await settle(host)

    // Not "session_unattributable": a scan this host cannot run proves nothing, so the
    // run is a refusal with the existing runtime_error code and a non-zero exit.
    expect(host.exit).toHaveBeenCalledWith(1)
    const refused = response()
    expect(refused).toMatchObject({ ok: false, code: 'runtime_error' })
    if (refused.ok) {
      throw new Error('expected a refusal')
    }
    expect(refused.message).toContain(error.message)
    expect(refused.message).toContain('Nothing was written')
    expect(storedPayload(item.databaseFile, item.profileId)).toBe(item.before)
  })

  it('settles at its upper bound when the scan never answers', async () => {
    const item = fixture()
    const host = fixtureHost()
    let rejectScan!: (error: Error) => void
    const pending = new Promise<never>((_resolve, reject) => {
      rejectScan = reject
    })
    run(item, host, { sessionIndexLookup: () => pending, deadlineMs: 25 })

    await vi.waitFor(() => expect(host.exit).toHaveBeenCalledWith(1), { timeout: 5_000 })
    const refused = response()
    expect(refused).toMatchObject({
      ok: false,
      code: 'runtime_error',
      message: expect.stringContaining('within 25 ms, its upper bound')
    })
    if (refused.ok) {
      throw new Error('expected a refusal')
    }
    // The write follows the scan, so a scan that never answered leaves the payload as
    // it was — the deadline cannot refuse a run whose write already happened.
    expect(refused.message).toContain('Nothing was written')
    expect(storedPayload(item.databaseFile, item.profileId)).toBe(item.before)

    // A late answer is not a second result: one line, one exit, whichever way the
    // abandoned promise settles after the deadline has already reported.
    rejectScan(new Error('scan answered after the deadline'))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(mocks.output).toHaveBeenCalledTimes(1)
    expect(host.exit).toHaveBeenCalledTimes(1)
  })

  it('keeps its upper bound above the scanner ready and scan budgets', () => {
    // The preflight deadline must never refuse a scan the scanner itself still treats
    // as in progress; raising either budget has to revisit the bound, not silently
    // outgrow it.
    expect(HISTORY_BACKFILL_PREFLIGHT_DEADLINE_MS).toBeGreaterThan(
      AI_VAULT_SERVICE_READY_TIMEOUT_MS + AI_VAULT_SERVICE_SCAN_TIMEOUT_MS
    )
  })

  it('keeps the existing invalid-launch refusal and never scans for it', async () => {
    const item = fixture()
    const host = fixtureHost()
    const lookup = vi.fn(async () => [] as AiVaultSession[])
    run({ ...item, argv: [...item.argv.slice(0, 3), '{'] }, host, {
      sessionIndexLookup: lookup
    })
    await settle(host)

    expect(host.exit).toHaveBeenCalledWith(1)
    expect(response()).toMatchObject({ ok: false, code: 'invalid_argument' })
    expect(lookup).not.toHaveBeenCalled()
    expect(host.acquireSingleInstanceLock).not.toHaveBeenCalled()
    expect(storedPayload(item.databaseFile, item.profileId)).toBe(item.before)
  })

  it('keeps the existing held-lock refusal and writes nothing', async () => {
    const item = fixture()
    const host = fixtureHost()
    host.acquireSingleInstanceLock.mockReturnValue(false)
    const lookup = vi.fn(async () => [] as AiVaultSession[])
    run(item, host, { sessionIndexLookup: lookup })
    await settle(host)

    expect(host.exit).toHaveBeenCalledWith(1)
    expect(response()).toMatchObject({
      ok: false,
      code: 'runtime_error',
      message: expect.stringContaining('Stop Orca')
    })
    expect(lookup).not.toHaveBeenCalled()
    expect(storedPayload(item.databaseFile, item.profileId)).toBe(item.before)
  })

  it('reports a transient scan failure as the existing gap, not as unavailability', async () => {
    const item = fixture()
    const host = fixtureHost()
    run(item, host, {
      sessionIndexLookup: async () => {
        throw new Error('EACCES reading /home/dev/.codex')
      }
    })
    await settle(host)

    // Unchanged policy: a failure to look is not a proof of absence, so one binding's
    // failed lookup stays a reported gap instead of aborting the whole run.
    expect(host.exit).toHaveBeenCalledWith(0)
    const report = response()
    expect(report).toMatchObject({
      ok: true,
      result: {
        examined: 1,
        resolved: 0,
        outcomes: [
          {
            outcome: 'session_unattributable',
            detail: expect.stringContaining('the session index lookup failed')
          }
        ]
      }
    })
    // And the gap is what the run wrote, which is why determinism had to be typed.
    expect(readFileSync(item.databaseFile).length).toBeGreaterThan(0)
  })
})

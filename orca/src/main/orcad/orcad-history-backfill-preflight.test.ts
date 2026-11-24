import type * as NodeFs from 'node:fs'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HistoryBackfillResult } from '../../shared/history-backfill-command'
import {
  HISTORY_BACKFILL_FLAG,
  HISTORY_BACKFILL_RESULT_PREFIX,
  historyBackfillResponseSchema
} from '../../shared/history-backfill-command'
import {
  createOrcadHistoryBackfillPreflightHost,
  runOrcadHistoryBackfillPreflight
} from './orcad-history-backfill-preflight'
import { OrcadInstanceLockError } from './orcad-instance-lock'

const mocks = vi.hoisted(() => ({
  backfill: vi.fn(),
  exit: vi.fn(),
  setPath: vi.fn(),
  output: vi.fn()
}))

vi.mock('../task-records/task-records-backfill-profile-state', () => ({
  backfillTaskRecords: mocks.backfill
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

const result: HistoryBackfillResult = {
  taskId: 'task:github:repo-1:issue:60',
  repoId: 'repo-1',
  number: 60,
  provider: 'github',
  itemType: 'issue',
  bindings: 1,
  examined: 1,
  resolved: 1,
  rowsWritten: { sessions: 1, runs: 1 },
  changed: true,
  revision: 4,
  discarded: {
    sessions: 0,
    runs: 0,
    gaps: 0,
    providers: 0,
    fields: 0,
    transcriptChecks: 0
  },
  writeRefusedReason: null,
  outcomes: []
}

const roots: string[] = []
const savedEnv: Record<string, string | undefined> = {}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.backfill.mockResolvedValue(result)
  vi.stubEnv('ORCA_BACKGROUND_LAUNCH', undefined)
  savedEnv.ORCA_USER_DATA = process.env.ORCA_USER_DATA
  savedEnv.ORCA_USER_DATA_PATH = process.env.ORCA_USER_DATA_PATH
})
afterEach(() => {
  vi.unstubAllEnvs()
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[name]
    } else {
      process.env[name] = value
    }
  }
  for (const directory of roots.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

/** The real profile layout the app uses: an index file, then `<root>/profiles/<id>/`. */
function profileRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-orcad-history-backfill-')))
  roots.push(root)
  mkdirSync(join(root, 'profiles', 'p'), { recursive: true })
  writeFileSync(
    join(root, 'orca-profile-index.json'),
    JSON.stringify({ activeProfileId: 'p', profiles: [{ id: 'p' }] })
  )
  return root
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

describe('orcad history backfill preflight', () => {
  it('runs the shared preflight with the request the CLI sent', async () => {
    const root = profileRoot()
    const task = { repo: { kind: 'id' as const, value: 'repo-1' }, number: 60 }
    const argv = [
      'bun-runtime',
      'orcad.js',
      '--serve',
      HISTORY_BACKFILL_FLAG,
      JSON.stringify({ userDataPath: root, task })
    ]

    expect(
      runOrcadHistoryBackfillPreflight(argv, {
        setUserDataPath: mocks.setPath,
        acquireSingleInstanceLock: () => true,
        exit: mocks.exit
      })
    ).toBe(true)
    await vi.waitFor(() => expect(mocks.exit).toHaveBeenCalledWith(0))

    expect(mocks.setPath).toHaveBeenCalledWith(root)
    expect(mocks.backfill).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        task,
        location: {
          profileId: 'p',
          dataFile: join(root, 'profiles', 'p', 'orca-data.json'),
          databaseFile: join(root, 'profiles', 'p', 'profile-state.db')
        }
      })
    )
    expect(response()).toMatchObject({ ok: true, result })
  })

  it('refuses while the second fence is held, with the existing sentence', async () => {
    const root = profileRoot()
    const argv = [
      'bun-runtime',
      'orcad.js',
      '--serve',
      HISTORY_BACKFILL_FLAG,
      JSON.stringify({
        userDataPath: root,
        task: { repo: { kind: 'auto', value: 'repo-1' }, number: 60 }
      })
    ]

    runOrcadHistoryBackfillPreflight(argv, {
      setUserDataPath: mocks.setPath,
      acquireSingleInstanceLock: () => false,
      exit: mocks.exit
    })
    await vi.waitFor(() => expect(mocks.exit).toHaveBeenCalledWith(1))

    expect(mocks.backfill).not.toHaveBeenCalled()
    expect(response()).toMatchObject({
      ok: false,
      code: 'runtime_error',
      message: expect.stringContaining('Stop Orca')
    })
  })

  it('binds both data-root names and turns a live orcad lock into a refusal', () => {
    const host = createOrcadHistoryBackfillPreflightHost({
      acquireInstanceLock: () => {
        throw new OrcadInstanceLockError('orcad_instance_lock_held', 'Another orcad owns the root')
      },
      exit: mocks.exit
    })
    host.setUserDataPath('/tmp/orca-history-backfill-root')

    expect(process.env.ORCA_USER_DATA).toBe('/tmp/orca-history-backfill-root')
    expect(process.env.ORCA_USER_DATA_PATH).toBe('/tmp/orca-history-backfill-root')
    expect(host.acquireSingleInstanceLock()).toBe(false)
    expect(mocks.exit).not.toHaveBeenCalled()
  })
})

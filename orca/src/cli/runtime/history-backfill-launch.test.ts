import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HISTORY_BACKFILL_FLAG,
  HISTORY_BACKFILL_RESULT_PREFIX,
  type HistoryBackfillResult
} from '../../shared/history-backfill-command'
import {
  HISTORY_BACKFILL_NO_EXECUTABLE_MESSAGE,
  canLaunchHistoryBackfill,
  launchHistoryBackfill,
  resolveHistoryBackfillLaunchTarget
} from './history-backfill-launch'

const mocks = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock('../../shared/child-process/run-process', () => ({ runProcess: mocks.run }))
vi.mock('./launch', () => ({
  resolveAppRoot: () => '/application',
  getExecutableAppArgs: () => ['/application'],
  stripElectronRunAsNode: (env: NodeJS.ProcessEnv) => {
    const clean = { ...env }
    delete clean.ELECTRON_RUN_AS_NODE
    return clean
  }
}))

const result: HistoryBackfillResult = {
  taskId: 'task:github:repo-1:issue:53',
  repoId: 'repo-1',
  number: 53,
  provider: 'github',
  itemType: 'issue',
  bindings: 1,
  examined: 1,
  resolved: 1,
  rowsWritten: { sessions: 1, runs: 1 },
  changed: true,
  revision: 7,
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
function root(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'orca-history-backfill-launch-')))
  roots.push(directory)
  return directory
}

beforeEach(() => {
  mocks.run.mockReset().mockResolvedValue({
    code: 0,
    signal: null,
    timedOut: false,
    stdout: `${HISTORY_BACKFILL_RESULT_PREFIX}${JSON.stringify({ ok: true, result })}\n`,
    stderr: ''
  })
})
afterEach(() => {
  vi.unstubAllEnvs()
  for (const directory of roots.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('history backfill launch target', () => {
  it('accepts the server-only artifact the CLI is installed inside', () => {
    const installRoot = root()
    mkdirSync(join(installRoot, 'cli'))
    writeFileSync(join(installRoot, 'orcad.js'), '// orcad\n')
    writeFileSync(join(installRoot, 'bun-runtime'), '// runtime\n')

    expect(resolveHistoryBackfillLaunchTarget({}, join(installRoot, 'cli'))).toEqual({
      kind: 'server',
      executable: join(installRoot, 'bun-runtime'),
      entry: join(installRoot, 'orcad.js')
    })
    expect(canLaunchHistoryBackfill({}, join(installRoot, 'cli'))).toBe(true)
  })

  it('keeps the app executable first when the host has one', () => {
    expect(
      resolveHistoryBackfillLaunchTarget(
        { ORCA_APP_EXECUTABLE: ' /packaged/Orca ' },
        join(root(), 'cli')
      )
    ).toEqual({ kind: 'app', executable: '/packaged/Orca' })
    expect(resolveHistoryBackfillLaunchTarget({ ELECTRON_RUN_AS_NODE: '1' }, '/nowhere')).toEqual({
      kind: 'app',
      executable: process.execPath
    })
  })

  it('reports the existing error when neither executable exists', async () => {
    const missing = join(root(), 'cli')
    expect(resolveHistoryBackfillLaunchTarget({}, missing)).toBeNull()
    expect(canLaunchHistoryBackfill({}, missing)).toBe(false)
    await expect(
      launchHistoryBackfill(
        { userDataPath: roots[0]!, task: { repo: { kind: 'id', value: 'repo-1' }, number: 53 } },
        null
      )
    ).rejects.toMatchObject({
      code: 'runtime_error',
      message: HISTORY_BACKFILL_NO_EXECUTABLE_MESSAGE
    })
    expect(mocks.run).not.toHaveBeenCalled()
  })
})

describe('history backfill launch', () => {
  const request = {
    task: { repo: { kind: 'id', value: 'repo-1' }, number: 53 }
  } as const

  it('uses the same serve request for a server-only executable', async () => {
    const userDataPath = root()
    const target = {
      kind: 'server' as const,
      executable: '/opt/orca/current/bun-runtime',
      entry: '/opt/orca/current/orcad.js'
    }

    expect(await launchHistoryBackfill({ userDataPath, ...request }, target)).toEqual(result)
    expect(mocks.run).toHaveBeenCalledWith(
      expect.objectContaining({
        program: '/opt/orca/current/bun-runtime',
        args: [
          '/opt/orca/current/orcad.js',
          '--serve',
          HISTORY_BACKFILL_FLAG,
          JSON.stringify({ userDataPath, ...request })
        ],
        cwd: '/opt/orca/current',
        env: expect.objectContaining({
          ORCA_BACKGROUND_LAUNCH: '1',
          ORCA_USER_DATA: userDataPath,
          ORCA_USER_DATA_PATH: userDataPath
        }),
        timeoutMs: null
      })
    )
    expect(mocks.run.mock.calls[0][0].env).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
  })

  it('keeps the desktop app launch form unchanged', async () => {
    const userDataPath = root()

    expect(
      await launchHistoryBackfill(
        { userDataPath, ...request },
        { kind: 'app', executable: '/packaged/Orca' }
      )
    ).toEqual(result)
    expect(mocks.run).toHaveBeenCalledWith(
      expect.objectContaining({
        program: '/packaged/Orca',
        args: [
          '/application',
          '--serve',
          HISTORY_BACKFILL_FLAG,
          JSON.stringify({ userDataPath, ...request })
        ],
        cwd: '/application',
        env: expect.objectContaining({ ORCA_USER_DATA_PATH: userDataPath }),
        timeoutMs: null
      })
    )
  })
})

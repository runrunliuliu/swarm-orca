import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HistoryBackfillResult } from '../../shared/history-backfill-command'
import type { HandlerContext } from '../dispatch'
import type { RuntimeClient } from '../runtime-client'

const mocks = vi.hoisted(() => ({
  getCliStatus: vi.fn(),
  launch: vi.fn(),
  canLaunch: vi.fn(),
  userDataPath: '/tmp/orca-handler-user-data'
}))

vi.mock('../runtime-client', () => {
  class RuntimeClientError extends Error {
    readonly code: string

    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  }

  class RuntimeClient {
    getCliStatus = mocks.getCliStatus
  }

  return {
    RuntimeClient,
    RuntimeClientError,
    getDefaultUserDataPath: () => mocks.userDataPath
  }
})

vi.mock('../runtime/history-backfill-launch', () => ({
  canLaunchHistoryBackfill: mocks.canLaunch,
  launchHistoryBackfill: mocks.launch
}))

import { HISTORY_HANDLERS } from './history'

const STOPPED = {
  result: { runtime: { reachable: false }, app: { running: false } }
}

const NO_DISCARDS = {
  sessions: 0,
  runs: 0,
  gaps: 0,
  providers: 0,
  fields: 0,
  transcriptChecks: 0
}

function report(): HistoryBackfillResult {
  return {
    taskId: 'task:github:repo-1:issue:53',
    repoId: 'repo-1',
    number: 53,
    provider: 'github',
    itemType: 'issue',
    bindings: 2,
    examined: 1,
    resolved: 1,
    rowsWritten: { sessions: 1, runs: 1 },
    changed: true,
    revision: 7,
    discarded: NO_DISCARDS,
    writeRefusedReason: null,
    outcomes: [
      {
        worktreeId: 'repo-1::/repos/app',
        hostId: 'local',
        path: '/repos/app',
        outcome: 'resolved',
        sessionRows: 1,
        runRows: 1
      }
    ]
  }
}

function context(flags: Record<string, string> = {}, json = false): HandlerContext {
  return {
    flags: new Map(Object.entries(flags)),
    client: {} as RuntimeClient,
    cwd: '/',
    json
  }
}

async function run(flags: Record<string, string>, json = false): Promise<void> {
  await HISTORY_HANDLERS['history backfill']!(context(flags, json))
}

async function refusal(flags: Record<string, string>): Promise<Error & { code?: string }> {
  try {
    await run(flags)
  } catch (error) {
    return error as Error & { code?: string }
  }
  throw new Error('expected the command to refuse')
}

let output: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  vi.clearAllMocks()
  mocks.getCliStatus.mockResolvedValue(STOPPED)
  mocks.canLaunch.mockReturnValue(true)
  mocks.launch.mockResolvedValue(report())
  output = vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  output.mockRestore()
})

describe('history backfill handler', () => {
  it('requires --task', async () => {
    const error = await refusal({})
    expect(error.code).toBe('invalid_argument')
    expect(error.message).toContain('--task <repo>#<number>')
    expect(mocks.launch).not.toHaveBeenCalled()
  })

  it.each(['repo-1', '#53', 'repo-1#0', 'repo-1#abc'])(
    'rejects the malformed --task %s without spawning anything',
    async (value) => {
      const error = await refusal({ task: value })
      expect(error.code).toBe('invalid_argument')
      expect(mocks.launch).not.toHaveBeenCalled()
      expect(mocks.getCliStatus).not.toHaveBeenCalled()
    }
  )

  it.each([
    {
      label: 'a reachable runtime',
      status: { result: { runtime: { reachable: true }, app: { running: true } } }
    },
    {
      label: 'an app that is starting but not reachable yet',
      status: { result: { runtime: { reachable: false }, app: { running: true } } }
    }
  ])('refuses while Orca is running: $label', async ({ status }) => {
    mocks.getCliStatus.mockResolvedValue(status)
    const error = await refusal({ task: 'repo-1#53' })
    expect(error.code).toBe('runtime_error')
    expect(error.message).toContain('Stop Orca before `history backfill`')
    expect(mocks.launch).not.toHaveBeenCalled()
    expect(output).not.toHaveBeenCalled()
  })

  it('refuses when this process cannot launch the app executable', async () => {
    mocks.canLaunch.mockReturnValue(false)
    const error = await refusal({ task: 'repo-1#53' })
    expect(error.code).toBe('runtime_error')
    expect(error.message).toContain('ORCA_APP_EXECUTABLE')
    expect(mocks.launch).not.toHaveBeenCalled()
  })

  it('prints the JSON facts the operator needs', async () => {
    await run({ task: 'path:/repos/app#53' }, true)

    expect(mocks.launch).toHaveBeenCalledWith({
      userDataPath: mocks.userDataPath,
      task: { repo: { kind: 'path', value: '/repos/app' }, number: 53 }
    })
    const printed = JSON.parse(String(output.mock.calls[0]?.[0])) as {
      ok: boolean
      result: HistoryBackfillResult
    }
    expect(printed.ok).toBe(true)
    expect(printed.result).toMatchObject({
      examined: 1,
      resolved: 1,
      rowsWritten: { sessions: 1, runs: 1 },
      revision: 7
    })
    expect(JSON.stringify(printed)).not.toContain('tokens')
    // R1: the JSON carries the load-boundary counters and the write outcome as
    // fields, so a script never has to parse the human sentence.
    expect(printed.result.discarded).toEqual(NO_DISCARDS)
    expect(printed.result.writeRefusedReason).toBeNull()
  })

  it('prints the load-trim refusal as JSON fields, not only as prose', async () => {
    mocks.launch.mockResolvedValue({
      ...report(),
      examined: 0,
      resolved: 0,
      rowsWritten: { sessions: 0, runs: 0 },
      changed: false,
      revision: null,
      discarded: { ...NO_DISCARDS, runs: 1 },
      writeRefusedReason: 'load_discarded_runs' as const,
      outcomes: []
    })
    await run({ task: 'repo-1#53' }, true)
    const printed = JSON.parse(String(output.mock.calls[0]?.[0])) as {
      ok: boolean
      result: HistoryBackfillResult
    }
    expect(printed.ok).toBe(true)
    expect(printed.result).toMatchObject({
      changed: false,
      revision: null,
      rowsWritten: { sessions: 0, runs: 0 },
      discarded: { ...NO_DISCARDS, runs: 1 },
      writeRefusedReason: 'load_discarded_runs'
    })
    // "No revision" and "no bindings" must not be the only signal that it refused.
    expect(printed.result.outcomes).toEqual([])
  })

  it('prints a short human summary that never states a zero figure', async () => {
    await run({ task: 'repo-1#53' })
    const text = String(output.mock.calls[0]?.[0])
    expect(text).toContain('task: github repo-1#53 (task:github:repo-1:issue:53)')
    expect(text).toContain('bindings: 2 (examined 1, resolved 1)')
    expect(text).toContain('rows written: sessions 1, runs 1')
    expect(text).toContain('profile state: written at revision 7')
    expect(text).toContain('usage: untouched')
    // A clean domain says nothing about discards and nothing about a refused write.
    expect(text).not.toContain('load boundary:')
    expect(text).not.toContain('NOT WRITTEN')
    expect(text).not.toMatch(/0 tokens|\$0/)
  })

  it('prints the load-trim refusal in the human summary instead of a revision', async () => {
    mocks.launch.mockResolvedValue({
      ...report(),
      examined: 0,
      resolved: 0,
      rowsWritten: { sessions: 0, runs: 0 },
      changed: false,
      revision: null,
      discarded: { ...NO_DISCARDS, runs: 1 },
      writeRefusedReason: 'load_discarded_runs' as const,
      outcomes: []
    })
    await run({ task: 'repo-1#53' })
    const text = String(output.mock.calls[0]?.[0])
    expect(text).toContain(
      'load boundary: discarded from the stored domain — runs 1, sessions 0, gaps 0, providers 0, fields 0, transcript checks 0'
    )
    expect(text).toContain('profile state: NOT WRITTEN')
    expect(text).toContain('The stored payload is unchanged.')
    // The one thing it must not imply: that "nothing to write" is the same outcome.
    expect(text).not.toContain('profile state: unchanged (nothing to write)')
    expect(text).not.toContain('profile state: written at revision')
    expect(text).toContain('examined bindings: not examined (the write was refused before any scan)')
    expect(text).not.toContain('examined bindings: none (no archived binding')
    expect(text).not.toMatch(/0 tokens|\$0/)
  })

  it('says when nothing was written', async () => {
    mocks.launch.mockResolvedValue({
      ...report(),
      examined: 0,
      resolved: 0,
      rowsWritten: { sessions: 0, runs: 0 },
      changed: false,
      revision: null,
      discarded: NO_DISCARDS,
      writeRefusedReason: null,
      outcomes: []
    })
    await run({ task: 'repo-1#53' })
    const text = String(output.mock.calls[0]?.[0])
    expect(text).toContain('profile state: unchanged (nothing to write)')
    expect(text).toContain('examined bindings: none')
    expect(text).not.toMatch(/0 tokens|\$0/)
  })

  it('passes the preflight refusal through as the CLI error shape', async () => {
    mocks.launch.mockRejectedValue(
      Object.assign(new Error('Stop Orca before `history backfill`'), { code: 'runtime_error' })
    )
    const error = await refusal({ task: 'repo-1#53' })
    expect(error.message).toContain('Stop Orca')
    expect(output).not.toHaveBeenCalled()
  })
})

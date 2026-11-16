/**
 * The operator acceptance override (issue-sedimentation.md §8, M5 C1) has to be reachable from the
 * CLI, not only from the two handlers that already read it.
 *
 * `cli/args.ts` refuses any flag outside `allowedFlags ∪ GLOBAL_FLAGS`, so a flag the handler
 * understands but the spec omits fails with `Unknown flag` before the handler ever runs. These cases
 * therefore drive the whole `main()` boundary: the spec gate, the handler's required-flag check and
 * the RPC payload, for both commands that can settle a blocked dispatch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { callMock, getTerminalHandleMock } = vi.hoisted(() => ({
  callMock: vi.fn(),
  getTerminalHandleMock: vi.fn()
}))

vi.mock('../runtime-client', async () => {
  // Why: re-export the REAL error classes so format.ts `instanceof` narrowing still matches.
  const { RuntimeClientError, RuntimeRpcFailureError } = await import('../runtime/types.js')
  class RuntimeClient {
    readonly isRemote = false
    call = callMock
    getCliStatus = vi.fn()
    openOrca = vi.fn()
  }
  return {
    RuntimeClient,
    RuntimeClientError,
    RuntimeRpcFailureError,
    serveOrcaApp: vi.fn(),
    getDefaultUserDataPath: vi.fn(() => '/tmp/orca-user-data')
  }
})

vi.mock('../selectors', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getTerminalHandle: getTerminalHandleMock
}))

import { main } from '../index'
import { okFixture, queueFixtures } from '../test-fixtures'

const originalTerminalHandle = process.env.ORCA_TERMINAL_HANDLE

describe('orchestration acceptance override CLI boundary', () => {
  let logSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    callMock.mockReset()
    getTerminalHandleMock.mockReset()
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    delete process.env.ORCA_TERMINAL_HANDLE
    process.exitCode = 0
  })

  afterEach(() => {
    logSpy.mockRestore()
    errorSpy.mockRestore()
    if (originalTerminalHandle === undefined) {
      delete process.env.ORCA_TERMINAL_HANDLE
    } else {
      process.env.ORCA_TERMINAL_HANDLE = originalTerminalHandle
    }
    process.exitCode = 0
  })

  const stderr = (): string => errorSpy.mock.calls.map((call) => String(call[0])).join('\n')

  const paramsFor = (method: string): Record<string, unknown> | undefined =>
    callMock.mock.calls.find((call) => call[0] === method)?.[1] as
      | Record<string, unknown>
      | undefined

  it('accepts task-update --override-acceptance --actor --reason and forwards both', async () => {
    queueFixtures(callMock, okFixture('req_task', { task: { id: 'task_1', status: 'completed' } }))

    await main(
      [
        'orchestration',
        'task-update',
        '--id',
        'task_1',
        '--status',
        'completed',
        '--override-acceptance',
        '--actor',
        'operator',
        '--reason',
        'manual sign-off',
        '--from',
        'term_coord',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(process.exitCode).toBe(0)
    expect(stderr()).not.toContain('Unknown flag')
    expect(paramsFor('orchestration.taskUpdate')).toEqual(
      expect.objectContaining({
        id: 'task_1',
        status: 'completed',
        overrideAcceptance: { actor: 'operator', reason: 'manual sign-off' }
      })
    )
  })

  it('refuses task-update --override-acceptance without --actor before any mutation', async () => {
    await main(
      [
        'orchestration',
        'task-update',
        '--id',
        'task_1',
        '--status',
        'completed',
        '--override-acceptance',
        '--from',
        'term_coord'
      ],
      '/tmp/repo'
    )

    expect(process.exitCode).toBe(1)
    expect(stderr()).toContain('Missing required --actor')
    expect(paramsFor('orchestration.taskUpdate')).toBeUndefined()
  })

  it('refuses task-update --override-acceptance without --reason', async () => {
    await main(
      [
        'orchestration',
        'task-update',
        '--id',
        'task_1',
        '--status',
        'completed',
        '--override-acceptance',
        '--actor',
        'operator',
        '--from',
        'term_coord'
      ],
      '/tmp/repo'
    )

    expect(process.exitCode).toBe(1)
    expect(stderr()).toContain('Missing required --reason')
    expect(paramsFor('orchestration.taskUpdate')).toBeUndefined()
  })

  it('accepts gate-create --override-acceptance --actor --reason and forwards both', async () => {
    queueFixtures(
      callMock,
      okFixture('req_gate', { gate: { id: 'gate_1', task_id: 'task_1', status: 'pending' } })
    )

    await main(
      [
        'orchestration',
        'gate-create',
        '--task',
        'task_1',
        '--question',
        'ship?',
        '--override-acceptance',
        '--actor',
        'operator',
        '--reason',
        'manual sign-off',
        '--from',
        'term_coord',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(process.exitCode).toBe(0)
    expect(stderr()).not.toContain('Unknown flag')
    expect(paramsFor('orchestration.gateCreate')).toEqual(
      expect.objectContaining({
        task: 'task_1',
        question: 'ship?',
        overrideAcceptance: { actor: 'operator', reason: 'manual sign-off' }
      })
    )
  })

  it('refuses gate-create --override-acceptance without --reason before any mutation', async () => {
    await main(
      [
        'orchestration',
        'gate-create',
        '--task',
        'task_1',
        '--question',
        'ship?',
        '--override-acceptance',
        '--actor',
        'operator',
        '--from',
        'term_coord'
      ],
      '/tmp/repo'
    )

    expect(process.exitCode).toBe(1)
    expect(stderr()).toContain('Missing required --reason')
    expect(paramsFor('orchestration.gateCreate')).toBeUndefined()
  })
})

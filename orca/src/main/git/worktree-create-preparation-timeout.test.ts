// prepareWorktreeCreateCheckout: the deadline ends the wait, never the materialization — and a
// deadlined reset is not a reason to discard the checkout Git is still writing.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({ gitExecFileAsyncMock: vi.fn() }))

vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  gitExecFileSync: vi.fn(),
  translateWslOutputPaths: (output: string) => output
}))

vi.mock('../worktree-trash', () => ({
  moveWorktreeDirectoryToTrash: vi.fn().mockResolvedValue(undefined),
  restoreWorktreeDirectoryFromTrash: vi.fn().mockResolvedValue(true),
  scheduleWorktreeTrashDeletion: vi.fn()
}))

import { GitCommandTimeoutError } from './command-runner/git-command-timeout'
import { prepareWorktreeCreateCheckout } from './worktree-create-preparation'
import { WORKTREE_REMOVAL_REGISTRATION_TIMEOUT_MS } from './worktree-operation-options'
import { registerWorktreeSuiteHooks } from './worktree-test-harness'

registerWorktreeSuiteHooks()

const REPO = '/repo'
const PREPARED = '/prep'
const LOCK_REASON = 'orca-create-preparation:v1:4321:timeout-test'
const DISCARD_ARGV = ['worktree', 'remove', '--force', '--force', PREPARED]

type RecordedCall = { args: string[]; timeout?: number; keepRunningOnTimeout?: boolean }

function prepare(options: { timeout?: number } = {}) {
  return prepareWorktreeCreateCheckout(REPO, PREPARED, 'main', LOCK_REASON, options)
}

describe('prepareWorktreeCreateCheckout deadlines', () => {
  let platformSpy: MockInstance<() => NodeJS.Platform>
  let warnSpy: MockInstance<typeof console.warn>
  let calls: RecordedCall[]

  beforeEach(() => {
    calls = []
    gitExecFileAsyncMock.mockReset()
    // Why: the Windows long-path prefix would change every recorded argv; pin one host for assertions.
    platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    platformSpy.mockRestore()
    warnSpy.mockRestore()
  })

  function recordCalls(failOn: (args: string[]) => Error | null): void {
    gitExecFileAsyncMock.mockImplementation(async (args: string[], options?: RecordedCall) => {
      calls.push({ args, ...options })
      const failure = failOn(args)
      if (failure) {
        throw failure
      }
      return { stdout: 'abc123\n', stderr: '' }
    })
  }

  // Why: reset is the step that writes the whole tree, so its deadline must not kill Git — and the
  // lock has to be in place before that so a half-written row reads as owned and unfinished.
  it('locks before materializing and leaves a deadlined reset running', async () => {
    recordCalls((args) => (args.includes('reset') ? new GitCommandTimeoutError(400) : null))

    await expect(prepare({ timeout: 400 })).rejects.toThrow('git timed out.')

    const lockIndex = calls.findIndex((call) => call.args.includes('lock'))
    const resetIndex = calls.findIndex((call) => call.args.includes('reset'))
    expect(lockIndex).toBeGreaterThan(-1)
    expect(lockIndex).toBeLessThan(resetIndex)
    expect(calls[resetIndex]).toMatchObject({ timeout: 400, keepRunningOnTimeout: true })
    // Why: the discard is the defect this pins — it would delete the tree Git is still writing.
    expect(calls.some((call) => call.args.includes('remove'))).toBe(false)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[git/worktree] git reset --hard exceeded 400ms')
    )
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('ORCA_WORKTREE_ADD_TIMEOUT_MS'))
  })

  // Why: the add writes metadata only, so a deadline there has nothing to preserve and must still
  // leave no unowned row behind (an unlocked preparation is never reclaimed automatically).
  it('discards a preparation whose add or lock missed the deadline', async () => {
    recordCalls((args) => (args.includes('lock') ? new GitCommandTimeoutError(400) : null))

    await expect(prepare({ timeout: 400 })).rejects.toThrow('git timed out.')

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(DISCARD_ARGV, {
      cwd: REPO,
      timeout: 400
    })
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('discards a preparation whose materialization failed for real', async () => {
    recordCalls((args) =>
      args.includes('reset')
        ? Object.assign(new Error('fatal: unable to write new index file'), { code: 128 })
        : null
    )

    await expect(prepare()).rejects.toThrow('fatal: unable to write new index file')

    const resetCall = calls.find((call) => call.args.includes('reset'))
    // Why: only the deadline is special; a killed Git left nothing to protect.
    expect(resetCall?.keepRunningOnTimeout).toBe(true)
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(DISCARD_ARGV, {
      cwd: REPO,
      timeout: WORKTREE_REMOVAL_REGISTRATION_TIMEOUT_MS
    })
    expect(warnSpy).not.toHaveBeenCalled()
  })
})

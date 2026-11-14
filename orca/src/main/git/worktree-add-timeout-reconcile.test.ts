// addWorktree: a timed-out `git worktree add` is unresolved (or adopted when it finished), never
// torn down; a real failure still clears the branch Git leaves behind.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

const { gitExecFileAsyncMock, gitExecFileSyncMock, listWorktreeGraphMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  gitExecFileSyncMock: vi.fn(),
  listWorktreeGraphMock: vi.fn()
}))

vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  gitExecFileSync: gitExecFileSyncMock,
  translateWslOutputPaths: (output: string) => output
}))

// The reconciliation read is the deadline's only witness; everything else about `git worktree list`
// is covered by its own suite.
vi.mock('./worktree-listing', () => ({
  listWorktreeGraph: listWorktreeGraphMock,
  listWorktreesStrict: vi.fn(),
  describeCreatedWorktree: vi.fn()
}))

vi.mock('../worktree-trash', () => ({
  moveWorktreeDirectoryToTrash: vi.fn().mockResolvedValue(undefined),
  restoreWorktreeDirectoryFromTrash: vi.fn().mockResolvedValue(true),
  scheduleWorktreeTrashDeletion: vi.fn()
}))

import { GitCommandTimeoutError } from './command-runner/git-command-timeout'
import { addWorktree, WORKTREE_ADD_TIMEOUT_MS } from './worktree'
import { registerWorktreeSuiteHooks } from './worktree-test-harness'

registerWorktreeSuiteHooks()

const WORKTREE_ADD_ARGV = ['worktree', 'add', '--no-track', '-b', 'feature/test', '/repo-feature']

const CREATED_ROW = {
  path: '/repo-feature',
  head: 'abc123',
  branch: 'refs/heads/feature/test',
  isBare: false,
  isMainWorktree: false
}

const PRIMARY_ONLY_LISTING = 'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n\n'

function timedOutAdd(): GitCommandTimeoutError {
  return new GitCommandTimeoutError(WORKTREE_ADD_TIMEOUT_MS)
}

function gitFailed(message = 'fatal: could not create work tree dir'): Error {
  return Object.assign(new Error(message), { code: 128 })
}

describe('addWorktree timeout and failure settlement', () => {
  let platformSpy: MockInstance<() => NodeJS.Platform>
  let warnSpy: MockInstance<typeof console.warn>

  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    gitExecFileSyncMock.mockReset()
    listWorktreeGraphMock.mockReset()
    // Why: argv for the long-path and case rules depends on the host OS; pin one for exact assertions.
    platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    platformSpy.mockRestore()
    warnSpy.mockRestore()
    vi.unstubAllEnvs()
  })

  // Why: the deadline must not kill the checkout, or Git deletes the directory it was writing.
  it('asks the runner to leave a deadlined add running', async () => {
    gitExecFileAsyncMock.mockRejectedValueOnce(timedOutAdd())
    listWorktreeGraphMock.mockResolvedValueOnce([CREATED_ROW])
    gitExecFileAsyncMock
      .mockRejectedValueOnce(Object.assign(new Error('key unset'), { code: 1 }))
      .mockResolvedValueOnce({ stdout: '' })

    await addWorktree('/repo', '/repo-feature', 'feature/test')

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(WORKTREE_ADD_ARGV, {
      cwd: '/repo',
      timeout: WORKTREE_ADD_TIMEOUT_MS,
      keepRunningOnTimeout: true
    })
  })

  // Why: Git can finish the checkout between the deadline and the first read; adopting it is the
  // difference between a created workspace and asking the user to repeat a four-minute checkout.
  it('adopts a checkout that Git finished after its deadline', async () => {
    gitExecFileAsyncMock.mockRejectedValueOnce(timedOutAdd())
    listWorktreeGraphMock.mockResolvedValueOnce([CREATED_ROW])
    gitExecFileAsyncMock
      .mockRejectedValueOnce(Object.assign(new Error('key unset'), { code: 1 }))
      .mockResolvedValueOnce({ stdout: '' })

    await expect(addWorktree('/repo', '/repo-feature', 'feature/test')).resolves.toEqual({})

    expect(listWorktreeGraphMock).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('exceeded 180000ms'))
    // Why: the checkout is real, so the post-add configuration still runs.
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['config', '--local', 'push.autoSetupRemote', 'true'],
      { cwd: '/repo-feature' }
    )
  })

  // Why: `locked initializing` is Git saying the add is still running — reporting a timeout is the
  // only honest answer, and any cleanup here would delete work in progress.
  it('reports the timeout as unresolved while Git still holds the checkout', async () => {
    gitExecFileAsyncMock.mockRejectedValueOnce(timedOutAdd())
    listWorktreeGraphMock.mockResolvedValueOnce([
      { ...CREATED_ROW, locked: true, lockReason: 'initializing' }
    ])

    await expect(addWorktree('/repo', '/repo-feature', 'feature/test')).rejects.toThrow(
      'git timed out.'
    )

    // Why: exactly the add — no config write, no branch delete, no removal.
    expect(gitExecFileAsyncMock.mock.calls).toEqual([
      [
        WORKTREE_ADD_ARGV,
        { cwd: '/repo', timeout: WORKTREE_ADD_TIMEOUT_MS, keepRunningOnTimeout: true }
      ]
    ])
  })

  it('reports the timeout as unresolved when the checkout is not visible yet', async () => {
    gitExecFileAsyncMock.mockRejectedValueOnce(timedOutAdd())
    listWorktreeGraphMock.mockResolvedValueOnce([])

    await expect(addWorktree('/repo', '/repo-feature', 'feature/test')).rejects.toThrow(
      'git timed out.'
    )
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  // Why: a prunable row is a registration whose directory Git already lost — nothing to adopt.
  it('does not adopt a prunable row', async () => {
    gitExecFileAsyncMock.mockRejectedValueOnce(timedOutAdd())
    listWorktreeGraphMock.mockResolvedValueOnce([{ ...CREATED_ROW, prunable: true }])

    await expect(addWorktree('/repo', '/repo-feature', 'feature/test')).rejects.toThrow(
      'git timed out.'
    )
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  // Why: Git's own failure cleanup removes the directory and admin entry but leaves the branch, so
  // a failed create would otherwise block every retry with a branch no workspace names.
  it('deletes the branch a real failure left on its start point', async () => {
    gitExecFileAsyncMock
      .mockRejectedValueOnce(gitFailed())
      .mockResolvedValueOnce({ stdout: 'abc123\n' }) // rev-parse refs/heads/feature/test
      .mockResolvedValueOnce({ stdout: 'abc123\n' }) // rev-parse HEAD^{commit}
      .mockResolvedValueOnce({ stdout: PRIMARY_ONLY_LISTING }) // worktree list --porcelain
      .mockResolvedValueOnce({ stdout: '' }) // update-ref -d refs/heads/feature/test
      .mockResolvedValueOnce({ stdout: PRIMARY_ONLY_LISTING }) // worktree list --porcelain (recheck)
      .mockRejectedValueOnce(new Error('no section')) // config --remove-section branch.feature/test

    await expect(addWorktree('/repo', '/repo-feature', 'feature/test')).rejects.toThrow(
      'fatal: could not create work tree dir'
    )

    expect(listWorktreeGraphMock).not.toHaveBeenCalled()
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['update-ref', '-d', 'refs/heads/feature/test', 'abc123'],
      { cwd: '/repo' }
    )
  })

  it('uses the pinned start point when proving the branch is untouched', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'abc123\n' }) // rev-parse --verify --quiet refs/remotes/origin/main^{commit}
      .mockRejectedValueOnce(gitFailed())
      .mockResolvedValueOnce({ stdout: 'abc123\n' }) // rev-parse refs/heads/feature/test
      .mockResolvedValueOnce({ stdout: 'abc123\n' }) // rev-parse abc123^{commit}
      .mockResolvedValueOnce({ stdout: PRIMARY_ONLY_LISTING })
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({ stdout: PRIMARY_ONLY_LISTING })
      .mockRejectedValueOnce(new Error('no section'))

    await expect(
      addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main', false, false, {
        pinnedBaseOid: 'abc123'
      })
    ).rejects.toThrow('fatal: could not create work tree dir')

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['rev-parse', '--verify', 'abc123^{commit}'],
      {
        cwd: '/repo'
      }
    )
  })

  // Why: `-b` refuses before writing anything when the ref exists, so that branch is somebody else's.
  it('leaves a branch that predates the failed add', async () => {
    gitExecFileAsyncMock.mockRejectedValueOnce(
      gitFailed("fatal: a branch named 'feature/test' already exists")
    )

    await expect(addWorktree('/repo', '/repo-feature', 'feature/test')).rejects.toThrow(
      'already exists'
    )
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  // Why: a branch that moved off its start point holds commits, so deletion would lose work.
  it('leaves a branch that moved off its start point', async () => {
    gitExecFileAsyncMock
      .mockRejectedValueOnce(gitFailed())
      .mockResolvedValueOnce({ stdout: 'def456\n' }) // rev-parse refs/heads/feature/test
      .mockResolvedValueOnce({ stdout: 'abc123\n' }) // rev-parse HEAD^{commit}

    await expect(addWorktree('/repo', '/repo-feature', 'feature/test')).rejects.toThrow(
      'fatal: could not create work tree dir'
    )
    expect(gitExecFileAsyncMock.mock.calls.some(([args]) => args[0] === 'update-ref')).toBe(false)
  })

  // Why: a failed checkout of a user's branch must never delete that branch.
  it('never deletes a branch that already existed before the create', async () => {
    gitExecFileAsyncMock.mockRejectedValueOnce(gitFailed())

    await expect(
      addWorktree('/repo', '/repo-feature', 'feature/test', 'feature/test', false, false, {
        checkoutExistingBranch: true
      })
    ).rejects.toThrow('fatal: could not create work tree dir')

    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })
})

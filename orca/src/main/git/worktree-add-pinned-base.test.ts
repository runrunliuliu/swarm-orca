// M1: resolve a worktree base to one commit and create the workspace at that commit.
import { execFileSync } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { addWorktree } from './worktree'
import { resolvePinnedWorktreeBase } from './worktree-add'

const tempRoots: string[] = []

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe']
  }).trim()
}

async function createRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-pinned-base-'))
  tempRoots.push(root)
  const repoPath = join(root, 'repo')
  execFileSync('git', ['init', '--quiet', repoPath])
  git(repoPath, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(repoPath, ['config', 'user.email', 'test@example.com'])
  git(repoPath, ['config', 'user.name', 'Test User'])
  await writeFile(join(repoPath, 'file.txt'), 'one\n')
  git(repoPath, ['add', '-A'])
  git(repoPath, ['commit', '--quiet', '-m', 'initial'])
  return realpath(repoPath)
}

async function commitOnMain(repoPath: string, name: string): Promise<string> {
  await writeFile(join(repoPath, name), 'more\n')
  git(repoPath, ['add', '-A'])
  git(repoPath, ['commit', '--quiet', '-m', name])
  return git(repoPath, ['rev-parse', 'refs/heads/main'])
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('resolvePinnedWorktreeBase', () => {
  it('resolves a short branch name to its qualified ref and full commit SHA', async () => {
    const repoPath = await createRepo()

    const pin = await resolvePinnedWorktreeBase(repoPath, 'main')

    expect(pin.resolvedRef).toBe('refs/heads/main')
    expect(pin.pinnedSha).toBe(git(repoPath, ['rev-parse', 'refs/heads/main']))
    expect(pin.pinnedSha).toMatch(/^[0-9a-f]{40,64}$/)
  })

  it('keeps the SHA it resolved after the base ref moves', async () => {
    const repoPath = await createRepo()
    const pin = await resolvePinnedWorktreeBase(repoPath, 'main')

    const movedSha = await commitOnMain(repoPath, 'later.txt')

    expect(movedSha).not.toBe(pin.pinnedSha)
    expect(pin.pinnedSha).toBe(git(repoPath, ['rev-parse', `${pin.pinnedSha}^{commit}`]))
  })

  it('refuses a base that cannot be resolved to a commit', async () => {
    const repoPath = await createRepo()

    await expect(resolvePinnedWorktreeBase(repoPath, 'missing-branch')).rejects.toThrow(
      /cannot be pinned/
    )
  })
})

describe('addWorktree with a pinned base commit', () => {
  it('creates at the pinned commit rather than at the current ref', async () => {
    const repoPath = await createRepo()
    const pin = await resolvePinnedWorktreeBase(repoPath, 'main')
    await commitOnMain(repoPath, 'later.txt')
    const worktreePath = join(dirname(repoPath), 'wt-pinned')

    await addWorktree(repoPath, worktreePath, 'task-pinned', 'main', false, true, {
      pinnedBaseOid: pin.pinnedSha
    })

    expect(git(worktreePath, ['rev-parse', 'HEAD'])).toBe(pin.pinnedSha)
    // Why: the pin only decides the checkout start point; base metadata stays the ref a user can read.
    expect(git(worktreePath, ['config', '--get', 'branch.task-pinned.base'])).toBe(
      'refs/heads/main'
    )
  })

  it('keeps creating at the ref when no pin is supplied', async () => {
    const repoPath = await createRepo()
    const movedSha = await commitOnMain(repoPath, 'later.txt')
    const worktreePath = join(dirname(repoPath), 'wt-unpinned')

    await addWorktree(repoPath, worktreePath, 'task-unpinned', 'main', false, true)

    expect(git(worktreePath, ['rev-parse', 'HEAD'])).toBe(movedSha)
  })
})

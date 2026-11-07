// M1: what a task sparse create refuses, and what it reads back before reporting success.
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { addSparseWorktree, addWorktree } from '../git/worktree'
import { resolvePinnedWorktreeBase } from '../git/worktree-add'
import {
  assertSparseTaskRequiredPathsSupported,
  assertSparseTaskWorkspaceCreatePath,
  assertSparseTaskWorkspaceNewBranch,
  buildSparseTaskWorkspaceReceipt,
  resolveSparseTaskWorkspaceRequest,
  sparseConeCovers,
  type SparseTaskWorkspaceRequest
} from './sparse-task-workspace-receipt'

const tempRoots: string[] = []

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe']
  }).trim()
}

type TaskRepo = {
  repoPath: string
  /** A real sparse worktree created at a pinned commit. */
  sparseWorktreePath: string
  pin: { resolvedRef: string; pinnedSha: string }
  /** A commit that is not the pin. */
  otherSha: string
}

function createRepoRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'orca-sparse-task-receipt-')).then((root) => {
    tempRoots.push(root)
    return join(root, 'repo')
  })
}
async function createRepo(): Promise<TaskRepo> {
  const repoPath = await createRepoRoot()
  execFileSync('git', ['init', '--quiet', repoPath])
  git(repoPath, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(repoPath, ['config', 'user.email', 'test@example.com'])
  git(repoPath, ['config', 'user.name', 'Test User'])
  await mkdir(join(repoPath, 'swarm', 'skills'), { recursive: true })
  await writeFile(join(repoPath, 'swarm', 'notes.md'), 'swarm\n')
  await writeFile(join(repoPath, 'swarm', 'skills', 'skill.md'), 'skill\n')
  await mkdir(join(repoPath, 'orca'), { recursive: true })
  await writeFile(join(repoPath, 'orca', 'readme.md'), 'orca\n')
  await writeFile(join(repoPath, 'AGENTS.md'), 'agents\n')
  git(repoPath, ['add', '-A'])
  git(repoPath, ['commit', '--quiet', '-m', 'initial'])

  const pin = await resolvePinnedWorktreeBase(join(await realpath(repoPath)), 'main')
  const sparseWorktreePath = join(dirname(await realpath(repoPath)), 'wt-sparse-task')
  await addSparseWorktree(
    await realpath(repoPath),
    sparseWorktreePath,
    'task-sparse',
    ['swarm'],
    'main',
    false,
    { pinnedBaseOid: pin.pinnedSha }
  )
  await writeFile(join(repoPath, 'later.md'), 'later\n')
  git(repoPath, ['add', '-A'])
  git(repoPath, ['commit', '--quiet', '-m', 'later'])
  return {
    repoPath: await realpath(repoPath),
    sparseWorktreePath: await realpath(sparseWorktreePath),
    pin,
    otherSha: git(await realpath(repoPath), ['rev-parse', 'HEAD'])
  }
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('resolveSparseTaskWorkspaceRequest', () => {
  it('is null for every payload that did not opt in', () => {
    expect(resolveSparseTaskWorkspaceRequest(undefined)).toBeNull()
    expect(resolveSparseTaskWorkspaceRequest({ directories: ['swarm'] })).toBeNull()
  })

  it('normalizes the cone and keeps first-seen order without duplicates', () => {
    const request = resolveSparseTaskWorkspaceRequest({
      directories: ['swarm/skills', 'swarm', 'swarm/skills'],
      mode: 'task-workspace-v1',
      requiredPaths: ['AGENTS.md']
    })

    expect(request).toEqual({
      directories: ['swarm/skills', 'swarm'],
      requiredPaths: ['AGENTS.md']
    })
  })

  it('still rejects absolute cone entries before any Git work', () => {
    expect(() =>
      resolveSparseTaskWorkspaceRequest({
        directories: ['/etc'],
        mode: 'task-workspace-v1'
      })
    ).toThrow(/repo-relative/)
  })
})

describe('task sparse create gates', () => {
  const request: SparseTaskWorkspaceRequest = { directories: ['swarm'], requiredPaths: [] }

  it('refuses the SSH create path', () => {
    expect(() => assertSparseTaskWorkspaceCreatePath(request, 'ssh')).toThrow(
      /\[sparse_task_capability_required\]/
    )
    expect(() => assertSparseTaskWorkspaceCreatePath(request, 'local')).not.toThrow()
  })

  it('refuses reusing an existing branch', () => {
    expect(() => assertSparseTaskWorkspaceNewBranch(request, true)).toThrow(
      /\[sparse_task_capability_required\]/
    )
    expect(() => assertSparseTaskWorkspaceNewBranch(request, false)).not.toThrow()
  })

  it('refuses declared required paths while they cannot be verified', () => {
    expect(() =>
      assertSparseTaskRequiredPathsSupported({ directories: ['swarm'], requiredPaths: ['AGENTS.md'] })
    ).toThrow(/\[sparse_task_capability_required\]/)
  })

  it('leaves every legacy payload alone', () => {
    expect(() => assertSparseTaskWorkspaceCreatePath(null, 'ssh')).not.toThrow()
    expect(() => assertSparseTaskWorkspaceNewBranch(null, true)).not.toThrow()
    expect(() => assertSparseTaskRequiredPathsSupported(null)).not.toThrow()
  })
})

describe('sparseConeCovers', () => {
  it('accepts an ancestor entry, which is how cone mode collapses a request', () => {
    expect(sparseConeCovers(['swarm'], 'swarm/skills')).toBe(true)
    expect(sparseConeCovers(['swarm/skills'], 'swarm')).toBe(false)
    expect(sparseConeCovers(['swarm'], 'swarm')).toBe(true)
    expect(sparseConeCovers(['orca'], 'swarm')).toBe(false)
    expect(sparseConeCovers([], 'swarm')).toBe(false)
  })
})

describe('buildSparseTaskWorkspaceReceipt', () => {
  it('reports the pin, the HEAD it read back, and the cone Git actually applied', async () => {
    const { sparseWorktreePath, pin } = await createRepo()

    const receipt = await buildSparseTaskWorkspaceReceipt({
      worktreePath: sparseWorktreePath,
      branch: 'task-sparse',
      pin: { baseSource: 'default', ...pin },
      requestedSparseCone: ['swarm/skills', 'swarm']
    })

    expect(receipt).toEqual({
      baseSource: 'default',
      resolvedRef: 'refs/heads/main',
      pinnedSha: pin.pinnedSha,
      actualHead: pin.pinnedSha,
      requestedSparseCone: ['swarm/skills', 'swarm'],
      effectiveSparseCone: ['swarm']
    })
  })

  it('fails when the created worktree is not at the pinned commit', async () => {
    const { sparseWorktreePath, otherSha } = await createRepo()

    await expect(
      buildSparseTaskWorkspaceReceipt({
        worktreePath: sparseWorktreePath,
        branch: 'task-sparse',
        pin: { baseSource: 'request', resolvedRef: 'refs/heads/main', pinnedSha: otherSha },
        requestedSparseCone: ['swarm']
      })
    ).rejects.toThrow(/\[sparse_task_head_mismatch\]/)
  })

  it('fails when the effective cone does not cover a requested directory', async () => {
    const { sparseWorktreePath, pin } = await createRepo()

    await expect(
      buildSparseTaskWorkspaceReceipt({
        worktreePath: sparseWorktreePath,
        branch: 'task-sparse',
        pin: { baseSource: 'request', ...pin },
        requestedSparseCone: ['swarm', 'orca']
      })
    ).rejects.toThrow(/\[sparse_task_effective_cone_mismatch\].*orca/)
  })

  it('fails closed when sparse state cannot be read back', async () => {
    const { repoPath } = await createRepo()
    const plainWorktreePath = join(dirname(repoPath), 'wt-plain')
    await addWorktree(repoPath, plainWorktreePath, 'plain', 'main', false, false)
    const pin = await resolvePinnedWorktreeBase(repoPath, 'main')

    await expect(
      buildSparseTaskWorkspaceReceipt({
        worktreePath: plainWorktreePath,
        branch: 'plain',
        pin: { baseSource: 'request', ...pin },
        requestedSparseCone: ['swarm']
      })
    ).rejects.toThrow(/\[sparse_task_effective_cone_mismatch\]/)
  })
})

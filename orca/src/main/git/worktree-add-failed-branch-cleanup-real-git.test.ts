// Real Git: a failed `git worktree add` must not leave the branch Git created behind, and must
// never delete a branch that predates the attempt.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { gitExecFileAsync } from './runner'
import { addWorktree } from './worktree'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function createRepo(): Promise<{ repo: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'orca-add-failure-'))
  roots.push(root)
  const repo = join(root, 'repo')
  await gitExecFileAsync(['init', '--quiet', repo], { cwd: root })
  await gitExecFileAsync(['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: repo })
  await writeFile(join(repo, 'file.txt'), 'workspace content\n')
  await gitExecFileAsync(['add', '.'], { cwd: repo })
  await gitExecFileAsync(
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture'],
    { cwd: repo }
  )
  return { repo, root }
}

async function localBranches(repo: string): Promise<string> {
  const { stdout } = await gitExecFileAsync(['branch', '--format=%(refname:short)'], { cwd: repo })
  return stdout.trim()
}

it('drops the branch a failed add created', async () => {
  const { repo, root } = await createRepo()
  // Why: an occupied target makes `git worktree add` fail after it already created the branch.
  const target = join(root, 'occupied')
  await mkdir(target)
  await writeFile(join(target, 'keep.txt'), 'not empty\n')

  await expect(addWorktree(repo, target, 'feature/failed')).rejects.toThrow(/already exists/i)

  expect(await localBranches(repo)).toBe('main')
})

it('keeps a branch that existed before the failed add', async () => {
  const { repo, root } = await createRepo()
  await gitExecFileAsync(['branch', 'feature/kept', 'main'], { cwd: repo })
  const target = join(root, 'occupied')
  await mkdir(target)
  await writeFile(join(target, 'keep.txt'), 'not empty\n')

  await expect(addWorktree(repo, target, 'feature/kept')).rejects.toThrow(/already exists/i)

  expect(await localBranches(repo)).toBe('feature/kept\nmain')
})

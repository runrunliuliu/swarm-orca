import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { normalizeGitRemoteUrl } from '../../../../src/shared/git-remote-identity'
import { prepareSimIdentity } from './identity'

const roots: string[] = []

function scratch(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'orca-sim-identity-test-'))
  roots.push(root)
  return root
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('prepareSimIdentity', () => {
  it('clones from a local bare repository and exposes the product canonical identity', async () => {
    const root = scratch()
    const metadata = {
      state: 'closed' as const,
      url: 'https://github.com/runrunliuliu/swarm-orca/issues/67',
      number: 67,
      title: 'Remote-only task record'
    }
    const identity = await prepareSimIdentity({
      owner: 'runrunliuliu',
      repo: 'swarm-orca',
      metadata,
      root
    })

    expect(identity).toMatchObject({
      owner: 'runrunliuliu',
      repo: 'swarm-orca',
      originUrl: 'git@github.com:runrunliuliu/swarm-orca.git',
      canonicalKey: 'github.com/runrunliuliu/swarm-orca',
      tracker: metadata
    })
    expect(identity.canonicalKey).toBe(normalizeGitRemoteUrl(identity.originUrl))
    expect(git(identity.worktreePath, ['remote', 'get-url', 'origin'])).toBe(identity.originUrl)
    expect(git(identity.worktreePath, ['rev-parse', 'HEAD'])).toBe(
      git(identity.bareRepoPath, ['rev-parse', 'refs/heads/main'])
    )
    expect(readFileSync(path.join(identity.worktreePath, 'README.md'), 'utf8')).toBe(
      '# runrunliuliu/swarm-orca\n'
    )
    expect(existsSync(path.join(root, 'seed-source'))).toBe(false)
  })

  it('creates deterministic commits and fallback tracker metadata without a network source', async () => {
    const first = await prepareSimIdentity({ owner: 'example', repo: 'same-name', root: scratch() })
    const second = await prepareSimIdentity({
      owner: 'example',
      repo: 'same-name',
      root: scratch()
    })

    expect(git(first.worktreePath, ['rev-parse', 'HEAD'])).toBe(
      git(second.worktreePath, ['rev-parse', 'HEAD'])
    )
    expect(first.tracker).toEqual({
      state: 'open',
      url: 'https://github.com/example/same-name/issues/1',
      number: 1,
      title: 'Simulation issue for example/same-name'
    })
    expect(first.bareRepoPath).not.toBe(second.bareRepoPath)
  })
})

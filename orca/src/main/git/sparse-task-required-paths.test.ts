import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SparseTaskValidationError } from './sparse-task-input-validation'
import {
  assertSparseTaskRequiredPathsPresent,
  statSparseTaskPath,
  verifySparseTaskRequiredPaths
} from './sparse-task-required-paths'
import type { SparseTaskPathProbe, SparseTaskPathVerdict } from './sparse-task-required-paths'

const WORKTREE = resolve('/tmp/orca-sparse-task-worktree')
const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function scriptedProbe(verdicts: Record<string, SparseTaskPathVerdict>): {
  probe: SparseTaskPathProbe
  probed: string[]
} {
  const probed: string[] = []
  return {
    probed,
    probe: async (absolutePath) => {
      probed.push(absolutePath)
      return verdicts[absolutePath] ?? 'present'
    }
  }
}

function thrownBy(run: () => unknown): SparseTaskValidationError {
  try {
    run()
  } catch (error) {
    if (error instanceof SparseTaskValidationError) {
      return error
    }
    throw error
  }
  throw new Error('expected the call to throw')
}

describe('verifySparseTaskRequiredPaths', () => {
  it('reports no gaps when every declared path is present', async () => {
    const { probe, probed } = scriptedProbe({})
    const result = await verifySparseTaskRequiredPaths({
      worktreePath: WORKTREE,
      requiredPaths: ['AGENTS.md', 'swarm/skills/x/SKILL.md'],
      probe
    })
    expect(result.worktreePath).toBe(WORKTREE)
    expect(result.requiredPaths).toEqual(['AGENTS.md', 'swarm/skills/x/SKILL.md'])
    expect(result.missingPaths).toEqual([])
    expect(result.unverifiablePaths).toEqual([])
    expect(probed).toEqual([
      resolve(WORKTREE, 'AGENTS.md'),
      resolve(WORKTREE, 'swarm/skills/x/SKILL.md')
    ])
  })

  it('reports missing paths in declaration order and keeps the present ones out', async () => {
    const missing = resolve(WORKTREE, 'swarm/skills/x/SKILL.md')
    const { probe } = scriptedProbe({ [missing]: 'missing' })
    const result = await verifySparseTaskRequiredPaths({
      worktreePath: WORKTREE,
      requiredPaths: ['swarm/skills/x/SKILL.md', 'AGENTS.md', 'swarm'],
      probe
    })
    expect(result.missingPaths).toEqual(['swarm/skills/x/SKILL.md'])
    expect(result.unverifiablePaths).toEqual([])
  })

  it('separates unverifiable paths from missing ones', async () => {
    const unverifiable = resolve(WORKTREE, 'swarm')
    const { probe } = scriptedProbe({ [unverifiable]: 'unverifiable' })
    const result = await verifySparseTaskRequiredPaths({
      worktreePath: WORKTREE,
      requiredPaths: ['swarm'],
      probe
    })
    expect(result.missingPaths).toEqual([])
    expect(result.unverifiablePaths).toEqual(['swarm'])
  })

  it('reports unverifiable rather than rejecting when the probe itself throws', async () => {
    const result = await verifySparseTaskRequiredPaths({
      worktreePath: WORKTREE,
      requiredPaths: ['AGENTS.md', 'swarm'],
      probe: async (absolutePath) => {
        if (absolutePath === resolve(WORKTREE, 'swarm')) {
          throw new Error('transport disconnected')
        }
        return 'present'
      }
    })
    expect(result.missingPaths).toEqual([])
    expect(result.unverifiablePaths).toEqual(['swarm'])
  })

  it('probes each declaration once and never an ancestor or a parent cone', async () => {
    const { probe, probed } = scriptedProbe({})
    await verifySparseTaskRequiredPaths({
      worktreePath: WORKTREE,
      requiredPaths: ['swarm', 'swarm/skills/x/SKILL.md', 'swarm', 'AGENTS.md'],
      probe
    })
    expect(probed).toHaveLength(3)
    expect(new Set(probed)).toEqual(
      new Set([
        resolve(WORKTREE, 'swarm'),
        resolve(WORKTREE, 'swarm/skills/x/SKILL.md'),
        resolve(WORKTREE, 'AGENTS.md')
      ])
    )
    // Why: no probe may escape the worktree; expanding scope is a separate authorized operation.
    for (const absolutePath of probed) {
      const escaped = relative(WORKTREE, absolutePath)
      expect(isAbsolute(escaped) || escaped.startsWith('..')).toBe(false)
    }
  })

  it('does not probe anything when nothing is declared', async () => {
    const { probe, probed } = scriptedProbe({})
    const result = await verifySparseTaskRequiredPaths({
      worktreePath: WORKTREE,
      requiredPaths: [],
      probe
    })
    expect(result.requiredPaths).toEqual([])
    expect(probed).toEqual([])
  })

  it.each([
    ['relative path', 'worktree'],
    ['empty path', '']
  ])('refuses a %s as the worktree', async (_label, worktreePath) => {
    await expect(
      verifySparseTaskRequiredPaths({ worktreePath, requiredPaths: ['AGENTS.md'] })
    ).rejects.toThrow(/absolute worktree path/)
  })

  it('refuses a declared path that escapes the worktree before probing it', async () => {
    const probed: string[] = []
    await expect(
      verifySparseTaskRequiredPaths({
        worktreePath: WORKTREE,
        requiredPaths: ['../AGENTS.md'],
        probe: async (absolutePath) => {
          probed.push(absolutePath)
          return 'present'
        }
      })
    ).rejects.toMatchObject({ code: 'sparse_task_required_path_invalid' })
    expect(probed).toEqual([])
  })
})

describe('assertSparseTaskRequiredPathsPresent', () => {
  it('passes a clean check', () => {
    expect(() =>
      assertSparseTaskRequiredPathsPresent({
        worktreePath: WORKTREE,
        requiredPaths: ['AGENTS.md'],
        missingPaths: [],
        unverifiablePaths: []
      })
    ).not.toThrow()
  })

  it('fails closed on missing paths with the stable code', () => {
    const error = thrownBy(() =>
      assertSparseTaskRequiredPathsPresent({
        worktreePath: WORKTREE,
        requiredPaths: ['AGENTS.md', 'swarm'],
        missingPaths: ['swarm'],
        unverifiablePaths: []
      })
    )
    expect(error.code).toBe('sparse_task_required_path_missing')
    expect(error.message).toContain('sparse_task_required_path_missing')
    expect(error.message).toContain('"swarm"')
  })

  it('fails closed when a path could not be verified', () => {
    const error = thrownBy(() =>
      assertSparseTaskRequiredPathsPresent({
        worktreePath: WORKTREE,
        requiredPaths: ['swarm'],
        missingPaths: [],
        unverifiablePaths: ['swarm']
      })
    )
    expect(error.code).toBe('sparse_task_required_path_missing')
    expect(error.message).toContain('could not verify')
  })
})

describe('statSparseTaskPath', () => {
  async function makeWorktree(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'orca-sparse-task-required-'))
    tempRoots.push(root)
    await writeFile(join(root, 'AGENTS.md'), '# agents\n')
    await mkdir(join(root, 'swarm', 'skills'), { recursive: true })
    return root
  }

  it('reports present for a file and a directory', async () => {
    const root = await makeWorktree()
    const result = await verifySparseTaskRequiredPaths({
      worktreePath: root,
      requiredPaths: ['AGENTS.md', 'swarm/skills']
    })
    expect(result).toEqual({
      worktreePath: root,
      requiredPaths: ['AGENTS.md', 'swarm/skills'],
      missingPaths: [],
      unverifiablePaths: []
    })
  })

  it('reports missing for an absent path and for the child of a file', async () => {
    const root = await makeWorktree()
    const result = await verifySparseTaskRequiredPaths({
      worktreePath: root,
      requiredPaths: ['swarm/skills/x/SKILL.md', 'AGENTS.md/inner']
    })
    expect(result.missingPaths).toEqual(['swarm/skills/x/SKILL.md', 'AGENTS.md/inner'])
    // Why: a failed verification is diagnostic only — it must not create the path it checked.
    await expect(statSparseTaskPath(join(root, 'swarm', 'skills', 'x'))).resolves.toBe('missing')
  })

  it.skipIf(process.platform === 'win32')('reports missing for a dangling symlink', async () => {
    const root = await makeWorktree()
    await symlink(join(root, 'gone'), join(root, 'dangling'))
    expect(await statSparseTaskPath(join(root, 'dangling'))).toBe('missing')
  })
})

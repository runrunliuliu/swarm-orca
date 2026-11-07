// M1+M2: what a task sparse create refuses, verifies against the pinned tree, and reads back
// before it is allowed to report success. Real Git throughout, because the whole point of the
// pinned-tree probe is what Git does with the argv (and `:(literal)` in particular).
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { addSparseWorktree, addWorktree } from '../git/worktree'
import { parseSparseTaskTreeListing } from '../git/sparse-task-tree-validation'
import {
  assertSparseTaskWorkspaceCreatePath,
  assertSparseTaskWorkspaceNewBranch,
  buildSparseTaskWorkspaceReceipt,
  createSparseTaskWorkspace,
  pinSparseTaskWorkspaceBase,
  resolveSparseTaskWorkspaceRequest,
  sparseConeCovers,
  verifySparseTaskWorkspacePinnedTree,
  type SparseTaskWorkspaceRequest
} from './sparse-task-workspace-create'
import {
  inspectSparseTaskCreate,
  isSparseTaskCreateNeedsReconciliation
} from './sparse-task-create-reconciliation'

const tempRoots: string[] = []

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe']
  }).trim()
}

/** Raw `-z` output, undecoded, exactly as the probe runner hands it to the parser. */
function gitRaw(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
}

async function createRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-sparse-task-create-'))
  tempRoots.push(root)
  const repoPath = join(root, 'repo')
  execFileSync('git', ['init', '--quiet', repoPath])
  git(repoPath, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(repoPath, ['config', 'user.email', 'test@example.com'])
  git(repoPath, ['config', 'user.name', 'Test User'])
  await mkdir(join(repoPath, 'swarm', 'skills'), { recursive: true })
  await mkdir(join(repoPath, 'orca', 'src'), { recursive: true })
  await mkdir(join(repoPath, 'docs site'), { recursive: true })
  await mkdir(join(repoPath, '文档'), { recursive: true })
  await mkdir(join(repoPath, 'a*'), { recursive: true })
  await mkdir(join(repoPath, 'ab'), { recursive: true })
  await mkdir(join(repoPath, '-dash'), { recursive: true })
  await mkdir(join(repoPath, '.github'), { recursive: true })
  await writeFile(join(repoPath, 'AGENTS.md'), 'agents\n')
  await writeFile(join(repoPath, 'swarm', 'notes.md'), 'swarm\n')
  await writeFile(join(repoPath, 'swarm', 'skills', 'skill.md'), 'skill\n')
  await writeFile(join(repoPath, 'orca', 'src', 'main.ts'), 'main\n')
  await writeFile(join(repoPath, 'docs site', 'readme.md'), 'docs\n')
  await writeFile(join(repoPath, '文档', 'readme.md'), 'docs\n')
  await writeFile(join(repoPath, '-dash', 'file.txt'), 'dash\n')
  await writeFile(join(repoPath, '.github', 'workflow.yml'), 'on: push\n')
  await writeFile(join(repoPath, 'a*', 'file.txt'), 'glob-ish name\n')
  await writeFile(join(repoPath, 'ab', 'file.txt'), 'plain name\n')
  await writeFile(join(repoPath, 'plain.txt'), 'plain\n')
  git(repoPath, ['add', '-A'])
  git(repoPath, ['commit', '--quiet', '-m', 'initial'])
  return realpath(repoPath)
}

/** A commit that adds a symlink and a gitlink, i.e. entries a cone must refuse. */
async function commitSymlinkAndGitlink(repoPath: string): Promise<string> {
  await symlink('swarm', join(repoPath, 'link-to-swarm'))
  git(repoPath, ['add', 'link-to-swarm'])
  const head = git(repoPath, ['rev-parse', 'HEAD'])
  git(repoPath, ['update-index', '--add', '--cacheinfo', `160000,${head},submodule-dir`])
  git(repoPath, ['commit', '--quiet', '-m', 'symlink and gitlink'])
  return git(repoPath, ['rev-parse', 'HEAD'])
}

async function createSparseTaskWorktree(
  repoPath: string,
  directories: string[] = ['swarm']
): Promise<{ worktreePath: string; pin: Awaited<ReturnType<typeof pinSparseTaskWorkspaceBase>> }> {
  const pin = await pinSparseTaskWorkspaceBase({
    repoPath,
    baseBranch: 'main',
    baseSource: 'request'
  })
  const worktreePath = join(dirname(repoPath), 'wt-sparse-task')
  await addSparseWorktree(repoPath, worktreePath, 'task-sparse', directories, 'main', false, {
    pinnedBaseOid: pin.pinnedSha
  })
  return { worktreePath: await realpath(worktreePath), pin }
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('resolveSparseTaskWorkspaceRequest', () => {
  it('is null for every payload that did not opt in', () => {
    expect(resolveSparseTaskWorkspaceRequest(undefined)).toBeNull()
    expect(resolveSparseTaskWorkspaceRequest({ directories: ['swarm'] })).toBeNull()
  })

  it('parses the task request with the strict rules, not the legacy normalization', () => {
    const request = resolveSparseTaskWorkspaceRequest({
      directories: ['swarm/skills', 'swarm', 'swarm/skills'],
      mode: 'task-workspace-v1',
      requiredPaths: ['AGENTS.md', 'AGENTS.md', 'swarm/skills/SKILL.md']
    })

    expect(request).toEqual({
      directories: ['swarm/skills', 'swarm'],
      requiredPaths: ['AGENTS.md', 'swarm/skills/SKILL.md']
    })
  })

  it.each([
    ['absolute cone entry', { directories: ['/etc'], mode: 'task-workspace-v1' as const }],
    ['trailing separator', { directories: ['swarm/'], mode: 'task-workspace-v1' as const }],
    ['surrounding whitespace', { directories: [' swarm'], mode: 'task-workspace-v1' as const }],
    ['empty cone', { directories: [], mode: 'task-workspace-v1' as const }],
    [
      'escaping required path',
      { directories: ['swarm'], mode: 'task-workspace-v1' as const, requiredPaths: ['../x'] }
    ]
  ])('refuses %s before any Git work', (_label, sparseCheckout) => {
    expect(() => resolveSparseTaskWorkspaceRequest(sparseCheckout)).toThrow(
      /\[sparse_task_(directory|required_path)_invalid\]/
    )
  })

  it('keeps a legacy payload free of every task rule', () => {
    // Why: legacy callers keep their historical trim-and-drop normalization, including entries the
    // task contract refuses. Non-opted-in payloads must not start failing.
    expect(
      resolveSparseTaskWorkspaceRequest({
        directories: [' swarm ', '.', 'swarm/'],
        requiredPaths: ['../../outside']
      })
    ).toBeNull()
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

  it('leaves every legacy payload alone', () => {
    expect(() => assertSparseTaskWorkspaceCreatePath(null, 'ssh')).not.toThrow()
    expect(() => assertSparseTaskWorkspaceNewBranch(null, true)).not.toThrow()
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

describe('pinSparseTaskWorkspaceBase', () => {
  it('reports the resolved ref, the full lowercase sha and where the base came from', async () => {
    const repoPath = await createRepo()

    const pin = await pinSparseTaskWorkspaceBase({
      repoPath,
      baseBranch: 'main',
      baseSource: 'default'
    })

    expect(pin.baseSource).toBe('default')
    expect(pin.resolvedRef).toBe('refs/heads/main')
    expect(pin.pinnedSha).toBe(git(repoPath, ['rev-parse', 'refs/heads/main']).toLowerCase())
    expect(pin.pinnedSha).toMatch(/^[0-9a-f]{40,64}$/)
  })
})

describe('verifySparseTaskWorkspacePinnedTree', () => {
  it('accepts real tree entries including spaces, unicode, glob characters and a leading dash', async () => {
    const repoPath = await createRepo()
    const pin = await pinSparseTaskWorkspaceBase({ repoPath, baseBranch: 'main', baseSource: 'request' })

    const check = await verifySparseTaskWorkspacePinnedTree({
      repoPath,
      pin,
      requestedSparseCone: ['swarm', 'docs site', '文档', 'a*', '-dash', '.github']
    })

    expect(check.directories).toEqual(['swarm', 'docs site', '文档', 'a*', '-dash', '.github'])
    expect(check.pinnedSha).toBe(pin.pinnedSha)
    for (const entry of check.entries) {
      expect(entry.mode).toBe('040000')
      expect(entry.objectId).toBe(git(repoPath, ['rev-parse', `${pin.pinnedSha}:${entry.path}`]))
    }
  })

  // Why this shape: `git ls-tree` refuses `:(glob)` magic outright (fatal: pathspec magic not
  // supported by this command) and treats a bare pathspec without wildcard matching, so the probe's
  // `:(literal)` is explicit intent rather than a behavior change. The test pins both facts: a
  // pattern that would glob (`a?`) resolves to nothing, and the selection does not depend on which
  // default pathspec reading a Git version applies.
  it('resolves wildcard characters literally, not as a glob', async () => {
    const repoPath = await createRepo()
    const pin = await pinSparseTaskWorkspaceBase({ repoPath, baseBranch: 'main', baseSource: 'request' })

    const check = await verifySparseTaskWorkspacePinnedTree({
      repoPath,
      pin,
      requestedSparseCone: ['a*']
    })
    expect(check.directories).toEqual(['a*'])
    const bare = parseSparseTaskTreeListing(
      gitRaw(repoPath, ['ls-tree', '-z', '--full-tree', pin.pinnedSha, '--', 'a*'])
    )
    expect(bare.map((entry) => entry.path)).toEqual(['a*'])

    // `a?` would match both `a*` and `ab` under glob semantics; literal resolution finds nothing.
    await expect(
      verifySparseTaskWorkspacePinnedTree({ repoPath, pin, requestedSparseCone: ['a?'] })
    ).rejects.toThrow(/\[sparse_task_directory_missing\].*"a\?"/)
  })

  it('reads the pinned tree, not the possibly-sparse source checkout', async () => {
    const repoPath = await createRepo()
    const pin = await pinSparseTaskWorkspaceBase({ repoPath, baseBranch: 'main', baseSource: 'request' })
    git(repoPath, ['sparse-checkout', 'set', '--cone', 'swarm'])
    await expect(stat(join(repoPath, 'orca', 'src'))).rejects.toThrow()

    const check = await verifySparseTaskWorkspacePinnedTree({
      repoPath,
      pin,
      requestedSparseCone: ['orca/src']
    })

    expect(check.directories).toEqual(['orca/src'])
  })

  it('refuses a path that the pinned tree does not hold', async () => {
    const repoPath = await createRepo()
    const pin = await pinSparseTaskWorkspaceBase({ repoPath, baseBranch: 'main', baseSource: 'request' })

    await expect(
      verifySparseTaskWorkspacePinnedTree({
        repoPath,
        pin,
        requestedSparseCone: ['swarm', 'missing-dir']
      })
    ).rejects.toThrow(/\[sparse_task_directory_missing\].*missing-dir/)
  })

  it.each([
    ['a file', 'AGENTS.md', 'blob'],
    ['a symlink', 'link-to-swarm', 'symlink'],
    ['a gitlink', 'submodule-dir', 'gitlink']
  ])('refuses %s', async (_label, path, reason) => {
    const repoPath = await createRepo()
    const pinnedSha = await commitSymlinkAndGitlink(repoPath)
    const pin = { pinnedSha }

    await expect(
      verifySparseTaskWorkspacePinnedTree({ repoPath, pin, requestedSparseCone: [path] })
    ).rejects.toThrow(new RegExp(`\\[sparse_task_directory_not_tree\\].*${reason}`))
  })
})

describe('buildSparseTaskWorkspaceReceipt', () => {
  it('reports the pin, the HEAD it read back, the applied cone and the verified required paths', async () => {
    const repoPath = await createRepo()
    const { worktreePath, pin } = await createSparseTaskWorktree(repoPath, ['swarm/skills', 'swarm'])

    const receipt = await buildSparseTaskWorkspaceReceipt({
      worktreePath,
      branch: 'task-sparse',
      pin,
      requestedSparseCone: ['swarm/skills', 'swarm'],
      requiredPaths: ['AGENTS.md', 'swarm/notes.md']
    })

    expect(receipt).toEqual({
      baseSource: 'request',
      resolvedRef: 'refs/heads/main',
      pinnedSha: pin.pinnedSha,
      actualHead: pin.pinnedSha,
      requestedSparseCone: ['swarm/skills', 'swarm'],
      effectiveSparseCone: ['swarm'],
      requiredPaths: ['AGENTS.md', 'swarm/notes.md']
    })
  })

  it('fails the create when a required path is outside the cone, without widening it', async () => {
    const repoPath = await createRepo()
    const { worktreePath, pin } = await createSparseTaskWorktree(repoPath, ['swarm'])

    await expect(
      buildSparseTaskWorkspaceReceipt({
        worktreePath,
        branch: 'task-sparse',
        pin,
        requestedSparseCone: ['swarm'],
        requiredPaths: ['AGENTS.md', 'orca/src/main.ts']
      })
    ).rejects.toThrow(/\[sparse_task_required_path_missing\].*orca\/src\/main\.ts/)

    // Why: failing closed must not repair the workspace — no cone change, no fabricated file.
    await expect(stat(join(worktreePath, 'orca', 'src', 'main.ts'))).rejects.toThrow()
    expect(git(worktreePath, ['sparse-checkout', 'list'])).toBe('swarm')
  })

  it('fails when the created worktree is not at the pinned commit', async () => {
    const repoPath = await createRepo()
    const { worktreePath, pin } = await createSparseTaskWorktree(repoPath)
    await writeFile(join(repoPath, 'later.md'), 'later\n')
    git(repoPath, ['add', '-A'])
    git(repoPath, ['commit', '--quiet', '-m', 'later'])

    await expect(
      buildSparseTaskWorkspaceReceipt({
        worktreePath,
        branch: 'task-sparse',
        pin: { ...pin, pinnedSha: git(repoPath, ['rev-parse', 'HEAD']) },
        requestedSparseCone: ['swarm'],
        requiredPaths: []
      })
    ).rejects.toThrow(/\[sparse_task_head_mismatch\]/)
  })

  it('fails when the effective cone does not cover a requested directory', async () => {
    const repoPath = await createRepo()
    const { worktreePath, pin } = await createSparseTaskWorktree(repoPath, ['swarm'])

    await expect(
      buildSparseTaskWorkspaceReceipt({
        worktreePath,
        branch: 'task-sparse',
        pin,
        requestedSparseCone: ['swarm', 'orca/src'],
        requiredPaths: []
      })
    ).rejects.toThrow(/\[sparse_task_effective_cone_mismatch\].*orca\/src/)
  })

  it('fails closed when sparse state cannot be read back', async () => {
    const repoPath = await createRepo()
    const pin = await pinSparseTaskWorkspaceBase({ repoPath, baseBranch: 'main', baseSource: 'request' })
    const plainWorktreePath = join(dirname(repoPath), 'wt-plain')
    await addWorktree(repoPath, plainWorktreePath, 'plain', 'main', false, false)

    await expect(
      buildSparseTaskWorkspaceReceipt({
        worktreePath: plainWorktreePath,
        branch: 'plain',
        pin,
        requestedSparseCone: ['swarm'],
        requiredPaths: []
      })
    ).rejects.toThrow(/\[sparse_task_effective_cone_mismatch\]/)
  })
})

// M4 (minimum): a task create that ends without a receipt must say what it left behind, and must
// never delete it. Real Git throughout, because the adjudication is about what Git still records.
describe('inspectSparseTaskCreate', () => {
  const pinPath = async (repoPath: string) =>
    pinSparseTaskWorkspaceBase({ repoPath, baseBranch: 'main', baseSource: 'request' })

  it('reports absent when nothing was created', async () => {
    const repoPath = await createRepo()
    const pin = await pinPath(repoPath)
    const worktreePath = join(dirname(repoPath), 'wt-never-created')

    const inspection = await inspectSparseTaskCreate({
      repoPath,
      worktreePath,
      branch: 'never-created',
      pin,
      requestedSparseCone: ['swarm'],
      requiredPaths: []
    })

    expect(inspection).toMatchObject({
      state: 'absent',
      registered: false,
      ghostRegistration: false,
      directoryExists: false
    })
  })

  it('reports live for the workspace a successful create left behind', async () => {
    const repoPath = await createRepo()
    const { worktreePath, pin } = await createSparseTaskWorktree(repoPath, ['swarm'])

    const inspection = await inspectSparseTaskCreate({
      repoPath,
      worktreePath,
      branch: 'task-sparse',
      pin,
      requestedSparseCone: ['swarm'],
      requiredPaths: ['AGENTS.md', 'swarm/notes.md']
    })

    expect(inspection).toMatchObject({
      state: 'live',
      registered: true,
      directoryExists: true,
      headMatchesPin: true,
      effectiveSparseCone: ['swarm'],
      reasons: []
    })
    expect(inspection.head?.toLowerCase()).toBe(pin.pinnedSha.toLowerCase())
  })

  it('does not call an unreadable repository listing "absent"', async () => {
    // Why this is the safety-relevant case: `absent` lets the caller retry. A listing that could not
    // be read cannot prove the registration is gone, so the answer must stay unknown — and a
    // missing directory must not talk the inspection out of that.
    const notARepo = await mkdtemp(join(tmpdir(), 'orca-sparse-task-not-a-repo-'))
    tempRoots.push(notARepo)

    const inspection = await inspectSparseTaskCreate({
      repoPath: notARepo,
      worktreePath: join(notARepo, 'never-created'),
      branch: 'never-created',
      pin: { pinnedSha: '0'.repeat(40) },
      requestedSparseCone: ['swarm'],
      requiredPaths: []
    })

    expect(inspection).toMatchObject({ state: 'unverifiable', registered: false })
    expect(inspection.reasons).toContain('repo listing could not be read')
    expect(inspection.reasons).toContain(
      'the directory is missing but the registration could not be read'
    )
  })

  it('reports a ghost registration when only the Git registration remains', async () => {
    const repoPath = await createRepo()
    const { worktreePath, pin } = await createSparseTaskWorktree(repoPath, ['swarm'])
    await rm(worktreePath, { recursive: true, force: true })

    const inspection = await inspectSparseTaskCreate({
      repoPath,
      worktreePath,
      branch: 'task-sparse',
      pin,
      requestedSparseCone: ['swarm'],
      requiredPaths: []
    })

    // Why this is the interesting state: Git still lists it, so the name is taken, but there is no
    // directory to inspect — exactly the residue a killed writer leaves behind.
    expect(inspection).toMatchObject({
      state: 'partial',
      registered: true,
      ghostRegistration: true,
      directoryExists: false
    })
    expect(inspection.reasons).toContain('registered but the directory is missing')
  })

  it('reports partial, with the paths it could not prove, without changing the workspace', async () => {
    const repoPath = await createRepo()
    const { worktreePath, pin } = await createSparseTaskWorktree(repoPath, ['swarm'])

    const inspection = await inspectSparseTaskCreate({
      repoPath,
      worktreePath,
      branch: 'task-sparse',
      pin,
      requestedSparseCone: ['swarm'],
      requiredPaths: ['AGENTS.md', 'orca/src/main.ts']
    })

    expect(inspection).toMatchObject({ state: 'partial', missingRequiredPaths: ['orca/src/main.ts'] })
    // Why: the inspection is read-only — no cone widening, no checkout repair.
    expect(git(worktreePath, ['sparse-checkout', 'list'])).toBe('swarm')
    await expect(stat(join(worktreePath, 'orca', 'src', 'main.ts'))).rejects.toThrow()
  })
})

describe('createSparseTaskWorkspace reconciliation marker', () => {
  const addTaskWorktree =
    (repoPath: string, worktreePath: string, branch: string, directories: string[]) =>
    (pin: Awaited<ReturnType<typeof pinSparseTaskWorkspaceBase>>) =>
      addSparseWorktree(repoPath, worktreePath, branch, directories, 'main', false, {
        pinnedBaseOid: pin.pinnedSha,
        retainPartialWorktreeOnFailure: true
      })

  it('marks a post-side-effect failure and keeps the workspace instead of deleting it', async () => {
    const repoPath = await createRepo()
    const worktreePath = join(dirname(repoPath), 'wt-marker')

    const error = await createSparseTaskWorkspace({
      repoPath,
      worktreePath,
      branch: 'task-marker',
      baseBranch: 'main',
      baseSource: 'request',
      request: { directories: ['swarm'], requiredPaths: ['AGENTS.md', 'orca/src/main.ts'] },
      options: {},
      addWorktreeAtPin: addTaskWorktree(repoPath, worktreePath, 'task-marker', ['swarm'])
    }).then(
      () => null,
      (thrown: unknown) => thrown
    )

    expect(error).toBeInstanceOf(Error)
    const text = (error as Error).message
    expect(isSparseTaskCreateNeedsReconciliation(error)).toBe(true)
    expect(text).toContain('[sparse_task_create_needs_reconciliation]')
    // The inner gate stays visible: the marker must not hide who refused the create.
    expect(text).toContain('[sparse_task_required_path_missing]')
    expect(text).toContain('observed partial')
    expect(text).toContain(`branch task-marker`)
    expect(text).toContain('registration listed')
    // Why the code must survive: callers switch on `[sparse_task_*]`, so the marker may not erase it.
    expect((error as Error & { code?: string }).code).toBe('sparse_task_required_path_missing')
    // Why the workspace survives: evidence for a human, and a later retry must not silently inherit
    // a half-built directory either.
    expect((await stat(join(worktreePath, 'swarm', 'notes.md'))).isFile()).toBe(true)
    expect(git(repoPath, ['worktree', 'list'])).toContain(worktreePath)
  })

  it('leaves a refusal that ran before any side effect unmarked and retryable', async () => {
    const repoPath = await createRepo()
    const worktreePath = join(dirname(repoPath), 'wt-refused')

    const error = await createSparseTaskWorkspace({
      repoPath,
      worktreePath,
      branch: 'task-refused',
      baseBranch: 'main',
      baseSource: 'request',
      request: { directories: ['no-such-directory'], requiredPaths: [] },
      options: {},
      addWorktreeAtPin: addTaskWorktree(repoPath, worktreePath, 'task-refused', [
        'no-such-directory'
      ])
    }).then(
      () => null,
      (thrown: unknown) => thrown
    )

    expect((error as Error).message).toContain('[sparse_task_directory_missing]')
    expect(isSparseTaskCreateNeedsReconciliation(error)).toBe(false)
    await expect(stat(worktreePath)).rejects.toThrow()
    expect(git(repoPath, ['worktree', 'list'])).not.toContain(worktreePath)
  })
})

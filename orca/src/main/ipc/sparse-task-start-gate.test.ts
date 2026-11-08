// M3: a bound task workspace is launched only while it still matches what the create proved.
// Real Git throughout: the point of the gate is what HEAD, the cone and the declared paths are now,
// and a mocked Git would only assert the mock.
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { addSparseWorktree } from '../git/worktree'
import { createSparseTaskWorkspaceBinding } from '../../shared/worktree/sparse-task-binding'
import type { SparseTaskWorkspaceReceipt } from '../../shared/worktree/create-types'
import {
  SparseTaskStartGateError,
  assertTaskWorkspaceLaunchableFor,
  assertTaskWorkspaceReadyToLaunch,
  inspectTaskWorkspaceReadiness,
  inspectTaskWorkspaceReadinessFor,
  type SparseTaskStartGateReason
} from './sparse-task-start-gate'

const tempRoots: string[] = []

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}

async function createRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-start-gate-'))
  tempRoots.push(root)
  const repoPath = join(root, 'repo')
  execFileSync('git', ['init', '--quiet', repoPath])
  git(repoPath, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(repoPath, ['config', 'user.email', 'test@example.com'])
  git(repoPath, ['config', 'user.name', 'Test User'])
  await mkdir(join(repoPath, 'swarm', 'skills'), { recursive: true })
  await mkdir(join(repoPath, 'orca', 'src'), { recursive: true })
  await writeFile(join(repoPath, 'AGENTS.md'), 'agents\n')
  await writeFile(join(repoPath, 'swarm', 'notes.md'), 'swarm\n')
  await writeFile(join(repoPath, 'swarm', 'skills', 'skill.md'), 'skill\n')
  await writeFile(join(repoPath, 'orca', 'src', 'main.ts'), 'main\n')
  git(repoPath, ['add', '-A'])
  git(repoPath, ['commit', '--quiet', '-m', 'initial'])
  return realpath(repoPath)
}

/** The workspace a task create leaves behind: a new branch at a pinned commit with one cone. */
async function createTaskWorkspace(
  repoPath: string,
  directories: string[] = ['swarm']
): Promise<{ worktreePath: string; pinnedSha: string; branch: string }> {
  const pinnedSha = git(repoPath, ['rev-parse', 'refs/heads/main'])
  const branch = 'task-gate'
  const worktreePath = join(dirname(repoPath), `wt-${branch}`)
  await addSparseWorktree(repoPath, worktreePath, branch, directories, 'main', false, {
    pinnedBaseOid: pinnedSha
  })
  return { worktreePath: await realpath(worktreePath), pinnedSha, branch }
}

function receipt(
  pinnedSha: string,
  overrides: Partial<SparseTaskWorkspaceReceipt> = {}
): SparseTaskWorkspaceReceipt {
  return {
    baseSource: 'request',
    resolvedRef: 'refs/heads/main',
    pinnedSha,
    actualHead: pinnedSha,
    requestedSparseCone: ['swarm'],
    effectiveSparseCone: ['swarm'],
    requiredPaths: ['swarm/notes.md'],
    ...overrides
  }
}

async function reasonOf(run: () => Promise<void>): Promise<SparseTaskStartGateReason | 'none'> {
  try {
    await run()
    return 'none'
  } catch (error) {
    if (error instanceof SparseTaskStartGateError) {
      return error.reason
    }
    throw error
  }
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('assertTaskWorkspaceLaunchableFor', () => {
  it('lets an unbound workspace through: legacy and external workspaces have nothing to gate', async () => {
    const repoPath = await createRepo()
    const { worktreePath } = await createTaskWorkspace(repoPath)

    await expect(
      assertTaskWorkspaceLaunchableFor({
        store: { getWorktreeMeta: () => ({ sparseTaskBinding: undefined }) },
        workspace: { id: 'repo-1::/wt', path: worktreePath }
      })
    ).resolves.toBeUndefined()
    // A store that cannot answer at all is the same case, not a failure.
    await expect(
      assertTaskWorkspaceLaunchableFor({
        store: undefined,
        workspace: { id: 'repo-1::/wt', path: worktreePath }
      })
    ).resolves.toBeUndefined()
  })

  it('refuses a workspace whose stored binding cannot be read', async () => {
    const repoPath = await createRepo()
    const { worktreePath } = await createTaskWorkspace(repoPath)

    expect(
      await reasonOf(() =>
        assertTaskWorkspaceLaunchableFor({
          store: { getWorktreeMeta: () => ({ sparseTaskBinding: { schemaVersion: 1 } }) },
          workspace: { id: 'repo-1::/wt', path: worktreePath }
        })
      )
    ).toBe('binding_invalid')
  })

  it('launches a workspace that still contains its baseline and declarations', async () => {
    const repoPath = await createRepo()
    const { worktreePath, pinnedSha } = await createTaskWorkspace(repoPath)
    const binding = createSparseTaskWorkspaceBinding(receipt(pinnedSha), 1)

    await expect(
      assertTaskWorkspaceLaunchableFor({
        store: { getWorktreeMeta: () => ({ sparseTaskBinding: binding }) },
        workspace: { id: 'repo-1::/wt', path: worktreePath }
      })
    ).resolves.toBeUndefined()
  })

  it('keeps working after the agent commits on top of the pinned baseline', async () => {
    const repoPath = await createRepo()
    const { worktreePath, pinnedSha } = await createTaskWorkspace(repoPath)
    const binding = createSparseTaskWorkspaceBinding(receipt(pinnedSha), 1)
    await writeFile(join(worktreePath, 'swarm', 'work.md'), 'work\n')
    git(worktreePath, ['add', '-A'])
    git(worktreePath, ['commit', '--quiet', '-m', 'work'])

    await expect(
      assertTaskWorkspaceReadyToLaunch({ binding, worktreePath })
    ).resolves.toBeUndefined()
  })

  it('refuses a workspace whose HEAD no longer contains the baseline', async () => {
    const repoPath = await createRepo()
    const { worktreePath, pinnedSha } = await createTaskWorkspace(repoPath)
    const binding = createSparseTaskWorkspaceBinding(receipt(pinnedSha), 1)
    // Why an orphan commit: a commit that merely continues the pinned history keeps the pin as an
    // ancestor, which is exactly the case the gate must accept. Unrelated history is the failure.
    git(repoPath, ['checkout', '--quiet', '--orphan', 'unrelated'])
    git(repoPath, ['commit', '--quiet', '--allow-empty', '-m', 'unrelated'])
    const other = git(repoPath, ['rev-parse', 'HEAD'])
    git(worktreePath, ['checkout', '--quiet', '--detach', other])

    expect(await reasonOf(() => assertTaskWorkspaceReadyToLaunch({ binding, worktreePath }))).toBe(
      'not_ready'
    )
  })

  it('refuses a workspace whose cone no longer covers the declared request', async () => {
    const repoPath = await createRepo()
    const { worktreePath, pinnedSha } = await createTaskWorkspace(repoPath, ['swarm'])
    const binding = createSparseTaskWorkspaceBinding(
      receipt(pinnedSha, { requestedSparseCone: ['swarm', 'orca'] }),
      1
    )

    expect(await reasonOf(() => assertTaskWorkspaceReadyToLaunch({ binding, worktreePath }))).toBe(
      'not_ready'
    )
  })

  it('refuses a workspace missing a declared required path', async () => {
    const repoPath = await createRepo()
    const { worktreePath, pinnedSha } = await createTaskWorkspace(repoPath, ['swarm'])
    // Why a nested path and not AGENTS.md: cone mode always materializes the root's files, so the
    // root would prove nothing about a missing declaration.
    const binding = createSparseTaskWorkspaceBinding(
      receipt(pinnedSha, { requiredPaths: ['orca/src/main.ts'] }),
      1
    )

    expect(await reasonOf(() => assertTaskWorkspaceReadyToLaunch({ binding, worktreePath }))).toBe(
      'not_ready'
    )
  })

  it('reports "unverified" when the workspace itself cannot be read', async () => {
    const repoPath = await createRepo()
    const { pinnedSha } = await createTaskWorkspace(repoPath)
    const binding = createSparseTaskWorkspaceBinding(receipt(pinnedSha), 1)

    expect(
      await reasonOf(() =>
        assertTaskWorkspaceReadyToLaunch({
          binding,
          worktreePath: join(dirname(repoPath), 'missing-worktree')
        })
      )
    ).toBe('unverified')
  })

  it('does not gate a remote workspace, whose probe would run on the wrong host', async () => {
    const repoPath = await createRepo()
    const { pinnedSha } = await createTaskWorkspace(repoPath)
    const binding = createSparseTaskWorkspaceBinding(receipt(pinnedSha), 1)

    await expect(
      assertTaskWorkspaceLaunchableFor({
        store: { getWorktreeMeta: () => ({ sparseTaskBinding: binding }) },
        workspace: { id: 'repo-1::/remote', path: join(dirname(repoPath), 'missing'), connectionId: 'ssh-1' }
      })
    ).resolves.toBeUndefined()
  })
})

// M3 read-only surface: the same probes, but as an answer a client can render.
describe('inspectTaskWorkspaceReadinessFor', () => {
  it('answers "unbound" for a workspace the task contract never applied to', async () => {
    const repoPath = await createRepo()
    const { worktreePath } = await createTaskWorkspace(repoPath)

    const report = await inspectTaskWorkspaceReadinessFor({
      store: {},
      workspace: { id: 'repo-1::/wt', path: worktreePath }
    })

    expect(report.state).toBe('unbound')
    expect(report.reasons).toEqual([])
  })

  it('reports "ready" with the pinned sha for a workspace that still matches', async () => {
    const repoPath = await createRepo()
    const { worktreePath, pinnedSha } = await createTaskWorkspace(repoPath)
    const binding = createSparseTaskWorkspaceBinding(receipt(pinnedSha), 1)

    const report = await inspectTaskWorkspaceReadinessFor({
      store: { getWorktreeMeta: () => ({ sparseTaskBinding: binding }) },
      workspace: { id: 'repo-1::/wt', path: worktreePath }
    })

    expect(report).toMatchObject({ state: 'ready', pinnedSha, reasons: [] })
    expect(report.head?.toLowerCase()).toBe(pinnedSha.toLowerCase())
    expect(report.checkedAt).toBeGreaterThan(0)
  })

  it('reports drift with the reason instead of throwing', async () => {
    const repoPath = await createRepo()
    const { worktreePath, pinnedSha } = await createTaskWorkspace(repoPath)
    const binding = createSparseTaskWorkspaceBinding(
      receipt(pinnedSha, { requestedSparseCone: ['swarm', 'orca'] }),
      1
    )

    const report = await inspectTaskWorkspaceReadinessFor({
      store: { getWorktreeMeta: () => ({ sparseTaskBinding: binding }) },
      workspace: { id: 'repo-1::/wt', path: worktreePath }
    })

    expect(report.state).toBe('drifted')
    expect(report.reasons.join(' ')).toContain('orca')
  })

  it('reports a binding it cannot parse as binding_invalid, never as ready', async () => {
    const report = await inspectTaskWorkspaceReadinessFor({
      store: { getWorktreeMeta: () => ({ sparseTaskBinding: { schemaVersion: 9 } }) },
      workspace: { id: 'repo-1::/wt', path: '/nowhere' }
    })

    expect(report.state).toBe('binding_invalid')
  })

  it('reports a remote bound workspace as unverified rather than probing the wrong host', async () => {
    const repoPath = await createRepo()
    const { pinnedSha } = await createTaskWorkspace(repoPath)
    const binding = createSparseTaskWorkspaceBinding(receipt(pinnedSha), 1)

    const report = await inspectTaskWorkspaceReadinessFor({
      store: { getWorktreeMeta: () => ({ sparseTaskBinding: binding }) },
      workspace: { id: 'repo-1::/remote', path: '/nowhere', connectionId: 'ssh-1' }
    })

    expect(report.state).toBe('unverified')
    expect(report.reasons.join(' ')).toContain('remote')
  })

  it('lets a proven failure win over a probe that could not answer', async () => {
    const repoPath = await createRepo()
    const { worktreePath, pinnedSha } = await createTaskWorkspace(repoPath)
    const binding = createSparseTaskWorkspaceBinding(
      receipt(pinnedSha, { requiredPaths: ['orca/src/main.ts'] }),
      1
    )
    // Why remove the git marker: HEAD and the cone become unreadable while the missing declared path
    // is still a proven fact, so `drifted` must win over `unverified`.
    await rm(join(worktreePath, '.git'), { force: true })

    const report = await inspectTaskWorkspaceReadiness({
      binding,
      worktreePath
    })

    expect(report.state).toBe('drifted')
    expect(report.reasons.join(' ')).toContain('orca/src/main.ts')
  })
})

import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createWorktreeCopiedPaths: vi.fn(),
  createWorktreeLinkedPaths: vi.fn(),
  createWorktreeSharedPaths: vi.fn(),
  resolveWorktreeIncludePaths: vi.fn(async () => []),
  resolveWorktreeSharedDirectories: vi.fn(async () => [])
}))

vi.mock('../ipc/worktree-symlinks', () => ({
  createWorktreeCopiedPaths: mocks.createWorktreeCopiedPaths,
  createWorktreeLinkedPaths: mocks.createWorktreeLinkedPaths,
  createWorktreeSharedPaths: mocks.createWorktreeSharedPaths
}))
vi.mock('../git/worktree-include-file', () => ({
  resolveWorktreeIncludePaths: mocks.resolveWorktreeIncludePaths
}))
vi.mock('../git/worktree-shared-directories', () => ({
  resolveWorktreeSharedDirectories: mocks.resolveWorktreeSharedDirectories
}))

import { parseSparseTaskWorkspaceBinding } from '../../shared/worktree/sparse-task-binding'
import { materializeRuntimeLocalWorktree } from './runtime-local-worktree-materialization'

describe('materializeRuntimeLocalWorktree', () => {
  it('records lineage immediately after metadata and before filesystem setup', async () => {
    const order: string[] = []
    mocks.createWorktreeLinkedPaths.mockImplementationOnce(async () => {
      order.push('filesystem')
      throw new Error('link failed')
    })
    const store = {
      getProjectHostSetups: () => [],
      setWorktreeMeta: vi.fn((_id, updates) => ({ ...updates, hostId: 'local' }))
    }

    await expect(
      materializeRuntimeLocalWorktree({
        request: {},
        repo: {
          id: 'repo-1',
          path: '/repo',
          displayName: 'Repo',
          badgeColor: '#000000',
          addedAt: 1,
          symlinkPaths: ['node_modules']
        },
        store,
        settings: { workspaceDir: '/worktrees', nestWorkspaces: true },
        created: {
          path: '/worktrees/app',
          head: 'abc123',
          branch: 'feature/app',
          isBare: false,
          isMainWorktree: false
        },
        remoteTrackingBase: null,
        sparseDirectories: [],
        checkoutExistingBranch: false,
        baseBranch: 'main',
        branchName: 'feature/app',
        effectiveRequestedName: 'app',
        effectiveSanitizedName: 'app',
        localWorktreeGitOptions: {},
        onMetadataPersisted: () => {
          order.push('metadata')
          return null
        }
      } as never)
    ).rejects.toThrow('link failed')

    expect(order).toEqual(['metadata', 'filesystem'])
  })

  /** The runtime create writes its own metadata, so the binding has to be proven here too — the
   *  desktop path is a different call site with the same contract. */
  const materialize = (sparseCheckoutReceipt?: Record<string, unknown>) => {
    const store = {
      getProjectHostSetups: () => [],
      setWorktreeMeta: vi.fn((_id, updates) => ({ ...updates, hostId: 'local' }))
    }
    const run = materializeRuntimeLocalWorktree({
      request: {},
      repo: {
        id: 'repo-1',
        path: '/repo',
        displayName: 'Repo',
        badgeColor: '#000000',
        addedAt: 1,
        symlinkPaths: []
      },
      store,
      settings: { workspaceDir: '/worktrees', nestWorkspaces: true },
      created: {
        path: '/worktrees/app',
        head: 'abc123',
        branch: 'feature/app',
        isBare: false,
        isMainWorktree: false
      },
      remoteTrackingBase: null,
      sparseDirectories: [],
      checkoutExistingBranch: false,
      baseBranch: 'main',
      branchName: 'feature/app',
      effectiveRequestedName: 'app',
      effectiveSanitizedName: 'app',
      ...(sparseCheckoutReceipt
        ? { sparseCheckoutReceipt: sparseCheckoutReceipt as never }
        : {}),
      localWorktreeGitOptions: {},
      onMetadataPersisted: () => null
    } as never)
    return { run, store }
  }

  it('persists a readable task binding when the create came from a task receipt', async () => {
    const receipt = {
      baseSource: 'request' as const,
      resolvedRef: 'refs/heads/main',
      pinnedSha: 'a'.repeat(40),
      actualHead: 'a'.repeat(40),
      requestedSparseCone: ['swarm'],
      effectiveSparseCone: ['swarm'],
      requiredPaths: ['AGENTS.md']
    }
    const { run, store } = materialize(receipt)
    await run

    const persisted = store.setWorktreeMeta.mock.calls.at(-1)?.[1] as {
      sparseTaskBinding?: unknown
    }
    const binding = parseSparseTaskWorkspaceBinding(persisted?.sparseTaskBinding)
    expect(binding).toMatchObject({
      pinnedSha: 'a'.repeat(40),
      requestedSparseCone: ['swarm'],
      requiredPaths: ['AGENTS.md']
    })
  })

  it('persists no binding for a create that had no task receipt', async () => {
    const { run, store } = materialize()
    await run

    const persisted = store.setWorktreeMeta.mock.calls.at(-1)?.[1] as {
      sparseTaskBinding?: unknown
    }
    expect(persisted?.sparseTaskBinding).toBeUndefined()
  })
})

/**
 * Pins which registration owns a `path:` selector when two repos on one host spell one directory.
 *
 * Live case: repo `fin_verl` is registered at its main checkout, while a second repo
 * (`fin_verl-agent-training-monitor`) is registered at a linked worktree of the same `.git`.
 * Scanning the second repo reports every worktree of the shared repository, so the main
 * checkout appeared twice. `path:<main checkout>` used to collapse to `candidates[0]` — repo
 * insertion order — and produced `<second-repo-id>::<main checkout>`: an id that no
 * `worktree list --repo` ever returns. A strict startup then refused the session as a
 * workspace-id mismatch, which is correct for the mismatch but was caused by this pick.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const electronMocks = vi.hoisted(() => {
  const ipcMain = {
    on: vi.fn(() => ipcMain),
    removeListener: vi.fn(() => ipcMain),
    emit: vi.fn(() => true)
  }
  return {
    BrowserWindow: { fromId: vi.fn((): unknown => null) },
    webContents: { fromId: vi.fn((): unknown => null) },
    ipcMain,
    app: { getPath: vi.fn(() => '/tmp'), isPackaged: false }
  }
})
vi.mock('electron', () => electronMocks)

const getSshGitProviderMock = vi.hoisted(() => vi.fn())
vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: getSshGitProviderMock,
  getSshGitProviderGeneration: vi.fn(() => 0),
  SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE: 'unavailable',
  requireSshGitProvider: (connectionId: string) => getSshGitProviderMock(connectionId)
}))

const listWorktreesStrictMock = vi.hoisted(() => vi.fn())
vi.mock('../git/worktree', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listWorktreesStrict: listWorktreesStrictMock
}))

import { OrcaRuntimeService } from './orca-runtime'

const MAIN_REPO_ID = 'repo-main'
const LINKED_REPO_ID = 'repo-linked'
const MAIN_PATH = '/srv/projects/app'
const LINKED_PATH = '/srv/projects/worktrees/plugin-host'

/** One shared `.git`: the main checkout plus one linked worktree. */
const SHARED_WORKTREES = [
  { path: MAIN_PATH, head: 'abc', branch: 'main', isBare: false, isMainWorktree: true },
  { path: LINKED_PATH, head: 'def', branch: 'feature', isBare: false, isMainWorktree: false }
]

function makeStore(repoOrder: 'main-first' | 'linked-first') {
  const main = {
    id: MAIN_REPO_ID,
    path: MAIN_PATH,
    displayName: 'app',
    badgeColor: 'blue',
    addedAt: 1
  }
  const linked = {
    id: LINKED_REPO_ID,
    path: LINKED_PATH,
    displayName: 'app-plugin-host',
    badgeColor: 'green',
    addedAt: 2
  }
  const repos = repoOrder === 'main-first' ? [main, linked] : [linked, main]
  const metaById: Record<string, Record<string, unknown>> = {}
  return {
    getRepo: (id: string) => repos.find((repo) => repo.id === id),
    getRepos: () => repos,
    getAllWorktreeMeta: vi.fn(() => metaById),
    getWorktreeMeta: (id: string) => metaById[id],
    setWorktreeMeta: vi.fn(),
    removeWorktreeMeta: () => {},
    getAllWorktreeLineage: () => ({}),
    getAllWorkspaceLineage: () => ({}),
    removeWorktreeLineage: vi.fn(),
    removeWorkspaceLineage: vi.fn(),
    getGitHubCache: () => undefined as never,
    getSettings: () => ({
      workspaceDir: '/tmp/workspaces',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: false,
      branchPrefix: 'none',
      branchPrefixCustom: ''
    }),
    getProjects: () => []
  }
}

beforeEach(() => {
  getSshGitProviderMock.mockReset()
  listWorktreesStrictMock.mockReset()
  // Both registrations share one `.git`, so either scan reports the same worktrees.
  listWorktreesStrictMock.mockResolvedValue(SHARED_WORKTREES)
})

describe('path: selector ownership when one host has duplicate directory spellings', () => {
  it.each(['main-first', 'linked-first'] as const)(
    'resolves the main checkout to the repo registered at it (%s repo order)',
    async (order) => {
      const runtime = new OrcaRuntimeService(makeStore(order) as never)
      await expect(runtime.showManagedWorktree(`path:${MAIN_PATH}`)).resolves.toMatchObject({
        id: `${MAIN_REPO_ID}::${MAIN_PATH}`
      })
    }
  )

  it.each(['main-first', 'linked-first'] as const)(
    'still resolves the linked worktree to its own registration (%s repo order)',
    async (order) => {
      const runtime = new OrcaRuntimeService(makeStore(order) as never)
      await expect(runtime.showManagedWorktree(`path:${LINKED_PATH}`)).resolves.toMatchObject({
        id: `${LINKED_REPO_ID}::${LINKED_PATH}`
      })
    }
  )

  it('never invents a cross-repo id for the main checkout', async () => {
    // The regression: path: answered `<linked-repo>::<main checkout>`, which no repo scan lists.
    for (const order of ['main-first', 'linked-first'] as const) {
      const runtime = new OrcaRuntimeService(makeStore(order) as never)
      const resolved = await runtime.showManagedWorktree(`path:${MAIN_PATH}`)
      expect(resolved.id).not.toBe(`${LINKED_REPO_ID}::${MAIN_PATH}`)
    }
  })
})

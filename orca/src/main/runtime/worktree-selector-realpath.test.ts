/**
 * A worktree registered under the real path must still answer a selector written through a symlink.
 *
 * Live case: the workspace root was reached through a symlinked parent, so the renderer/CLI asked
 * with `id:` and `path:` in the link spelling while the scan reported the target spelling. Both
 * used to fail with `selector_not_found` even though `name:` resolved the same worktree.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
import { resolveLocalSelectorRealpath } from './runtime-worktree-selector-realpath'

const REPO_ID = 'repo-local'
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'orca-selector-realpath-')))
const REAL_ROOT = join(ROOT, 'real')
const LINK_ROOT = join(ROOT, 'link')
const REPO_PATH = join(REAL_ROOT, 'projects', 'app')
/** The spelling the Git scan reports — the symlink is already resolved. */
const WORKTREE_PATH = join(REAL_ROOT, 'workspaces', 'plugin-host')
/** The spelling a caller can legitimately type: the same directory through the symlinked parent. */
const LINKED_WORKTREE_PATH = join(LINK_ROOT, 'workspaces', 'plugin-host')

function makeStore(executionHostId?: string) {
  const repo = {
    id: REPO_ID,
    path: REPO_PATH,
    displayName: 'app',
    badgeColor: 'blue',
    addedAt: 1,
    ...(executionHostId ? { executionHostId } : {})
  }
  const metaById: Record<string, Record<string, unknown>> = {}
  return {
    getRepo: (id: string) => (id === REPO_ID ? repo : undefined),
    getRepos: () => [repo],
    getAllWorktreeMeta: vi.fn(() => metaById),
    getWorktreeMeta: (id: string) => metaById[id],
    setWorktreeMeta: vi.fn(),
    removeWorktreeMeta: () => {},
    getAllWorktreeLineage: () => ({}),
    getAllWorkspaceLineage: () => ({}),
    removeWorktreeLineage: vi.fn(),
    removeWorkspaceLineage: vi.fn(),
    getGitHubCache: () => ({ pr: {}, issue: {} }),
    getSettings: () => ({
      workspaceDir: join(ROOT, 'workspaces'),
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: false,
      branchPrefix: 'none',
      branchPrefixCustom: ''
    }),
    getProjects: () => []
  }
}

function makeRuntime(executionHostId?: string): OrcaRuntimeService {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the runtime only reads the store members this fixture defines; the full Store surface is not under test.
  return new OrcaRuntimeService(makeStore(executionHostId) as never)
}

function scanReports(): void {
  listWorktreesStrictMock.mockResolvedValue([
    { path: REPO_PATH, head: 'abc', branch: 'main', isBare: false, isMainWorktree: true },
    { path: WORKTREE_PATH, head: 'def', branch: 'feature', isBare: false, isMainWorktree: false }
  ])
}

beforeEach(() => {
  getSshGitProviderMock.mockReset()
  listWorktreesStrictMock.mockReset()
  scanReports()
})

beforeAll(() => {
  if (process.platform === 'win32') {
    return
  }
  mkdirSync(REPO_PATH, { recursive: true })
  mkdirSync(WORKTREE_PATH, { recursive: true })
  symlinkSync(REAL_ROOT, LINK_ROOT, 'dir')
})

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

describe('realpath fallback eligibility', () => {
  it('refuses Windows and WSL UNC spellings', () => {
    expect(resolveLocalSelectorRealpath('C:\\work\\plugin-host')).toBeNull()
    expect(resolveLocalSelectorRealpath('\\\\wsl.localhost\\Ubuntu\\home\\me\\repo')).toBeNull()
  })

  it('refuses a relative selector so a name or branch cannot resolve against the cwd', () => {
    expect(resolveLocalSelectorRealpath('release-radar')).toBeNull()
  })
})

describe.skipIf(process.platform === 'win32')(
  'a selector written through a symlinked parent',
  () => {
    it('resolves an `id:` selector to the worktree the scan registered under the real path', async () => {
      const runtime = makeRuntime()

      await expect(
        runtime.showManagedWorktree(`id:${REPO_ID}::${LINKED_WORKTREE_PATH}`)
      ).resolves.toMatchObject({ id: `${REPO_ID}::${WORKTREE_PATH}`, path: WORKTREE_PATH })
    })

    it('resolves a `path:` selector to the worktree the scan registered under the real path', async () => {
      const runtime = makeRuntime()

      await expect(
        runtime.showManagedWorktree(`path:${LINKED_WORKTREE_PATH}`)
      ).resolves.toMatchObject({ id: `${REPO_ID}::${WORKTREE_PATH}` })
    })

    it('resolves a bare path selector to the same worktree', async () => {
      const runtime = makeRuntime()

      await expect(runtime.showManagedWorktree(LINKED_WORKTREE_PATH)).resolves.toMatchObject({
        id: `${REPO_ID}::${WORKTREE_PATH}`
      })
    })

    it('keeps a missing directory unresolvable instead of inventing a match', async () => {
      const runtime = makeRuntime()
      const missing = join(LINK_ROOT, 'workspaces', 'deleted-plugin')

      await expect(runtime.showManagedWorktree(`path:${missing}`)).rejects.toThrow(
        'selector_not_found'
      )
      await expect(runtime.showManagedWorktree(`id:${REPO_ID}::${missing}`)).rejects.toThrow(
        'selector_not_found'
      )
      await expect(runtime.showManagedWorktree(missing)).rejects.toThrow('selector_not_found')
    })

    it('does not let a local realpath answer for a workspace owned by another host', async () => {
      const runtime = makeRuntime('runtime:other-host')

      await expect(runtime.showManagedWorktree(`path:${LINKED_WORKTREE_PATH}`)).rejects.toThrow(
        'selector_not_found'
      )
    })
  }
)

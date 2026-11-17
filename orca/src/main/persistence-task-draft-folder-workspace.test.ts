import {
  closeTestStores,
  createStore,
  makeRepo,
  readPersistedStateJson,
  testState
} from './persistence-test-harness'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { folderWorkspaceKey } from '../shared/workspace-scope'
import { folderWorkspaceToWorktree } from '../shared/folder-workspace-worktree'
import { FolderWorkspaceCreate } from '../shared/rpc-contract/folder-workspace-params'
import { FolderWorkspaceCreateArgs } from './ipc/repos/repo-ipc-arg-schemas'

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.dir
  }
}))

describe('taskDraft folder workspace', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  // A checkout-backed group is the tempting fallback the draft must never fall back to.
  const groupPath = '/repo/checkout'
  const draftPath = '/app-data/task-drafts/5f2c8a10-6f3b-4c8a-9a2e'

  async function createDraftGroup() {
    const store = await createStore()
    const group = store.createProjectGroup({
      name: 'Platform',
      parentPath: groupPath,
      createdFrom: 'folder-scan'
    })
    return { store, projectGroupId: group.id }
  }

  it('persists the explicit userData draft path instead of the group parent path', async () => {
    const { store, projectGroupId } = await createDraftGroup()

    const workspace = store.createFolderWorkspace({
      projectGroupId,
      name: 'add-login-retry',
      folderPath: draftPath,
      taskDraft: true
    })

    expect(workspace.folderPath).toBe(draftPath)
    expect(workspace.folderPath).not.toBe(groupPath)
    // A descendant would mean the draft landed inside the checkout, which the dock must never do.
    expect(workspace.folderPath.startsWith(`${groupPath}/`)).toBe(false)
    expect(workspace.taskDraft).toBe(true)

    store.flush()
    const persisted = readPersistedStateJson()
    expect(persisted).toContain(draftPath)
    expect(persisted).toContain('"taskDraft"')
  })

  it('registers a folder workspace, not a repository checkout', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())
    const group = store.createProjectGroup({
      name: 'Platform',
      parentPath: groupPath,
      createdFrom: 'folder-scan'
    })
    const reposBefore = store.getRepos().length

    const workspace = store.createFolderWorkspace({
      projectGroupId: group.id,
      name: 'add-login-retry',
      folderPath: draftPath,
      taskDraft: true
    })
    const worktree = folderWorkspaceToWorktree(workspace)

    expect(worktree.id).toBe(folderWorkspaceKey(workspace.id))
    expect(worktree.id.startsWith('folder:')).toBe(true)
    expect(worktree.path).toBe(draftPath)
    expect(worktree.head).toBe('')
    expect(worktree.branch).toBe('')
    expect(worktree.isBare).toBe(false)
    expect(worktree.isMainWorktree).toBe(false)

    // Nothing records a branch, PR or base for it. Read optionally: the row is normally absent
    // outright, and either way no field the dock did not author may appear.
    const meta = store.getWorktreeMeta(worktree.id)
    expect(meta?.linkedPR ?? null).toBeNull()
    expect(meta?.baseRef).toBeUndefined()
    expect(meta?.pushTarget).toBeUndefined()
    expect(store.getWorktreeLineage(worktree.id)).toBeUndefined()
    expect(store.getWorkspaceLineage(folderWorkspaceKey(workspace.id))).toBeUndefined()
    expect(store.getRepos().length).toBe(reposBefore)
  })

  it('round-trips the marker and the explicit path through a second store', async () => {
    const { store, projectGroupId } = await createDraftGroup()
    const workspace = store.createFolderWorkspace({
      projectGroupId,
      name: 'add-login-retry',
      folderPath: draftPath,
      taskDraft: true
    })
    store.flush()

    const reloaded = (await createStore()).getFolderWorkspace(workspace.id)

    expect(
      reloaded?.taskDraft,
      'normalizeFolderWorkspaces (src/shared/folder-workspaces.ts) must project taskDraft. If it is ' +
        'dropped on load, the next save erases the marker and the sidebar can no longer tell a ' +
        'draft from a real folder workspace.'
    ).toBe(true)
    expect(reloaded?.folderPath).toBe(draftPath)
  })

  it('keeps the field absent for a plain folder workspace across a round trip', async () => {
    const { store, projectGroupId } = await createDraftGroup()

    // The pre-existing call shape, unchanged: no folderPath and no marker.
    const workspace = store.createFolderWorkspace({ projectGroupId, name: 'Notes' })

    expect(workspace.folderPath).toBe(groupPath)
    expect(workspace.taskDraft).toBeUndefined()
    expect(Object.keys(workspace)).not.toContain('taskDraft')
    store.flush()

    const reloaded = (await createStore()).getFolderWorkspace(workspace.id)
    expect(reloaded?.taskDraft).toBeUndefined()
    expect(Object.keys(reloaded ?? {})).not.toContain('taskDraft')
    // Absent, never `false`: an older build's record must read exactly as it did before.
    expect(readPersistedStateJson()).not.toContain('"taskDraft"')
  })

  it('parses the create params with and without the marker, and rejects a non-boolean', () => {
    const createParams = {
      projectGroupId: 'group-1',
      name: 'add-login-retry',
      folderPath: draftPath
    }

    const rpc = FolderWorkspaceCreate.parse(createParams)
    const ipc = FolderWorkspaceCreateArgs.parse(createParams)
    for (const parsed of [rpc, ipc]) {
      expect(parsed.projectGroupId).toBe('group-1')
      expect(parsed.name).toBe('add-login-retry')
      expect(parsed.folderPath).toBe(draftPath)
      // An absent input must not become `taskDraft: false`.
      expect('taskDraft' in parsed).toBe(false)
    }

    const rpcDraft = FolderWorkspaceCreate.parse({ ...createParams, taskDraft: true })
    const ipcDraft = FolderWorkspaceCreateArgs.parse({ ...createParams, taskDraft: true })
    for (const parsed of [rpcDraft, ipcDraft]) {
      expect(parsed.taskDraft).toBe(true)
      expect(parsed.folderPath).toBe(draftPath)
    }

    expect(() => FolderWorkspaceCreate.parse({ ...createParams, taskDraft: 'yes' })).toThrow()
    expect(() => FolderWorkspaceCreateArgs.parse({ ...createParams, taskDraft: 'yes' })).toThrow()
  })
})

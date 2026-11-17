import { describe, expect, it, vi } from 'vitest'
import { RuntimeProjectGroupController } from './runtime-project-group-controller'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'

const { removeTaskDraftDirectoryMock } = vi.hoisted(() => ({
  removeTaskDraftDirectoryMock: vi.fn(async () => true)
}))

vi.mock('../ipc/task-draft-directory', () => ({
  removeTaskDraftDirectory: removeTaskDraftDirectoryMock
}))

const workspace = {
  id: 'ws-1',
  projectGroupId: 'group-1',
  folderPath: '/tmp/ws'
} as FolderWorkspace

const draftWorkspace = {
  ...workspace,
  taskDraft: true,
  folderPath: '/userData/task-drafts/key-1'
} as FolderWorkspace

function createController(
  resolveFolderConnectionId: (workspace: FolderWorkspace) => string | null,
  workspaces: FolderWorkspace[] = [workspace]
) {
  const removeFolderWorkspace = vi.fn(() => true)
  const teardownFolderWorkspacePtys = vi.fn(async () => undefined)
  const cleanupRemovedFolderWorkspaceState = vi.fn()
  const notifyReposChanged = vi.fn()
  const controller = new RuntimeProjectGroupController({
    getStore: () => ({ getFolderWorkspaces: () => workspaces, removeFolderWorkspace }) as never,
    resolveRepo: async () => {
      throw new Error('unused')
    },
    notifyReposChanged,
    resolveFolderConnectionId,
    teardownFolderWorkspacePtys,
    cleanupRemovedFolderWorkspaceState
  })
  return {
    controller,
    removeFolderWorkspace,
    teardownFolderWorkspacePtys,
    cleanupRemovedFolderWorkspaceState,
    notifyReposChanged
  }
}

describe('RuntimeProjectGroupController.deleteFolderWorkspace', () => {
  it('tears down PTYs and runtime state before removing the catalog row', async () => {
    const deps = createController(() => 'ssh-1')

    await expect(deps.controller.deleteFolderWorkspace('ws-1')).resolves.toEqual({ deleted: true })

    expect(deps.teardownFolderWorkspacePtys).toHaveBeenCalledWith('folder:ws-1', 'ssh-1')
    expect(deps.cleanupRemovedFolderWorkspaceState).toHaveBeenCalledWith('folder:ws-1')
    expect(deps.teardownFolderWorkspacePtys.mock.invocationCallOrder[0]).toBeLessThan(
      deps.removeFolderWorkspace.mock.invocationCallOrder[0]!
    )
    expect(deps.notifyReposChanged).toHaveBeenCalledTimes(1)
  })

  it('still deletes when the folder host is ambiguous, skipping only the PTY sweep', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const deps = createController(() => {
      throw new Error('folder_workspace_connection_ambiguous')
    })

    await expect(deps.controller.deleteFolderWorkspace('ws-1')).resolves.toEqual({ deleted: true })

    expect(deps.teardownFolderWorkspacePtys).not.toHaveBeenCalled()
    expect(deps.cleanupRemovedFolderWorkspaceState).toHaveBeenCalledWith('folder:ws-1')
    expect(deps.removeFolderWorkspace).toHaveBeenCalledWith('ws-1')
    warn.mockRestore()
  })

  it('removes the draft leaf before the catalog row', async () => {
    removeTaskDraftDirectoryMock.mockClear()
    const deps = createController(() => 'local', [draftWorkspace])

    await expect(deps.controller.deleteFolderWorkspace('ws-1')).resolves.toEqual({ deleted: true })

    expect(removeTaskDraftDirectoryMock).toHaveBeenCalledTimes(1)
    expect(removeTaskDraftDirectoryMock).toHaveBeenCalledWith('/userData/task-drafts/key-1')
    expect(removeTaskDraftDirectoryMock.mock.invocationCallOrder[0]).toBeLessThan(
      deps.removeFolderWorkspace.mock.invocationCallOrder[0]!
    )
    expect(deps.removeFolderWorkspace).toHaveBeenCalledWith('ws-1')
  })

  it('never calls the draft remover for a non-draft workspace', async () => {
    removeTaskDraftDirectoryMock.mockClear()
    const deps = createController(() => 'local')

    await expect(deps.controller.deleteFolderWorkspace('ws-1')).resolves.toEqual({ deleted: true })

    expect(removeTaskDraftDirectoryMock).not.toHaveBeenCalled()
  })

  it('keeps the row and touches nothing else when the leaf cannot be removed', async () => {
    removeTaskDraftDirectoryMock.mockClear()
    removeTaskDraftDirectoryMock.mockResolvedValueOnce(false)
    const deps = createController(() => 'local', [draftWorkspace])

    await expect(deps.controller.deleteFolderWorkspace('ws-1')).rejects.toThrow(
      'folder_draft_directory_delete_failed'
    )

    expect(deps.removeFolderWorkspace).not.toHaveBeenCalled()
    expect(deps.teardownFolderWorkspacePtys).not.toHaveBeenCalled()
    expect(deps.cleanupRemovedFolderWorkspaceState).not.toHaveBeenCalled()
    expect(deps.notifyReposChanged).not.toHaveBeenCalled()
  })

  it('passes only the deleted draft own folderPath', async () => {
    removeTaskDraftDirectoryMock.mockClear()
    const otherDraft = {
      ...workspace,
      id: 'ws-2',
      taskDraft: true,
      folderPath: '/userData/task-drafts/key-2'
    } as FolderWorkspace
    const deps = createController(() => 'local', [draftWorkspace, otherDraft])

    await expect(deps.controller.deleteFolderWorkspace('ws-1')).resolves.toEqual({ deleted: true })

    expect(removeTaskDraftDirectoryMock).toHaveBeenCalledTimes(1)
    expect(removeTaskDraftDirectoryMock).toHaveBeenCalledWith('/userData/task-drafts/key-1')
    expect(removeTaskDraftDirectoryMock).not.toHaveBeenCalledWith('/userData/task-drafts/key-2')
  })

  it('keeps today’s behavior for a draft with a blank folderPath', async () => {
    removeTaskDraftDirectoryMock.mockClear()
    const blankDraft = { ...workspace, taskDraft: true, folderPath: '   ' } as FolderWorkspace
    const deps = createController(() => 'local', [blankDraft])

    await expect(deps.controller.deleteFolderWorkspace('ws-1')).resolves.toEqual({ deleted: true })

    expect(removeTaskDraftDirectoryMock).not.toHaveBeenCalled()
    expect(deps.removeFolderWorkspace).toHaveBeenCalledWith('ws-1')
  })
})

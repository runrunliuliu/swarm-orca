import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { RepoSlice } from '../repos/repo-state'

export const createTaskDraftLinkStatusSlice: StateCreator<
  AppState,
  [],
  [],
  Pick<RepoSlice, 'markTaskDraftLinkMissing'>
> = (set) => ({
  markTaskDraftLinkMissing: (folderWorkspaceId) =>
    set((state) => ({
      taskDraftLinkMissing: { ...state.taskDraftLinkMissing, [folderWorkspaceId]: true }
    }))
})

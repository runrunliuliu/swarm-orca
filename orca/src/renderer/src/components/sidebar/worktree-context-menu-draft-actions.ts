export type DraftContextMenuState = { isDraft: boolean }

export function getDraftContextMenuState(
  workspace: { taskDraft?: boolean } | null | undefined
): DraftContextMenuState {
  return { isDraft: workspace?.taskDraft === true }
}

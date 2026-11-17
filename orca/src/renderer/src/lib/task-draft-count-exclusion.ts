export function isDraftExcludedFromCounts(workspace: { taskDraft?: boolean }): boolean {
  return workspace.taskDraft === true
}

export function excludeDraftsFromCounts<T extends { taskDraft?: boolean }>(
  items: readonly T[]
): T[] {
  return items.filter((item) => !isDraftExcludedFromCounts(item))
}

/**
 * The `完成后归档` intent recorded at launch (README §7.12 D2/A10).
 *
 * Why it exists: §7.11.3 rule 8 keeps the agent out of archiving, so "archive
 * after delivery" has to become an Orca-side action. This module is the one
 * place that remembers the operator ticked it, and the only state it keeps is a
 * set of worktree ids.
 *
 * Why in memory and not persisted: the plan deliberately adds no persistence for
 * this intent. It lives for one app run; a restart falls back to the workspace
 * row's own Archive action, which the interface states instead of pretending the
 * intent survived. One entry per workspace, consumed exactly once, so observing
 * the completed fact twice cannot archive twice.
 *
 * Pure by construction: no store, React, RPC or `git` import, so the workbench's
 * import-boundary rule still holds for the hook that reads it.
 */

const ARCHIVE_INTENTS = new Set<string>()

export function recordTaskWorkbenchArchiveIntent(worktreeId: string): void {
  ARCHIVE_INTENTS.add(worktreeId)
}

/** Whether an intent was pending; consumes it, so the caller may run the
 *  archive once even if its own effect fires again. */
export function consumeTaskWorkbenchArchiveIntent(worktreeId: string): boolean {
  return ARCHIVE_INTENTS.delete(worktreeId)
}

/** Test-only reset: the set is module state and a test must not inherit one. */
export function resetTaskWorkbenchArchiveIntents(): void {
  ARCHIVE_INTENTS.clear()
}

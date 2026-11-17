import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import { authorizeExternalPath } from './filesystem-auth'
import { isDescendantOrEqual } from './filesystem-path-containment'

const TASK_DRAFT_DIRNAME = 'task-drafts'
// Why: the key comes from the renderer, so accept only the UUID spelling the draft
// already produces — no separator, dot, drive letter or unbounded length can pass.
const TASK_DRAFT_KEY_PATTERN = /^[0-9a-f-]{8,64}$/i

export async function ensureTaskDraftDirectory(draftKey: string): Promise<string> {
  if (!TASK_DRAFT_KEY_PATTERN.test(draftKey)) {
    throw new Error('task_draft_key_invalid')
  }
  const root = path.resolve(app.getPath('userData'), TASK_DRAFT_DIRNAME)
  const leaf = path.resolve(root, draftKey)
  if (!isDescendantOrEqual(leaf, root)) {
    throw new Error('task_draft_key_invalid')
  }
  // Why idempotent: a retried create must reuse the same scratch directory
  // instead of failing or leaving a second one behind.
  await mkdir(leaf, { recursive: true })
  // Why the leaf: a draft lives outside every repository root by design, so authorize
  // only this app-owned directory instead of widening access to task-drafts or userData.
  authorizeExternalPath(leaf)
  return leaf
}

/**
 * Delete exactly the app-owned draft leaf. Takes a path, never a key: only a path
 * provably under `<userData>/task-drafts` may be removed, and never the root itself.
 */
export async function removeTaskDraftDirectory(folderPath: string): Promise<boolean> {
  if (typeof folderPath !== 'string' || folderPath.trim().length === 0) {
    return false
  }
  const root = path.resolve(app.getPath('userData'), TASK_DRAFT_DIRNAME)
  const leaf = path.resolve(folderPath)
  // Why false, not throw: a partial delete must leave the caller's row in place, not
  // look like an exception with no answer about what survived.
  if (leaf === root || !isDescendantOrEqual(leaf, root)) {
    return false
  }
  try {
    await rm(leaf, { recursive: true, force: true })
  } catch (error) {
    console.warn(`[task-draft] failed to remove ${leaf}:`, error)
    return false
  }
  return !existsSync(leaf)
}

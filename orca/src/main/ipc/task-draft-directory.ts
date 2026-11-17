import { mkdir } from 'node:fs/promises'
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

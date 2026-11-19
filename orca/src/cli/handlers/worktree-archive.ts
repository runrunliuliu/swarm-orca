import type { RuntimeWorktreeRecord } from '../../shared/runtime-types'
import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'
import { getRequiredWorktreeSelector } from '../selectors'

/**
 * The non-destructive workspace lifecycle commands: archive hides the row,
 * unarchive restores it. Both are one `worktree.set` on `isArchived`; neither
 * ever calls `worktree.rm`, so the checkout, Git registration and trace stay.
 *
 * Why a sibling module: `handlers/worktree.ts` sits at its `max-lines` budget,
 * and this pair has a different contract from metadata editing — it must never
 * be mistaken for deletion.
 */
export const WORKTREE_ARCHIVE_HANDLERS: Record<string, CommandHandler> = {
  'worktree archive': async ({ flags, client, cwd, json }) => {
    const worktree = await getRequiredWorktreeSelector(flags, 'worktree', cwd, client)
    // Why: archiving the repository's own checkout would hide the only row that
    // opens the repo. Reversible, but not a state the user meant to ask for.
    const resolved = await client.call<{ worktree: RuntimeWorktreeRecord }>('worktree.show', {
      worktree
    })
    if (resolved.result.worktree.isMainWorktree) {
      throw new RuntimeClientError(
        'invalid_argument',
        'The main checkout is the repository itself and cannot be archived.'
      )
    }
    const result = await client.call<{ worktree: RuntimeWorktreeRecord }>('worktree.set', {
      worktree,
      isArchived: true
    })
    printResult(result, json, (value) => `archived: ${value.worktree.id}`)
  },
  'worktree unarchive': async ({ flags, client, cwd, json }) => {
    const result = await client.call<{ worktree: RuntimeWorktreeRecord }>('worktree.set', {
      worktree: await getRequiredWorktreeSelector(flags, 'worktree', cwd, client),
      isArchived: false
    })
    printResult(result, json, (value) => `restored: ${value.worktree.id}`)
  }
}

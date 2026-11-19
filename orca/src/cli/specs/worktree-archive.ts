import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

/**
 * Non-destructive workspace lifecycle commands.
 *
 * Why a separate spec module: `core.ts` sits at its `max-lines` budget, and
 * these two verbs are about hiding/restoring a row rather than editing its
 * metadata, so they get their own surface. Archive never implies deletion:
 * `worktree rm` stays the only destructive command and keeps its own spec.
 */
export const WORKTREE_ARCHIVE_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['worktree', 'archive'],
    summary: 'Hide a worktree from the workspace list without deleting it',
    usage: 'orca worktree archive --worktree <selector> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree'],
    notes: [
      'Archiving keeps the checkout, its Git worktree registration, metadata, terminals and trace on disk; only the workspace list hides the row.',
      'It does not stop terminals or delete the branch. Use workspace Sleep when sessions should hibernate and resume later.',
      'Restore the row with `orca worktree unarchive`; physical deletion is `orca worktree rm`.'
    ],
    examples: ['orca worktree archive --worktree active --json']
  },
  {
    path: ['worktree', 'unarchive'],
    summary: 'Show an archived worktree in the workspace list again',
    usage: 'orca worktree unarchive --worktree <selector> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'worktree'],
    notes: [
      'Unarchiving does not start terminals or change the branch; it only restores the workspace row.'
    ],
    examples: ['orca worktree unarchive --worktree id:<repoId>::<path> --json']
  }
]

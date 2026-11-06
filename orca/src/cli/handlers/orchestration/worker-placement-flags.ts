import { getOptionalStringFlag } from '../../flags'
import { RuntimeClientError } from '../../runtime/types'

export function validateWorkerPlacementFlags(flags: Map<string, string | boolean>): void {
  const worktree = getOptionalStringFlag(flags, 'worktree')
  if (worktree === 'new-child' || worktree === 'new-top-level') {
    return
  }

  const creationFlags = [
    'name',
    'repo',
    'base-branch',
    'display-name',
    'comment',
    'setup',
    'sparse-dir'
  ]
  const conflicts = creationFlags.filter((flag) => flags.has(flag))
  if (conflicts.length === 0) {
    return
  }

  throw new RuntimeClientError(
    'invalid_argument',
    `${conflicts.map((flag) => `--${flag}`).join(', ')} apply only to --worktree new-child or new-top-level. ` +
      'For current/existing workspaces, remove these creation flags. --name names a new worktree, not a Worker or Task; ' +
      'use --task-title with --spec to title a new Task, or keep the title of the existing --task.'
  )
}

import { realpathSync } from 'node:fs'
import {
  isWindowsAbsolutePathLike,
  normalizeRuntimePathForComparison
} from '../../shared/cross-platform-path'
import { LOCAL_EXECUTION_HOST_ID, getWorktreeExecutionHostId } from '../../shared/execution-host'
import type { Repo } from '../../shared/repo-types'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'

type RepoHostLookup = (repoId: string) => Pick<Repo, 'connectionId' | 'executionHostId'> | undefined

/**
 * Why: the comparison key is on the FS-event storm path and must stay filesystem-free, so a
 * symlinked selector spelling is resolved here — once, only after the exact candidates are empty.
 */
export function resolveLocalSelectorRealpath(selectorPath: string): string | null {
  // Why: drive-letter and UNC spellings front another filesystem (or a WSL distro), so this
  // process's realpath cannot answer for them; the shared predicate keeps that rule in one place.
  if (!selectorPath.startsWith('/') || isWindowsAbsolutePathLike(selectorPath)) {
    return null
  }
  try {
    return realpathSync(selectorPath)
  } catch {
    // Missing or unreadable stays "no match": unresolved is not a verdict about the workspace.
    return null
  }
}

/**
 * Candidates for a selector whose exact spelling did not match. The registered spelling is what
 * this compares against, so one realpath call answers the whole fleet slice.
 */
export function matchLocalWorktreesByResolvedSelectorPath(
  worktrees: ResolvedWorktree[],
  selectorPath: string,
  getRepo: RepoHostLookup
): ResolvedWorktree[] {
  // Why filter first: a fleet with no local row cannot be answered by this process's filesystem,
  // so it must not pay a realpath call at all.
  const localWorktrees = worktrees.filter((worktree) => {
    // Why: an SSH/runtime row's path names another machine; this process's realpath says
    // nothing about it even when the same spelling happens to exist locally.
    return (
      getWorktreeExecutionHostId(worktree, getRepo(worktree.repoId)) === LOCAL_EXECUTION_HOST_ID
    )
  })
  if (localWorktrees.length === 0) {
    return []
  }
  const resolvedPath = resolveLocalSelectorRealpath(selectorPath)
  if (resolvedPath === null) {
    return []
  }
  const comparisonKey = normalizeRuntimePathForComparison(resolvedPath)
  return localWorktrees.filter(
    (worktree) => normalizeRuntimePathForComparison(worktree.path) === comparisonKey
  )
}

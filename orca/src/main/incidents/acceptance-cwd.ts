// Where an acceptance command may run (issue-sedimentation.md v2.6 §8, M5 review C5).
//
// A declaration names a `cwd`, and the runner hands it straight to `runProcess`. Without a boundary
// that is "run an arbitrary argv in an arbitrary directory on this host" — argv-only and no-shell
// already remove interpolation, but they say nothing about *where*. So a declaration must also name
// the worker worktree root it is scoped to, `cwd` must be that root or inside it, and the root must
// actually be a git worktree on disk.
//
// Two moments, deliberately the same function:
//   * declare time — a declaration that cannot be authorized is refused, so a typo or a copied path
//     from another host never becomes a stored contract;
//   * run time — the same check is repeated before the spawn, because a directory can be replaced by
//     a symlink between declaration and evaluation. A failing re-check is `undeterminable`, never a
//     silent run outside the root.
//
// The check is filesystem-only: `realpath` on both sides, `.git` presence on the root, and a
// containment test on the resolved strings. No dependency, no subprocess, no `git` invocation.

import { existsSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, sep } from 'node:path'

export type CwdAuthorizationFailure =
  | 'missing_cwd'
  | 'missing_worktree_root'
  | 'cwd_not_absolute'
  | 'worktree_root_not_absolute'
  | 'cwd_missing'
  | 'worktree_root_missing'
  | 'worktree_root_not_a_worktree'
  | 'cwd_outside_worktree'

export type CwdAuthorization = {
  cwd: string
  worktreeRoot: string
}

/**
 * Pure containment test on two path strings (§8 C5). Used by the declaration store so its validation
 * does not need the filesystem (fixtures declare paths that are only meaningful in a test).
 *
 * `relative()` is the whole trick: a child yields `''` or a relative path that does not start with
 * `..`, while an escape yields `..`/`../x` (or an absolute path on Windows when the drive differs).
 */
export function isWithinWorktreeRoot(cwd: string, worktreeRoot: string): boolean {
  const rel = relative(worktreeRoot, cwd)
  if (rel === '') {
    return true
  }
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function hasGitEntry(path: string): boolean {
  // A linked worktree has a `.git` FILE, a primary checkout has a `.git` DIRECTORY. Both are roots.
  return existsSync(`${path}${sep}.git`)
}

/**
 * Resolve and authorize one declared cwd against one worktree root.
 *
 * Returns the realpath'd pair on success so the caller can store the resolved values; the resolution
 * is what makes a symlinked cwd visible instead of letting it pass as a prefix of the root.
 */
export function authorizeCwd(input: {
  cwd: string
  worktreeRoot: string
}): { ok: true; resolved: CwdAuthorization } | { ok: false; reason: CwdAuthorizationFailure } {
  const cwd = input.cwd.trim()
  const root = input.worktreeRoot.trim()
  if (cwd.length === 0) {
    return { ok: false, reason: 'missing_cwd' }
  }
  if (root.length === 0) {
    return { ok: false, reason: 'missing_worktree_root' }
  }
  if (!isAbsolute(cwd)) {
    return { ok: false, reason: 'cwd_not_absolute' }
  }
  if (!isAbsolute(root)) {
    return { ok: false, reason: 'worktree_root_not_absolute' }
  }
  if (!isDirectory(cwd)) {
    return { ok: false, reason: 'cwd_missing' }
  }
  if (!isDirectory(root)) {
    return { ok: false, reason: 'worktree_root_missing' }
  }
  let resolvedCwd: string
  let resolvedRoot: string
  try {
    resolvedCwd = realpathSync(cwd)
    resolvedRoot = realpathSync(root)
  } catch {
    // A dangling symlink resolves to nothing: treat as missing rather than authorizing the link.
    return { ok: false, reason: 'cwd_missing' }
  }
  if (!hasGitEntry(resolvedRoot)) {
    return { ok: false, reason: 'worktree_root_not_a_worktree' }
  }
  if (!isWithinWorktreeRoot(resolvedCwd, resolvedRoot)) {
    return { ok: false, reason: 'cwd_outside_worktree' }
  }
  return { ok: true, resolved: { cwd: resolvedCwd, worktreeRoot: resolvedRoot } }
}

/**
 * Run-time form: the same authorization, reduced to "may we spawn here".
 *
 * Returns `null` when authorized and a failure token otherwise; the caller turns the token into an
 * `undeterminable` verdict detail (never `failed`, which would claim the product was judged).
 */
export function rejectionForRun(input: {
  cwd: string
  worktreeRoot: string
}): CwdAuthorizationFailure | null {
  const authorized = authorizeCwd(input)
  return authorized.ok ? null : authorized.reason
}

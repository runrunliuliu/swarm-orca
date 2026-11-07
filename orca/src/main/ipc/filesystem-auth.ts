import { resolve, dirname, basename } from 'node:path'
import { realpathSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import type { Store } from '../persistence'
import { getAllowedRoots } from './filesystem-allowed-roots'
import { isDescendantOrEqual, isENOENT, normalizeExistingPath } from './filesystem-path-containment'
import {
  ensureAuthorizedRootsCache,
  isPathAllowedByCanonicalRegisteredRoot,
  isRegisteredWorktreePath
} from './registered-worktree-roots-cache'

// Compatibility exports for runtime command modules that historically imported these seams from
// filesystem-auth. The implementations remain owned by their focused modules.
export { invalidateAuthorizedRootsCache } from './registered-worktree-roots-cache'
export { invalidateAuthorizedRootsCacheForRepo } from './registered-worktree-roots-scoped-invalidation'
export { isENOENT } from './filesystem-path-containment'

export const PATH_ACCESS_DENIED_MESSAGE =
  'Access denied: path resolves outside allowed directories. If this blocks a legitimate workflow, please file a GitHub issue.'
// Why: authorized external paths accumulate all session; LRU-bound the set. Safe to evict because every caller re-authorizes before operating.
export const AUTHORIZED_EXTERNAL_PATHS_MAX = 4096
const authorizedExternalPaths = new Set<string>()

function rememberAuthorizedExternalPath(path: string): void {
  // Delete-then-add makes re-authorized paths most-recent so LRU eviction sheds only the oldest untouched entries.
  authorizedExternalPaths.delete(path)
  authorizedExternalPaths.add(path)
  while (authorizedExternalPaths.size > AUTHORIZED_EXTERNAL_PATHS_MAX) {
    const oldest = authorizedExternalPaths.keys().next().value
    if (oldest === undefined) {
      break
    }
    authorizedExternalPaths.delete(oldest)
  }
}

export function authorizeExternalPath(targetPath: string): void {
  const resolvedTarget = resolve(targetPath)
  rememberAuthorizedExternalPath(resolvedTarget)
  try {
    // Why: macOS canonicalizes /tmp to /private/tmp during read authorization.
    rememberAuthorizedExternalPath(realpathSync(resolvedTarget))
  } catch {}
}

/**
 * One allowed-root list shared by every check in a single authorization.
 *
 * Lazy so a path already covered by an external grant still builds nothing at all, the way it did
 * before the list was hoisted out of the individual checks.
 */
type AllowedRootsSnapshot = {
  get: () => readonly string[]
  /** Canonical form of every root, resolved once per authorization. */
  getCanonical: () => Promise<readonly string[]>
}

function createAllowedRootsSnapshot(store: Store): AllowedRootsSnapshot {
  let roots: readonly string[] | undefined
  let canonicalRoots: Promise<readonly string[]> | undefined
  const list = (): readonly string[] => (roots ??= getAllowedRoots(store))
  return {
    get: list,
    getCanonical: () => (canonicalRoots ??= resolveCanonicalAllowedRoots(list()))
  }
}

/**
 * The roots as the filesystem sees them, so a root registered through a symlink or mount alias
 * authorizes the directory it actually names.
 *
 * `normalizeExistingPath` returns its input when the root is gone, which keeps this fail-closed: a
 * missing root adds nothing beyond the comparison `isPathAllowed` already made.
 */
async function resolveCanonicalAllowedRoots(roots: readonly string[]): Promise<readonly string[]> {
  const canonical = await Promise.all(roots.map((root) => normalizeExistingPath(resolve(root))))
  return [...new Set(canonical)]
}

export function isPathAllowed(
  targetPath: string,
  store: Store,
  allowedRoots?: AllowedRootsSnapshot
): boolean {
  const resolvedTarget = resolve(targetPath)
  if (authorizedExternalPaths.has(resolvedTarget)) {
    return true
  }
  for (const authorizedPath of authorizedExternalPaths) {
    if (isDescendantOrEqual(resolvedTarget, authorizedPath)) {
      return true
    }
  }
  return (allowedRoots?.get() ?? getAllowedRoots(store)).some((root) =>
    isDescendantOrEqual(resolvedTarget, root)
  )
}

export type ResolveAuthorizedPathOptions = {
  /**
   * Canonicalize the parent but preserve the leaf so delete/rename target the symlink itself, not its destination (which may live outside allowed roots).
   */
  preserveSymlink?: boolean
}

export async function resolveAuthorizedPath(
  targetPath: string,
  store: Store,
  options: ResolveAuthorizedPathOptions = {}
): Promise<string> {
  const resolvedTarget = resolve(targetPath)
  // Why: the roots depend only on store state, not on the candidate path, so one snapshot serves
  // every authorization below; each candidate is still checked against it in full.
  const allowedRoots = createAllowedRootsSnapshot(store)
  // Why kept, not required: the spelling the caller typed may be an alias of an allowed root, or an
  // allowed root may be an alias of it, so the canonical form below is what decides. This result
  // only decides which error an unreadable candidate reports.
  const typedSpellingAllowed = await isPathAllowedIncludingRegisteredWorktrees(
    resolvedTarget,
    store,
    { allowedRoots }
  )

  if (options.preserveSymlink) {
    // Canonicalize the parent so ancestor symlinks can't redirect outside allowed roots, but keep the leaf so delete/rename act on the link itself.
    let realParent: string
    try {
      realParent = await realpath(dirname(resolvedTarget))
    } catch (error) {
      if (isENOENT(error)) {
        return resolveAuthorizedMissingPath(resolvedTarget, store, allowedRoots)
      }
      if (!typedSpellingAllowed) {
        throw new Error(PATH_ACCESS_DENIED_MESSAGE)
      }
      throw error
    }
    const candidateTarget = resolve(realParent, basename(resolvedTarget))
    if (
      !(await isPathAllowedIncludingRegisteredWorktrees(candidateTarget, store, {
        canonicalSourcePath: resolvedTarget,
        allowedRoots
      }))
    ) {
      throw new Error(PATH_ACCESS_DENIED_MESSAGE)
    }
    return candidateTarget
  }

  try {
    // Why: Windows/WSL realpath can return UNC-shaped paths; re-resolve to compare against this module's allow-list roots.
    const realTarget = resolve(await realpath(resolvedTarget))
    if (
      !(await isPathAllowedIncludingRegisteredWorktrees(realTarget, store, {
        canonicalSourcePath: resolvedTarget,
        allowedRoots
      }))
    ) {
      throw new Error(PATH_ACCESS_DENIED_MESSAGE)
    }
    return realTarget
  } catch (error) {
    if (!isENOENT(error)) {
      if (!typedSpellingAllowed) {
        throw new Error(PATH_ACCESS_DENIED_MESSAGE)
      }
      throw error
    }
    return resolveAuthorizedMissingPath(resolvedTarget, store, allowedRoots)
  }
}

async function resolveAuthorizedMissingPath(
  resolvedTarget: string,
  store: Store,
  allowedRoots: AllowedRootsSnapshot
): Promise<string> {
  let existingAncestor = resolvedTarget
  const missingSegments: string[] = []

  while (true) {
    try {
      const realAncestor = await realpath(existingAncestor)
      const candidateTarget = resolve(realAncestor, ...missingSegments)
      if (
        !(await isPathAllowedIncludingRegisteredWorktrees(candidateTarget, store, {
          canonicalSourcePath: resolvedTarget,
          allowedRoots
        }))
      ) {
        throw new Error(PATH_ACCESS_DENIED_MESSAGE)
      }
      return candidateTarget
    } catch (error) {
      if (!isENOENT(error)) {
        throw error
      }
      const parent = dirname(existingAncestor)
      if (parent === existingAncestor) {
        throw error
      }
      // Why: create/copy make missing parents after auth; canonicalize nearest existing ancestor to catch symlink escapes without rejecting nested paths.
      missingSegments.unshift(basename(existingAncestor))
      existingAncestor = parent
    }
  }
}

async function isPathAllowedIncludingRegisteredWorktrees(
  targetPath: string,
  store: Store,
  options: { canonicalSourcePath?: string; allowedRoots?: AllowedRootsSnapshot } = {}
): Promise<boolean> {
  if (isPathAllowed(targetPath, store, options.allowedRoots)) {
    return true
  }

  if (isRegisteredWorktreePath(targetPath, store)) {
    return true
  }

  if (await isPathAllowedByCanonicalAllowedRoot(targetPath, store, options.allowedRoots)) {
    return true
  }

  if (
    await isPathAllowedByCanonicalRegisteredRoot(targetPath, options.canonicalSourcePath, store)
  ) {
    return true
  }

  await ensureAuthorizedRootsCache(store)

  // Why: linked worktrees are already git-trusted; reuse the cached root index so reads don't spawn `git worktree list` each time.
  return (
    isRegisteredWorktreePath(targetPath, store) ||
    (await isPathAllowedByCanonicalRegisteredRoot(targetPath, options.canonicalSourcePath, store))
  )
}

/**
 * Whether the candidate lands inside an allowed root once both sides are canonical.
 *
 * Why not gated on the caller's spelling: a root may be registered through an alias (a symlinked
 * `workspaceDir`, a mount alias) while the candidate arrives canonical, and the reverse, so
 * requiring one spelling to contain the other denied paths that name the allowed directory exactly
 * (#21172's sibling). Containment here is decided between two canonical paths, so a symlink that
 * escapes an allowed root is still denied.
 */
async function isPathAllowedByCanonicalAllowedRoot(
  targetPath: string,
  store: Store,
  allowedRoots?: AllowedRootsSnapshot
): Promise<boolean> {
  const canonicalRoots = allowedRoots
    ? await allowedRoots.getCanonical()
    : await resolveCanonicalAllowedRoots(getAllowedRoots(store))
  return canonicalRoots.some((root) => isDescendantOrEqual(targetPath, root))
}

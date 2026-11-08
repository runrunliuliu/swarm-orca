// M4: a worktree that Orca did not create still belongs in its catalog.
//
// Why adopt: the catalog is the Git listing overlaid with metadata. An externally created worktree
// (a hand `git worktree add`, another tool, a script) appears in the listing with no metadata row,
// so `createdAt`/`lastActivityAt` read as absent, `instanceId` has no anchor after path reuse, and
// every metadata-keyed feature — the task binding included — silently sees nothing. Silently seeing
// nothing fails open, which is the wrong direction for a gate.
//
// What adoption is not: it does not claim Orca created the checkout. `orcaCreationSource` says
// `external` and `orcaCreatedAt` is left unset, so provenance stays honest; what adoption adds is the
// identity and lifecycle fields the rest of the app needs to treat it as a first-class workspace.

import { randomUUID } from 'node:crypto'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'

/** How many rows one listing will adopt; a first scan of a busy repo must stay bounded. */
const MAX_ADOPTIONS_PER_LISTING = 50

export type AdoptableWorktree = {
  path: string
  branch?: string
  isMainWorktree?: boolean
}

export type AdoptionStore = {
  getWorktreeMetaForHost?: (worktreeId: string, hostId: string) => WorktreeMeta | undefined
  getWorktreeMeta?: (worktreeId: string) => WorktreeMeta | undefined
  setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => unknown
}

/**
 * Which rows this listing should adopt.
 *
 * Why skip the main worktree: it is the repository's own checkout, not a task workspace, and giving
 * it a metadata row would make it look creatable/deletable like one.
 */
export function selectWorktreesToAdopt(args: {
  repoId: string
  hostId: string
  worktrees: readonly AdoptableWorktree[]
  readMeta: (worktreeId: string) => WorktreeMeta | undefined
  limit?: number
}): AdoptableWorktree[] {
  const limit = args.limit ?? MAX_ADOPTIONS_PER_LISTING
  const selected: AdoptableWorktree[] = []
  for (const worktree of args.worktrees) {
    if (selected.length >= limit) {
      break
    }
    if (worktree.isMainWorktree === true) {
      continue
    }
    const id = `${args.repoId}::${worktree.path}`
    if (args.readMeta(id)) {
      continue
    }
    selected.push(worktree)
  }
  return selected
}

/** The metadata row an adopted worktree gets. Pure, so the shape is testable without a store. */
export function externalWorktreeAdoptionMeta(args: {
  worktree: AdoptableWorktree
  now: number
  instanceId?: string
  existingDisplayName?: string
}): Partial<WorktreeMeta> {
  const branchName = args.worktree.branch?.replace(/^refs\/heads\//, '')
  return {
    instanceId: args.instanceId ?? randomUUID(),
    displayName: args.existingDisplayName?.trim() || branchName || 'external worktree',
    createdAt: args.now,
    lastActivityAt: args.now,
    orcaCreationSource: 'external',
    // Why keep the branch: Orca did not create it, so removing the workspace must not prune a branch
    // that existed before this catalog did.
    preserveBranchOnDelete: true
  }
}

/**
 * Adopt every unadopted row of this listing.
 *
 * Why here and not in a background task: the listing is where the gap is observed, and a workspace
 * that is visible but not adopted is exactly the state this closes. Bounded, idempotent (a row with
 * metadata is skipped), and logged so a surprising adoption is traceable.
 */
export function adoptExternalWorktreesForListing(args: {
  repoId: string
  hostId: string
  worktrees: readonly AdoptableWorktree[]
  store: AdoptionStore
  now?: number
  limit?: number
}): string[] {
  const readMeta = (worktreeId: string): WorktreeMeta | undefined =>
    args.store.getWorktreeMetaForHost?.(worktreeId, args.hostId) ??
    args.store.getWorktreeMeta?.(worktreeId)
  const adopted: string[] = []
  for (const worktree of selectWorktreesToAdopt({
    repoId: args.repoId,
    hostId: args.hostId,
    worktrees: args.worktrees,
    readMeta,
    ...(args.limit !== undefined ? { limit: args.limit } : {})
  })) {
    const worktreeId = `${args.repoId}::${worktree.path}`
    try {
      args.store.setWorktreeMeta(worktreeId, {
        ...externalWorktreeAdoptionMeta({
          worktree,
          now: args.now ?? Date.now()
        })
      })
      adopted.push(worktreeId)
    } catch (error) {
      // Why continue: one unwritable row must not hide the rest of the listing from the user.
      console.warn(`[worktrees] could not adopt external worktree ${worktreeId}:`, error)
    }
  }
  if (adopted.length > 0) {
    console.info('[worktrees] adopted external worktrees', { repoId: args.repoId, adopted })
  }
  return adopted
}

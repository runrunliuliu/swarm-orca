import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from './execution-host'
import type { TaskProviderIdentity } from './task-provider-identity'
import type { TaskProvider } from './task-providers'
import { getRepoIdFromWorktreeId, splitWorktreeIdForFilesystem } from './worktree/id'
import type { WorktreeMeta } from './worktree/meta-types'
import type { WorkspaceLinkedItem } from './worktree/types'
import type { TaskRecordItemType, TaskRecordOrigin } from './task-records-types'

/**
 * Which tasks a worktree says it belongs to, read from the metadata fields that
 * already exist (design doc §8.2: the worktree side stays provenance, it is not
 * mirrored). `linkedWorkItem` is the provider-agnostic link the non-GitHub pages
 * write; `linkedIssue` / `linkedPR` are the GitHub fields every worktree created
 * from GitHub carries, including ones written before `linkedWorkItem` existed.
 *
 * A worktree with no link is not "no task": it is a workspace-origin task, whose
 * identity is its own primary worktree. That is the local-workspace entry the
 * workbench already offers (`taskWorkbenchTaskKey` returns `workspace:<id>`).
 */
export type TaskRecordLink = {
  origin: TaskRecordOrigin
  repoId: string
  hostId: ExecutionHostId
  path: string
}

export type TaskRecordLinkMeta = Pick<
  WorktreeMeta,
  'linkedIssue' | 'linkedPR' | 'linkedTaskSourceContext' | 'hostId'
> & {
  /** Untyped on purpose: this field is read back from persisted JSON, so the guard
   *  below is the only thing standing between a corrupt row and a task id. */
  linkedWorkItem?: unknown
}

export function taskRecordLinksForWorktree(
  worktreeId: string,
  meta: TaskRecordLinkMeta
): TaskRecordLink[] {
  const locator = splitWorktreeIdForFilesystem(worktreeId)
  if (!locator) {
    return []
  }
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  const hostId = meta.hostId ?? LOCAL_EXECUTION_HOST_ID
  const path = locator.worktreePath
  const links: TaskRecordLink[] = []
  const seen = new Set<string>()

  const push = (
    provider: TaskProvider,
    itemType: TaskRecordItemType,
    number: number,
    extra: {
      url?: string
      title?: string
    }
  ): void => {
    if (!Number.isInteger(number) || number <= 0) {
      return
    }
    const key = `${provider}:${itemType}:${number}`
    if (seen.has(key)) {
      return
    }
    seen.add(key)
    links.push({
      repoId,
      hostId,
      path,
      origin: {
        kind: 'external',
        provider,
        itemType,
        number,
        ...(extra.url ? { url: extra.url } : {}),
        ...(extra.title ? { titleSnapshot: extra.title } : {}),
        ...(providerIdentityFor(meta, provider)
          ? { providerIdentity: providerIdentityFor(meta, provider) }
          : {})
      }
    })
  }

  const item = meta.linkedWorkItem
  if (isUsableLinkedItem(item)) {
    push(item.provider, item.type === 'issue' ? 'issue' : 'pr', item.number, {
      ...(typeof item.url === 'string' ? { url: item.url } : {}),
      ...(typeof item.title === 'string' ? { title: item.title } : {})
    })
  }
  if (typeof meta.linkedIssue === 'number') {
    push('github', 'issue', meta.linkedIssue, {})
  }
  if (typeof meta.linkedPR === 'number') {
    push('github', 'pr', meta.linkedPR, {})
  }
  if (links.length > 0) {
    return links
  }
  return [{ repoId, hostId, path, origin: { kind: 'workspace', primaryWorktreeId: worktreeId } }]
}

function isUsableLinkedItem(item: unknown): item is WorkspaceLinkedItem {
  if (!item || typeof item !== 'object') {
    return false
  }
  return (
    'provider' in item &&
    (item.provider === 'github' ||
      item.provider === 'gitlab' ||
      item.provider === 'linear' ||
      item.provider === 'jira') &&
    'type' in item &&
    (item.type === 'issue' || item.type === 'pr' || item.type === 'mr') &&
    'number' in item &&
    typeof item.number === 'number'
  )
}

/** The provider identity the page carried, but only when it describes the same
 *  provider: a Linear page must not inherit a GitHub identity. */
function providerIdentityFor(
  meta: TaskRecordLinkMeta,
  provider: TaskProvider
): TaskProviderIdentity | null {
  const context = meta.linkedTaskSourceContext
  if (!context || context.provider !== provider) {
    return null
  }
  return context.providerIdentity ?? null
}

import type { GitHubWorkItem, GitHubWorkItemDetails } from '../../../shared/github/work-item-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import { useAppStore } from '@/store'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import {
  getGitHubMutationRoutingSettings,
  getGitHubRuntimeRepoId,
  getGitHubSourceRuntimeHost,
  getGitHubSourceRuntimeTarget
} from './github-source-runtime-context'

type GitHubWorkItemLookupArgs = {
  repoPath: string
  repoId: string
  sourceContext?: TaskSourceContext | null
  number: number
  type?: 'issue' | 'pr'
}

type GitHubWorkItemByOwnerRepoLookupArgs = GitHubWorkItemLookupArgs & {
  owner: string
  repo: string
  host?: string
  type: 'issue' | 'pr'
}

type GitHubWorkItemDetailsLookupArgs = {
  repoPath: string
  repoId: string
  sourceContext?: TaskSourceContext | null
  number: number
  type: 'issue' | 'pr'
}

function runtimeRepoId(args: Pick<GitHubWorkItemLookupArgs, 'repoId' | 'sourceContext'>): string {
  return getGitHubRuntimeRepoId(args.sourceContext, args.repoId)
}

export async function lookupGitHubWorkItemForSource(
  args: GitHubWorkItemLookupArgs
): Promise<GitHubWorkItem | null> {
  const target = getGitHubSourceRuntimeTarget(args.sourceContext)
  const item =
    target.kind === 'environment'
      ? await callRuntimeRpc<Omit<GitHubWorkItem, 'repoId'> | null>(
          target,
          'github.workItem',
          {
            repo: runtimeRepoId(args),
            number: args.number,
            type: args.type
          },
          { timeoutMs: 30_000 }
        )
      : await window.api.gh.workItem({
          repoPath: args.repoPath,
          repoId: args.repoId,
          number: args.number,
          type: args.type
        })
  return item ? ({ ...item, repoId: args.repoId } as GitHubWorkItem) : null
}

export async function lookupGitHubWorkItemByOwnerRepoForSource(
  args: GitHubWorkItemByOwnerRepoLookupArgs
): Promise<GitHubWorkItem | null> {
  const target = getGitHubSourceRuntimeTarget(args.sourceContext)
  const item =
    target.kind === 'environment'
      ? await callRuntimeRpc<Omit<GitHubWorkItem, 'repoId'> | null>(
          target,
          'github.workItemByOwnerRepo',
          {
            repo: runtimeRepoId(args),
            owner: args.owner,
            ownerRepo: args.repo,
            ...(args.host ? { host: args.host } : {}),
            number: args.number,
            type: args.type
          },
          { timeoutMs: 30_000 }
        )
      : await window.api.gh.workItemByOwnerRepo({
          repoPath: args.repoPath,
          repoId: args.repoId,
          owner: args.owner,
          repo: args.repo,
          ...(args.host ? { host: args.host } : {}),
          number: args.number,
          type: args.type
        })
  return item ? ({ ...item, repoId: args.repoId } as GitHubWorkItem) : null
}

// Why: the local gh IPC validates the repo against the LOCAL registry and rejects
// anything it does not own with a raw "Access denied: ..." string, which the detail
// dialog renders verbatim in place of the whole tab strip. When the repo's host
// cannot be resolved there is no better answer available, so say what the user can
// act on instead of leaking the registry's wording.
export const WORK_ITEM_DETAILS_REPO_UNREADABLE_MESSAGE =
  "This item's repository is not readable on this computer. It may be hosted on a remote runtime that is not connected."

// Why: mirrored from main/ipc/github-repo-routing.ts. The denial reason crosses IPC
// as message text only (Electron prefixes it with the handler name), so there is no
// code to switch on; keep this list in step with that file.
const LOCAL_REPO_DENIAL_MESSAGES = [
  'Access denied: unknown repository path',
  'Access denied: repository path does not match repo id',
  'Access denied: GitHub source host does not match repository host'
]

function isLocalRepoRoutingDenial(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return LOCAL_REPO_DENIAL_MESSAGES.some((denial) => message.includes(denial))
}

async function requestLocalWorkItemDetails(
  args: GitHubWorkItemDetailsLookupArgs
): Promise<GitHubWorkItemDetails | null> {
  try {
    return await window.api.gh.workItemDetails({
      repoPath: args.repoPath,
      repoId: args.repoId,
      sourceContext: args.sourceContext,
      number: args.number,
      type: args.type
    })
  } catch (error) {
    if (isLocalRepoRoutingDenial(error)) {
      throw new Error(WORK_ITEM_DETAILS_REPO_UNREADABLE_MESSAGE)
    }
    throw error
  }
}

// Why (#70): the dialog's repo can be runtime-owned while the page source context
// still says `local` — runtime repo rows reach the renderer directory before the task
// page rebinds its source, so path and host disagree for a moment. Routing on the
// source alone hands that repo's path/id to the LOCAL gh IPC and the local registry
// denies it. Resolve the route from the repo's actual owner host instead, reusing the
// PR-mutation rule (#6957) so there is one host decision in this app, not a second one.
export function lookupGitHubWorkItemDetailsForSource(
  args: GitHubWorkItemDetailsLookupArgs
): Promise<GitHubWorkItemDetails | null> {
  const target = getActiveRuntimeTarget(
    getGitHubMutationRoutingSettings(useAppStore.getState(), args.repoId, args.sourceContext)
  )
  if (target.kind === 'environment') {
    const sourceHost = getGitHubSourceRuntimeHost(args.sourceContext)
    return callRuntimeRpc<GitHubWorkItemDetails | null>(
      target,
      'github.workItemDetails',
      {
        // Why: only a runtime source names the runtime repo identity itself; an
        // owner-routed request must address the row's own repo, because the stale
        // page source context is exactly what this routing is correcting.
        repo: sourceHost ? getGitHubRuntimeRepoId(args.sourceContext, args.repoId) : args.repoId,
        number: args.number,
        type: args.type
      },
      { timeoutMs: 30_000 }
    )
  }
  return requestLocalWorkItemDetails(args)
}

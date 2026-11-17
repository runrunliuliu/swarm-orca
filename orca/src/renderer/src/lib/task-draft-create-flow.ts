/**
 * The draft's create target, duplicate read, linked-task shape and agent command
 * formatting. Pure helpers shared by the dock hook and its action/poll hooks.
 */
import {
  errorText,
  findDuplicateCandidates,
  trailingNumber,
  type TaskDraftCandidate,
  type TaskDraftDuplicateCandidate,
  type TaskDraftProposal,
  type TaskDraftProvider,
  type TaskDraftState,
  type TaskDraftTarget
} from '@/lib/task-draft-issue-create'
import { buildGhFallbackInvocation, type TaskDraftReceipt } from '@/lib/task-draft-receipt'
import { getTaskPageRepoSourceContext } from '@/components/task-page-source-context'
import { translate } from '@/i18n/i18n'
import { LOCAL_EXECUTION_HOST_ID, getRepoExecutionHostId } from '../../../shared/execution-host'
import type { ProjectGroup } from '../../../shared/project-group-types'
import type { Repo } from '../../../shared/repo-types'
import type { TaskProvider } from '../../../shared/task-providers'
import {
  normalizeTaskSourceContext,
  type TaskSourceContext
} from '../../../shared/task-source-context'
import type { TuiAgent } from '../../../shared/tui-agent'

export type DraftRequestResolution =
  | {
      ok: true
      repo: Repo
      group: ProjectGroup
      provider: TaskDraftProvider
      target: TaskDraftTarget
    }
  | { ok: false; state: TaskDraftState; message: string }

/** The dock's creation preconditions: source, repo, group, local host, then the target. */
export function resolveDraftRequest(args: {
  taskSource: TaskProvider
  primaryRepo: Repo | null
  projectGroups: readonly ProjectGroup[]
  linearTeam: { id: string; key: string; workspaceId?: string } | null | undefined
  linearWorkspaceId: string | null | undefined
}): DraftRequestResolution {
  const repo = args.primaryRepo
  if (!repo) {
    return {
      ok: false,
      state: 'no-context',
      message: translate(
        'auto.components.TaskPage.taskDockPickTarget',
        'Pick a source and a repository first.'
      )
    }
  }
  const provider = toDraftProvider(args.taskSource)
  if (!provider) {
    return {
      ok: false,
      state: 'no-context',
      message: translate(
        'auto.hooks.useTaskPageDockActions.taskDockUnsupportedSource',
        'Drafts support GitHub, Linear and Jira tasks only.'
      )
    }
  }
  const group = args.projectGroups.find((candidate) => candidate.id === repo.projectGroupId)
  if (!group) {
    return {
      ok: false,
      state: 'no-context',
      message: translate(
        'auto.components.TaskPage.taskDockNoProjectGroup',
        'Pick a repository that belongs to a project group.'
      )
    }
  }
  // Why: the scratch directory is app-owned and local; a remote group has no path this host can create.
  if (group.connectionId || getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID) {
    return {
      ok: false,
      state: 'remote-unsupported',
      message: translate(
        'auto.components.TaskPage.taskDockLocalRepoRequired',
        'Drafts need a local repository.'
      )
    }
  }
  return {
    ok: true,
    repo,
    group,
    provider,
    target: buildDraftTarget({
      provider,
      repo,
      projectId: group.id,
      linearTeam: args.linearTeam,
      linearWorkspaceId: args.linearWorkspaceId
    })
  }
}

export type ActiveTaskDraft = {
  folderWorkspaceId: string
  folderPath: string
  primaryTabId: string | null
  draftKey: string
  /** The agent launched into the draft's tab; null until a launch succeeds. */
  agent: TuiAgent | null
  instruction: string
  target: TaskDraftTarget
  repoPath: string | null
  attempt: number
  lastProposalRevision: number
  frozenProposal: TaskDraftProposal | null
  receipt: TaskDraftReceipt | null
  channel: 'primary-rpc' | 'gh-fallback' | null
}

/** `provider · owner/repo` for the dock chip; falls back to the repo's display name. */
export function getDockTargetLabel(repo: Repo, provider: TaskProvider): string {
  const identity = getTaskPageRepoSourceContext(repo, 'github')?.providerIdentity
  const repoLabel =
    identity?.provider === 'github' ? `${identity.owner}/${identity.repo}` : repo.displayName
  return `${provider} · ${repoLabel}`
}

export function toDraftProvider(provider: TaskProvider): TaskDraftProvider | null {
  return provider === 'github' || provider === 'linear' || provider === 'jira' ? provider : null
}

export function buildDraftTarget(args: {
  provider: TaskDraftProvider
  repo: Repo
  projectId: string
  linearTeam: { id: string; key: string; workspaceId?: string } | null | undefined
  linearWorkspaceId: string | null | undefined
}): TaskDraftTarget {
  const identity = getTaskPageRepoSourceContext(args.repo, 'github')?.providerIdentity
  const owner =
    identity?.provider === 'github' ? identity.owner : (args.repo.upstream?.owner ?? null)
  const repo = identity?.provider === 'github' ? identity.repo : (args.repo.upstream?.repo ?? null)
  const linearWorkspaceId =
    args.linearTeam?.workspaceId ??
    (args.linearWorkspaceId && args.linearWorkspaceId !== 'all' ? args.linearWorkspaceId : null)
  return {
    provider: args.provider,
    label: getDockTargetLabel(args.repo, args.provider),
    repoId: args.repo.id,
    projectId: args.projectId,
    hostId: getRepoExecutionHostId(args.repo),
    owner,
    repo,
    teamId: args.provider === 'linear' ? (args.linearTeam?.id ?? null) : null,
    teamKey: args.provider === 'linear' ? (args.linearTeam?.key ?? null) : null,
    workspaceId: args.provider === 'linear' ? linearWorkspaceId : null
  }
}

export function buildLinkedTaskSourceContext(target: TaskDraftTarget): TaskSourceContext | null {
  return normalizeTaskSourceContext({
    provider: target.provider,
    projectId: target.projectId ?? '',
    hostId: LOCAL_EXECUTION_HOST_ID,
    repoId: target.repoId,
    providerIdentity:
      target.provider === 'github' && target.owner && target.repo
        ? { provider: 'github', owner: target.owner, repo: target.repo }
        : null
  })
}

export async function findDuplicates(
  active: ActiveTaskDraft,
  title: string
): Promise<TaskDraftDuplicateCandidate[]> {
  let candidates: TaskDraftCandidate[]
  if (active.target.provider === 'github') {
    if (!active.repoPath) {
      throw new Error('The draft has no repository path to search.')
    }
    const result = await window.api.gh.listWorkItems({ repoPath: active.repoPath, query: title })
    candidates = result.items.map((item) => ({
      number: item.number,
      title: item.title,
      url: item.url
    }))
  } else if (active.target.provider === 'linear') {
    const issues = await window.api.linear.searchIssues({ query: title, limit: 25 })
    candidates = issues.map((issue) => ({
      number: trailingNumber(issue.identifier) ?? 0,
      title: issue.title,
      url: issue.url,
      identifier: issue.identifier
    }))
  } else {
    const issues = await window.api.jira.searchIssues({
      jql: `summary ~ "${escapeJql(title)}"`,
      limit: 25
    })
    candidates = issues.map((issue) => ({
      number: trailingNumber(issue.key) ?? 0,
      title: issue.title,
      url: issue.url,
      identifier: issue.key
    }))
  }
  return findDuplicateCandidates({ title }, candidates)
}

function escapeJql(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

export type GhFallbackResolution =
  | { ok: true; invocation: { command: string; args: string[] } }
  | { ok: false; message: string }

/** The D8 gate: local draft, installed and signed-in `gh`, an explicit owner/repo, then the argv. */
export async function resolveGhFallback(args: {
  active: ActiveTaskDraft
  primaryRepo: Repo | null
  frozen: TaskDraftProposal
}): Promise<GhFallbackResolution> {
  const { active, primaryRepo, frozen } = args
  if (
    !primaryRepo ||
    active.target.hostId !== LOCAL_EXECUTION_HOST_ID ||
    getRepoExecutionHostId(primaryRepo) !== LOCAL_EXECUTION_HOST_ID
  ) {
    return {
      ok: false,
      message: translate(
        'auto.hooks.useTaskPageDockActions.taskDraftGhLocalOnly',
        'The manual gh fallback needs a local repository.'
      )
    }
  }
  const preflight = await window.api.preflight.check().catch(() => null)
  if (!preflight?.gh.installed) {
    return {
      ok: false,
      message: translate(
        'auto.hooks.useTaskPageDockActions.taskDraftGhMissing',
        'The gh CLI is not installed, so the manual fallback is unavailable.'
      )
    }
  }
  if (!preflight.gh.authenticated) {
    return {
      ok: false,
      message: translate(
        'auto.hooks.useTaskPageDockActions.taskDraftGhLoggedOut',
        'gh is not signed in, so the manual fallback is unavailable.'
      )
    }
  }
  if (!active.target.owner || !active.target.repo) {
    return {
      ok: false,
      message: translate(
        'auto.hooks.useTaskPageDockActions.taskDraftGhNoRepo',
        'This repository has no GitHub owner and name.'
      )
    }
  }
  try {
    return {
      ok: true,
      invocation: buildGhFallbackInvocation({
        owner: active.target.owner,
        repo: active.target.repo,
        title: frozen.title,
        body: frozen.body,
        labels: frozen.labels
      })
    }
  } catch (error) {
    return { ok: false, message: errorText(error) }
  }
}

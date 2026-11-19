import type { GhAccountBinding } from '../../shared/github/account-binding'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { isFolderRepo } from '../../shared/repo-kind'
import type { Repo } from '../../shared/repo-types'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import {
  buildLinkedIssueContextSnapshot,
  type LinkedIssueContextSnapshot
} from '../../shared/linked-issue-context-snapshot'
import { ghExecFileAsync } from '../git/runner'
import { ghRepoExecOptions, githubRepoContext } from './github-repository-identity'
import { resolveIssueGitHubApiRepositorySource } from './github-api-repository'
import { githubRepositoryWebHost } from './github-repository-host'

/**
 * The slice of the store this capture needs. Narrow on purpose: the two create funnels that call
 * it hold different authorities (IPC store vs runtime store), and this keeps the dependency
 * identical for both instead of threading a runtime service through the IPC handler.
 */
export type LinkedIssueContextCaptureStore = {
  getWorktreeMeta(worktreeId: string): WorktreeMeta | undefined
  setWorktreeMeta(worktreeId: string, meta: Partial<WorktreeMeta>): unknown
  getRepo(repoId: string): Repo | undefined
}

/** Which repository an issue number is read from, resolved before the read. */
export type LinkedIssueReadTarget = {
  owner: string
  repo: string
  /**
   * Always explicit, including `github.com`.
   *
   * Why not `undefined` for dotcom: `gh api` resolves a bare repo against gh's default host, so a
   * process-level `GH_HOST` would redirect the read to another server that has the same
   * owner/repo/issue number. The runner turns this into `--hostname <host>`.
   */
  host: string
  /** Bound account for a per-project GitHub identity; absent means ambient auth. */
  ghAccount?: GhAccountBinding
}

export type CaptureLinkedIssueContextArgs = {
  store: LinkedIssueContextCaptureStore
  worktreeId: string
  worktreePath: string
  /** Called after a snapshot was persisted, so the caller can push the new worktree state. */
  onCaptured?: () => void
  /** Test seam; production resolves the issue source from the repo's remotes. */
  resolveReadTarget?: (repo: Repo) => Promise<LinkedIssueReadTarget | null>
  /** Test seam; production reads through `gh` on the client. */
  fetchIssue?: (target: LinkedIssueReadTarget, issueNumber: number) => Promise<unknown>
  now?: () => number
}

/**
 * Capture the linked GitHub issue body once, right after a worktree was created.
 *
 * Never throws and never runs on the create path's critical path: callers fire it without
 * awaiting, so a slow, offline, unauthenticated or failed `gh` only means the worktree keeps the
 * pre-capture behaviour (the agent draft links the issue without quoting it).
 */
export async function captureLinkedIssueContextForWorktree(
  args: CaptureLinkedIssueContextArgs
): Promise<LinkedIssueContextSnapshot | null> {
  try {
    const meta = args.store.getWorktreeMeta(args.worktreeId)
    const issueNumber = meta?.linkedIssue
    if (!meta || typeof issueNumber !== 'number' || !Number.isInteger(issueNumber) || issueNumber <= 0) {
      return null
    }
    // Why re-capture is skipped rather than refreshed: the snapshot is written once by design.
    if (meta?.linkedIssueContext?.number === issueNumber) {
      return null
    }
    const repo = args.store.getRepo(getRepoIdFromWorktreeId(args.worktreeId))
    if (!repo || isFolderRepo(repo)) {
      return null
    }
    // Why local only: the GitHub CLI runs on the client, so a host-backed checkout has no `gh`
    // credential path here (getIssueBodyAndComments takes the same stand for connection-backed
    // lookups). Those worktrees keep the pre-capture behaviour.
    // Why not `repo.connectionId`: a row that names its owner only as `executionHostId: 'ssh:...'`
    // still has a null connectionId, and reading that field is the exact mistake that ran creates
    // on the wrong machine (#11163).
    if (getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID) {
      return null
    }
    // Why resolve the target instead of letting `gh issue view` read the cwd's remotes: on a fork
    // checkout those resolve to upstream, so the same issue number in the other repository would be
    // captured and injected. The target is pinned to the repo's own issue source preference.
    const target = await (args.resolveReadTarget ?? resolveRepoIssueReadTarget)(repo)
    if (!target) {
      return null
    }

    const fetchIssue =
      args.fetchIssue ??
      ((readTarget: LinkedIssueReadTarget, numberToRead: number) =>
        readIssueThroughGh(args.worktreePath, readTarget, numberToRead))
    const issue = await fetchIssue(target, issueNumber)
    const echoedIssue = echoedIssueNumber(issue)
    if (echoedIssue !== null && echoedIssue !== issueNumber) {
      return null
    }
    const snapshot = buildLinkedIssueContextSnapshot(
      toSnapshotSource(issue, issueNumber, (args.now ?? Date.now)())
    )
    if (!snapshot) {
      return null
    }
    // Why re-read after the await: the fetch is async, so the link or the worktree itself can move
    // while it is in flight. A snapshot written then would belong to a worktree that no longer
    // points at this issue — or overwrite the one a same-path rebuild already captured.
    if (!isStillTheSameLinkedWorktree(args.store, args.worktreeId, meta, issueNumber)) {
      return null
    }
    args.store.setWorktreeMeta(args.worktreeId, { linkedIssueContext: snapshot })
    args.onCaptured?.()
    return snapshot
  } catch {
    // Why swallow: this is best-effort enrichment of an existing worktree. A capture failure must
    // not surface as a create failure or a background error the user cannot act on.
    return null
  }
}

/** Same worktree instance, still linked to the same issue, still without a snapshot for it. */
function isStillTheSameLinkedWorktree(
  store: LinkedIssueContextCaptureStore,
  worktreeId: string,
  beforeFetch: WorktreeMeta,
  issueNumber: number
): boolean {
  const current = store.getWorktreeMeta(worktreeId)
  if (!current || current.linkedIssue !== issueNumber) {
    return false
  }
  // Why the instance id: a same-path rebuild reuses the worktree id, so the number alone cannot
  // tell the old instance from the new one, and the late write would overwrite its snapshot.
  if (beforeFetch.instanceId && current.instanceId !== beforeFetch.instanceId) {
    return false
  }
  return current.linkedIssueContext?.number !== issueNumber
}

export async function resolveRepoIssueReadTarget(
  repo: Pick<Repo, 'path' | 'ghAccount' | 'issueSourcePreference'>
): Promise<LinkedIssueReadTarget | null> {
  const localGitOptions = repo.ghAccount ? { ghAccount: repo.ghAccount } : {}
  // Why the hosted (ApiRepository) resolver rather than the remote one: it also parses Enterprise
  // remotes, and its identity is what the gh request is pinned to.
  const { source } = await resolveIssueGitHubApiRepositorySource(
    repo.path,
    repo.issueSourcePreference,
    null,
    localGitOptions
  )
  if (!source) {
    return null
  }
  return {
    owner: source.owner,
    repo: source.repo,
    host: githubRepositoryWebHost(source),
    ...(repo.ghAccount ? { ghAccount: repo.ghAccount } : {})
  }
}

async function readIssueThroughGh(
  worktreePath: string,
  target: LinkedIssueReadTarget,
  issueNumber: number
): Promise<unknown> {
  const { stdout } = await ghExecFileAsync(
    ['api', '--cache', '60s', `repos/${target.owner}/${target.repo}/issues/${issueNumber}`],
    {
      ...ghRepoExecOptions(
        githubRepoContext(
          worktreePath,
          null,
          target.ghAccount ? { ghAccount: target.ghAccount } : {}
        )
      ),
      host: target.host,
      // Why background: a capture runs right after a create, so it must not take an admission slot
      // from the interactive git work the user is waiting on.
      admissionTier: 'background' as const
    }
  )
  return JSON.parse(stdout) as unknown
}

function echoedIssueNumber(issue: unknown): number | null {
  if (!issue || typeof issue !== 'object') {
    return null
  }
  const value = (issue as { number?: unknown }).number
  return typeof value === 'number' && Number.isInteger(value) ? value : null
}

function toSnapshotSource(
  issue: unknown,
  issueNumber: number,
  capturedAt: number
): {
  number: number
  title: string | null
  url: string | null
  body: string | null
  updatedAt: string | null
  capturedAt: number
} {
  // The REST issue payload (`gh api repos/{owner}/{repo}/issues/{n}`) names these fields
  // `title` / `html_url` / `updated_at` / `body`.
  const raw = (issue && typeof issue === 'object' ? issue : {}) as {
    title?: unknown
    url?: unknown
    html_url?: unknown
    body?: unknown
    updatedAt?: unknown
    updated_at?: unknown
  }
  const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null)
  return {
    // Why the linked number rather than a possibly different echoed one: the read is pinned to a
    // repository, and a response for another issue must never be stored under this worktree's link.
    number: issueNumber,
    title: asString(raw.title),
    url: asString(raw.html_url) ?? asString(raw.url),
    body: asString(raw.body),
    updatedAt: asString(raw.updated_at) ?? asString(raw.updatedAt),
    capturedAt
  }
}

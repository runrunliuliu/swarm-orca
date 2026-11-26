import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'
import { normalizeGitRemoteUrl } from '../../../../shared/git-remote-identity'
import type { Repo } from '../../../../shared/repo-types'
import type { TaskProviderIdentity } from '../../../../shared/task-provider-identity'

export type TaskRecordRepoMatch =
  | { kind: 'unique'; repoId: string }
  | { kind: 'none' }
  | { kind: 'ambiguous' }
  | { kind: 'unidentifiable' }

type MatchableRepo = Pick<Repo, 'id' | 'path' | 'gitRemoteIdentity' | 'upstream'>

function canonicalRemoteKey(repo: MatchableRepo): string | null {
  const canonicalKey = repo.gitRemoteIdentity?.canonicalKey.trim()
  if (canonicalKey) {
    return canonicalKey
  }
  return normalizeGitRemoteUrl(repo.gitRemoteIdentity?.remoteUrl ?? '')
}

function canonicalRemoteParts(repo: MatchableRepo): { host: string; tail: string } | null {
  const key = canonicalRemoteKey(repo)?.replace(/\/+$/, '').toLowerCase()
  const separator = key?.indexOf('/') ?? -1
  return key && separator > 0 && separator < key.length - 1
    ? { host: key.slice(0, separator), tail: key.slice(separator + 1) }
    : null
}

/** Whether a tracker identity corroborates one runtime repo. `null` means the
 *  provider has no cross-host Git repository identity. */
export function taskProviderIdentityMatchesRepo(
  identity: TaskProviderIdentity | null | undefined,
  repo: MatchableRepo
): boolean | null {
  if (identity?.provider !== 'github') {
    return null
  }
  const host = identity.host?.trim().toLowerCase() || 'github.com'
  const tail = `${identity.owner}/${identity.repo}`.toLowerCase()
  const remote = canonicalRemoteParts(repo)
  if (remote && remote.host === host && remote.tail === tail) {
    return true
  }
  const upstream = repo.upstream
  if (!upstream) {
    return false
  }
  return (
    (upstream.host?.trim().toLowerCase() || 'github.com') === host &&
    `${upstream.owner}/${upstream.repo}`.toLowerCase() === tail
  )
}

export function matchTaskProviderRepo(
  identity: TaskProviderIdentity | null | undefined,
  runtimeRepos: readonly MatchableRepo[]
): TaskRecordRepoMatch {
  if (identity?.provider !== 'github') {
    return { kind: 'unidentifiable' }
  }
  const matches = runtimeRepos.filter((repo) => taskProviderIdentityMatchesRepo(identity, repo))
  return matches.length === 0
    ? { kind: 'none' }
    : matches.length === 1
      ? { kind: 'unique', repoId: matches[0].id }
      : { kind: 'ambiguous' }
}

/** Match host-local repo registrations only through their cross-host Git identity. */
export function matchTaskRecordRepo(
  pageRepo: MatchableRepo,
  runtimeRepos: readonly MatchableRepo[]
): TaskRecordRepoMatch {
  const pageKey = canonicalRemoteKey(pageRepo)
  if (pageKey === null) {
    return { kind: 'unidentifiable' }
  }

  const identityMatches = runtimeRepos.filter((repo) => canonicalRemoteKey(repo) === pageKey)
  if (identityMatches.length === 0) {
    return { kind: 'none' }
  }
  if (identityMatches.length === 1) {
    return { kind: 'unique', repoId: identityMatches[0].id }
  }

  // Path may break a tie only after the remote identity already matched. A same-looking
  // path on another host is never proof that two registrations name the same repository.
  const pagePath = normalizeRuntimePathForComparison(pageRepo.path)
  const pathMatches = identityMatches.filter(
    (repo) => normalizeRuntimePathForComparison(repo.path) === pagePath
  )
  return pathMatches.length === 1
    ? { kind: 'unique', repoId: pathMatches[0].id }
    : { kind: 'ambiguous' }
}

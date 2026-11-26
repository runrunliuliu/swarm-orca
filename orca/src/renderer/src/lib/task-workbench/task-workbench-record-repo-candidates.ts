import type { Repo } from '../../../../shared/repo-types'
import type { TaskProviderIdentity } from '../../../../shared/task-provider-identity'
import type {
  TaskRecordSourceAnswer,
  TaskRecordSourceFailure
} from './task-workbench-record-sources'
import {
  matchTaskProviderRepo,
  matchTaskRecordRepo,
  taskProviderIdentityMatchesRepo
} from './task-workbench-record-repo-match'

export type TaskRecordRepoCatalogResult =
  | { kind: 'catalog'; environmentId: string; repos: readonly Repo[] }
  | { kind: 'failed'; environmentId: string; failure: TaskRecordSourceFailure }

export type TaskRecordRepoCandidateResolution = {
  pairs: { environmentId: string; repoId: string }[]
  unavailable: TaskRecordSourceAnswer[]
  verdict: 'resolved' | 'undetermined'
}

export function taskRecordRepoUnavailable(
  environmentId: string,
  failure: TaskRecordSourceFailure
): TaskRecordSourceAnswer {
  return {
    target: { kind: 'environment', environmentId },
    kind: 'unavailable',
    failure
  }
}

function matchWithAvailableIdentity(
  pageRepo: Repo | undefined,
  providerIdentity: TaskProviderIdentity | null | undefined,
  repos: readonly Repo[]
): ReturnType<typeof matchTaskRecordRepo> | { kind: 'contradictory' } {
  const pageMatch = pageRepo
    ? matchTaskRecordRepo(pageRepo, repos)
    : ({ kind: 'unidentifiable' } as const)
  const providerMatch = matchTaskProviderRepo(providerIdentity, repos)
  if (pageMatch.kind === 'unidentifiable') {
    return providerMatch
  }
  if (providerMatch.kind === 'unidentifiable') {
    return pageMatch
  }
  if (
    pageMatch.kind === 'unique' &&
    providerMatch.kind === 'unique' &&
    pageMatch.repoId === providerMatch.repoId
  ) {
    return pageMatch
  }
  if (pageMatch.kind === 'none' && providerMatch.kind === 'none') {
    return pageMatch
  }
  return { kind: 'contradictory' }
}

export function resolveTaskRecordRepoCandidates(args: {
  queryRepoId: string
  pageRepo: Repo | undefined
  providerIdentity: TaskProviderIdentity | null | undefined
  initialUnavailable: readonly TaskRecordSourceAnswer[]
  results: readonly TaskRecordRepoCatalogResult[]
}): TaskRecordRepoCandidateResolution {
  const unavailable = [...args.initialUnavailable]
  const catalogs = args.results.filter((result) => result.kind === 'catalog')
  for (const result of args.results) {
    if (result.kind === 'failed') {
      unavailable.push(taskRecordRepoUnavailable(result.environmentId, result.failure))
    }
  }

  const exactIdMatches = catalogs.flatMap(({ environmentId, repos }) =>
    repos.filter((repo) => repo.id === args.queryRepoId).map((repo) => ({ environmentId, repo }))
  )
  if (exactIdMatches.length > 1) {
    return { pairs: [], unavailable, verdict: 'undetermined' }
  }
  const exact = exactIdMatches[0]
  if (exact) {
    const providerCorroborates = taskProviderIdentityMatchesRepo(args.providerIdentity, exact.repo)
    const pageCorroborates = args.pageRepo ? matchTaskRecordRepo(args.pageRepo, [exact.repo]) : null
    if (
      providerCorroborates === false ||
      (pageCorroborates !== null &&
        pageCorroborates.kind !== 'unique' &&
        pageCorroborates.kind !== 'unidentifiable')
    ) {
      return { pairs: [], unavailable, verdict: 'undetermined' }
    }
    return {
      pairs: [{ environmentId: exact.environmentId, repoId: exact.repo.id }],
      unavailable,
      verdict: 'resolved'
    }
  }

  const pairs: { environmentId: string; repoId: string }[] = []
  let contradictoryIdentity = false
  for (const { environmentId, repos } of catalogs) {
    const match = matchWithAvailableIdentity(args.pageRepo, args.providerIdentity, repos)
    if (match.kind === 'unique') {
      pairs.push({ environmentId, repoId: match.repoId })
    } else if (match.kind === 'none') {
      unavailable.push(taskRecordRepoUnavailable(environmentId, 'repo-unmatched'))
    } else if (match.kind === 'ambiguous') {
      unavailable.push(taskRecordRepoUnavailable(environmentId, 'repo-ambiguous'))
    } else if (match.kind === 'contradictory') {
      contradictoryIdentity = true
    }
  }
  const hasPageIdentity = args.pageRepo
    ? matchTaskRecordRepo(args.pageRepo, []).kind !== 'unidentifiable'
    : false
  return {
    pairs,
    unavailable,
    verdict:
      pairs.length === 0 && (!hasPageIdentity || contradictoryIdentity)
        ? 'undetermined'
        : 'resolved'
  }
}

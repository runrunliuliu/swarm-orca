import { normalizeRuntimePathForComparison } from './cross-platform-path'
import {
  HistoryBackfillCommandError,
  type HistoryBackfillRepoSelector,
  type HistoryBackfillTask
} from './history-backfill-command'
import type { TaskRecord, TaskRecordsState } from './task-records-types'

/** Only the two fields these lookups compare; `repos` is a persisted array this
 *  build reads defensively rather than trusting its shape. */
export type RegisteredRepo = { id: string; path: string }

/** Parse the persisted `repos` domain without accepting a half-shaped row. */
export function registeredRepos(value: unknown): RegisteredRepo[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) {
      return []
    }
    const { id, path } = entry as { id?: unknown; path?: unknown }
    if (typeof id !== 'string' || id.length === 0) {
      return []
    }
    return [{ id, path: typeof path === 'string' ? path : '' }]
  })
}

/** A repo id, or a path. A bare value is matched as an id first, then as a path,
 *  so the common `repo-1#53` and `…/repos/app#53` forms both work without a flag;
 *  the explicit `id:` / `path:` prefixes settle a value that is both. */
export function resolveTaskRecordRepoId(
  repos: readonly RegisteredRepo[],
  selector: HistoryBackfillRepoSelector
): string {
  const matches =
    selector.kind === 'id'
      ? repos.filter((repo) => repo.id === selector.value)
      : selector.kind === 'path'
        ? reposByPath(repos, selector.value)
        : bareRepoMatches(repos, selector.value)
  if (matches.length === 1) {
    return matches[0].id
  }
  if (matches.length === 0) {
    throw new HistoryBackfillCommandError(
      'invalid_argument',
      `No registered repo matches "${selector.value}". Pass a repo id (\`orca repo list\`) or its checkout path.`
    )
  }
  throw new HistoryBackfillCommandError(
    'invalid_argument',
    `"${selector.value}" matches ${matches.length} registered repos. Pass \`id:<repoId>\` or \`path:<checkout>\` to name one.`
  )
}

function bareRepoMatches(repos: readonly RegisteredRepo[], selector: string): RegisteredRepo[] {
  const byId = repos.filter((repo) => repo.id === selector)
  return byId.length > 0 ? byId : reposByPath(repos, selector)
}

function reposByPath(repos: readonly RegisteredRepo[], path: string): RegisteredRepo[] {
  if (path.length === 0) {
    return []
  }
  const target = normalizeRuntimePathForComparison(path)
  return repos.filter(
    (repo) => repo.path.length > 0 && normalizeRuntimePathForComparison(repo.path) === target
  )
}

/** The one record `<repo>#<number>` names. An issue and a pull request cannot share
 *  a number on one tracker, so more than one match means two trackers claimed the
 *  number in one repo; picking one would attribute a run to a task the operator did
 *  not name. `itemType` narrows that set when the caller could state it. */
export function resolveTaskRecordByNumber(
  state: TaskRecordsState,
  args: { repoId: string; task: HistoryBackfillTask }
): TaskRecord {
  const { repoId, task } = args
  const matches = Object.values(state.byId).filter(
    (record) =>
      record.origin.kind === 'external' &&
      record.origin.number === task.number &&
      (task.itemType === undefined || record.origin.itemType === task.itemType) &&
      record.bindings.some((binding) => binding.repoId === repoId)
  )
  if (matches.length === 1) {
    return matches[0]
  }
  if (matches.length === 0) {
    throw new HistoryBackfillCommandError(
      'invalid_argument',
      `No task record for ${repoId}#${task.number}. A record exists only after a workspace was bound to that task.`
    )
  }
  throw new HistoryBackfillCommandError(
    'invalid_argument',
    `${repoId}#${task.number} matches ${matches.length} task records (${matches
      .map((record) => record.taskId)
      .join(', ')}); this command does not guess which one.`
  )
}

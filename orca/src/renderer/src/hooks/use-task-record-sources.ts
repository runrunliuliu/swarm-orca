import { useMemo } from 'react'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { TaskRecord } from '../../../shared/task-records-types'
import type { Repo } from '../../../shared/repo-types'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import type { TaskProviderIdentity } from '../../../shared/task-provider-identity'
import type { TaskWorkbenchRecordSource } from '@/components/task-workbench/task-workbench-view'
import type { TaskRecordQuery } from './use-task-records'
import { useTaskRecordsRemote, type TaskRecordsRuntimeStatus } from './use-task-records-remote'
import {
  mergeTaskRecordSources,
  selectTaskRecordEnvironments,
  worktreeRecordHostId,
  type TaskRecordSources
} from '@/lib/task-workbench/task-workbench-record-sources'
import { projectTaskRecordSource } from '@/lib/task-workbench/task-workbench-record-source-view'
import { useTaskRecordRepoCandidates } from './use-task-record-repo-candidates'

/**
 * One task's record, read from the client's profile and from evidence-led runtime
 * owners, or from the bounded paired-runtime catalog fallback (issues #31/#67).
 *
 * Why a hook of its own: the task page needs three things from this decision —
 * the merged record to render, the presentational source state to print, and a
 * pending flag — and threading those through the page's own assembly made one
 * function own both "which profiles" and "how the page looks". The three steps
 * stay separate and pure (evidence selection → repo-candidate resolution → remote
 * read → merge); this module only orders them and keeps their identities stable.
 *
 * Stability matters here for a measured reason: every value this hook returns is a
 * dependency of the page's big view memo, so an object literal rebuilt per render
 * would rebuild the whole tab per render. `record`, `recordSource` and `pending`
 * are memoized on the inputs that actually change them, and the caller compares
 * the returned object by its fields, not by identity.
 */
export type TaskRecordSourcesLoad = {
  /** The merged record, or `null` when no profile that answered has one. */
  record: TaskRecord | null
  /** The full evidence view (answered, unavailable, conflicts). */
  sources: TaskRecordSources
  /** What the panel prints about where the record came from. `undefined` when no
   *  environment applies to this task, which is the local-only case. */
  recordSource: TaskWorkbenchRecordSource | undefined
  /** True while a selected environment has not answered yet. */
  pending: boolean
}

const NO_BINDINGS: readonly ExecutionHostId[] = []

export function useTaskRecordSources(args: {
  query: TaskRecordQuery | null
  /** This task's workspace rows, in store order. Must be a memoized list: it is
   *  the identity the environment list is derived from. */
  worktrees: readonly {
    hostId?: ExecutionHostId | null
    runtimeOwnerEnvironmentId?: string | null
  }[]
  /** The locally-read record. Its bindings are host evidence too, and they outlive
   *  the workspace rows that created them. */
  local: TaskRecord | null
  /** The page's own repo registration's host, when the store has one. */
  repoHostId?: ExecutionHostId
  /** The page's local repo registration supplies the cross-host Git identity. */
  pageRepo?: Repo
  /** Tracker repository identity survives when the local repo row does not. */
  providerIdentity?: TaskProviderIdentity | null
  /** The status store's rows: they skip a call a host cannot serve, and they name
   *  the version of a host that turned out to be too old. */
  statusByEnvironment?: ReadonlyMap<string, TaskRecordsRuntimeStatus>
  /** The environment catalog, for the display name the notice prints instead of an
   *  opaque id. */
  environments?: readonly PublicKnownRuntimeEnvironment[]
  catalogHydrated?: boolean
  catalogSettled?: boolean
  /** Changes when the repo's workspace list changes, matching `useTaskRecords`. */
  revision?: unknown
}): TaskRecordSourcesLoad {
  const {
    query,
    worktrees,
    local,
    repoHostId,
    pageRepo,
    providerIdentity,
    statusByEnvironment,
    environments,
    catalogHydrated,
    catalogSettled,
    revision
  } = args
  const environmentLabels = useMemo(
    () => new Map((environments ?? []).map((environment) => [environment.id, environment.name])),
    [environments]
  )
  const appVersions = useMemo(
    () =>
      new Map(
        [...(statusByEnvironment ?? [])].flatMap(([environmentId, entry]) =>
          entry.appVersion ? [[environmentId, entry.appVersion] as const] : []
        )
      ),
    [statusByEnvironment]
  )

  const worktreeHostIds = useMemo(() => worktrees.map(worktreeRecordHostId), [worktrees])
  const bindingHostIds = useMemo(
    () => local?.bindings.map((binding) => binding.hostId) ?? NO_BINDINGS,
    [local]
  )
  const evidenceEnvironmentIds = useMemo(
    () =>
      selectTaskRecordEnvironments({
        worktreeHostIds,
        bindingHostIds: repoHostId ? [...bindingHostIds, repoHostId] : bindingHostIds
      }),
    [worktreeHostIds, bindingHostIds, repoHostId]
  )

  const candidates = useTaskRecordRepoCandidates({
    query,
    pageRepo,
    providerIdentity,
    evidenceEnvironmentIds,
    environments,
    statusByEnvironment,
    catalogHydrated,
    catalogSettled
  })

  const remote = useTaskRecordsRemote({
    query,
    pairs: candidates.pairs,
    statusByEnvironment,
    revision
  })
  const answers = useMemo(
    () => [...candidates.unavailable, ...remote.answers],
    [candidates.unavailable, remote.answers]
  )
  const sources = useMemo(() => mergeTaskRecordSources({ local, answers }), [local, answers])
  const pending = candidates.pending || remote.pending
  const blocksFinalAbsence =
    evidenceEnvironmentIds.length > 0 ||
    (!pageRepo && worktrees.length === 0 && local === null) ||
    // The catalog fallback probes every environment when no evidence names one.
    // An inconclusive probe with no workspace row to anchor local absence must not
    // print as "this task never ran" — unknown is not absence (issue #67).
    (candidates.verdict === 'undetermined' && worktrees.length === 0)
  const recordSource = useMemo(
    () =>
      projectTaskRecordSource({
        environmentIds: candidates.environmentIds,
        candidateVerdict: candidates.verdict,
        blocksFinalAbsence,
        sources,
        pending,
        labels: environmentLabels,
        appVersions
      }),
    [
      candidates.environmentIds,
      candidates.verdict,
      blocksFinalAbsence,
      sources,
      pending,
      environmentLabels,
      appVersions
    ]
  )

  return { record: sources.record, sources, recordSource, pending }
}

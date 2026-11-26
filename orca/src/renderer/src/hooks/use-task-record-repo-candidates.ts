import { useEffect, useRef, useState } from 'react'
import { TASK_RECORDS_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import type { Repo } from '../../../shared/repo-types'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import { lastVerifiedRuntimeStatus } from '../../../shared/runtime-host-status'
import type { TaskProviderIdentity } from '../../../shared/task-provider-identity'
import type { TaskRecordSourceAnswer } from '@/lib/task-workbench/task-workbench-record-sources'
import { classifyTaskRecordsRemoteFailure } from '@/lib/task-workbench/task-workbench-record-source-failures'
import {
  resolveTaskRecordRepoCandidates,
  taskRecordRepoUnavailable,
  type TaskRecordRepoCatalogResult
} from '@/lib/task-workbench/task-workbench-record-repo-candidates'
import type { TaskRecordQuery } from './use-task-records'
import type { TaskRecordsRuntimeStatus } from './use-task-records-remote'
import {
  clearTaskRecordRepoCatalogCacheForTests,
  expectedTaskRecordRuntimeId,
  pruneTaskRecordRepoCatalogs,
  readTaskRecordRepoCatalog,
  taskRecordEnvironmentPairingRevision
} from './task-record-repo-catalog-cache'

export { clearTaskRecordRepoCatalogCacheForTests }

export type TaskRecordRepoPair = { environmentId: string; repoId: string }
export type TaskRecordCandidateVerdict = 'not-needed' | 'resolved' | 'undetermined'

export type TaskRecordRepoCandidatesLoad = {
  pairs: TaskRecordRepoPair[]
  unavailable: TaskRecordSourceAnswer[]
  environmentIds: string[]
  verdict: TaskRecordCandidateVerdict
  pending: boolean
}

const IDLE: TaskRecordRepoCandidatesLoad = {
  pairs: [],
  unavailable: [],
  environmentIds: [],
  verdict: 'not-needed',
  pending: false
}
const PENDING: TaskRecordRepoCandidatesLoad = { ...IDLE, pending: true }

type CandidateEffectInput = {
  key: string
  query: TaskRecordQuery | null
  pageRepo: Repo | undefined
  providerIdentity: TaskProviderIdentity | null | undefined
  evidenceEnvironmentIds: readonly string[]
  environments: readonly PublicKnownRuntimeEnvironment[]
  statusByEnvironment: ReadonlyMap<string, TaskRecordsRuntimeStatus> | undefined
  catalogHydrated: boolean
  catalogSettled: boolean
}

function statusAdvertisesTaskRecords(status: TaskRecordsRuntimeStatus | undefined): boolean {
  const capabilities = lastVerifiedRuntimeStatus(status)?.capabilities
  return capabilities === undefined || capabilities.includes(TASK_RECORDS_RUNTIME_CAPABILITY)
}

function statusRefusesTaskRecords(status: TaskRecordsRuntimeStatus | undefined): boolean {
  const capabilities = lastVerifiedRuntimeStatus(status)?.capabilities
  return capabilities !== undefined && !capabilities.includes(TASK_RECORDS_RUNTIME_CAPABILITY)
}

export function useTaskRecordRepoCandidates(args: {
  query: TaskRecordQuery | null
  pageRepo?: Repo
  providerIdentity?: TaskProviderIdentity | null
  evidenceEnvironmentIds: readonly string[]
  environments?: readonly PublicKnownRuntimeEnvironment[]
  statusByEnvironment?: ReadonlyMap<string, TaskRecordsRuntimeStatus>
  catalogHydrated?: boolean
  catalogSettled?: boolean
}): TaskRecordRepoCandidatesLoad {
  const {
    query,
    pageRepo,
    providerIdentity,
    evidenceEnvironmentIds,
    statusByEnvironment,
    environments = []
  } = args
  const catalogHydrated = args.catalogHydrated ?? args.environments === undefined
  const catalogSettled = args.catalogSettled ?? args.environments === undefined
  const inputKey = JSON.stringify({
    query:
      query === null ? null : [query.repoId, query.itemType, query.number, query.provider ?? ''],
    pageRepo: pageRepo
      ? [
          pageRepo.id,
          pageRepo.path,
          pageRepo.gitRemoteIdentity?.canonicalKey ?? '',
          pageRepo.gitRemoteIdentity?.remoteUrl ?? ''
        ]
      : null,
    providerIdentity: providerIdentity ?? null,
    evidenceEnvironmentIds,
    catalogHydrated,
    catalogSettled,
    environments: environments.map((environment) => {
      const status = statusByEnvironment?.get(environment.id)
      return [
        environment.id,
        taskRecordEnvironmentPairingRevision(environment),
        expectedTaskRecordRuntimeId(environment, status) ?? '',
        statusByEnvironment?.has(environment.id) === true,
        lastVerifiedRuntimeStatus(status)?.capabilities ?? null
      ]
    })
  })
  const [load, setLoad] = useState<TaskRecordRepoCandidatesLoad & { key: string | null }>({
    ...IDLE,
    key: null,
    pending: true
  })
  const effectInput = useRef<CandidateEffectInput>({
    key: inputKey,
    query,
    pageRepo,
    providerIdentity,
    evidenceEnvironmentIds,
    environments,
    statusByEnvironment,
    catalogHydrated,
    catalogSettled
  })
  if (effectInput.current.key !== inputKey) {
    effectInput.current = {
      key: inputKey,
      query,
      pageRepo,
      providerIdentity,
      evidenceEnvironmentIds,
      environments,
      statusByEnvironment,
      catalogHydrated,
      catalogSettled
    }
  }

  useEffect(() => {
    const {
      query,
      pageRepo,
      providerIdentity,
      evidenceEnvironmentIds,
      environments,
      statusByEnvironment,
      catalogHydrated,
      catalogSettled
    } = effectInput.current
    if (query === null) {
      setLoad({ ...IDLE, key: inputKey })
      return
    }
    const statusCoverageComplete = environments.every((environment) =>
      statusByEnvironment?.has(environment.id)
    )
    if (
      (environments.length > 0 && !catalogHydrated) ||
      !catalogSettled ||
      !statusCoverageComplete
    ) {
      setLoad({ ...IDLE, key: inputKey, pending: true })
      return
    }

    pruneTaskRecordRepoCatalogs(environments, statusByEnvironment)
    const evidenceSet = new Set(evidenceEnvironmentIds)
    const fallback = evidenceEnvironmentIds.length === 0
    const selected = fallback
      ? environments.filter((environment) =>
          statusAdvertisesTaskRecords(statusByEnvironment?.get(environment.id))
        )
      : environments.filter((environment) => evidenceSet.has(environment.id))
    const excluded = fallback
      ? environments.filter((environment) =>
          statusRefusesTaskRecords(statusByEnvironment?.get(environment.id))
        )
      : []
    const missingEvidence = fallback
      ? []
      : evidenceEnvironmentIds.filter(
          (environmentId) => !environments.some((environment) => environment.id === environmentId)
        )
    const environmentIds = fallback
      ? environments.map((environment) => environment.id)
      : [...evidenceEnvironmentIds]
    const initialUnavailable = [
      ...missingEvidence.map((environmentId) =>
        taskRecordRepoUnavailable(environmentId, 'unreachable')
      ),
      ...excluded.map((environment) =>
        taskRecordRepoUnavailable(environment.id, 'unsupported')
      )
    ]
    const readable = selected.filter((environment) => {
      const status = statusByEnvironment?.get(environment.id)
      if (!fallback && statusRefusesTaskRecords(status)) {
        initialUnavailable.push(taskRecordRepoUnavailable(environment.id, 'unsupported'))
        return false
      }
      return true
    })

    if (environmentIds.length === 0) {
      setLoad({ ...IDLE, key: inputKey })
      return
    }
    if (readable.length === 0) {
      setLoad({
        key: inputKey,
        pairs: [],
        unavailable: initialUnavailable,
        environmentIds,
        verdict: 'resolved',
        pending: false
      })
      return
    }
    let cancelled = false
    setLoad({
      key: inputKey,
      pairs: [],
      unavailable: initialUnavailable,
      environmentIds,
      verdict: 'resolved',
      pending: true
    })
    const read = async (): Promise<void> => {
      const results: TaskRecordRepoCatalogResult[] = await Promise.all(
        readable.map(async (environment): Promise<TaskRecordRepoCatalogResult> => {
          try {
            const repos = await readTaskRecordRepoCatalog(
              environment,
              statusByEnvironment?.get(environment.id)
            )
            return {
              kind: 'catalog' as const,
              environmentId: environment.id,
              repos
            }
          } catch (error) {
            return {
              kind: 'failed' as const,
              environmentId: environment.id,
              failure: classifyTaskRecordsRemoteFailure(error)
            }
          }
        })
      )
      if (cancelled) {
        return
      }
      const resolved = resolveTaskRecordRepoCandidates({
        queryRepoId: query.repoId,
        pageRepo,
        providerIdentity,
        initialUnavailable,
        results
      })
      setLoad({
        key: inputKey,
        pairs: resolved.pairs,
        unavailable: resolved.unavailable,
        environmentIds,
        verdict: resolved.verdict,
        pending: false
      })
    }
    void read()
    return () => {
      cancelled = true
    }
  }, [inputKey])

  if (load.key !== inputKey) {
    return PENDING
  }
  return load
}

import type { Repo } from '../../../shared/repo-types'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import { lastVerifiedRuntimeStatus } from '../../../shared/runtime-host-status'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { TaskRecordsRuntimeStatus } from './use-task-records-remote'

export const TASK_RECORD_REPO_CATALOG_TIMEOUT_MS = 15_000
export const TASK_RECORD_REPO_CATALOG_TTL_MS = 5_000
export const TASK_RECORD_REPO_CATALOG_CACHE_MAX = 32

type RepoCatalogEntry = {
  key: string
  settledAt: number | null
  promise: Promise<readonly Repo[]>
}

const repoCatalogCache = new Map<string, RepoCatalogEntry>()

export function clearTaskRecordRepoCatalogCacheForTests(): void {
  repoCatalogCache.clear()
}

export function taskRecordRepoCatalogCacheSizeForTests(): number {
  return repoCatalogCache.size
}

export function taskRecordEnvironmentPairingRevision(
  environment: PublicKnownRuntimeEnvironment
): number {
  return environment.pairingRevision ?? environment.createdAt
}

export function expectedTaskRecordRuntimeId(
  environment: PublicKnownRuntimeEnvironment,
  status: TaskRecordsRuntimeStatus | undefined
): string | undefined {
  return lastVerifiedRuntimeStatus(status)?.runtimeId ?? environment.runtimeId ?? undefined
}

function catalogKey(
  environment: PublicKnownRuntimeEnvironment,
  status: TaskRecordsRuntimeStatus | undefined
): string {
  return [
    environment.id,
    String(taskRecordEnvironmentPairingRevision(environment)),
    expectedTaskRecordRuntimeId(environment, status) ?? ''
  ].join('\0')
}

function rememberCatalog(entry: RepoCatalogEntry): void {
  repoCatalogCache.delete(entry.key)
  repoCatalogCache.set(entry.key, entry)
  while (repoCatalogCache.size > TASK_RECORD_REPO_CATALOG_CACHE_MAX) {
    const oldest = repoCatalogCache.keys().next().value
    if (oldest === undefined) {
      break
    }
    repoCatalogCache.delete(oldest)
  }
}

export function pruneTaskRecordRepoCatalogs(
  environments: readonly PublicKnownRuntimeEnvironment[],
  statusByEnvironment: ReadonlyMap<string, TaskRecordsRuntimeStatus> | undefined
): void {
  const validKeys = new Set(
    environments.map((environment) =>
      catalogKey(environment, statusByEnvironment?.get(environment.id))
    )
  )
  for (const [key] of repoCatalogCache) {
    if (!validKeys.has(key)) {
      repoCatalogCache.delete(key)
    }
  }
}

export function readTaskRecordRepoCatalog(
  environment: PublicKnownRuntimeEnvironment,
  status: TaskRecordsRuntimeStatus | undefined
): Promise<readonly Repo[]> {
  const key = catalogKey(environment, status)
  const cached = repoCatalogCache.get(key)
  if (
    cached &&
    (cached.settledAt === null || Date.now() - cached.settledAt < TASK_RECORD_REPO_CATALOG_TTL_MS)
  ) {
    repoCatalogCache.delete(key)
    repoCatalogCache.set(key, cached)
    return cached.promise
  }
  if (cached) {
    repoCatalogCache.delete(key)
  }

  const target = { kind: 'environment' as const, environmentId: environment.id }
  const entry: RepoCatalogEntry = { key, settledAt: null, promise: Promise.resolve([]) }
  const promise = callRuntimeRpc<{ repos: Repo[] }>(target, 'repo.list', undefined, {
    timeoutMs: TASK_RECORD_REPO_CATALOG_TIMEOUT_MS,
    reuseRecentCompatibilityFailure: true,
    expectedEnvironmentPairingRevision: taskRecordEnvironmentPairingRevision(environment),
    expectedEnvironmentRuntimeId: expectedTaskRecordRuntimeId(environment, status)
  })
    .then((result) => {
      if (!result || !Array.isArray(result.repos)) {
        throw new Error('Invalid repo.list response')
      }
      entry.settledAt = Date.now()
      return result.repos
    })
    .catch((error) => {
      if (repoCatalogCache.get(key) === entry) {
        repoCatalogCache.delete(key)
      }
      throw error
    })
  entry.promise = promise
  rememberCatalog(entry)
  return promise
}

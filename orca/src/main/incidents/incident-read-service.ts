// Strictly read-only incident reads, shared by IPC (desktop panel), runtime RPC (paired clients) and the
// two grayscale views.
//
// Why this module exists (2026-11-16): reads went through `incidentRuntimeStore()`, the *creating*
// resolver, so opening the Incidents panel on a host that had never written an incident made
// `<userData>/incidents/` and migrated the schema — the side effect the CLI read path was built to avoid
// (M1 C4 / M5 C4). A read is a read on every surface now.
//
// Why the projections live here and not in the IPC module: one store must answer identically to the
// desktop panel and to a paired runtime's client, or the two views disagree about the same rows.

import { existsSync } from 'node:fs'
import type Database from '../sqlite/sync-database'
import { openIncidentsDatabase } from './incidents-database'
import {
  DEFAULT_INCIDENT_STORE_LIMITS,
  createIncidentStore,
  type IncidentListItem,
  type IncidentStore
} from './incident-store'
import { resolveMainProcessIncidentsDatabaseFile } from './incidents-paths'
import { isIncidentClass, isIncidentStatus } from './incident-types'
import type { IncidentClass, IncidentStatus, IncidentView } from './incident-types'
import { readIncidentCounts } from './incident-counts'
import {
  attachIncidentRemoteMirrorToCounts,
  attachIncidentRemoteMirrorToCoverage
} from '../ipc/incident-mirror-coverage'
import type {
  IncidentClassDto,
  IncidentCountsDto,
  IncidentCountsRequest,
  IncidentCoverageDto,
  IncidentDetailDto,
  IncidentListRequest,
  IncidentSnapshotDto,
  IncidentSourceDto,
  IncidentStatusDto
} from '../../shared/incident-api-types'

export type IncidentReadOutcome<T> =
  | { availability: 'supported'; value: T }
  | { availability: 'store-not-created' }
  | { availability: 'unavailable'; error: string }

export type IncidentReadService = {
  snapshot(
    request: IncidentListRequest | undefined,
    source: IncidentSourceDto
  ): IncidentReadOutcome<IncidentSnapshotDto>
  /** `null` means "not in this store"; the caller owns the wording of that. */
  detail(incidentId: string, source: IncidentSourceDto): IncidentReadOutcome<IncidentDetailDto | null>
  counts(
    request: IncidentCountsRequest | undefined,
    source: IncidentSourceDto
  ): IncidentReadOutcome<IncidentCountsDto>
  close(): void
}

/**
 * A read-only handle for projections that need the raw connection (the two grayscale views).
 *
 * Exported so those views stop opening the store with the *creating* resolver: a viewer must never be
 * the reason a database appears.
 */
export type IncidentReadStore =
  | {
      availability: 'supported'
      db: Database.Database
      store: IncidentStore
      close: () => void
    }
  | { availability: 'store-not-created' }
  | { availability: 'unavailable'; error: string }

function listItem(item: IncidentListItem): IncidentSnapshotDto['incidents'][number] {
  return {
    id: item.id,
    class: item.class as IncidentClassDto,
    sourceKind: item.sourceKind,
    facet: item.facet,
    hostId: item.hostId,
    worktreeId: item.worktreeId,
    agentSessionId: item.agentSessionId,
    status: item.status as IncidentStatusDto,
    effectiveStatus: item.effectiveStatus as IncidentStatusDto,
    exitCause: item.exitCause,
    fingerprint: item.fingerprint,
    summary: item.summary,
    createdAt: item.createdAt,
    decisionCount: item.decisionCount
  }
}

export function incidentDetailFromView(
  view: IncidentView,
  source: IncidentSourceDto
): IncidentDetailDto {
  return {
    id: view.id,
    sourceKind: view.sourceKind,
    sourceId: view.sourceId,
    facet: view.facet,
    hostId: view.hostId,
    worktreeId: view.worktreeId,
    runId: view.runId,
    taskId: view.taskId,
    dispatchId: view.dispatchId,
    agentSessionId: view.agentSessionId,
    ptyIncarnationId: view.ptyIncarnationId,
    class: view.class as IncidentClassDto,
    status: view.status as IncidentStatusDto,
    effectiveStatus: view.effectiveStatus as IncidentStatusDto,
    exitCause: view.exitCause,
    fingerprint: view.fingerprint,
    evidence: {
      pointers: view.evidence.pointers,
      unknownBoundaries: view.evidence.unknownBoundaries,
      ...(view.evidence.agentIdentityDigest
        ? { agentIdentityDigest: view.evidence.agentIdentityDigest }
        : {}),
      ...(view.evidence.code ? { code: view.evidence.code } : {}),
      ...(view.evidence.repro ? { repro: view.evidence.repro } : {})
    },
    summary: view.summary,
    createdAt: view.createdAt,
    decisionCount: view.decisionCount,
    lastDecisionAt: view.lastDecisionAt,
    decisions: view.decisions.map((decision) => ({
      id: decision.id,
      incidentId: decision.incidentId,
      fromStatus: decision.fromStatus as IncidentStatusDto,
      toStatus: decision.toStatus as IncidentStatusDto,
      actor: decision.actor,
      reason: decision.reason,
      createdAt: decision.createdAt
    })),
    source
  }
}

function statusFilter(value: unknown): IncidentStatus | undefined | null {
  if (value === undefined) {
    return undefined
  }
  return isIncidentStatus(value) ? value : null
}

function classFilter(value: unknown): IncidentClass | undefined | null {
  if (value === undefined) {
    return undefined
  }
  return isIncidentClass(value) ? value : null
}

/**
 * The coverage a host that never wrote an incident may honestly report: zeros, the real limits, and no
 * gap — nothing was ever lost, so `gap` must not fire and the UI must not show a lower-bound badge.
 */
function notCreatedCoverage(): IncidentCoverageDto {
  const limits = DEFAULT_INCIDENT_STORE_LIMITS
  return {
    remoteIncidentCapture: 'unsupported',
    capacityLatchSet: false,
    currentlyLimited: false,
    capacity: { rows: 0, bytes: 0, maxRows: limits.maxRows, maxBytes: limits.maxBytes },
    shadowReplay: {
      lastSeq: 0,
      incomplete: false,
      lastStopReason: null,
      failures: 0,
      lastError: null,
      dropped: 0,
      lastDroppedReason: null,
      lastRun: null
    },
    paneClock: {
      sampledAt: null,
      panes: 0,
      declaredWaits: 0,
      skipped: 0,
      errors: 0,
      lastError: null
    }
  }
}

function notCreatedSnapshot(source: IncidentSourceDto): IncidentSnapshotDto {
  return {
    incidents: [],
    total: 0,
    coverage: notCreatedCoverage(),
    source,
    availability: 'store-not-created'
  }
}

function notCreatedCounts(source: IncidentSourceDto): IncidentCountsDto {
  return {
    untriaged: 0,
    total: 0,
    byClass: {
      crash: 0,
      no_progress: 0,
      tool_error: 0,
      acceptance_failed: 0,
      acceptance_overridden: 0,
      unknown_state: 0
    },
    byWorktree: [],
    coverage: {
      currentlyLimited: false,
      capacityLatchSet: false,
      shadowReplayIncomplete: false,
      shadowReplayDropped: 0,
      remoteIncidentCapture: 'unsupported',
      gap: false
    },
    readAt: Date.now(),
    source,
    availability: 'store-not-created'
  }
}

/**
 * Open the store for reading only.
 *
 * A missing file is `store-not-created` without opening anything; a present file is opened `readOnly`,
 * so a future schema stays an incompatibility instead of a silent migration performed by a viewer.
 * `resolveMainProcessIncidentsDatabaseFile()` returning `null` (no booted runtime) is `unavailable` —
 * a different answer again, never "no incidents".
 */
/**
 * Test seam (house pattern, like `__configureIncidentStoreForTests`): the suites for IPC, counts push and
 * gray views already own a real store pair, and re-resolving userData for each would test the path
 * resolver instead of the projection. Production never calls these.
 */
let testOverride: IncidentReadStore | null = null

export function __configureIncidentReadStoreForTests(handle: IncidentReadStore | null): void {
  testOverride = handle
}

export function __resetIncidentReadStoreForTests(): void {
  testOverride = null
}

export function openIncidentReadStore(): IncidentReadStore {
  if (testOverride !== null) {
    return testOverride
  }
  const path = resolveMainProcessIncidentsDatabaseFile()
  if (path === null) {
    return {
      availability: 'unavailable',
      error: 'The incident store cannot be resolved in this process.'
    }
  }
  let present: boolean
  try {
    present = existsSync(path)
  } catch (error) {
    return { availability: 'unavailable', error: messageOf(error) }
  }
  if (!present) {
    return { availability: 'store-not-created' }
  }
  try {
    const opened = openIncidentsDatabase(path, { readOnly: true })
    return {
      availability: 'supported',
      db: opened.db,
      store: createIncidentStore({
        db: opened.db,
        fileSizeBytes: opened.fileSizeBytes,
        readOnly: true
      }),
      close: () => {
        try {
          opened.db.close()
        } catch {
          // Already closed.
        }
      }
    }
  } catch (error) {
    return { availability: 'unavailable', error: messageOf(error) }
  }
}

export function openIncidentReadService(): IncidentReadService {
  const handle = openIncidentReadStore()
  if (handle.availability === 'unavailable') {
    return unavailableEverywhere(handle.error)
  }
  if (handle.availability === 'store-not-created') {
    return {
      snapshot: (_request, source) => ({ availability: 'supported', value: notCreatedSnapshot(source) }),
      detail: () => ({ availability: 'store-not-created' }),
      counts: (_request, source) => ({ availability: 'supported', value: notCreatedCounts(source) }),
      close: () => undefined
    }
  }

  const { db, store, close } = handle
  return {
    snapshot: (request, source) => {
      try {
        return snapshotOf(store, db, request, source)
      } catch (error) {
        return { availability: 'unavailable', error: messageOf(error) }
      }
    },
    detail: (incidentId, source) => {
      try {
        const view = store.getIncident(incidentId)
        return {
          availability: 'supported',
          value: view === null ? null : incidentDetailFromView(view, source)
        }
      } catch (error) {
        return { availability: 'unavailable', error: messageOf(error) }
      }
    },
    counts: (request, source) => {
      try {
        return countsOf(store, db, request, source)
      } catch (error) {
        return { availability: 'unavailable', error: messageOf(error) }
      }
    },
    close
  }
}

function snapshotOf(
  store: IncidentStore,
  db: Database.Database,
  request: IncidentListRequest | undefined,
  source: IncidentSourceDto
): IncidentReadOutcome<IncidentSnapshotDto> {
  const status = statusFilter(request?.status)
  const incidentClass = classFilter(request?.class)
  if (status === null || incidentClass === null) {
    return { availability: 'unavailable', error: 'Unknown status or class filter.' }
  }
  const result = store.listIncidents({
    ...(request?.limit === undefined ? {} : { limit: request.limit }),
    ...(status === undefined ? {} : { status }),
    ...(incidentClass === undefined ? {} : { class: incidentClass })
  })
  return {
    availability: 'supported',
    value: {
      incidents: result.incidents.map(listItem),
      total: result.total,
      coverage: attachIncidentRemoteMirrorToCoverage(db, result.coverage),
      source,
      availability: 'supported'
    }
  }
}

function countsOf(
  store: IncidentStore,
  db: Database.Database,
  request: IncidentCountsRequest | undefined,
  source: IncidentSourceDto
): IncidentReadOutcome<IncidentCountsDto> {
  const counts = readIncidentCounts({
    db,
    coverage: store.coverage(),
    ...(request?.topWorktrees === undefined ? {} : { topWorktrees: request.topWorktrees })
  })
  return {
    availability: 'supported',
    value: attachIncidentRemoteMirrorToCounts(db, {
      ...counts,
      source,
      availability: 'supported'
    })
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function unavailableEverywhere(error: string): IncidentReadService {
  const fail = <T>(): IncidentReadOutcome<T> => ({ availability: 'unavailable', error })
  return { snapshot: fail, detail: fail, counts: fail, close: () => undefined }
}

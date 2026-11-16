// The incident read model for the renderer (§12, M2 + M7-A).
//
// Read-only snapshot, the aggregate counts the activity-bar badge draws, the one mutating call triage
// needs (`appendDecision`), and the coalesced push that keeps an open renderer's counts fresh. It
// exposes exactly what `orca incident list/show/decide` already does, from the same store, so the two
// cannot drift.
//
// Why reads go through `openIncidentReadService()` (2026-11-16): the IPC read paths used the *creating*
// resolver, so merely opening the panel made `<userData>/incidents/` and migrated the schema on a host
// that had never written an incident. The read service opens read-only and never creates; the write
// path (`decide`) keeps the writer's resolver because it must see the same connection.

import { BrowserWindow, ipcMain } from 'electron'
import { isIncidentStatus } from '../incidents/incident-types'
import {
  incidentRuntimeStoreIfPresent
} from '../incidents/incident-writer'
import type {
  IncidentCountsDto,
  IncidentCountsRequest,
  IncidentDecideFailureDto,
  IncidentDecideRequest,
  IncidentDecideResultDto,
  IncidentDetailDto,
  IncidentDetailRequest,
  IncidentListRequest,
  IncidentSnapshotDto,
  IncidentStatusDto
} from '../../shared/incident-api-types'
import {
  openIncidentReadService,
  type IncidentReadOutcome
} from '../incidents/incident-read-service'
import { startIncidentCountsPush } from './incident-counts-push'
import { readIncidentPaneClocksView, readIncidentToolFailuresView } from './incident-gray-views'

/** The push channel the preload bridge listens on (`incidents.onCountsChanged`). */
export const INCIDENT_COUNTS_CHANGED_CHANNEL = 'incidents:countsChanged'

/** A closed channel result: the renderer renders `ok: false` instead of throwing over IPC. */
export type IncidentIpcResult<T> = { ok: true; value: T } | { ok: false; error: string; code: string }

function unavailable<T>(error?: string): IncidentIpcResult<T> {
  return {
    ok: false,
    code: 'incident_store_unavailable',
    error:
      error ??
      'The incident store is not available on this host yet. It is created by the running Orca runtime.'
  }
}

/**
 * Map one read outcome onto the closed IPC result.
 *
 * `store-not-created` is *not* an error: the read service answers it with a real empty view whose
 * `availability` says why, so the panel can print "this host never recorded an incident" instead of an
 * unavailable banner or — worse — a zero that looks like health.
 */
function fromRead<T>(outcome: IncidentReadOutcome<T>): IncidentIpcResult<T> {
  if (outcome.availability === 'supported') {
    return { ok: true, value: outcome.value }
  }
  if (outcome.availability === 'store-not-created') {
    // Only a detail can land here: the service answers snapshot/counts for a missing store with a real
    // empty view whose `availability` says `store-not-created`.
    return { ok: false, code: 'incident_store_not_created', error: 'No incident store on this host yet.' }
  }
  return unavailable(outcome.error)
}

export function readIncidentSnapshot(
  request: IncidentListRequest | undefined
): IncidentIpcResult<IncidentSnapshotDto> {
  const reader = openIncidentReadService()
  try {
    return fromRead(reader.snapshot(request, { kind: 'local' }))
  } finally {
    reader.close()
  }
}

export function readIncidentDetail(
  request: IncidentDetailRequest
): IncidentIpcResult<IncidentDetailDto> {
  const reader = openIncidentReadService()
  try {
    const outcome = reader.detail(request?.incidentId ?? '', { kind: 'local' })
    if (outcome.availability !== 'supported') {
      return fromRead<IncidentDetailDto>(outcome as IncidentReadOutcome<IncidentDetailDto>)
    }
    if (outcome.value === null) {
      return { ok: false, code: 'not_found', error: `Incident ${request?.incidentId} not found.` }
    }
    return { ok: true, value: outcome.value }
  } finally {
    reader.close()
  }
}

/**
 * Triage from the renderer. Same rules as the CLI: the actor is self-reported, `confirmed` needs an
 * explicit one, and the decision is appended (never an edit).
 */
export function decideIncident(
  request: IncidentDecideRequest
): IncidentIpcResult<IncidentDecideResultDto | IncidentDecideFailureDto> {
  const runtime = incidentRuntimeStoreIfPresent()
  if (runtime === null) {
    return unavailable()
  }
  if (!isIncidentStatus(request?.toStatus)) {
    return { ok: false, code: 'invalid_argument', error: 'Unsupported target status.' }
  }
  const reason = typeof request.reason === 'string' ? request.reason.trim() : ''
  const statedActor = typeof request.actor === 'string' ? request.actor.trim() : ''
  // Same rule as the CLI (§19.1): `confirmed` must name its author, everything else records the
  // honest placeholder rather than an empty string or an invented person.
  if (request.toStatus === 'confirmed' && statedActor.length === 0) {
    return {
      ok: true,
      value: { outcome: 'actor_required', detail: '`confirmed` requires an explicit actor.' }
    }
  }
  const actor = statedActor.length > 0 ? statedActor : 'unspecified'
  const result = runtime.store.appendDecision({
    incidentId: request.incidentId,
    toStatus: request.toStatus,
    actor,
    reason
  })
  if (result.outcome !== 'appended') {
    return {
      ok: true,
      value: { outcome: result.outcome, detail: `Could not record the decision (${result.outcome}).` }
    }
  }
  return {
    ok: true,
    value: {
      outcome: 'appended',
      incidentId: request.incidentId,
      decisionId: result.decisionId ?? '',
      fromStatus: result.fromStatus as IncidentStatusDto,
      toStatus: result.toStatus ?? (request.toStatus as IncidentStatusDto),
      actor
    }
  }
}

/**
 * The activity-bar counts (§12, M7-A).
 *
 * Same closed-result contract as the rest of this surface: an unavailable store is a stated answer, not
 * a thrown bridge. It uses the *creating* resolver like `snapshot`, so an explicit read from the UI
 * behaves the same as a list request — the passive push is the one that must not create the store.
 */
export function readIncidentCountsSnapshot(
  request: IncidentCountsRequest | undefined
): IncidentIpcResult<IncidentCountsDto> {
  const reader = openIncidentReadService()
  try {
    return fromRead(reader.counts(request, { kind: 'local' }))
  } finally {
    reader.close()
  }
}

export function registerIncidentHandlers(): void {
  ipcMain.handle('incidents:snapshot', (_event, request: IncidentListRequest | undefined) =>
    readIncidentSnapshot(request)
  )
  ipcMain.handle('incidents:detail', (_event, request: IncidentDetailRequest) =>
    readIncidentDetail(request)
  )
  ipcMain.handle('incidents:decide', (_event, request: IncidentDecideRequest) =>
    decideIncident(request)
  )
  ipcMain.handle('incidents:counts', (_event, request: IncidentCountsRequest | undefined) =>
    readIncidentCountsSnapshot(request)
  )
  // Why read-only handlers here: the grayscale tables are diagnostics the panel may only look at
  // (§7.2/§7.3). Nothing on this path can write, so offering it over IPC cannot turn a write switch on.
  ipcMain.handle('incidents:paneClocks', () => readIncidentPaneClocksView())
  ipcMain.handle('incidents:toolFailures', () => readIncidentToolFailuresView())
  // Why here: this is the one place the incident surface is attached to the window, so it is the one
  // place the store's change signal has somewhere to go. Idempotent, so a re-registration replaces
  // the subscription instead of doubling every notification.
  startIncidentCountsPush(broadcastIncidentCountsChanged)
}

/**
 * Tell every live window the counts moved.
 *
 * Deliberately not gated on `state.mainWindow`: a dashboard popout or a second window that shows the
 * activity bar must not keep a stale badge because it is not the window this module knows about. A
 * destroyed window is skipped rather than trusted not to throw.
 */
function broadcastIncidentCountsChanged(counts: IncidentCountsDto): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) {
      continue
    }
    window.webContents.send(INCIDENT_COUNTS_CHANGED_CHANNEL, counts)
  }
}

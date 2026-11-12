// The incident read model for the renderer (§12, M2).
//
// Read-only snapshot + the one mutating call triage needs (`appendDecision`). No renderer UI exists
// yet (M7), so this surface is deliberately narrow: it exposes exactly what `orca incident
// list/show/decide` already does, from the same store, so the two cannot drift.
//
// Why the handler opens the store instead of taking one: the incident store is per-host user data
// resolved lazily from the app environment (same as the PTY-exit writer), and the read model must
// see the same connection the writer uses — including its capacity latch.

import { ipcMain } from 'electron'
import {
  isIncidentClass,
  isIncidentStatus,
  type IncidentClass,
  type IncidentStatus,
  type IncidentView
} from '../incidents/incident-types'
import { incidentRuntimeStore } from '../incidents/incident-writer'
import type { IncidentListItem } from '../incidents/incident-store'
import type {
  IncidentClassDto,
  IncidentDecideFailureDto,
  IncidentDecideRequest,
  IncidentDecideResultDto,
  IncidentDetailDto,
  IncidentDetailRequest,
  IncidentListRequest,
  IncidentSnapshotDto,
  IncidentStatusDto
} from '../../shared/incident-api-types'

/** A closed channel result: the renderer renders `ok: false` instead of throwing over IPC. */
export type IncidentIpcResult<T> = { ok: true; value: T } | { ok: false; error: string; code: string }

function unavailable<T>(): IncidentIpcResult<T> {
  return {
    ok: false,
    code: 'incident_store_unavailable',
    error:
      'The incident store is not available on this host yet. It is created by the running Orca runtime.'
  }
}

function listItem(item: IncidentListItem): IncidentSnapshotDto['incidents'][number] {
  return {
    id: item.id,
    class: item.class as IncidentClassDto,
    sourceKind: item.sourceKind,
    facet: item.facet,
    hostId: item.hostId,
    worktreeId: item.worktreeId,
    status: item.status as IncidentStatusDto,
    effectiveStatus: item.effectiveStatus as IncidentStatusDto,
    exitCause: item.exitCause,
    fingerprint: item.fingerprint,
    summary: item.summary,
    createdAt: item.createdAt,
    decisionCount: item.decisionCount
  }
}

export function incidentDetailFromView(view: IncidentView): IncidentDetailDto {
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
    }))
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

export function readIncidentSnapshot(
  request: IncidentListRequest | undefined
): IncidentIpcResult<IncidentSnapshotDto> {
  const runtime = incidentRuntimeStore()
  if (runtime === null) {
    return unavailable()
  }
  const status = statusFilter(request?.status)
  const incidentClass = classFilter(request?.class)
  if (status === null || incidentClass === null) {
    return { ok: false, code: 'invalid_argument', error: 'Unknown status or class filter.' }
  }
  const result = runtime.store.listIncidents({
    ...(request?.limit === undefined ? {} : { limit: request.limit }),
    ...(status === undefined ? {} : { status }),
    ...(incidentClass === undefined ? {} : { class: incidentClass })
  })
  return {
    ok: true,
    value: {
      incidents: result.incidents.map(listItem),
      total: result.total,
      coverage: result.coverage
    }
  }
}

export function readIncidentDetail(
  request: IncidentDetailRequest
): IncidentIpcResult<IncidentDetailDto> {
  const runtime = incidentRuntimeStore()
  if (runtime === null) {
    return unavailable()
  }
  const view = runtime.store.getIncident(request?.incidentId ?? '')
  if (view === null) {
    return { ok: false, code: 'not_found', error: `Incident ${request?.incidentId} not found.` }
  }
  return { ok: true, value: incidentDetailFromView(view) }
}

/**
 * Triage from the renderer. Same rules as the CLI: the actor is self-reported, `confirmed` needs an
 * explicit one, and the decision is appended (never an edit).
 */
export function decideIncident(
  request: IncidentDecideRequest
): IncidentIpcResult<IncidentDecideResultDto | IncidentDecideFailureDto> {
  const runtime = incidentRuntimeStore()
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
}

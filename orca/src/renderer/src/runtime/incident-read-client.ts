// Read incidents from the runtime the panel is actually looking at (A-fix, 2026-11-16).
//
// Before this, the panel took a window bridge with no target: it always read the desktop's own
// `<userData>/incidents/incidents.db`, so a paired Server's rows could not appear even though the CLI on
// that Server printed them. One adapter, one explicit target, no silent fallback to local.
//
// Why local reads stay on the preload bridge and remote reads use runtime RPC (reviewed with codex-ark):
// the bridge is one hop to the host that owns this window, and adding a socket round-trip to the local
// case buys nothing. Both transports land in the same read implementation (`openIncidentReadService`) and
// return the same DTOs, so the panel cannot drift from what a paired client sees.
//
// What is not here on purpose: decide/prune/archive. They mutate a store a person owns on that host and
// stay on the local-only IPC surface (see `useIncidentDecide`); the CLI keeps the same local-only rule.

import type {
  IncidentCountsDto,
  IncidentCountsRequest,
  IncidentDetailDto,
  IncidentListRequest,
  IncidentSnapshotDto,
  IncidentSourceDto
} from '../../../shared/incident-api-types'
import { callRuntimeRpc, hasRuntimeRpcErrorCode } from './runtime-rpc-client'
import type { RuntimeClientTarget } from './runtime-client-target'
import type { IncidentRuntimeTarget } from './incident-runtime-target'

/**
 * The outcome of one read, in the vocabulary the panel renders.
 *
 * `supported` is the only case that may be shown as a list. `unsupported` is a target that does not
 * serve the read (an older host); `unavailable` is a target that does but could not answer right now.
 * Neither is allowed to render as an empty store — that is the whole point of the distinction.
 */
export type IncidentReadOutcome<T> =
  | { availability: 'supported'; value: T }
  | { availability: 'unsupported' }
  | { availability: 'unavailable'; error: string }

/** What the answer is labelled with — the host says `local`, the client re-stamps where it came from. */
export function sourceForTarget(target: RuntimeClientTarget): IncidentSourceDto {
  return target.kind === 'local'
    ? { kind: 'local' }
    : { kind: 'environment', environmentId: target.environmentId }
}

function unavailable(error: unknown): { availability: 'unavailable'; error: string } {
  return {
    availability: 'unavailable',
    error: error instanceof Error ? error.message : String(error)
  }
}

async function readRemote<T>(
  environmentId: string,
  method: string,
  params: unknown
): Promise<IncidentReadOutcome<T>> {
  try {
    return {
      availability: 'supported',
      value: await callRuntimeRpc<T>({ kind: 'environment', environmentId }, method, params)
    }
  } catch (error) {
    // Why this one code is special: a host that predates the method still authenticates and answers,
    // it just has nothing to serve. Telling the reader "not wired on that host" is the honest answer;
    // "no incidents" or a generic failure both lie about what happened.
    if (hasRuntimeRpcErrorCode(error, 'method_not_found')) {
      return { availability: 'unsupported' }
    }
    return unavailable(error)
  }
}

/**
 * The local bridge.
 *
 * Guarded per method, not per object: a window may expose one of these reads and not another (an older
 * preload, or a test double), and requiring `snapshot` to call `counts` would report the counts as
 * unavailable for no reason.
 */
function incidentApi(): NonNullable<Window['api']>['incidents'] | null {
  return window.api?.incidents ?? null
}

function fromBridge<T>(
  result: { ok: true; value: T } | { ok: false; error: string; code: string }
): IncidentReadOutcome<T> {
  if (result.ok) {
    return { availability: 'supported', value: result.value }
  }
  // `incident_store_unavailable` covers "no store yet" on the bridge's older vocabulary; both readings
  // are a stated absence rather than an empty store, and the panel renders them apart from zero rows.
  return { availability: 'unavailable', error: result.error }
}

export async function readIncidentSnapshot(
  target: IncidentRuntimeTarget,
  request: IncidentListRequest
): Promise<IncidentReadOutcome<IncidentSnapshotDto>> {
  if (target.kind === 'unsupported') {
    return { availability: 'unsupported' }
  }
  if (target.kind === 'unavailable') {
    return unavailable('The workspace incident runtime could not be resolved.')
  }
  const outcome =
    target.kind === 'local'
      ? typeof incidentApi()?.snapshot !== 'function'
        ? ({ availability: 'unsupported' } as const)
        : fromBridge(await incidentApi()!.snapshot(request))
      : await readRemote<IncidentSnapshotDto>(target.environmentId, 'incidents.snapshot', request)
  if (outcome.availability !== 'supported') {
    return outcome
  }
  return {
    availability: 'supported',
    value: { ...outcome.value, source: sourceForTarget(target) }
  }
}

export async function readIncidentDetail(
  target: IncidentRuntimeTarget,
  incidentId: string
): Promise<IncidentReadOutcome<IncidentDetailDto>> {
  if (target.kind === 'unsupported') {
    return { availability: 'unsupported' }
  }
  if (target.kind === 'unavailable') {
    return unavailable('The workspace incident runtime could not be resolved.')
  }
  const outcome =
    target.kind === 'local'
      ? typeof incidentApi()?.detail !== 'function'
        ? ({ availability: 'unsupported' } as const)
        : fromBridge(await incidentApi()!.detail({ incidentId }))
      : await readRemote<IncidentDetailDto>(target.environmentId, 'incidents.detail', {
          incidentId
        })
  if (outcome.availability !== 'supported') {
    return outcome
  }
  return {
    availability: 'supported',
    value: { ...outcome.value, source: sourceForTarget(target) }
  }
}

export async function readIncidentCounts(
  target: IncidentRuntimeTarget,
  request?: IncidentCountsRequest
): Promise<IncidentReadOutcome<IncidentCountsDto>> {
  if (target.kind === 'unsupported') {
    return { availability: 'unsupported' }
  }
  if (target.kind === 'unavailable') {
    return unavailable('The workspace incident runtime could not be resolved.')
  }
  const outcome =
    target.kind === 'local'
      ? typeof incidentApi()?.counts !== 'function'
        ? ({ availability: 'unsupported' } as const)
        : fromBridge(
            await (request === undefined ? incidentApi()!.counts() : incidentApi()!.counts(request))
          )
      : await readRemote<IncidentCountsDto>(target.environmentId, 'incidents.counts', request ?? {})
  if (outcome.availability !== 'supported') {
    return outcome
  }
  return {
    availability: 'supported',
    value: { ...outcome.value, source: sourceForTarget(target) }
  }
}

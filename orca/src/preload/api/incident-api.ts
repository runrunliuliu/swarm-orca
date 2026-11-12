// Preload surface for the incident read model (§12, M2).
//
// No renderer UI yet (M7): this exists so the shape is fixed now and the UI milestone cannot invent
// a second one. Every method returns a closed result object instead of throwing across the bridge,
// because a diagnostics surface that throws is a diagnostics surface nobody wraps correctly.

import type {
  IncidentDecideRequest,
  IncidentDecideResultDto,
  IncidentDecideFailureDto,
  IncidentDetailDto,
  IncidentDetailRequest,
  IncidentListRequest,
  IncidentSnapshotDto
} from '../../shared/incident-api-types'

export type IncidentIpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; code: string }

export type IncidentApi = {
  snapshot: (request?: IncidentListRequest) => Promise<IncidentIpcResult<IncidentSnapshotDto>>
  detail: (request: IncidentDetailRequest) => Promise<IncidentIpcResult<IncidentDetailDto>>
  decide: (
    request: IncidentDecideRequest
  ) => Promise<IncidentIpcResult<IncidentDecideResultDto | IncidentDecideFailureDto>>
}

// Preload surface for the incident read model (§12, M2 + M7-A).
//
// Every method returns a closed result object instead of throwing across the bridge, because a
// diagnostics surface that throws is a diagnostics surface nobody wraps correctly. `counts`/
// `onCountsChanged` are the badge pair: one pull for hydration, one push while the store changes, so
// no renderer has to poll.

import type {
  IncidentCountsDto,
  IncidentCountsRequest,
  IncidentDecideRequest,
  IncidentDecideResultDto,
  IncidentDecideFailureDto,
  IncidentDetailDto,
  IncidentDetailRequest,
  IncidentListRequest,
  IncidentSnapshotDto
} from '../../shared/incident-api-types'
import type {
  IncidentStallsViewDto,
  IncidentToolErrorsViewDto
} from '../../shared/incident-gray-types'

export type IncidentIpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; code: string }

export type IncidentApi = {
  snapshot: (request?: IncidentListRequest) => Promise<IncidentIpcResult<IncidentSnapshotDto>>
  detail: (request: IncidentDetailRequest) => Promise<IncidentIpcResult<IncidentDetailDto>>
  decide: (
    request: IncidentDecideRequest
  ) => Promise<IncidentIpcResult<IncidentDecideResultDto | IncidentDecideFailureDto>>
  /** Aggregate untriaged counts plus the coverage that qualifies them (M7-A). */
  counts: (request?: IncidentCountsRequest) => Promise<IncidentIpcResult<IncidentCountsDto>>
  /**
   * Main-process push, already coalesced upstream (one notification per settled burst, not per row).
   * Returns the unsubscribe function, matching the other push bridges.
   */
  onCountsChanged: (callback: (counts: IncidentCountsDto) => void) => () => void
  /**
   * The stall sampler's last pass (§7.2): read-only, and a row marked `wouldWriteIfEnabled` is an
   * observation the host did *not* record. The renderer only formats it.
   */
  stalls: () => Promise<IncidentIpcResult<IncidentStallsViewDto>>
  /**
   * The tool-error windows (§7.3): read-only, with the provider coverage that bounds what silence
   * means, and `written` to tell a recorded incident from an observation.
   */
  toolErrors: () => Promise<IncidentIpcResult<IncidentToolErrorsViewDto>>
}

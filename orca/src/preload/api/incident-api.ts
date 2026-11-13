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
  IncidentPaneClocksViewDto,
  IncidentToolFailuresViewDto
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
   * Pane event clocks (M8-2): read-only facts the host recorded. There is no verdict and no write
   * switch on this surface; whether a pane is stuck is a triage question outside Orca.
   */
  paneClocks: () => Promise<IncidentIpcResult<IncidentPaneClocksViewDto>>
  /**
   * Recorded tool-call failures (M8-3): raw facts plus the provider coverage that bounds what silence
   * means. No window, no normalized code, no write switch.
   */
  toolFailures: () => Promise<IncidentIpcResult<IncidentToolFailuresViewDto>>
}

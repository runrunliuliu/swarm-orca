import type { IncidentCountsDto } from '../../../../shared/incident-api-types'

/** No reading yet, a fresh reading, an expired reading, or a failed read. */
export type IncidentCountsAvailability = 'idle' | 'ok' | 'stale' | 'unavailable'

export type IncidentCountsState = {
  counts: IncidentCountsDto | null
  availability: IncidentCountsAvailability
}

// Tray `all` and the enum members for the filter menus (§12, M7-B).
//
// The lists are declared here rather than derived from a store row set so a filter for a status with
// zero current rows is still offered: "no confirmed incidents yet" is a fact a reader may want to check,
// and a menu built from the page cannot express it.

import { translate } from '@/i18n/i18n'
import type { IncidentClassDto, IncidentStatusDto } from '../../../../../shared/incident-api-types'
import { incidentClassLabel, incidentStatusLabel } from './incident-labels'
import type {
  IncidentClassFilter,
  IncidentStatusFilter,
  IncidentTimeWindowFilter
} from './incident-filter'

/** Untriaged first: it is the default view and the reason the panel exists. */
export const INCIDENT_STATUSES_FOR_FILTER: readonly IncidentStatusDto[] = [
  'untriaged',
  'watch',
  'needs_archive',
  'acceptance_pending',
  'confirmed',
  'duplicate',
  'invalid',
  'closed'
]

export const INCIDENT_CLASSES_FOR_FILTER: readonly IncidentClassDto[] = [
  'crash',
  'no_progress',
  'tool_error',
  'acceptance_failed',
  'acceptance_overridden',
  'unknown_state'
]

export function incidentStatusFilterLabel(value: IncidentStatusFilter): string {
  return value === 'all'
    ? translate('auto.components.right.sidebar.incidents.incident.filter.labels.88a01e1f55', 'all')
    : incidentStatusLabel(value)
}

export function incidentClassFilterLabel(value: IncidentClassFilter): string {
  return value === 'all'
    ? translate('auto.components.right.sidebar.incidents.incident.filter.labels.88a01e1f55', 'all')
    : incidentClassLabel(value)
}

export function incidentTimeWindowLabel(value: IncidentTimeWindowFilter): string {
  switch (value) {
    case '24h':
      return translate('auto.components.right.sidebar.incidents.incident.filter.labels.94e2d8c1e7',
        'last 24h'
      )
    case '7d':
      return translate('auto.components.right.sidebar.incidents.incident.filter.labels.d7489a87e3',
        'last 7 days'
      )
    case 'all':
      return translate('auto.components.right.sidebar.incidents.incident.filter.labels.33389a1415', 'any time')
  }
}

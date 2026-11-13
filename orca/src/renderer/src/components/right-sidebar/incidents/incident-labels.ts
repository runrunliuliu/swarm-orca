// Display labels shared by the incident list and the detail drawer (§12, M7-B).
//
// One module for the vocabulary so the row, the drawer and the gray tables cannot name the same value
// two ways. Every function takes the raw union member the host sent and returns a translated string;
// none of them interprets a status or decides whether a transition is allowed.

import { translate } from '@/i18n/i18n'
import type {
  IncidentClassDto,
  IncidentEvidencePointerDto,
  IncidentStatusDto
} from '../../../../../shared/incident-api-types'
import type { IncidentExitCauseView } from './incident-detail-model'

export function incidentClassLabel(value: IncidentClassDto): string {
  switch (value) {
    case 'crash':
      return translate('auto.components.right.sidebar.incidents.incident.labels.95cb29e6ff', 'crash')
    case 'no_progress':
      return translate('auto.components.right.sidebar.incidents.incident.labels.9e26065e72',
        'no progress'
      )
    case 'tool_error':
      return translate('auto.components.right.sidebar.incidents.incident.labels.c18e9d4934',
        'tool error'
      )
    case 'acceptance_failed':
      return translate('auto.components.right.sidebar.incidents.incident.labels.1c2de4eeea',
        'acceptance failed'
      )
    case 'acceptance_overridden':
      return translate('auto.components.right.sidebar.incidents.incident.labels.32ebafcd75',
        'acceptance overridden'
      )
    case 'unknown_state':
      return translate('auto.components.right.sidebar.incidents.incident.labels.6e1d6d9c27',
        'unknown state'
      )
  }
}

export function incidentStatusLabel(value: IncidentStatusDto): string {
  switch (value) {
    case 'untriaged':
      return translate('auto.components.right.sidebar.incidents.incident.labels.7e1204485a', 'untriaged')
    case 'confirmed':
      return translate('auto.components.right.sidebar.incidents.incident.labels.2d781c4d8a', 'confirmed')
    case 'duplicate':
      return translate('auto.components.right.sidebar.incidents.incident.labels.312459ce33', 'duplicate')
    case 'invalid':
      return translate('auto.components.right.sidebar.incidents.incident.labels.a27eaadeb4', 'invalid')
    case 'watch':
      return translate('auto.components.right.sidebar.incidents.incident.labels.192c62657d', 'watch')
    case 'needs_archive':
      return translate('auto.components.right.sidebar.incidents.incident.labels.0db676284d',
        'needs archive'
      )
    case 'acceptance_pending':
      return translate('auto.components.right.sidebar.incidents.incident.labels.e9455f3651',
        'acceptance pending'
      )
    case 'closed':
      return translate('auto.components.right.sidebar.incidents.incident.labels.e110a854e0', 'closed')
  }
}

/**
 * The exit cause as recorded, including the word `unknown`.
 *
 * The explanation beside `unknown` is the point: a reader must be able to tell "a stop was requested
 * and never confirmed" from "this host cannot report why" without opening the source. The reason code
 * itself is kept visible, because that is what an issue report cites.
 */
export function incidentExitCauseLabel(view: IncidentExitCauseView): string {
  switch (view.kind) {
    case 'signaled':
      return view.signal === null
        ? translate('auto.components.right.sidebar.incidents.incident.labels.5fd2dbde9c',
            'Signaled (signal number not recorded)'
          )
        : translate('auto.components.right.sidebar.incidents.incident.labels.ee5b763093',
            'Signaled (signal {{signal}})',
            { signal: view.signal }
          )
    case 'exited':
      return view.exitCode === null
        ? translate('auto.components.right.sidebar.incidents.incident.labels.830b270e20',
            'Exited (code not recorded)'
          )
        : translate('auto.components.right.sidebar.incidents.incident.labels.3ab739053c',
            'Exited (code {{code}})',
            { code: view.exitCode }
          )
    case 'unknown':
      return translate('auto.components.right.sidebar.incidents.incident.labels.f17f788ce3',
        'Unknown · {{reason}}',
        { reason: unknownReasonLabel(view.reason) }
      )
    case 'operator_close':
      return translate('auto.components.right.sidebar.incidents.incident.labels.461f85bc76',
        'Closed by operator request (not a failure)'
      )
    case 'not_recorded':
      return translate('auto.components.right.sidebar.incidents.incident.labels.4dd665e476',
        'No exit cause was recorded for this row.'
      )
    case 'unrecognised':
      return translate('auto.components.right.sidebar.incidents.incident.labels.a1160fe8b0',
        'Recorded cause is not a known shape: {{raw}}',
        { raw: view.raw }
      )
  }
}

function unknownReasonLabel(reason: string | null): string {
  switch (reason) {
    case 'stop_unverified':
      return translate('auto.components.right.sidebar.incidents.incident.labels.e2be50f0c0',
        'stop_unverified — a stop was requested and no exit was ever observed, so the process may still have been alive'
      )
    case 'host_status_unavailable':
      return translate('auto.components.right.sidebar.incidents.incident.labels.0adc22a6a3',
        'host_status_unavailable — this host cannot report its child process status'
      )
    case 'cause_unreported':
      return translate('auto.components.right.sidebar.incidents.incident.labels.4b0ac37c2b',
        'cause_unreported — the reporting host gave a code but no cause'
      )
    default:
      return reason === null
        ? translate('auto.components.right.sidebar.incidents.incident.labels.e9ebf08d63',
            'the record does not say why'
          )
        : reason
  }
}

export function evidenceKindLabel(kind: IncidentEvidencePointerDto['kind']): string {
  switch (kind) {
    case 'transcript':
      return translate('auto.components.right.sidebar.incidents.incident.labels.9a78c0bf65',
        'transcript'
      )
    case 'status_snapshot':
      return translate('auto.components.right.sidebar.incidents.incident.labels.aeb45b9aa7',
        'status snapshot'
      )
    case 'events':
      return translate('auto.components.right.sidebar.incidents.incident.labels.c699dc1ee3', 'events')
    case 'command_output':
      return translate('auto.components.right.sidebar.incidents.incident.labels.dba10fc054',
        'command output'
      )
    case 'other':
      return translate('auto.components.right.sidebar.incidents.incident.labels.b01725e451', 'other')
  }
}

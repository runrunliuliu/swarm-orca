// `orca incident …` — the command map only (simplify S4).
//
// Every command lives in its own module next to this file: the read/triage loop in
// `incident-basic.ts`, and one module per diagnostic or maintenance surface. Keeping this file to a
// map means adding a command touches one import and one key, and no command's logic sits "in the
// centre" for a different reason than its neighbours.

import type { CommandHandler } from '../dispatch'
import { reportIncident } from './incident-report'
import { stallsIncident, waitIncident } from './incident-stall'
import { toolErrorsIncident } from './incident-tool-errors'
import { digestIncident } from './incident-digest'
import { mineIncident } from './incident-mine'
import {
  acceptanceDeclareIncident,
  acceptanceListIncident,
  acceptanceResolveIncident,
  acceptanceShowIncident
} from './incident-acceptance'
import { INCIDENT_BASIC_HANDLERS } from './incident-basic'

export const INCIDENT_HANDLERS: Record<string, CommandHandler> = {
  ...INCIDENT_BASIC_HANDLERS,

  'incident report': reportIncident,
  'incident wait': waitIncident,
  'incident stalls': stallsIncident,
  'incident tool-errors': toolErrorsIncident,
  'incident digest': digestIncident,
  'incident mine': mineIncident,
  'incident acceptance declare': acceptanceDeclareIncident,
  'incident acceptance list': acceptanceListIncident,
  'incident acceptance show': acceptanceShowIncident,
  'incident acceptance resolve': acceptanceResolveIncident
}

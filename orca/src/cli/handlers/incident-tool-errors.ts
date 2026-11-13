// `orca incident tool-errors`: the read-only grayscale view (issue-sedimentation.md v2.5 §7.3).
//
// The windows live in the host process; this command reads the snapshot that collector publishes into
// meta, and never writes an incident (the switch is the host process's environment, not this one's).

import type { CommandHandler } from '../dispatch'
import { openIncidentStore } from '../incident-store-access'
import {
  readToolErrorWindows,
  toolErrorWriteEnabled
} from '../../main/incidents/incident-tool-error-observer'
import { formatIncidentToolErrors } from '../incident-tool-error-format'
import { printIncidentJson, refuseNonLocalIncidentSelector } from './incident-shared'

export const toolErrorsIncident: CommandHandler = async (ctx) => {
  refuseNonLocalIncidentSelector(ctx, 'orca incident tool-errors')
  const opened = openIncidentStore({ requireExisting: false, readOnly: true })
  try {
    const db = opened.db
    const snapshot =
      db === null ? { updatedAt: null, writeEnabled: false, windows: [] } : readToolErrorWindows(db)
    // The switch is a property of the *host* process; report the live env when this process is the
    // host (serve/orcad) and the published value otherwise. Either way it never enables a write here.
    const writeEnabled = snapshot.writeEnabled || toolErrorWriteEnabled()
    if (ctx.json) {
      printIncidentJson({ ...snapshot, writeEnabled })
      return
    }
    console.log(formatIncidentToolErrors({ ...snapshot, writeEnabled }))
  } finally {
    opened.close()
  }
}

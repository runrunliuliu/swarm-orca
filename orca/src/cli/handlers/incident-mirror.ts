// `orca incident mirror` — the remote mirror's read model (issue-sedimentation.md §11.1, M7-C).
//
// Read-only by construction. The feeds that pull from an origin live in the runtime process that owns
// them, so a CLI invocation cannot sync anything; all it can do — and all an operator needs after a
// failed reconnect — is report what the link rows say. That is the question the M1 read model could
// not answer: "nothing was recorded" vs "nothing is being recorded here".
//
// It reads the incidents database directly (like every other incident command, §12): triage happens
// on a host whose desktop app is not running, which is exactly when a mirror link is down.

import type { CommandHandler } from '../dispatch'
import { openIncidentStore } from '../incident-store-access'
import {
  emptyMirrorCoverage,
  readIncidentMirrorCoverage
} from '../../main/incidents/incident-mirror-store'
import {
  formatIncidentMirrorCoverage,
  formatIncidentMirrorJson
} from '../incident-mirror-format'
import { printIncidentJson, refuseNonLocalIncidentSelector } from './incident-shared'

export const mirrorIncident: CommandHandler = async (ctx) => {
  refuseNonLocalIncidentSelector(ctx, 'orca incident mirror')
  const opened = openIncidentStore({ requireExisting: false, readOnly: true })
  try {
    // No store file means no link rows: `unsupported` is a fact about this client, and it is printed
    // rather than silently rendered as an empty (i.e. healthy-looking) mirror list.
    const coverage = opened.db === null ? emptyMirrorCoverage() : readIncidentMirrorCoverage(opened.db)
    const readAt = Date.now()
    if (ctx.json) {
      printIncidentJson(formatIncidentMirrorJson(coverage, { path: opened.path, readAt }))
      return
    }
    console.log(formatIncidentMirrorCoverage(coverage, { path: opened.path, readAt }))
  } finally {
    opened.close()
  }
}

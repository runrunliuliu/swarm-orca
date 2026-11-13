// `orca incident archive` (M8-4): what happened to the evidence excerpts, and an optional drain.
//
// Without `--drain` this is a read-only report: configured or not, how many pointers are staged,
// pending, archived or incomplete. `--drain` performs the same move the runtime does on its interval —
// it exists for a host whose desktop app is not running, and it never blocks anything.

import type { CommandHandler } from '../dispatch'
import { openIncidentStore } from '../incident-store-access'
import {
  drainEvidenceArchive,
  readEvidenceArchiveState,
  resolveArchiveRoot
} from '../../main/incidents/incident-archive'
import { printIncidentJson, refuseNonLocalIncidentSelector } from './incident-shared'

export const archiveIncident: CommandHandler = async (ctx) => {
  refuseNonLocalIncidentSelector(ctx, 'orca incident archive')
  const drain = ctx.flags.get('drain') === true
  const root = resolveArchiveRoot()
  const opened = openIncidentStore({ requireExisting: false, readOnly: !drain })
  try {
    const db = opened.db
    const drained =
      drain && db !== null
        ? drainEvidenceArchive({ db, root, now: Date.now(), limit: 200 })
        : null
    // Read the state AFTER the drain: the report must describe what is true now, not what was true
    // before this command moved the excerpts.
    const states = db === null ? [] : readEvidenceArchiveState(db)
    const counts = { staged: 0, archive_pending: 0, archived: 0, archive_incomplete: 0 }
    for (const state of states) {
      counts[state.state] += 1
    }
    const payload = {
      configured: root !== null,
      root,
      counts,
      drain: drained,
      rows: states.map((state) => ({
        incidentId: state.incidentId,
        pointerIndex: state.pointerIndex,
        state: state.state,
        archivePath: state.archivePath,
        sha256: state.sha256,
        bytes: state.bytes,
        error: state.error
      }))
    }
    if (ctx.json) {
      printIncidentJson(payload)
      return
    }
    console.log(
      `Evidence archive: ${root === null ? 'NOT CONFIGURED (durable=false; excerpts stay pending)' : root}`
    )
    console.log(
      `State: staged=${counts.staged} pending=${counts.archive_pending} ` +
        `archived=${counts.archived} incomplete=${counts.archive_incomplete}`
    )
    if (drained !== null) {
      console.log(
        `Drain: archived=${drained.archived} incomplete=${drained.incomplete} ` +
          `failed=${drained.failed} remaining=${drained.remaining}`
      )
    }
    if (states.length === 0) {
      console.log(
        'No evidence pointer has been staged on this host. Crash rows carry no transcript pointer by design.'
      )
    }
    for (const state of states) {
      const detail = state.error === null ? '' : `  error=${state.error}`
      console.log(
        `  ${state.incidentId}#${state.pointerIndex}  ${state.state}  ` +
          `${state.archivePath ?? '—'}${detail}`
      )
    }
    if (counts.archive_pending > 0 && root !== null && !drain) {
      console.log('Run `orca incident archive --drain` to move pending excerpts (the runtime also retries).')
    }
  } finally {
    opened.close()
  }
}

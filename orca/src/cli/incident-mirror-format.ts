// Human and JSON rendering for `orca incident mirror` (issue-sedimentation.md §11.1, M7-C).
//
// The command is the operator-visible half of the three-state answer: `incident list` prints one
// coarse value, and this prints the per-origin cursors, the retained unsynced counts and the probe
// errors behind it. Nothing here writes: the CLI is a different process from the runtime that holds
// the feeds, so it can only report what the link rows say.
//
// Formatting lives apart from the handler for the same reason every CLI group does: the handler owns
// store access and error typing, the formatter is a pure function the tests can pin.

import type { MirrorCoverage } from '../main/incidents/incident-mirror-types'
import { isoTimestamp as iso } from './incident-format-shared'

export type MirrorJson = {
  /** The incidents database this reading came from (the link state is per-file, not per-process). */
  path: string
  readAt: number
  mirror: MirrorCoverage
}

export function formatIncidentMirrorJson(coverage: MirrorCoverage, options: {
  path: string
  readAt: number
}): MirrorJson {
  return { path: options.path, readAt: options.readAt, mirror: coverage }
}

function hostLine(host: MirrorCoverage['hosts'][number]): string {
  const unsynced = host.unsynced === null ? 'unknown' : String(host.unsynced)
  const asOf = host.unsyncedAsOf === null ? '' : `@${iso(host.unsyncedAsOf)}`
  return (
    `  ${host.hostId}  ${host.state}  cursor=${host.lastCursor}  unsynced=${unsynced}${asOf}  ` +
    `present=${host.rowsPresent}  inserted=${host.mirroredRows}  duplicate=${host.duplicateRows}  ` +
    `rejected=${host.rejectedRows}  pruned=${host.prunedRows}  dropped=${host.droppedRows}  ` +
    `skipped=${host.skippedRows}` +
    (host.lastSkippedReason === null ? '' : ` (${host.lastSkippedReason})`) +
    (host.lastError === null ? '' : `  last_error=${host.lastError}`)
  )
}

/**
 * The whole read model as text.
 *
 * Three states, three sentences, and no fourth: an operator who sees no rows must be able to tell
 * "nothing is mirrored here" from "a mirror exists and has never been read" from "the mirror is
 * behind right now".
 */
export function formatIncidentMirrorCoverage(
  coverage: MirrorCoverage,
  options: { path: string; readAt: number }
): string {
  const lines: string[] = []
  lines.push(`Incident mirror (${options.path})`)
  lines.push(`  read at: ${iso(options.readAt)}`)
  if (coverage.capture === 'unsupported') {
    lines.push('')
    lines.push('No origin host is registered with this store.')
    lines.push(
      'Remote hosts keep their own incident facts (§11.1); this host mirrors a remote host only when a'
    )
    lines.push(
      'link is registered with it. This is a scope statement about this client — it is NOT evidence'
    )
    lines.push('that no incidents happened on any other host.')
    return lines.join('\n')
  }
  const unsynced = coverage.unsynced === null ? 'unknown' : String(coverage.unsynced)
  const asOf = coverage.unsyncedAsOf === null ? '' : ` (as of ${iso(coverage.unsyncedAsOf)})`
  lines.push('')
  lines.push(
    `Capture: ${coverage.capture}  hosts=${coverage.hosts.length}  unsynced=${unsynced}${asOf}  ` +
      `unreachable=${coverage.unreachable}  rejected=${coverage.rejected}  pruned=${coverage.pruned}  ` +
      `skipped=${coverage.skippedRows}  mirrored_rows=${coverage.mirroredRowsPresent}`
  )
  lines.push('')
  for (const host of coverage.hosts) {
    lines.push(hostLine(host))
  }
  lines.push('')
  if (coverage.capture === 'not_probed') {
    lines.push(
      'WARNING: at least one registered origin has never been read. Its incidents are not in this'
    )
    lines.push(
      'store, and their absence means nothing about that host — treat the local count as unknown for'
    )
    lines.push('that host, not as zero.')
  } else if (coverage.unsynced === null || coverage.unsynced > 0 || coverage.unreachable > 0) {
    lines.push(
      'WARNING: the mirror is behind (see unsynced/unreachable). Rows recorded on those origins since'
    )
    lines.push('the cursor are not in this store yet.')
  }
  if (coverage.rejected > 0) {
    lines.push(
      `${coverage.rejected} mirrored row(s) were refused because this host already owned the fact key:`
    )
    lines.push(
      'one fact is one row, so the local row was kept and the refusal counted (see the per-host reason).'
    )
  }
  if (coverage.skippedRows > 0) {
    lines.push(
      `${coverage.skippedRows} row(s) were not exported by the origin but it declared why; they are`
    )
    lines.push('counted here and never silently skipped (see the per-host reason).')
  }
  if (coverage.provenanceConflicts > 0) {
    lines.push(
      `WARNING: ${coverage.provenanceConflicts} fact key(s) have more than one provenance row. This`
    )
    lines.push(
      'store predates the provenance UNIQUE constraint or was edited outside Orca; mirrored writes for'
    )
    lines.push('those keys stop instead of guessing which provenance row is real.')
  }
  if (coverage.pruned > 0) {
    lines.push(
      `${coverage.pruned} mirrored row(s) had been pruned locally after triage; the mirror did not`
    )
    lines.push('resurrect them (the provenance row acts as a tombstone).')
  }
  return lines.join('\n')
}

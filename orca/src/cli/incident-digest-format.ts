// Formatting for `orca incident tool-errors` and `orca incident digest` (M4).
//
// Both outputs state whether they are a grayscale view (tool errors: nothing written) or a count
// (digest), and both keep the coverage gaps visible: an empty list with an incomplete shadow replay
// must not read as "nothing happened".

import type { IncidentDigest } from '../main/incidents/incident-digest'

function pad(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value.padEnd(width)
}

export function formatIncidentDigest(digest: IncidentDigest): string {
  const window = digest.windowMs >= 86_400_000
    ? `${Math.round(digest.windowMs / 86_400_000)}d`
    : digest.windowMs >= 3_600_000
      ? `${Math.round(digest.windowMs / 3_600_000)}h`
      : `${Math.round(digest.windowMs / 60_000)}m`
  const lines: string[] = []
  lines.push(`Incident digest (last ${window}, since ${new Date(digest.since).toISOString()})`)
  lines.push('')
  lines.push(`Total in window: ${digest.total}    unseen/untriaged: ${digest.unseen}`)
  lines.push('')
  lines.push('By class:')
  if (digest.byClass.length === 0) {
    lines.push('  (none)')
  } else {
    for (const entry of digest.byClass) {
      lines.push(`  ${pad(entry.class, 18)} ${entry.count}`)
    }
  }
  lines.push('')
  lines.push('By status (effective):')
  if (digest.byStatus.length === 0) {
    lines.push('  (none)')
  } else {
    for (const entry of digest.byStatus) {
      lines.push(`  ${pad(entry.status, 18)} ${entry.count}`)
    }
  }
  lines.push('')
  lines.push('Top fingerprints:')
  if (digest.topFingerprints.length === 0) {
    lines.push('  (none)')
  } else {
    for (const entry of digest.topFingerprints) {
      lines.push(`  ${entry.fingerprint.slice(0, 16)}…  ${entry.count}`)
    }
  }
  lines.push('')
  lines.push(
    `Shadow replay: ${digest.shadowReplay.incomplete ? 'INCOMPLETE' : 'complete'}` +
      `${digest.shadowReplay.lastStopReason ? ` (${digest.shadowReplay.lastStopReason})` : ''}` +
      `  last_seq=${digest.shadowReplay.lastSeq}  dropped=${digest.dropped}` +
      `  failures=${digest.shadowReplay.failures}`
  )
  if (digest.shadowReplay.incomplete) {
    lines.push(
      'WARNING: the replay did not finish, so incidents recorded before the crash may be missing from these counts.'
    )
  }
  lines.push(
    `Capacity: rows=${digest.capacity.rows}/${digest.capacity.maxRows}  ` +
      `capacity_latch_set=${String(digest.capacity.capacityLatchSet)}  ` +
      `currently_limited=${String(digest.capacity.currentlyLimited)}`
  )
  lines.push(
    `Tool-error windows: ${digest.toolError.windows} counted, ${digest.toolError.wouldWrite} would write  ` +
      `write=${digest.toolError.writeEnabled ? 'on' : 'off'}`
  )
  return lines.join('\n')
}

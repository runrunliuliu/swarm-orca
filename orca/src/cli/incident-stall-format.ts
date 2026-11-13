// `orca incident stalls` formatting (M3-3/C5).
//
// Separate from incident-format.ts to keep both files inside the max-lines budget, and because the
// grayscale view has its own vocabulary: `wouldWriteIfEnabled`, `ageBasis`, and a disclaimer that a
// yes is not a recorded accident.

import type { IncidentCoverage } from '../main/incidents/incident-types'
import { formatStallSampleNote } from '../main/incidents/incident-stall-coverage'
import { pad } from './incident-format-shared'

/** `orca incident stalls`: the grayscale view. Prints the last sample, never writes. */
export function formatIncidentStalls(
  rows: readonly {
    paneKey: string
    terminalHandle: string | null
    state: string
    ageMs: number
    ageBasis: 'event' | 'state_fallback'
    thresholdMs: number
    wouldWriteIfEnabled: boolean
    reason: string
    declaredWait: string | null
  }[],
  coverage: IncidentCoverage
): string {
  const minutes = (ms: number): string => `${Math.floor(ms / 60_000)}m`
  const lines: string[] = []
  const sampledAt = coverage.stallSample.sampledAt
  lines.push(
    sampledAt === null
      ? 'Stall sample: none yet (the sampler records one per minute while the runtime is up).'
      : `Stall sample: ${new Date(sampledAt).toISOString()} (${coverage.stallSample.panes} pane(s))`
  )
  if (rows.length === 0) {
    lines.push('No panes sampled.')
  } else {
    lines.push(
      `${pad('PANE', 28)} ${pad('STATE', 9)} ${pad('AGE', 8)} ${pad('BASIS', 14)} ` +
        `${pad('THRESHOLD', 10)} ${pad('WOULD-WRITE', 12)} ${pad('REASON', 24)} DECLARED`
    )
    for (const row of rows) {
      lines.push(
        `${pad(row.paneKey, 28)} ${pad(row.state, 9)} ${pad(minutes(row.ageMs), 8)} ` +
          `${pad(row.ageBasis === 'event' ? 'event' : 'state_fallback', 14)} ` +
          `${pad(minutes(row.thresholdMs), 10)} ` +
          `${pad(row.wouldWriteIfEnabled ? 'yes' : 'no', 12)} ` +
          `${pad(row.reason, 24)} ${row.declaredWait ?? '—'}`
      )
    }
  }
  lines.push('')
  lines.push(formatStallSampleNote(coverage.stallSample))
  lines.push(
    'This is a grayscale judgement, not a recorded accident: the default mode writes no incident, ' +
      'and wouldWriteIfEnabled=yes means "a write-enabled sampler would record this now".'
  )
  lines.push(
    `Writing incidents: ${coverage.stallSample.writeEnabled ? 'on' : 'off'} ` +
      '(switch INCIDENT_STALL_WRITE=on in the host process; this command never writes).'
  )
  if (rows.some((row) => row.ageBasis === 'state_fallback')) {
    lines.push(
      'ageBasis=state_fallback: that row never reported a semantic event clock, so its age falls ' +
        'back to stateStartedAt. Treat it as a weaker signal than ageBasis=event.'
    )
  }
  if (coverage.stallSample.errors > 0) {
    lines.push(
      `WARNING: the sampler failed ${coverage.stallSample.errors} time(s); ` +
        `last error: ${coverage.stallSample.lastError ?? 'unknown'}.`
    )
  }
  if (coverage.stallSample.keyRejected > 0) {
    lines.push(
      `WARNING: ${coverage.stallSample.keyRejected} stall write(s) were refused because the pane/epoch ` +
        'could not form an idempotency key.'
    )
  }
  return lines.join('\n')
}


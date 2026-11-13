// `orca incident pane-clocks` formatting (M8-2).
//
// The view used to print a verdict (`wouldWriteIfEnabled`, threshold, reason) and a write switch. Those
// were judgement, and M8 moved them out of Orca. What is printed now is the fact row plus the age
// computed at read time; the disclaimer says plainly that no threshold is applied here.

import type { IncidentCoverage } from '../main/incidents/incident-types'
import type { PaneClockRow } from '../main/incidents/incident-pane-clocks'
import { formatPaneClockNote } from '../main/incidents/incident-pane-clocks'
import { pad } from './incident-format-shared'

export function formatIncidentPaneClocks(
  rows: readonly PaneClockRow[],
  coverage: IncidentCoverage
): string {
  const minutes = (ms: number): string => `${Math.floor(ms / 60_000)}m`
  const lines: string[] = []
  const sampledAt = coverage.paneClock.sampledAt
  lines.push(
    sampledAt === null
      ? 'Pane clock: none yet (the sampler records one fact row per minute while the runtime is up).'
      : `Pane clock: ${new Date(sampledAt).toISOString()} (${coverage.paneClock.panes} pane(s))`
  )
  if (rows.length === 0) {
    lines.push('No panes sampled.')
  } else {
    lines.push(
      `${pad('PANE', 28)} ${pad('STATE', 9)} ${pad('AGE', 8)} ${pad('BASIS', 14)} ` +
        `${pad('OBSERVED', 21)} DECLARED`
    )
    for (const row of rows) {
      lines.push(
        `${pad(row.paneKey, 28)} ${pad(row.state, 9)} ${pad(minutes(row.ageMs), 8)} ` +
          `${pad(row.ageBasis, 14)} ${pad(new Date(row.observedAt).toISOString(), 21)} ` +
          `${row.declaredWait ?? '—'}`
      )
    }
  }
  lines.push('')
  lines.push(formatPaneClockNote(coverage.paneClock))
  lines.push(
    'These are facts, not a verdict: Orca applies no threshold and writes no incident for a quiet ' +
      'pane. Decide whether it is stuck in triage and report it with `orca incident report` if it is.'
  )
  if (rows.some((row) => row.ageBasis === 'state_fallback')) {
    lines.push(
      'ageBasis=state_fallback: that row never reported a semantic event clock, so its age falls ' +
        'back to stateStartedAt. Treat it as a weaker signal than ageBasis=event.'
    )
  }
  if (coverage.paneClock.errors > 0) {
    lines.push(
      `WARNING: the sampler failed ${coverage.paneClock.errors} time(s); ` +
        `last error: ${coverage.paneClock.lastError ?? 'unknown'}.`
    )
  }
  if (coverage.paneClock.skipped > 0) {
    lines.push(
      `WARNING: ${coverage.paneClock.skipped} observation(s) were skipped because the pane epoch was ` +
        'not a finite number. They are counted, not written.'
    )
  }
  return lines.join('\n')
}

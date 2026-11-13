// `orca incident tool-failures` formatting (M8-3).
//
// Facts only: the provider's own `errorKind`/`exitCode`, never a normalized code, a window or a
// severity. The provider coverage block stays, because silence from an uncovered agent must not read
// as "no tool failures".

import type { ToolFailuresSnapshot } from '../main/incidents/incident-tool-failures'
import { TOOL_ERROR_COVERAGE_NOTES } from '../main/incidents/incident-tool-error-coverage'
import { pad } from './incident-format-shared'

export function formatIncidentToolFailures(
  snapshot: ToolFailuresSnapshot,
  providers: { covered: string[]; uncovered: string[] }
): string {
  const iso = (ms: number): string => new Date(ms).toISOString()
  const lines: string[] = []
  lines.push(
    `Tool failures: ${snapshot.rows.length} of ${snapshot.total} row(s) since ${iso(snapshot.since)}` +
      `${snapshot.truncated ? ' (truncated by --limit)' : ''}.`
  )
  if (snapshot.rows.length === 0) {
    lines.push('No failed tool calls recorded in this window.')
  } else {
    lines.push(
      `${pad('OBSERVED', 21)} ${pad('SESSION', 18)} ${pad('TURN', 12)} ${pad('TOOL', 18)} ` +
        `${pad('ERROR-KIND', 18)} EXIT`
    )
    for (const row of snapshot.rows) {
      lines.push(
        `${pad(iso(row.observedAt), 21)} ${pad(row.sessionId, 18)} ${pad(row.turn, 12)} ` +
          `${pad(row.toolName, 18)} ${pad(row.errorKind ?? '—', 18)} ` +
          `${row.exitCode === null ? '—' : String(row.exitCode)}`
      )
    }
  }
  lines.push('')
  lines.push(`Coverage: covered=${providers.covered.join(',')}`)
  lines.push(`Coverage gap: no tool-failure data from ${providers.uncovered.join(', ')}`)
  if (snapshot.dropped > 0) {
    lines.push(
      `WARNING: ${snapshot.dropped} failed call(s) were dropped by the store's cap or an insert ` +
        'failure. A row count is a floor, not a total.'
    )
  }
  for (const note of TOOL_ERROR_COVERAGE_NOTES) {
    lines.push(note)
  }
  return lines.join('\n')
}

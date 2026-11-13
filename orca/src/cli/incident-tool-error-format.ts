// `orca incident tool-errors` formatting (M4-1).
//
// The grayscale view states its own limits: a would-write yes is not a recorded accident, the switch
// lives in the host process, and windowing is in-process so a restart resets the counts.

import type { ToolErrorWindowsSnapshot } from '../main/incidents/incident-tool-error-observer'
import {
  TOOL_ERROR_COVERAGE_NOTES,
  TOOL_ERROR_COVERED_PROVIDERS,
  TOOL_ERROR_UNCOVERED_PROVIDERS,
  TOOL_ERROR_WRITE_PRECONDITION
} from '../main/incidents/incident-tool-error-coverage'

function pad(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value.padEnd(width)
}

function minutes(ms: number): string {
  return `${Math.round(ms / 60_000)}m`
}

export function formatIncidentToolErrors(snapshot: ToolErrorWindowsSnapshot): string {
  const lines: string[] = []
  if (snapshot.updatedAt === null) {
    lines.push('No tool-error window has been observed on this host yet.')
  } else {
    lines.push(
      `Tool-error windows (${snapshot.windows.length}, as of ${new Date(snapshot.updatedAt).toISOString()}):`
    )
    if (snapshot.windows.length > 0) {
      lines.push(
        `${pad('SESSION', 18)} ${pad('TOOL', 22)} ${pad('CODE', 18)} ${pad('COUNT', 6)} ` +
          `${pad('WINDOW', 10)} ${pad('WOULD-WRITE', 12)} SEVERITY`
      )
      for (const window of snapshot.windows) {
        lines.push(
          `${pad(window.sessionId, 18)} ${pad(window.toolName, 22)} ${pad(window.code, 18)} ` +
            `${pad(String(window.count), 6)} ${pad(minutes(window.lastAt - window.windowStart), 10)} ` +
            `${pad(window.wouldWriteIfEnabled ? 'yes' : 'no', 12)} ` +
            `${window.highSeverity ? 'high (single hit)' : 'threshold'}` +
            `${window.written ? ' [written]' : ''}`
        )
      }
    }
  }
  lines.push('')
  if (snapshot.total > snapshot.published) {
    lines.push(
      `Note: showing ${snapshot.published} of ${snapshot.total} windows (payload is capped); ` +
        'the rest are counted but not listed.'
    )
  }
  if (snapshot.evicted > 0) {
    lines.push(
      `WARNING: ${snapshot.evicted} window(s) were dropped by the in-process bound; those counts are lost.`
    )
  }
  lines.push(
    'This is a grayscale view: the default mode writes zero incident ROWS (it does publish this ' +
      'snapshot), and wouldWriteIfEnabled=yes means "a write-enabled collector would record this ' +
      'window now".'
  )
  lines.push(
    `Writing tool_error incidents: ${snapshot.writeEnabled ? 'on' : 'off'} ` +
      '(switch INCIDENT_TOOL_ERROR_WRITE=on in the host process; this command never writes).'
  )
  lines.push(`Coverage: covered=${TOOL_ERROR_COVERED_PROVIDERS.join(',')}`)
  lines.push(
    `Coverage gap: no tool-error data from ${TOOL_ERROR_UNCOVERED_PROVIDERS.join(', ')} ` +
      '(their tool results never reach this collector).'
  )
  for (const note of TOOL_ERROR_COVERAGE_NOTES) {
    lines.push(`Coverage note: ${note}`)
  }
  lines.push(TOOL_ERROR_WRITE_PRECONDITION)
  lines.push(
    'Windowing is in-process and per turn: a restart resets the counts, and a new turn starts a new ' +
      'window.'
  )
  return lines.join('\n')
}


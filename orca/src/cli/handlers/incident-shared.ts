// Small helpers shared by the incident CLI handlers (list/show/decide/report/prune).
//
// Separate file only because the command modules are already close to the max-lines budget; the
// helpers themselves are the ones the M1 handlers had inline.

import type { HandlerContext } from '../dispatch'
import { RuntimeClientError } from '../runtime/types'
import { rejectRemoteSelectionFlags } from '../remote-selection-flag-rejection'
import { isIncidentClass, type IncidentClass } from '../../main/incidents/incident-types'

/** Records exist only on the host that wrote them (§11.1): refuse rather than answer for another. */
export function refuseNonLocalIncidentSelector(ctx: HandlerContext, command: string): void {
  rejectRemoteSelectionFlags(
    ctx.flags,
    `\`${command}\`. Incidents are recorded by the host that owns the PTY; run the command there.`
  )
  if (ctx.flags.has('host')) {
    throw new RuntimeClientError(
      'invalid_argument',
      `\`--host\` does not retarget \`${command}\`. Incident records exist only on the host that ` +
        'wrote them (remote capture is unsupported).'
    )
  }
}

export function stringFlag(ctx: HandlerContext, name: string): string | null {
  const value = ctx.flags.get(name)
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

/**
 * Self-report accepts only the classes a reporter can honestly claim.
 *
 * `acceptance_overridden` is written by the maintenance path with its own evidence (actor, reason,
 * skipped rules); letting `incident report --class acceptance_overridden` mint one would turn the
 * audit trail into something anyone can forge with one flag.
 */
const SELF_REPORT_CLASSES: readonly IncidentClass[] = [
  'crash',
  'no_progress',
  'tool_error',
  'acceptance_failed',
  'unknown_state'
]

export function parseIncidentClass(value: string): IncidentClass {
  if (!isIncidentClass(value) || !SELF_REPORT_CLASSES.includes(value)) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Unsupported --class "${value}". One of: ${SELF_REPORT_CLASSES.join(', ')}.`
    )
  }
  return value
}

export function printIncidentJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2))
}

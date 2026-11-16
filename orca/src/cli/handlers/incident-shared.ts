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
 * One integer-flag parser for every incident command (C4/C5).
 *
 * Five handlers had each grown a copy of this, and two of them had drifted: `--limit 0` was accepted
 * by `list` and refused by `export`. The minimum therefore stays explicit at the call site, because
 * it is that command's documented contract and not a property of the flag name; `'any'` is for
 * `--expect-exit`, where a negative number is a recorded exit code rather than a count.
 *
 * `Number.isSafeInteger`, not `isInteger`: a flag beyond 2^53 has already lost precision by the time
 * it reaches here, and accepting it would mean silently acting on a different number.
 */
export function intFlag(
  ctx: HandlerContext,
  name: string,
  options: { min?: number | 'any' } = {}
): number | null {
  const raw = stringFlag(ctx, name)
  if (raw === null) {
    return null
  }
  const min = options.min ?? 0
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || (min !== 'any' && parsed < min)) {
    const bound =
      min === 'any' ? 'an integer' : min > 0 ? 'a positive integer' : 'a non-negative integer'
    throw new RuntimeClientError('invalid_argument', `\`--${name}\` must be ${bound}.`)
  }
  return parsed
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

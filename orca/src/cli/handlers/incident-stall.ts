// `orca incident wait` and `orca incident stalls` (issue-sedimentation.md v2.4 §7.2, M3-1/M3-3).
//
// Both read the sampler's last sample from the incidents database, because the CLI is a different
// process from the runtime that holds the hook server's rows. `stalls` prints that sample as-is and
// never writes; `wait` needs the sample only to find the pane's epoch, which is what makes the
// declaration survive a respawn incorrectly — it cannot, by construction.
//
// Neither command writes an incident. The grayscale switch (`INCIDENT_STALL_WRITE`) lives in the
// runtime's sampler, so a CLI invocation can never turn the writer on.

import type { CommandHandler, HandlerContext } from '../dispatch'
import { RuntimeClientError } from '../runtime/types'
import { openIncidentStore } from '../incident-store-access'
import {
  WaitDeclarationError,
  clearWait,
  declareWait,
  listActiveWaits
} from '../../main/incidents/incident-wait'
import { readStallSamples } from '../../main/incidents/incident-stall-samples'
import { formatIncidentStalls } from '../incident-format'
import {
  printIncidentJson,
  refuseNonLocalIncidentSelector,
  stringFlag
} from './incident-shared'

/** RFC3339 → epoch ms, rejecting a deadline in the past (a dead-on-arrival promise is noise). */
export function parseUntilFlag(value: string, now: number): number {
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) {
    throw new RuntimeClientError(
      'invalid_argument',
      `--until must be an RFC3339 timestamp (e.g. 2026-11-13T18:00:00Z), got "${value}".`
    )
  }
  if (parsed <= now) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--until is in the past; a declaration that is already expired would not suppress anything.'
    )
  }
  return parsed
}

function requireTerminal(ctx: HandlerContext): string {
  const terminal = stringFlag(ctx, 'terminal')
  if (terminal === null) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Missing --terminal <handle>. Use the terminal handle or the pane key from `orca incident stalls`.'
    )
  }
  return terminal
}

/**
 * Resolve the pane from the last sample. Refusing when the pane is unknown is deliberate: the
 * declaration must bind to an observed epoch, and guessing one is exactly what M3-1 forbids.
 */
function resolveSampledPane(
  samples: ReturnType<typeof readStallSamples>,
  terminal: string
): ReturnType<typeof readStallSamples>[number] {
  const match =
    samples.find((sample) => sample.terminalHandle === terminal) ??
    samples.find((sample) => sample.paneKey === terminal)
  if (!match) {
    throw new RuntimeClientError(
      'invalid_argument',
      `No observed state for "${terminal}". The stall sampler records one sample per minute; run ` +
        '`orca incident stalls` to see which panes it has seen.'
    )
  }
  return match
}

export const waitIncident: CommandHandler = async (ctx) => {
  refuseNonLocalIncidentSelector(ctx, 'orca incident wait')
  const terminal = requireTerminal(ctx)
  const clear = ctx.flags.get('clear') === true
  const opened = openIncidentStore({ requireExisting: true, readOnly: false })
  try {
    const db = opened.db
    if (db === null) {
      throw new RuntimeClientError('invalid_argument', 'No incident store on this host yet.')
    }
    const samples = readStallSamples(db)
    const pane = resolveSampledPane(samples, terminal)
    if (clear) {
      const removed = clearWait(db, { paneKey: pane.paneKey })
      const payload = { action: 'cleared' as const, paneKey: pane.paneKey, removed }
      if (ctx.json) {
        printIncidentJson(payload)
        return
      }
      console.log(
        removed > 0
          ? `Cleared ${removed} wait declaration(s) for ${pane.paneKey}.`
          : `No wait declaration for ${pane.paneKey}.`
      )
      return
    }

    const reason = stringFlag(ctx, 'reason')
    if (reason === null) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Missing --reason <text>. A declaration says why the pane is expected to be quiet.'
      )
    }
    const untilFlag = stringFlag(ctx, 'until')
    const now = Date.now()
    const actor = stringFlag(ctx, 'actor') ?? 'unspecified'
    let declaration
    try {
      declaration = declareWait(db, {
        paneKey: pane.paneKey,
        epoch: String(pane.stateStartedAt),
        reason,
        actor,
        expiresAt: untilFlag === null ? null : parseUntilFlag(untilFlag, now),
        now
      })
    } catch (error) {
      if (error instanceof WaitDeclarationError) {
        throw new RuntimeClientError('invalid_argument', `Invalid wait declaration (${error.reason}).`)
      }
      throw error
    }
    const payload = {
      action: 'declared' as const,
      paneKey: declaration.paneKey,
      epoch: declaration.epoch,
      reason: declaration.reason,
      actor: declaration.actor,
      expiresAt: declaration.expiresAt
    }
    if (ctx.json) {
      printIncidentJson(payload)
      return
    }
    console.log(
      `Declared wait for ${declaration.paneKey} (epoch ${declaration.epoch}): "${declaration.reason}"` +
        `${declaration.expiresAt === null ? ' (no deadline)' : ` until ${new Date(declaration.expiresAt).toISOString()}`}` +
        ` — actor=${declaration.actor} (self-reported). Stalls are suppressed while it applies.`
    )
  } finally {
    opened.close()
  }
}

export const stallsIncident: CommandHandler = async (ctx) => {
  refuseNonLocalIncidentSelector(ctx, 'orca incident stalls')
  const opened = openIncidentStore({ requireExisting: false, readOnly: true })
  try {
    const db = opened.db
    const rows = db === null ? [] : readStallSamples(db)
    const declarations = db === null ? [] : listActiveWaits(db, { now: Date.now() })
    if (ctx.json) {
      printIncidentJson({
        coverage: opened.store.coverage(),
        declarations,
        rows
      })
      return
    }
    console.log(formatIncidentStalls(rows, opened.store.coverage()))
  } finally {
    opened.close()
  }
}

// `orca incident wait` and `orca incident pane-clocks` (issue-sedimentation m8-subtraction.md §4).
//
// Both read the pane-clock facts from the incidents database, because the CLI is a different process
// from the runtime that holds the hook server's rows. `pane-clocks` prints those facts as-is and
// never writes; `wait` needs a row only to find the pane's epoch, which is what makes a declaration
// survive a respawn incorrectly — it cannot, by construction.
//
// Neither command writes an incident, and neither applies a threshold: a declared wait is context a
// triage reads, not a suppressor of an in-process judgement (M8-2 removed that judgement).

import type { CommandHandler, HandlerContext } from '../dispatch'
import { RuntimeClientError } from '../runtime/types'
import { openIncidentStore } from '../incident-store-access'
import {
  WaitDeclarationError,
  clearWait,
  declareWait,
  listActiveWaits
} from '../../main/incidents/incident-wait'
import { readPaneClocks, type PaneClockRow } from '../../main/incidents/incident-pane-clocks'
import { formatIncidentPaneClocks } from '../incident-stall-format'
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
      'Missing --terminal <handle>. Use the terminal handle or the pane key from `orca incident pane-clocks`.'
    )
  }
  return terminal
}

/**
 * Resolve the pane from the last sample. Refusing when the pane is unknown is deliberate: the
 * declaration must bind to an observed epoch, and guessing one is exactly what M3-1 forbids.
 */
function resolveSampledPane(
  samples: readonly PaneClockRow[],
  terminal: string
): PaneClockRow {
  const match =
    samples.find((sample) => sample.terminalHandle === terminal) ??
    samples.find((sample) => sample.paneKey === terminal)
  if (!match) {
    throw new RuntimeClientError(
      'invalid_argument',
      `No observed state for "${terminal}". The stall sampler records one sample per minute; run ` +
        '`orca incident pane-clocks` to see which panes it has seen.'
    )
  }
  return match
}

export const waitIncident: CommandHandler = async (ctx) => {
  refuseNonLocalIncidentSelector(ctx, 'orca incident wait')
  const terminal = requireTerminal(ctx)
  const clear = ctx.flags.get('clear') === true
  if (clear) {
    // `--clear` removes every epoch of the pane; mixing it with declaration fields is always a
    // mistake, and silently ignoring them would leave the caller believing a wait was declared.
    const conflicting = ['reason', 'until', 'actor'].filter((name) => ctx.flags.has(name))
    if (conflicting.length > 0) {
      throw new RuntimeClientError(
        'invalid_argument',
        `--clear cannot be combined with ${conflicting.map((name) => `--${name}`).join(', ')}. ` +
          'Run it alone to remove the whole pane\'s declarations.'
      )
    }
  }
  const opened = openIncidentStore({ requireExisting: true, readOnly: false })
  try {
    const db = opened.db
    if (db === null) {
      throw new RuntimeClientError('invalid_argument', 'No incident store on this host yet.')
    }
    const samples = readPaneClocks(db, Date.now())
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
        ` — actor=${declaration.actor} (self-reported). Triage sees this declaration as context.`
    )
  } finally {
    opened.close()
  }
}

export const paneClocksIncident: CommandHandler = async (ctx) => {
  refuseNonLocalIncidentSelector(ctx, 'orca incident pane-clocks')
  const opened = openIncidentStore({ requireExisting: false, readOnly: true })
  try {
    const db = opened.db
    const rows = db === null ? [] : readPaneClocks(db, Date.now())
    const declarations = db === null ? [] : listActiveWaits(db, { now: Date.now() })
    if (ctx.json) {
      printIncidentJson({
        coverage: opened.store.coverage(),
        declarations,
        rows
      })
      return
    }
    console.log(formatIncidentPaneClocks(rows, opened.store.coverage()))
  } finally {
    opened.close()
  }
}

// `orca incident export` (M8-1): the read-only NDJSON stream an agent-side triage skill consumes.
//
// Deliberately thin. Everything that used to be here — clustering, thresholds, candidate rules and
// the digest aggregates — was judgement and now lives outside Orca (m8-subtraction.md §4). This file
// only validates flags, opens the store read-only and serializes `readIncidentExport`.

import type { HandlerContext } from '../dispatch'
import { RuntimeClientError } from '../runtime/types'
import { openIncidentStore } from '../incident-store-access'
import {
  DEFAULT_EXPORT_WINDOW_MS,
  INCIDENT_EXPORT_VERSION,
  INCIDENT_EXPORT_VIEW,
  clampExportLimit,
  parseExportWindow,
  readIncidentExport,
  type IncidentExport
} from '../../main/incidents/incident-export'
import { refuseNonLocalIncidentSelector, stringFlag } from './incident-shared'

function intFlag(ctx: HandlerContext, name: string): number | null {
  const raw = stringFlag(ctx, name)
  if (raw === null) {
    return null
  }
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new RuntimeClientError('invalid_argument', `\`--${name}\` must be a positive integer.`)
  }
  return parsed
}

function emptyExport(coverage: IncidentExport['coverage'], windowMs: number): IncidentExport {
  const now = Date.now()
  return { rows: [], truncated: false, total: 0, since: now - windowMs, windowMs, coverage }
}

export async function exportIncident(ctx: HandlerContext): Promise<void> {
  refuseNonLocalIncidentSelector(ctx, 'orca incident export')

  const sinceRaw = stringFlag(ctx, 'since')
  const windowMs = sinceRaw === null ? undefined : parseExportWindow(sinceRaw)
  if (sinceRaw !== null && windowMs === null) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Unsupported --since "${sinceRaw}". Use a duration such as 24h, 7d or 90m.`
    )
  }
  const limitRaw = intFlag(ctx, 'limit')

  const opened = openIncidentStore({ requireExisting: false, readOnly: true })
  try {
    const coverage = opened.store.coverage()
    const result =
      opened.db === null
        ? emptyExport(coverage, windowMs ?? DEFAULT_EXPORT_WINDOW_MS)
        : readIncidentExport(opened.db, {
            now: Date.now(),
            ...(windowMs === undefined ? {} : { windowMs }),
            ...(limitRaw === null ? {} : { limit: clampExportLimit(limitRaw) }),
            coverage
          })

    if (!ctx.json) {
      console.log(
        `Export: ${result.rows.length} of ${result.total} incident(s) in the window` +
          `${result.truncated ? ' (truncated by --limit)' : ''}. ` +
          'Pass --json for the NDJSON stream.'
      )
      console.log(formatCoverageNote(result.coverage))
      return
    }

    console.log(
      JSON.stringify({
        kind: 'meta',
        view: INCIDENT_EXPORT_VIEW,
        exportVersion: INCIDENT_EXPORT_VERSION,
        since: result.since,
        windowMs: result.windowMs,
        generatedAt: Date.now(),
        coverage: result.coverage
      })
    )
    for (const row of result.rows) {
      console.log(JSON.stringify({ kind: 'incident', ...row }))
    }
    console.log(
      JSON.stringify({
        kind: 'end',
        counts: { incident: result.rows.length },
        total: { incident: result.total },
        truncated: { incident: result.truncated }
      })
    )
  } finally {
    opened.close()
  }
}

/** Exported for the formatter test: the one coverage line must survive every output mode. */
export function formatCoverageNote(coverage: IncidentExport['coverage']): string {
  const shadow = coverage.shadowReplay
  return (
    `Coverage: remote_incident_capture=${coverage.remoteIncidentCapture}  ` +
    `capacity_latch_set=${coverage.capacityLatchSet}  currently_limited=${coverage.currentlyLimited}  ` +
    `shadow: lastSeq=${shadow.lastSeq} incomplete=${shadow.incomplete}` +
    `${shadow.dropped > 0 ? ` dropped=${shadow.dropped}` : ''}`
  )
}

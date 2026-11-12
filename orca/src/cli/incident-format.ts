// Human-readable rendering for `orca incident …` (issue-sedimentation.md v2.2 §12).
//
// Formatting lives apart from the handler for the same reason every other group does it: the
// handler owns store access and error typing, the formatter is a pure function the tests can pin.
//
// The coverage footer is not decoration. §11.1 makes "no incident" and "no capture" different
// answers, and an operator who reads an empty list must see which one they got.

import type {
  IncidentCoverage,
  IncidentDecision,
  IncidentStatus,
  IncidentView
} from '../main/incidents/incident-types'
import { formatStallSampleNote } from '../main/incidents/incident-stall-coverage'

// Re-exported so callers (and the CLI handler) keep one import site for incident formatting.
export { formatIncidentStalls } from './incident-stall-format'
import type {
  IncidentListResult,
  PruneResult
} from '../main/incidents/incident-store'

function iso(ms: number | null): string {
  return ms === null ? '—' : new Date(ms).toISOString()
}

function formatShadowReplay(coverage: IncidentCoverage): string {
  const replay = coverage.shadowReplay
  const state = replay.incomplete
    ? `INCOMPLETE${replay.lastStopReason ? ` (${replay.lastStopReason})` : ''}`
    : 'complete'
  const lastRun = replay.lastRun
  const run = lastRun ? `  last_run=${lastRun.lines}lines/${lastRun.bytes}B/${lastRun.ms}ms` : ''
  return (
    `Shadow replay: ${state}  last_seq=${replay.lastSeq}  dropped=${replay.dropped}  ` +
    `failures=${replay.failures}${run}`
  )
}

function bytes(value: number): string {
  if (value < 1024) {
    return `${value}B`
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)}KB`
  }
  if (value < 1024 * 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(1)}MB`
  }
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)}GB`
}

function exitCauseLabel(cause: unknown): string {
  if (typeof cause !== 'object' || cause === null || !('kind' in cause)) {
    return '—'
  }
  const typed = cause as { kind: string; signal?: number; exitCode?: number; reason?: string }
  switch (typed.kind) {
    case 'operator_close':
      return 'operator_close'
    case 'signaled':
      return `signaled(${typed.signal ?? '?'})`
    case 'exited':
      return `exited(${typed.exitCode ?? '?'})`
    case 'unknown':
      return `unknown(${typed.reason ?? '?'})`
    default:
      return typed.kind
  }
}

function pad(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value.padEnd(width)
}

/** The coverage line every list/show prints (§11.1, §12). */
export function formatIncidentCoverage(coverage: IncidentCoverage): string {
  return (
    `Coverage: remote_incident_capture=${coverage.remoteIncidentCapture}  ` +
    `capacity_latch_set=${String(coverage.capacityLatchSet)}  ` +
    `currently_limited=${String(coverage.currentlyLimited)}  ` +
    `rows=${coverage.capacity.rows}/${coverage.capacity.maxRows}  ` +
    `bytes=${bytes(coverage.capacity.bytes)}/${bytes(coverage.capacity.maxBytes)}`
  )
}

/**
 * The capacity warning, split by tense.
 *
 * `capacityLatchSet` means this store refused a write at some point — which stays true after a prune
 * brings the row count back down. Printing that as "writes are being refused" made an already
 * recovered store look broken, so only `currentlyLimited` may use the present tense; the latch is
 * reported as history plus how to clear it.
 */
export function formatIncidentCapacityWarning(coverage: IncidentCoverage): string | null {
  if (coverage.currentlyLimited) {
    return (
      'Capacity limit reached: new non-crash incidents are being refused right now (crash rows are ' +
      'still written). Triage and `orca incident prune --apply` to free space.'
    )
  }
  if (coverage.capacityLatchSet) {
    return (
      'This store has refused writes before (capacity latch set); it is accepting them again now ' +
      `(${coverage.capacity.rows}/${coverage.capacity.maxRows} rows).`
    )
  }
  return null
}

export function formatIncidentList(result: IncidentListResult): string {
  const lines: string[] = []
  if (result.incidents.length === 0) {
    lines.push('No incidents recorded on this host.')
  } else {
    lines.push(
      `Incidents (${result.incidents.length} shown / ${result.total} total, this host only):`
    )
    lines.push(
      `${pad('ID', 30)} ${pad('CLASS', 15)} ${pad('STATUS', 12)} ${pad('CREATED', 21)} ${pad('CAUSE', 26)} WORKTREE`
    )
    for (const incident of result.incidents) {
      lines.push(
        `${pad(incident.id, 30)} ${pad(incident.class, 15)} ${pad(incident.effectiveStatus, 12)} ` +
          `${pad(iso(incident.createdAt), 21)} ${pad(exitCauseLabel(incident.exitCause), 26)} ` +
          `${incident.worktreeId ?? '—'}`
      )
      if (incident.summary.length > 0) {
        lines.push(`  ${incident.summary}`)
      }
    }
  }
  lines.push('')
  lines.push(formatIncidentCoverage(result.coverage))
  lines.push(formatShadowReplay(result.coverage))
  lines.push(formatStallSampleNote(result.coverage.stallSample))
  if (result.coverage.shadowReplay.incomplete) {
    // Why spelled out: an empty list plus an unfinished replay is the one combination an operator
    // must not read as "no incidents".
    lines.push(
      'WARNING: the shadow replay did not finish, so incidents recorded before the crash may be missing from this list.'
    )
    if (result.coverage.shadowReplay.lastError) {
      lines.push(`  last replay error: ${result.coverage.shadowReplay.lastError}`)
    }
  }
  if (result.coverage.shadowReplay.dropped > 0) {
    lines.push(
      `WARNING: ${result.coverage.shadowReplay.dropped} replayed line(s) were dropped by the capacity gate and are not in this list.`
    )
  }
  const warning = formatIncidentCapacityWarning(result.coverage)
  if (warning !== null) {
    lines.push(warning)
  }
  return lines.join('\n')
}

function decisionLine(decision: IncidentDecision): string {
  return (
    `- ${iso(decision.createdAt)}  ${decision.fromStatus} → ${decision.toStatus}  ` +
    `actor=${decision.actor}  reason=${decision.reason}`
  )
}

export function formatIncidentShow(
  view: IncidentView,
  options: { coverage?: IncidentCoverage } = {}
): string {
  const lines: string[] = []
  lines.push(`${view.id}  ${view.class}  ${view.effectiveStatus}`)
  if (view.decisionCount > 0) {
    lines.push(`  entry status: ${view.status} (${view.decisionCount} decision(s))`)
  }
  lines.push(`  created: ${iso(view.createdAt)}`)
  lines.push(`  host: ${view.hostId}`)
  lines.push(`  source: ${view.sourceKind}/${view.sourceId} facet=${view.facet}`)
  lines.push(`  fingerprint: ${view.fingerprint}`)
  lines.push(`  worktree: ${view.worktreeId ?? '—'}`)
  lines.push(
    `  run/task/dispatch: ${view.runId ?? '—'} / ${view.taskId ?? '—'} / ${view.dispatchId ?? '—'}`
  )
  lines.push(`  pty incarnation: ${view.ptyIncarnationId ?? '—'}`)
  lines.push(`  exit cause: ${exitCauseLabel(view.exitCause)}`)
  lines.push('')
  lines.push('Summary:')
  lines.push(`  ${view.summary.length > 0 ? view.summary : '—'}`)
  lines.push('')
  lines.push('Unknown boundaries:')
  if (view.evidence.unknownBoundaries.length === 0) {
    lines.push('  (none recorded — itself a gap)')
  } else {
    for (const boundary of view.evidence.unknownBoundaries) {
      lines.push(`  - ${boundary}`)
    }
  }
  lines.push('')
  lines.push('Evidence (pointers, durable=false):')
  if (view.evidence.pointers.length === 0) {
    lines.push('  (none collected)')
  } else {
    for (const pointer of view.evidence.pointers) {
      const offsets =
        pointer.startOffset === undefined
          ? ''
          : ` [${pointer.startOffset}..${pointer.endOffset ?? '?'}]`
      lines.push(`  - ${pointer.kind}: ${pointer.path}${offsets}${pointer.sha256 ? ` sha256=${pointer.sha256}` : ''}`)
    }
  }
  lines.push('')
  lines.push('Decisions:')
  if (view.decisions.length === 0) {
    lines.push('  (none — status is the entry status)')
  } else {
    for (const decision of view.decisions) {
      lines.push(`  ${decisionLine(decision)}`)
    }
  }
  if (options.coverage) {
    lines.push('')
    lines.push(formatIncidentCoverage(options.coverage))
  }
  return lines.join('\n')
}

export function formatIncidentDecision(input: {
  incidentId: string
  decisionId: string
  fromStatus: IncidentStatus
  toStatus: IncidentStatus
  actor: string
}): string {
  return `${input.incidentId}: ${input.fromStatus} → ${input.toStatus} (actor=${input.actor}, decision=${input.decisionId})`
}

/** One-line confirmation for `incident report`, naming the rank the record starts at. */
export function formatIncidentReport(result: {
  incidentId: string | null
  outcome: 'inserted' | 'duplicate'
  class: string
  code: string
  shadow: 'written' | 'failed' | 'skipped'
}): string {
  const head =
    result.outcome === 'duplicate'
      ? `Already recorded: ${result.incidentId ?? '(unknown id)'} — same --source-id, existing record ` +
        'kept and NOT overwritten (incident rows are immutable)'
      : `Reported: ${result.incidentId ?? '(unknown id)'}`
  const shadow =
    result.shadow === 'written'
      ? 'shadow hint written'
      : result.shadow === 'failed'
        ? 'shadow hint NOT written (replay will not cover this row)'
        : 'shadow skipped'
  return (
    `${head} (class=${result.class}, code=${result.code}, status=untriaged; ` +
    `self-report is not independently verified; ${shadow})`
  )
}

export function formatIncidentPrune(result: PruneResult): string {
  const counts = Object.entries(result.byStatus)
    .map(([status, count]) => `${status}=${count}`)
    .join(' ')
  const ids = `${result.candidateIds.length} id(s)${
    result.candidateIdsTruncated ? ' (truncated)' : ''
  } in --json`
  if (result.dryRun) {
    return (
      `Prune (dry run): ${result.candidates} candidate(s) older than ${result.olderThanDays} days` +
      `${counts ? ` (${counts})` : ''}; ${ids}. Nothing was deleted. Re-run with --apply to delete.`
    )
  }
  return (
    `Prune: deleted ${result.deleted} of ${result.candidates} candidate(s) older than ` +
    `${result.olderThanDays} days${counts ? ` (${counts})` : ''} (${ids}). Decision rows were retained.`
  )
}

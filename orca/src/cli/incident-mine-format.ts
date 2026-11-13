// Formatting for `orca incident mine` (issue-sedimentation.md v2.7 §10, M6-1/M6-3).
//
// The reader's question is "what should I open, and why is it here". So every cluster prints the rule
// that promoted it, its counts, and the span it covers; every cap that fired is printed next to the
// number it truncated.

import type { IncidentMine, MineCluster } from '../main/incidents/incident-mine'
import { formatDigestCoverage, formatWindowLabel } from './incident-digest-format'

function pad(value: string, width: number): string {
  return value.length >= width ? value.slice(0, width) : value.padEnd(width)
}

function iso(value: number): string {
  return new Date(value).toISOString()
}

function classSummary(cluster: MineCluster): string {
  return cluster.byClass.map((entry) => `${entry.value}:${entry.count}`).join(',')
}

export function formatIncidentMine(mine: IncidentMine): string {
  const lines: string[] = []
  const mode = mine.apply ? `APPLY (target ${mine.target})` : 'dry-run (no writes)'
  lines.push(
    `Incident mine (last ${formatWindowLabel(mine.windowMs)}, since ${iso(mine.since)}) — ${mode}`
  )
  lines.push('')
  lines.push(
    `Rows in window: ${mine.totals.rowsInWindow}` +
      `    clusters: ${mine.totals.clusters}` +
      `    candidate clusters: ${mine.totals.candidateClusters}` +
      `    untriaged candidates: ${mine.totals.candidates}`
  )
  lines.push(
    `Excluded from clustering (already triaged): ${mine.excluded.total}` +
      (mine.excluded.total === 0
        ? ''
        : `  [${mine.excluded.byStatus.map((entry) => `${entry.status}:${entry.count}`).join(', ')}]`)
  )
  if (mine.truncated.groups) {
    lines.push(
      `TRUNCATED: showing ${mine.clusters.length} of ${mine.totals.clusters} clusters ` +
        `(--max-groups ${mine.limits.maxGroups}). The totals above describe the whole window.`
    )
  }
  if (mine.truncated.candidates) {
    lines.push(
      `TRUNCATED: ${mine.totals.candidates} untriaged candidates exist, this run selects ` +
        `${mine.candidates.length} (--max-candidates ${mine.limits.maxCandidates}).`
    )
  }
  if (mine.truncated.timeBudget) {
    lines.push(
      `TRUNCATED: the ${mine.limits.timeBudgetMs}ms time budget ran out; the candidate set is partial.`
    )
  }
  lines.push('')
  if (mine.clusters.length === 0) {
    lines.push('No clusters in this window.')
  } else {
    lines.push(
      `${pad('FINGERPRINT', 18)} ${pad('COUNT', 6)} ${pad('SRC', 4)} ${pad('CLASS', 24)} ` +
        `${pad('FIRST→LAST', 24)} RULES`
    )
    for (const cluster of mine.clusters) {
      const span = `${iso(cluster.firstSeen).slice(5, 16)}→${iso(cluster.lastSeen).slice(5, 16)}`
      lines.push(
        `${pad(`${cluster.fingerprint.slice(0, 16)}…`, 18)} ${pad(String(cluster.count), 6)} ` +
          `${pad(String(cluster.distinctSourceIds), 4)} ${pad(classSummary(cluster), 24)} ` +
          `${pad(span, 24)} ${cluster.rules.length === 0 ? '—' : cluster.rules.join(',')}`
      )
      const places = [
        cluster.worktrees.length === 0
          ? null
          : `worktrees=${cluster.worktrees.join(',')}` +
            (cluster.worktreeCount > cluster.worktrees.length
              ? ` (+${cluster.worktreeCount - cluster.worktrees.length})`
              : ''),
        cluster.runs.length === 0
          ? null
          : `runs=${cluster.runs.join(',')}` +
            (cluster.runCount > cluster.runs.length
              ? ` (+${cluster.runCount - cluster.runs.length})`
              : '')
      ].filter((entry): entry is string => entry !== null)
      if (places.length > 0) {
        lines.push(`  ${places.join('  ')}`)
      }
      lines.push(
        `  first id: ${cluster.representativeId}` +
          `${cluster.hasUntriaged ? `  (untriaged: ${cluster.untriagedCount})` : '  (all triaged)'}`
      )
    }
  }
  lines.push('')
  if (mine.candidates.length === 0) {
    lines.push('No candidates selected.')
  } else if (mine.apply) {
    const applied = mine.applied
    lines.push(
      `Applied (target ${mine.target}, actor=miner): ${applied?.appended ?? 0} appended, ` +
        `${applied?.skipped ?? 0} skipped of ${mine.candidates.length} candidates`
    )
    for (const result of applied?.results ?? []) {
      lines.push(
        `  ${result.incidentId}  ${result.rule}  ${result.fromStatus} → ${result.toStatus}` +
          `  ${result.outcome}`
      )
    }
    if ((applied?.skipped ?? 0) > 0) {
      lines.push(
        'Skipped rows were already in the target state, already terminal, or no longer present: ' +
          'the miner never re-opens a decision a human made.'
      )
    }
  } else {
    lines.push(`Would set (target ${mine.target}, actor=miner) — re-run with --apply to write:`)
    for (const candidate of mine.candidates) {
      lines.push(
        `  ${candidate.incidentId}  ${candidate.rule}  ` +
          `count=${candidate.stats.count} src=${candidate.stats.distinctSourceIds}  ` +
          `${candidate.fromStatus} → ${mine.target}`
      )
    }
  }
  lines.push('')
  // §M6-3: the same counting view `incident digest` prints, from the same object, so the two commands
  // cannot report different numbers for the same store and window.
  lines.push(
    `Digest in the same window: ${mine.digest.total} incidents, ` +
      `${mine.digest.unseen} unseen/untriaged (identical to \`orca incident digest --since ${formatWindowLabel(mine.windowMs)}\`)`
  )
  lines.push(...formatDigestCoverage(mine.digest))
  lines.push('')
  lines.push(
    'The miner never sets confirmed: that requires a human or independent context (R1). ' +
      'Mining, verdicts and repair tasks are separate steps; nothing here changes code or dispatch state.'
  )
  return lines.join('\n')
}

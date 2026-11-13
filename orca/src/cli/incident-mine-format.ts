// Formatting for `orca incident mine` (issue-sedimentation.md v2.7 §10, M6-1/M6-3).
//
// The reader's question is "what should I open, and why is it here". So every cluster prints the rule
// that promoted it, its counts, and the span it covers; every cap that fired is printed next to the
// number it truncated.

import type { IncidentMine, MineCluster } from '../main/incidents/incident-mine'
import { formatDigestCoverage } from './incident-digest-format'
import { formatWindowLabel, isoTimestamp as iso, pad } from './incident-format-shared'

function classSummary(cluster: MineCluster): string {
  return cluster.byClass.map((entry) => `${entry.value}:${entry.count}`).join(',')
}

export function formatIncidentMine(mine: IncidentMine): string {
  const lines: string[] = []
  const mode = mine.apply
    ? `APPLY (target ${mine.target ?? '—'})`
    : mine.target === null
      ? 'dry-run (no writes; no --target given)'
      : `dry-run (no writes; would set ${mine.target})`
  lines.push(
    `Incident mine (last ${formatWindowLabel(mine.windowMs)}, since ${iso(mine.since)}) — ${mode}`
  )
  lines.push('')
  lines.push(
    `Rows scanned: ${mine.scan.rows} in ${mine.scan.ms}ms (digest ${mine.scan.digestMs}ms)` +
      `    clusters: ${mine.totals.clusters}` +
      `    candidate clusters: ${mine.totals.candidateClusters}` +
      `    untriaged candidates: ${mine.totals.candidates}`
  )
  if (mine.truncated.scan) {
    // Separate from every other truncation: this one means the numbers themselves are partial.
    lines.push(
      `SCAN TRUNCATED: the window holds more than --max-scan-rows ${mine.scan.limit} rows; ` +
        'the newest rows were read and every total below describes only those. Narrow --since.'
    )
  }
  lines.push(
    `Excluded from clustering: ${mine.excluded.total}` +
      ` (triaged ${mine.excluded.byReason.terminal}, self-report ${mine.excluded.byReason.selfReport})` +
      (mine.excluded.byStatus.length === 0
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
  if (mine.truncated.lowInformation) {
    lines.push(
      'TRUNCATED: more low-information candidates (unknown / non_zero_exit) existed than their ' +
        'separate budget allows; they are reported as clusters but not queued.'
    )
  }
  lines.push('')
  if (mine.clusters.length === 0) {
    lines.push('No clusters in this window.')
  } else {
    lines.push(
      `${pad('FINGERPRINT', 18)} ${pad('ROWS', 8)} ${pad('SOURCES', 16)} ${pad('CLASS', 22)} ` +
        `${pad('FIRST→LAST', 24)} RULES`
    )
    for (const cluster of mine.clusters) {
      const span = `${iso(cluster.firstSeen).slice(5, 16)}→${iso(cluster.lastSeen).slice(5, 16)}`
      // `epochRows` and `stableSources` are printed side by side so "3 rows" cannot be read as
      // "3 entities" — the distinction the M6 review blocked on.
      const sources =
        `${cluster.stableSources} src` +
        (cluster.unknownStableSource > 0 ? ` (+${cluster.unknownStableSource}?)` : '')
      const flags = [
        cluster.singleEntityRecurrence ? 'single-entity' : null,
        cluster.lowInformation ? `low-info:${cluster.lowInformationReason ?? 'yes'}` : null
      ].filter((entry): entry is string => entry !== null)
      lines.push(
        `${pad(`${cluster.fingerprint.slice(0, 16)}…`, 18)} ${pad(`${cluster.epochRows}r/${cluster.untriagedCount}u`, 8)} ` +
          `${pad(sources, 16)} ${pad(cluster.summary, 22)} ` +
          `${pad(span, 24)} ${cluster.rules.length === 0 ? '—' : cluster.rules.join(',')}` +
          (flags.length > 0 ? `  [${flags.join(', ')}]` : '')
      )
      lines.push(
        `  dimensions: panes=${cluster.distinctPanes} sessions=${cluster.distinctSessions} ` +
          `dispatches=${cluster.distinctDispatches} worktrees=${cluster.distinctWorktrees} ` +
          `runs=${cluster.distinctRuns}` +
          `  owner=${cluster.ownerAction}` +
          (cluster.latestDecisionAt === null
            ? '  last_decision=never'
            : `  last_decision=${iso(cluster.latestDecisionAt)}`)
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
  } else if (mine.target === null) {
    lines.push(
      'Candidates found, but no --target was given: nothing would be written. Pass ' +
        '--target watch|duplicate|needs_archive (with --apply) to record a triage decision.'
    )
    for (const candidate of mine.candidates) {
      lines.push(
        `  ${candidate.incidentId}  ${candidate.rule}  ` +
          `count=${candidate.stats.count} sources=${candidate.stats.stableSources}  ` +
          `${candidate.fromStatus} → ?`
      )
    }
  } else {
    lines.push(`Would set (target ${mine.target}, actor=miner) — re-run with --apply to write:`)
    for (const candidate of mine.candidates) {
      lines.push(
        `  ${candidate.incidentId}  ${candidate.rule}  ` +
          `count=${candidate.stats.count} sources=${candidate.stats.stableSources}  ` +
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
    'The miner never sets confirmed: that requires a human or independent context (R1), and it only ' +
      'acts on rows that are still untriaged — a decision made after mining is never overwritten. ' +
      'A miner decision routes a candidate; it does not confirm a fact. Mining, verdicts and repair ' +
      'tasks are separate steps, and nothing here changes code or dispatch state.'
  )
  return lines.join('\n')
}

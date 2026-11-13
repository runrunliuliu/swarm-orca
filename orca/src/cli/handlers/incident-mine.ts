// `orca incident mine` (issue-sedimentation.md v2.7 §10, M6-1).
//
// Read-only in this milestone: it clusters and selects candidates, prints what it would do, and writes
// nothing. `--apply` arrives with M6-2 and is validated here so the flag cannot silently mean
// something else later.
//
// Pure CLI on purpose (§10 / M6-4): a scheduled automation runs this binary and parses `--json`; no
// scheduler, no automation type, no new IPC surface.

import type { CommandHandler } from '../dispatch'
import { RuntimeClientError } from '../runtime/types'
import { openIncidentStore } from '../incident-store-access'
import { parseDigestWindow } from '../../main/incidents/incident-digest'
import {
  DEFAULT_MINE_MAX_CANDIDATES,
  DEFAULT_MINE_MAX_GROUPS,
  DEFAULT_MINE_TIME_BUDGET_MS,
  DEFAULT_MINE_WINDOW_MS,
  DEFAULT_MINER_TARGET,
  buildIncidentMine
} from '../../main/incidents/incident-mine'
import { formatIncidentMine } from '../incident-mine-format'
import { printIncidentJson, refuseNonLocalIncidentSelector, stringFlag } from './incident-shared'

function positiveIntFlag(
  ctx: Parameters<CommandHandler>[0],
  name: string,
  fallback: number
): number {
  const raw = stringFlag(ctx, name)
  if (raw === null) {
    return fallback
  }
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new RuntimeClientError('invalid_argument', `--${name} must be a positive integer.`)
  }
  return parsed
}

export const mineIncident: CommandHandler = async (ctx) => {
  refuseNonLocalIncidentSelector(ctx, 'orca incident mine')
  const sinceFlag = stringFlag(ctx, 'since')
  const windowMs = sinceFlag === null ? DEFAULT_MINE_WINDOW_MS : parseDigestWindow(sinceFlag)
  if (windowMs === null || windowMs <= 0) {
    throw new RuntimeClientError(
      'invalid_argument',
      `--since must look like 90m, 24h or 7d (got "${sinceFlag ?? ''}").`
    )
  }
  const maxGroups = positiveIntFlag(ctx, 'max-groups', DEFAULT_MINE_MAX_GROUPS)
  const maxCandidates = positiveIntFlag(ctx, 'max-candidates', DEFAULT_MINE_MAX_CANDIDATES)
  const timeBudgetMs = positiveIntFlag(ctx, 'time-budget-ms', DEFAULT_MINE_TIME_BUDGET_MS)
  const apply = false
  const target = DEFAULT_MINER_TARGET

  // The store is opened read-only, so "this command writes nothing" is a property of the handle rather
  // than a promise in a comment.
  const opened = openIncidentStore({ requireExisting: false, readOnly: true })
  try {
    const db = opened.db
    if (db === null) {
      // No store yet is a real answer, and it must not create one: an empty window plus the coverage
      // gaps, exactly like `incident digest`.
      const empty = {
        version: 1 as const,
        now: Date.now(),
        since: Date.now() - windowMs,
        windowMs,
        apply,
        target,
        totals: { rowsInWindow: 0, clusters: 0, candidateClusters: 0, candidates: 0 },
        excluded: { total: 0, byStatus: [] },
        truncated: { groups: false, candidates: false, timeBudget: false },
        limits: { maxGroups, maxCandidates, timeBudgetMs },
        clusters: [],
        candidates: []
      }
      if (ctx.json) {
        printIncidentJson(empty)
        return
      }
      console.log(formatIncidentMine(empty))
      return
    }
    const mine = buildIncidentMine(db, {
      now: Date.now(),
      windowMs,
      maxGroups,
      maxCandidates,
      timeBudgetMs,
      apply,
      target
    })
    if (ctx.json) {
      printIncidentJson(mine)
      return
    }
    console.log(formatIncidentMine(mine))
  } finally {
    opened.close()
  }
}

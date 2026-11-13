// `orca incident mine` (issue-sedimentation.md v2.7 §10, M6-1).
//
// Dry run by default: it clusters, selects candidates and prints what it would set. `--apply` writes
// append-only decisions with actor=miner and nothing else — no dispatch, no orchestration row, no code.
// The store is opened read-only unless `--apply` was asked for, so "this command cannot write" is a
// property of the handle rather than a promise in a comment.
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
  applyMineCandidates,
  buildIncidentMine,
  isMinerTarget,
  type MinerTarget
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

function parseTarget(ctx: Parameters<CommandHandler>[0]): MinerTarget {
  const raw = stringFlag(ctx, 'target')
  if (raw === null) {
    return DEFAULT_MINER_TARGET
  }
  if (!isMinerTarget(raw)) {
    // §10.3: only watch / duplicate / needs_archive. `confirmed` is refused BY NAME so the message
    // explains the rule instead of saying "unsupported value".
    throw new RuntimeClientError(
      'invalid_argument',
      raw === 'confirmed'
        ? 'The miner cannot set `confirmed`: that needs a human or independent context (R1). ' +
            'Allowed targets: watch, duplicate, needs_archive.'
        : `Unsupported --target "${raw}". Allowed: watch, duplicate, needs_archive.`
    )
  }
  return raw
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
  const apply = ctx.flags.get('apply') === true
  const target = parseTarget(ctx)

  // A dry run opens the store read-only; --apply is the only path that can write, and the write is
  // restricted to `appendDecision` below.
  const opened = openIncidentStore({ requireExisting: false, readOnly: !apply })
  try {
    const db = opened.db
    if (apply && opened.store.readOnly) {
      // A store written by a newer build opens read-only by design (§6.1). Saying so is better than a
      // run that reports zero applied decisions for a reason nobody sees.
      throw new RuntimeClientError(
        'runtime_unavailable',
        'The incidents store was written by a newer Orca build and is opened read-only; ' +
          '--apply cannot append decisions. Run mine without --apply to inspect it.'
      )
    }
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
    if (apply) {
      mine.applied = applyMineCandidates(opened.store, mine)
    }
    if (ctx.json) {
      printIncidentJson(mine)
      return
    }
    console.log(formatIncidentMine(mine))
  } finally {
    opened.close()
  }
}

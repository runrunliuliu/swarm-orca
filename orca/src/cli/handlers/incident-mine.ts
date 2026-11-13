// `orca incident mine` (issue-sedimentation.md v2.7 §10, M6-1).
//
// Dry run by default: it clusters, selects candidates and prints what it WOULD set. `--apply` writes
// append-only decisions with actor=miner and nothing else — no dispatch, no orchestration row, no code.
// The store is opened read-only unless `--apply` was asked for, so "this command cannot write" is a
// property of the handle rather than a promise in a comment.
//
// `--apply` without `--target` is refused (M6 review C6, both reviewers chose this): a default target
// would let an unattended schedule move rows out of the untriaged queue by itself. The operator has to
// name the triage destination, which is a policy choice, not a default.
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
  DEFAULT_MINE_MAX_SCAN_ROWS,
  DEFAULT_MINE_TIME_BUDGET_MS,
  DEFAULT_MINE_WINDOW_MS,
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

/**
 * `--target` is optional only for a dry run (it then pre-writes the report's "would set" line). An
 * `--apply` without it is an error: the miner has no default destination.
 */
function parseTarget(ctx: Parameters<CommandHandler>[0], apply: boolean): MinerTarget | null {
  const raw = stringFlag(ctx, 'target')
  if (raw === null) {
    if (apply) {
      throw new RuntimeClientError(
        'invalid_argument',
        '--apply requires an explicit --target watch|duplicate|needs_archive. The miner does not pick a ' +
          'destination for you: without one it would remove rows from the untriaged queue by default.'
      )
    }
    return null
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
  const maxScanRows = positiveIntFlag(ctx, 'max-scan-rows', DEFAULT_MINE_MAX_SCAN_ROWS)
  const apply = ctx.flags.get('apply') === true
  const target = parseTarget(ctx, apply)

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
      const coverage = opened.store.coverage()
      const now = Date.now()
      const empty = {
        version: 1 as const,
        now,
        since: now - windowMs,
        windowMs,
        apply,
        target,
        scan: { rows: 0, ms: 0, digestMs: 0, truncated: false, limit: maxScanRows },
        // Built from the same builder so an empty host still emits the digest shape, not a stub that
        // drifts from it (the builder only needs the store report here).
        digest: {
          since: now - windowMs,
          windowMs,
          total: 0,
          byClass: [],
          byStatus: [],
          topFingerprints: [],
          unseen: 0,
          dropped: coverage.shadowReplay.dropped,
          shadowReplay: {
            lastSeq: coverage.shadowReplay.lastSeq,
            incomplete: coverage.shadowReplay.incomplete,
            lastStopReason: coverage.shadowReplay.lastStopReason,
            failures: coverage.shadowReplay.failures,
            lastError: coverage.shadowReplay.lastError,
            lastRun: coverage.shadowReplay.lastRun
          },
          capacity: {
            rows: 0,
            bytes: coverage.capacity.bytes,
            maxRows: coverage.capacity.maxRows,
            maxBytes: coverage.capacity.maxBytes,
            capacityLatchSet: coverage.capacityLatchSet,
            currentlyLimited: coverage.currentlyLimited
          },
          toolError: { windows: 0, wouldWrite: 0, writeEnabled: false, updatedAt: null }
        },
        totals: {
          rowsInWindow: 0,
          clusters: 0,
          candidateClusters: 0,
          candidates: 0,
          lowInformationClusters: 0
        },
        excluded: { total: 0, byStatus: [], byReason: { terminal: 0, selfReport: 0 } },
        truncated: {
          groups: false,
          candidates: false,
          timeBudget: false,
          scan: false,
          lowInformation: false
        },
        limits: { maxGroups, maxCandidates, timeBudgetMs, maxScanRows },
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
      // The same object `incident digest` builds, from the same store report (M6-3).
      coverage: opened.store.coverage(),
      windowMs,
      maxGroups,
      maxCandidates,
      timeBudgetMs,
      maxScanRows,
      apply,
      target
    })
    if (apply) {
      // `target` is non-null whenever `apply` is true: parseTarget refuses the combination above.
      mine.applied = applyMineCandidates(opened.store, mine, { target: target as MinerTarget })
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

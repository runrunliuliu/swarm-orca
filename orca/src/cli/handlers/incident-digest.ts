// `orca incident tool-errors` and `orca incident digest` (issue-sedimentation.md v2.5 §7.3, §10; M4).
//
// Both are read-only views over what M4 already publishes: the tool-error window snapshot (in meta,
// written by the live collector) and the store's own aggregates + coverage. Neither command writes an
// incident, starts a sampler, or performs mining/triage — those stay behind later milestones.

import type { CommandHandler } from '../dispatch'
import { RuntimeClientError } from '../runtime/types'
import { openIncidentStore } from '../incident-store-access'
import { DEFAULT_DIGEST_WINDOW_MS, buildIncidentDigest, parseDigestWindow } from '../../main/incidents/incident-digest'
import { formatIncidentDigest } from '../incident-digest-format'
import {
  printIncidentJson,
  refuseNonLocalIncidentSelector,
  stringFlag
} from './incident-shared'

export const digestIncident: CommandHandler = async (ctx) => {
  refuseNonLocalIncidentSelector(ctx, 'orca incident digest')
  const sinceFlag = stringFlag(ctx, 'since')
  const windowMs = sinceFlag === null ? DEFAULT_DIGEST_WINDOW_MS : parseDigestWindow(sinceFlag)
  if (windowMs === null || windowMs <= 0) {
    throw new RuntimeClientError(
      'invalid_argument',
      `--since must look like 90m, 24h or 7d (got "${sinceFlag ?? ''}").`
    )
  }
  const opened = openIncidentStore({ requireExisting: false, readOnly: true })
  try {
    const db = opened.db
    const coverage = opened.store.coverage()
    if (db === null) {
      // No store yet is a real answer: zero incidents, and the coverage gaps still printed.
      const empty = {
        since: Date.now() - windowMs,
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
      }
      if (ctx.json) {
        printIncidentJson(empty)
        return
      }
      console.log(formatIncidentDigest(empty))
      return
    }
    const digest = buildIncidentDigest(db, { now: Date.now(), windowMs, coverage })
    if (ctx.json) {
      printIncidentJson(digest)
      return
    }
    console.log(formatIncidentDigest(digest))
  } finally {
    opened.close()
  }
}

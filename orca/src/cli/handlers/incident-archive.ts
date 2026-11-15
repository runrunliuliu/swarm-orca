// `orca incident archive` (M8-4): what happened to the evidence excerpts, an optional drain, and the
// one explicit repair path for a pointer whose archive attempt failed.
//
// Without `--drain` / `--retry-incomplete` this is a read-only report: configured or not, how many
// pointers are staged, pending, archived or incomplete. `--drain` performs the same move the runtime
// does on its interval — it exists for a host whose desktop app is not running, and it never blocks
// anything. `--retry-incomplete <id>` is the operator's way back for a `archive_incomplete` pointer:
// it appends a new `archive_pending` event (nothing is updated or deleted), and the drain — in the same
// call when `--drain` is also given — republishes it.

import type { CommandHandler, HandlerContext } from '../dispatch'
import { RuntimeClientError } from '../runtime/types'
import { openIncidentStore } from '../incident-store-access'
import {
  drainEvidenceArchive,
  readEvidenceArchiveState,
  resolveArchiveRoot,
  retryIncompleteArchive,
  type ArchiveRetryResult
} from '../../main/incidents/incident-archive'
import { printIncidentJson, refuseNonLocalIncidentSelector, stringFlag } from './incident-shared'

/** `--pointer` is an index, so it must be a non-negative integer (`0` is the first pointer). */
function pointerFlag(ctx: HandlerContext): number | null {
  const raw = stringFlag(ctx, 'pointer')
  if (raw === null) {
    return null
  }
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new RuntimeClientError('invalid_argument', '`--pointer` must be a non-negative integer.')
  }
  return parsed
}

export const archiveIncident: CommandHandler = async (ctx) => {
  refuseNonLocalIncidentSelector(ctx, 'orca incident archive')
  const drain = ctx.flags.get('drain') === true
  const retryIncidentId = stringFlag(ctx, 'retry-incomplete')
  const pointer = pointerFlag(ctx)
  if (pointer !== null && retryIncidentId === null) {
    // A silent no-op would look like a repair that happened: make the dependency explicit.
    throw new RuntimeClientError(
      'invalid_argument',
      '`--pointer` only narrows `--retry-incomplete <incident-id>`; it does nothing on its own.'
    )
  }
  const root = resolveArchiveRoot()
  // Retrying writes, so the store must be writable: `readOnly: !(drain || retry)`.
  const opened = openIncidentStore({
    requireExisting: false,
    readOnly: !(drain || retryIncidentId !== null)
  })
  try {
    const db = opened.db
    const retried: ArchiveRetryResult | null =
      retryIncidentId !== null && db !== null
        ? retryIncompleteArchive({
            db,
            incidentId: retryIncidentId,
            now: Date.now(),
            ...(pointer === null ? {} : { pointerIndex: pointer })
          })
        : null
    const drained =
      drain && db !== null
        ? drainEvidenceArchive({ db, root, now: Date.now(), limit: 200 })
        : null
    // Read the state AFTER the writes: the report must describe what is true now, not what was true
    // before this command moved or re-queued the excerpts.
    const states = db === null ? [] : readEvidenceArchiveState(db)
    const counts = { staged: 0, archive_pending: 0, archived: 0, archive_incomplete: 0 }
    for (const state of states) {
      counts[state.state] += 1
    }
    const payload = {
      configured: root !== null,
      root,
      counts,
      drain: drained,
      retry: retried,
      rows: states.map((state) => ({
        incidentId: state.incidentId,
        pointerIndex: state.pointerIndex,
        state: state.state,
        archivePath: state.archivePath,
        sha256: state.sha256,
        bytes: state.bytes,
        error: state.error
      }))
    }
    if (ctx.json) {
      printIncidentJson(payload)
      return
    }
    console.log(
      `Evidence archive: ${root === null ? 'NOT CONFIGURED (durable=false; excerpts stay pending)' : root}`
    )
    console.log(
      `State: staged=${counts.staged} pending=${counts.archive_pending} ` +
        `archived=${counts.archived} incomplete=${counts.archive_incomplete}`
    )
    if (retried !== null) {
      // `code=` is the batch verdict, not a per-pointer code: `no_incomplete_pointer` produces no
      // per-pointer lines at all, so without it a text-only operator cannot see the no-op reason that
      // `--json` exposes as `retry.code`.
      console.log(
        `Retry ${retried.incidentId}: code=${retried.code} retried=${retried.retried} ` +
          `refused=${retried.refused}`
      )
      for (const entry of retried.pointers) {
        console.log(`  ${entry.incidentId}#${entry.pointerIndex}  ${entry.code}`)
      }
      if (retried.retried === 0) {
        console.log(
          'Nothing was appended: only a latest-state archive_incomplete pointer with a readable ' +
            'staging excerpt can be retried.'
        )
      }
    }
    if (drained !== null) {
      console.log(
        `Drain: archived=${drained.archived} incomplete=${drained.incomplete} ` +
          `failed=${drained.failed} remaining=${drained.remaining}`
      )
    }
    if (states.length === 0) {
      console.log(
        'No evidence pointer has been staged on this host. Crash rows carry no transcript pointer by design.'
      )
    }
    for (const state of states) {
      const detail = state.error === null ? '' : `  error=${state.error}`
      console.log(
        `  ${state.incidentId}#${state.pointerIndex}  ${state.state}  ` +
          `${state.archivePath ?? '—'}${detail}`
      )
    }
    if (counts.archive_pending > 0 && root !== null && !drain) {
      console.log('Run `orca incident archive --drain` to move pending excerpts (the runtime also retries).')
    }
    if (counts.archive_incomplete > 0 && retried === null) {
      console.log(
        'An incomplete pointer needs an explicit repair: `orca incident archive ' +
          '--retry-incomplete <incident-id> [--pointer <n>] --drain` re-queues it (append-only).'
      )
    }
  } finally {
    opened.close()
  }
}

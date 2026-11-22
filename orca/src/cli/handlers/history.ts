import {
  parseHistoryBackfillTaskArgument,
  type HistoryBackfillResult
} from '../../shared/history-backfill-command'
import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import { rejectRemoteSelectionFlags } from '../remote-selection-flag-rejection'
import {
  RuntimeClient,
  RuntimeClientError,
  getDefaultUserDataPath,
  type RuntimeRpcSuccess
} from '../runtime-client'
import { canLaunchHistoryBackfill, launchHistoryBackfill } from '../runtime/history-backfill-launch'

/**
 * `orca history backfill` (issue #53 B): the explicit one-shot that reconstructs an
 * archived workspace's agent run from local evidence.
 *
 * This handler is deliberately thin. The work runs in a headless preflight launch of
 * the Orca executable (`src/main/startup/history-backfill-preflight.ts`), because the
 * profile-state maintenance lock must be owned by a process that never becomes the
 * app, and because the agent session index lives in the main-process graph rather
 * than in the CLI bundle. The CLI's job is to parse `--task` strictly, refuse while
 * Orca is running, and print the result.
 */

function localSuccess<TResult>(result: TResult): RuntimeRpcSuccess<TResult> {
  return { id: 'local', ok: true, result, _meta: { runtimeId: 'local' } }
}

function requireTaskArgument(flags: ReadonlyMap<string, string | boolean>): string {
  const value = flags.get('task')
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new RuntimeClientError(
      'invalid_argument',
      'history backfill requires --task <repo>#<number>, where <repo> is a registered repo id or its checkout path.'
    )
  }
  return value.trim()
}

/** The precondition the whole command rests on. `app.running` counts as running even
 *  when the socket is not up yet: a starting app is exactly the process that would
 *  publish its in-memory revision over this write. The preflight repeats the check
 *  under the single-instance lock; this one exists so the common case fails fast with
 *  the actionable sentence instead of a spawn. */
async function requireStoppedRuntime(): Promise<void> {
  // Why a fresh local client instead of the dispatched one: this command answers for
  // *this machine's* profile state, and an ambient ORCA_ENVIRONMENT would point the
  // status question at another host while the write still lands here.
  const client = new RuntimeClient(getDefaultUserDataPath(), 60_000, null, null)
  const status = await client.getCliStatus()
  if (status.result.runtime.reachable || status.result.app.running) {
    throw new RuntimeClientError(
      'runtime_error',
      'Stop Orca before `history backfill`: it writes the profile state database offline, and a running app would overwrite that write from memory. Quit Orca, run the command, then start Orca again.'
    )
  }
}

function formatBackfill(report: HistoryBackfillResult): string {
  const rows = report.outcomes.map((row) => {
    const written =
      row.outcome === 'resolved' ? ` (sessions ${row.sessionRows}, runs ${row.runRows})` : ''
    // A refusal must say which refusal: "binding gone" and "over the cap" are
    // different operator problems, and neither is "already correct".
    const refused = row.refusedReason === undefined ? '' : ` [${row.refusedReason}]`
    const detail = row.detail === undefined ? '' : `\n  reason: ${row.detail}`
    return `- ${row.worktreeId}: ${row.outcome}${refused}${written}${detail}`
  })
  // Why say it at all: the load boundary rewrites the domain it read (unknown
  // fields dropped, malformed rows removed, an over-cap `runs` list trimmed to the
  // first 16), so a discard here is data this run would have made permanent. Silence
  // is the one answer an operator cannot act on.
  const discarded = report.discarded
  const discardedTotal =
    discarded.sessions +
    discarded.runs +
    discarded.gaps +
    discarded.providers +
    discarded.fields +
    discarded.transcriptChecks
  const discardedLines =
    discardedTotal === 0
      ? []
      : [
          `load boundary: discarded from the stored domain — runs ${discarded.runs}, sessions ${discarded.sessions}, gaps ${discarded.gaps}, providers ${discarded.providers}, fields ${discarded.fields}, transcript checks ${discarded.transcriptChecks}`
        ]
  // `writeRefusedReason` is the machine-readable form of this line and the exit code
  // stays 0 (a refusal is a reported outcome, not a crash); the sentence has to carry
  // the whole weight, so it names both facts an operator needs: nothing was written,
  // and nothing could be recovered from having written it.
  const profileStateLine =
    report.writeRefusedReason === 'load_discarded_runs'
      ? `profile state: NOT WRITTEN — the stored domain holds run rows this build drops or trims at load (${discarded.runs} discarded at load), so writing it back would persist an unrecoverable loss. The stored payload is unchanged.`
      : report.revision === null
        ? 'profile state: unchanged (nothing to write)'
        : `profile state: written at revision ${report.revision}`
  const examinedLines =
    report.writeRefusedReason === null
      ? rows.length > 0
        ? ['examined bindings:', ...rows]
        : ['examined bindings: none (no archived binding with an empty session list)']
      : ['examined bindings: not examined (the write was refused before any scan)']
  return [
    `task: ${report.provider} ${report.repoId}#${report.number} (${report.taskId})`,
    `bindings: ${report.bindings} (examined ${report.examined}, resolved ${report.resolved})`,
    `rows written: sessions ${report.rowsWritten.sessions}, runs ${report.rowsWritten.runs}`,
    profileStateLine,
    ...discardedLines,
    'usage: untouched (this command does not read the usage stores, so it writes no token figure)',
    ...examinedLines
  ].join('\n')
}

export const HISTORY_HANDLERS: Record<string, CommandHandler> = {
  'history backfill': async ({ flags, json }) => {
    rejectRemoteSelectionFlags(
      flags,
      "history backfill; it writes this machine's profile state database."
    )
    const task = parseHistoryBackfillTaskArgument(requireTaskArgument(flags))
    if (!canLaunchHistoryBackfill()) {
      throw new RuntimeClientError(
        'runtime_error',
        'history backfill must run through the Orca app executable (the `orca` CLI shim). Set ORCA_APP_EXECUTABLE to the installed Orca binary and retry.'
      )
    }
    await requireStoppedRuntime()
    const result = await launchHistoryBackfill({
      userDataPath: getDefaultUserDataPath(),
      task
    })
    printResult(localSuccess(result), json, formatBackfill)
  }
}

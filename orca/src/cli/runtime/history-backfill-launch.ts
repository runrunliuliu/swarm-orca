import { realpathSync } from 'node:fs'
import { runProcess } from '../../shared/child-process/run-process'
import {
  HISTORY_BACKFILL_FLAG,
  HISTORY_BACKFILL_RESULT_PREFIX,
  historyBackfillResponseSchema,
  type HistoryBackfillRequest,
  type HistoryBackfillResult
} from '../../shared/history-backfill-command'
import {
  getExecutableAppArgs,
  resolveAppRoot,
  resolveForegroundOrcaExecutable,
  stripElectronRunAsNode
} from './launch'
import { RuntimeClientError } from './types'

/**
 * The CLI side of `orca history backfill` (issue #53 B): relaunch the Orca executable
 * in its headless preflight form and read the one prefixed result line.
 *
 * Why a child and not in-process work: the only degraded source is the agent session
 * index, which the CLI build deliberately does not compile, and the write must happen
 * while this process holds the profile-state maintenance lock
 * (`src/main/startup/history-backfill-preflight.ts`). The shape is copied from
 * `profile-state-recovery-launch.ts` — same argv contract, same result-prefix parse,
 * same refusal to guess when the response is missing or malformed.
 */
export function canLaunchHistoryBackfill(): boolean {
  return process.env.ELECTRON_RUN_AS_NODE === '1' || !!process.env.ORCA_APP_EXECUTABLE?.trim()
}

export async function launchHistoryBackfill(
  request: HistoryBackfillRequest
): Promise<HistoryBackfillResult> {
  const executable = resolveForegroundOrcaExecutable()
  const userDataPath = realpathSync(request.userDataPath)
  const response = await runProcess({
    program: executable,
    args: [
      ...getExecutableAppArgs(executable),
      '--serve',
      HISTORY_BACKFILL_FLAG,
      JSON.stringify({ ...request, userDataPath })
    ],
    cwd: resolveAppRoot(),
    env: {
      ...stripElectronRunAsNode(process.env),
      ORCA_BACKGROUND_LAUNCH: '1',
      ORCA_USER_DATA_PATH: userDataPath
    },
    // The backfill scans the session index once and then writes; a deadline here would
    // report a timeout while the lock owner may still be writing.
    timeoutMs: null
  })
  const lines = response.stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith(HISTORY_BACKFILL_RESULT_PREFIX))
  if (!response.outputTruncated && lines.length === 1) {
    let parsed: unknown
    try {
      parsed = JSON.parse(lines[0].slice(HISTORY_BACKFILL_RESULT_PREFIX.length))
    } catch {
      throw new RuntimeClientError(
        'runtime_error',
        'Orca returned an invalid history backfill response. Profile state may not have been written; inspect it before retrying.'
      )
    }
    const result = historyBackfillResponseSchema.safeParse(parsed)
    if (result.success) {
      if (!result.data.ok) {
        throw new RuntimeClientError(result.data.code, result.data.message)
      }
      if (response.code === 0 && !response.signal && !response.timedOut) {
        return result.data.result
      }
    }
  }
  throw new RuntimeClientError(
    'runtime_error',
    'Orca did not complete the history backfill. Stop Orca and retry; if it keeps failing, inspect the profile state database before assuming nothing was written.',
    {
      exitCode: response.code,
      signal: response.signal,
      timedOut: response.timedOut,
      outputTruncated: response.outputTruncated ?? false,
      stderr: response.stderr.trim().slice(-4096)
    }
  )
}

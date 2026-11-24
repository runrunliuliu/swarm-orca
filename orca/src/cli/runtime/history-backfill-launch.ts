import { existsSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { runProcess } from '../../shared/child-process/run-process'
import {
  HISTORY_BACKFILL_FLAG,
  HISTORY_BACKFILL_RESULT_PREFIX,
  historyBackfillResponseSchema,
  type HistoryBackfillRequest,
  type HistoryBackfillResult
} from '../../shared/history-backfill-command'
import { orcadBunRuntimeFilename } from '../../shared/orcad-artifacts'
import { getExecutableAppArgs, resolveAppRoot, stripElectronRunAsNode } from './launch'
import { RuntimeClientError } from './types'

/**
 * The CLI side of `orca history backfill` (issue #53 B): relaunch whichever build owns
 * this host's main process in its headless preflight form and read the one prefixed
 * result line.
 *
 * Why a child and not in-process work: the only degraded source is the agent session
 * index, which the CLI build deliberately does not compile, and the write must happen
 * while this process holds the profile-state maintenance lock
 * (`src/main/startup/history-backfill-preflight-run.ts`). The shape is copied from
 * `profile-state-recovery-launch.ts` — same argv contract, same result-prefix parse,
 * same refusal to guess when the response is missing or malformed.
 *
 * Two hosts can own the preflight, and the request argv is the same for both:
 *
 * - the Electron app (`ORCA_APP_EXECUTABLE`, or plain Node under
 *   `ELECTRON_RUN_AS_NODE`), whose main-process preflight takes Electron's
 *   single-instance lock;
 * - the server-only `orcad` artifact this CLI ships inside. There is no app to point
 *   at, so the artifact is the executable: its own runtime runs `orcad.js`, and the
 *   data root's `orcad.lock` is the second fence.
 *
 * The server-only arm is resolved from the CLI's own install directory, not from an
 * environment variable, because that is the only fact always true on such a host: a
 * CLI bundled with `orcad.js` beside it cannot be a desktop-only install.
 */
export type HistoryBackfillLaunchTarget =
  | { kind: 'app'; executable: string }
  | { kind: 'server'; executable: string; entry: string }

/**
 * The sentence the handler prints when neither executable exists. Kept in one place
 * for the launcher's own guard; the handler's `canLaunchHistoryBackfill` check keeps
 * the user-facing refusal identical (it must stay the existing error, not a new one).
 */
export const HISTORY_BACKFILL_NO_EXECUTABLE_MESSAGE =
  'history backfill must run through the Orca app executable (the `orca` CLI shim). Set ORCA_APP_EXECUTABLE to the installed Orca binary and retry.'

export function resolveHistoryBackfillLaunchTarget(
  env: NodeJS.ProcessEnv = process.env,
  runtimeDir: string = __dirname
): HistoryBackfillLaunchTarget | null {
  const override = env.ORCA_APP_EXECUTABLE?.trim()
  if (override) {
    return { kind: 'app', executable: override }
  }
  if (env.ELECTRON_RUN_AS_NODE === '1') {
    return { kind: 'app', executable: process.execPath }
  }
  return resolveServerOnlyTarget(runtimeDir)
}

/** A sibling `orcad.js` is the server-only artifact's own entry point. */
function resolveServerOnlyTarget(runtimeDir: string): HistoryBackfillLaunchTarget | null {
  const installRoot = resolve(runtimeDir, '..')
  const entry = join(installRoot, 'orcad.js')
  let isFile = false
  try {
    isFile = statSync(entry).isFile()
  } catch {
    isFile = false
  }
  if (!isFile) {
    return null
  }
  // Why the sibling runtime: the CLI may have been started by a system Node, while
  // orcad's graph expects the Bun build shipped beside it. Falling back to the current
  // process keeps a node-only artifact (e.g. a test fixture) launchable.
  const bundledRuntime = join(installRoot, orcadBunRuntimeFilename(process.platform))
  const executable = existsSync(bundledRuntime) ? bundledRuntime : process.execPath
  return { kind: 'server', executable, entry }
}

export function canLaunchHistoryBackfill(
  env: NodeJS.ProcessEnv = process.env,
  runtimeDir: string = __dirname
): boolean {
  return resolveHistoryBackfillLaunchTarget(env, runtimeDir) !== null
}

export async function launchHistoryBackfill(
  request: HistoryBackfillRequest,
  target: HistoryBackfillLaunchTarget | null = resolveHistoryBackfillLaunchTarget()
): Promise<HistoryBackfillResult> {
  if (!target) {
    throw new RuntimeClientError('runtime_error', HISTORY_BACKFILL_NO_EXECUTABLE_MESSAGE)
  }
  const userDataPath = realpathSync(request.userDataPath)
  const requestJson = JSON.stringify({ ...request, userDataPath })
  const response = await runProcess(
    target.kind === 'app'
      ? appLaunch(target.executable, requestJson, userDataPath)
      : serverLaunch(target, requestJson, userDataPath)
  )
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

/** The desktop launch form: the app's preflight reads `--serve --history-backfill`. */
function appLaunch(executable: string, requestJson: string, userDataPath: string) {
  return {
    program: executable,
    args: [...getExecutableAppArgs(executable), '--serve', HISTORY_BACKFILL_FLAG, requestJson],
    cwd: resolveAppRoot(),
    env: {
      ...stripElectronRunAsNode(process.env),
      ORCA_BACKGROUND_LAUNCH: '1',
      ORCA_USER_DATA_PATH: userDataPath
    },
    // The backfill scans the session index once and then writes; a deadline here would
    // report a timeout while the lock owner may still be writing. The preflight owns that
    // bound instead (`HISTORY_BACKFILL_PREFLIGHT_DEADLINE_MS`, an upper bound), so this
    // wait ends when the child refuses with its own result line — including when the
    // scan never answers — rather than hanging or reading a silent exit as an answer.
    timeoutMs: null
  }
}

/**
 * The server-only launch form: same `--serve --history-backfill` contract, but the
 * runtime executes `orcad.js`. Both `ORCA_USER_DATA*` names are bound to the canonical
 * root so orcad's own path resolution and the shared profile-state readers cannot
 * disagree about which tree is being written.
 */
function serverLaunch(
  target: Extract<HistoryBackfillLaunchTarget, { kind: 'server' }>,
  requestJson: string,
  userDataPath: string
) {
  return {
    program: target.executable,
    args: [target.entry, '--serve', HISTORY_BACKFILL_FLAG, requestJson],
    cwd: dirname(target.entry),
    env: {
      ...stripElectronRunAsNode(process.env),
      ORCA_BACKGROUND_LAUNCH: '1',
      ORCA_USER_DATA: userDataPath,
      ORCA_USER_DATA_PATH: userDataPath
    },
    timeoutMs: null
  }
}

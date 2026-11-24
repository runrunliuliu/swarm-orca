import { realpathSync, writeFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import {
  HISTORY_BACKFILL_FLAG,
  HISTORY_BACKFILL_RESULT_PREFIX,
  historyBackfillRequestSchema,
  isHistoryBackfillCommandError,
  type HistoryBackfillResponse
} from '../../shared/history-backfill-command'
import { getActiveProfileStateLocation } from '../persistence/profile-state/profile-state-active-location'
import { acquireProfileStateMaintenance } from '../persistence/profile-state/profile-state-access'
import { backfillTaskRecords } from '../task-records/task-records-backfill-profile-state'
import {
  createAiVaultSessionIndexLookup,
  type TaskRecordsSessionIndexLookup
} from '../task-records/task-records-session-index-lookup'
import { createTranscriptCheckProbe } from '../task-records/task-records-transcript-check'

/**
 * The upper bound on one preflight, in milliseconds.
 *
 * An **upper bound**, not a progress budget: a run that reaches it is refused and never
 * reported as success. 180 s sits above the scanner's own two bounds — a 5 s ready wait
 * (`AI_VAULT_SERVICE_READY_TIMEOUT_MS`) plus a 130 s scan deadline
 * (`AI_VAULT_SERVICE_SCAN_TIMEOUT_MS`) — with room for the domain read and the one
 * write, so this process cannot refuse a scan the scanner itself still considers in
 * progress. `history-backfill-preflight-run.test.ts` pins that relationship, so raising
 * either scanner bound forces this number to be revisited instead of silently shrunk.
 */
export const HISTORY_BACKFILL_PREFLIGHT_DEADLINE_MS = 180_000

/** What a caller (or a test) may vary without touching the launch contract. */
export type HistoryBackfillPreflightOptions = {
  /**
   * The scan to consult. Defaults to the real AI Vault session index. A test supplies one
   * so the refusal and the write can be exercised without forking the scanner child.
   */
  sessionIndexLookup?: TaskRecordsSessionIndexLookup
  /** Overrides the deadline above. Tests only; production hosts take the constant. */
  deadlineMs?: number
}

/**
 * The process-independent half of the `orca history backfill` preflight.
 *
 * Why this module exists separately from `history-backfill-preflight.ts`: the write
 * path has to run in two different hosts — the Electron app and the server-only
 * `orcad` artifact — and only the locks that fence it differ. Keeping the parse,
 * the maintenance owner, the scan and the one prefixed result line here means both
 * hosts execute the same contract instead of a copy that can drift. This module
 * must stay free of `electron`; it is reachable from `src/main/orcad/main.ts`, whose
 * bundle refuses an Electron importer (`config/scripts/build-orcad.mjs`).
 *
 * Contract (unchanged from the desktop preflight): one `HISTORY_BACKFILL_FLAG`
 * occurrence, only with `--serve`, followed by the JSON request; one prefixed result
 * line on stdout; exit code 0 only for a completed run. Never fall through into
 * ordinary startup (the caller returns out of its preflight when this returns true).
 *
 * Settlement is guaranteed: the asynchronous scan is armed with a ref'd deadline timer
 * (`HISTORY_BACKFILL_PREFLIGHT_DEADLINE_MS`, an upper bound) and `finish` acts once. A
 * scan that never answers therefore still produces one prefixed refusal and a non-zero
 * exit, instead of letting a pending promise drain the event loop into exit 0 with no
 * output — the F3 defect on a server-only host, where every handle the scan itself
 * holds (the forked child, its channel, the client's timers) is deliberately unref'd.
 */
export type HistoryBackfillPreflightHost = {
  /**
   * Bind the canonical profile root before a lock or a read. The host also owns
   * whatever environment its build resolves paths from (`ORCA_USER_DATA_PATH` for
   * the desktop, both names for orcad).
   */
  setUserDataPath: (userDataPath: string) => void
  /**
   * The second fence, taken after the maintenance owner. `false` means another
   * process owns this profile and the command is refused with the existing
   * "Stop Orca" sentence; it never means "write anyway".
   */
  acquireSingleInstanceLock: () => boolean
  /** Write the result and leave. Production implementations never return. */
  exit: (exitCode: number) => void
  /** Desktop-only: a headless host has no windows to deactivate. */
  applyBackgroundActivationPolicy?: () => void
}

export function runHistoryBackfillPreflightOnHost(
  argv: readonly string[],
  host: HistoryBackfillPreflightHost,
  options: HistoryBackfillPreflightOptions = {}
): boolean {
  const index = argv.indexOf(HISTORY_BACKFILL_FLAG)
  if (index === -1) {
    return false
  }
  process.env.ORCA_BACKGROUND_LAUNCH = '1'
  host.applyBackgroundActivationPolicy?.()
  const launchValid = argv.includes('--serve') && argv.lastIndexOf(HISTORY_BACKFILL_FLAG) === index
  const deadlineMs = options.deadlineMs ?? HISTORY_BACKFILL_PREFLIGHT_DEADLINE_MS
  const sessionIndexLookup = options.sessionIndexLookup ?? createAiVaultSessionIndexLookup()
  let settled = false
  let deadline: NodeJS.Timeout | null = null
  const finish = (response: HistoryBackfillResponse): void => {
    // Why guard: the deadline and the settled scan can both call this. Acting twice would
    // write two result lines and exit twice, and the second line would be a "refusal"
    // for a run that had already reported its answer.
    if (settled) {
      return
    }
    settled = true
    if (deadline !== null) {
      clearTimeout(deadline)
      deadline = null
    }
    let exitCode = response.ok ? 0 : 1
    try {
      writeFileSync(1, `${HISTORY_BACKFILL_RESULT_PREFIX}${JSON.stringify(response)}\n`)
    } catch {
      // The CLI may have exited while this process held the locks; never open an error dialog.
      exitCode = 1
    }
    host.exit(exitCode)
  }
  if (!launchValid) {
    finish(invalidLaunch())
    return true
  }
  // Why a ref'd timer and not `unref()`: on the server-only host every handle the scan
  // uses is unref'd on purpose, so an unanswered scan would let Node drain the event loop
  // and exit 0 with no result line — a success report for a write that never happened.
  // This is the one handle that keeps the process alive long enough to refuse. Its number
  // is an upper bound (see the constant), and it can only fire while the run is awaiting
  // the scan: the single domain write and the result line are synchronous, so no timer
  // callback can run between them.
  deadline = setTimeout(() => finish(deadlineExceeded(deadlineMs)), deadlineMs)
  // The scan is asynchronous, so the exit happens when it settles rather than on
  // return. Nothing below may throw past `finish`; a launch that dies silently would
  // look to the CLI like a crash, not like a refused command.
  void runBackfillRequest(argv[index + 1], host, sessionIndexLookup).then(
    finish,
    (error: unknown) =>
      finish({
        ok: false,
        code: 'runtime_error',
        message: error instanceof Error ? error.message : String(error)
      })
  )
  return true
}

async function runBackfillRequest(
  payload: string | undefined,
  host: HistoryBackfillPreflightHost,
  sessionIndexLookup: TaskRecordsSessionIndexLookup
): Promise<HistoryBackfillResponse> {
  try {
    let raw: unknown
    try {
      raw = JSON.parse(payload ?? '')
    } catch {
      raw = undefined
    }
    const parsed = historyBackfillRequestSchema.safeParse(raw)
    if (!parsed.success || !isAbsolute(parsed.data.userDataPath)) {
      return invalidLaunch()
    }
    const userDataPath = realpathSync(parsed.data.userDataPath)
    host.setUserDataPath(userDataPath)
    // The maintenance owner is what stops a starting app from racing this write; the
    // single-instance lock is the second fence, forced on even for a launch form that
    // would normally bypass it.
    const maintenance = acquireProfileStateMaintenance(userDataPath)
    try {
      if (!host.acquireSingleInstanceLock()) {
        return {
          ok: false,
          code: 'runtime_error',
          message:
            'Stop Orca before `history backfill`: it writes the profile state database offline, and a running app would overwrite that write from memory. Quit Orca, run the command, then start Orca again.'
        }
      }
      const location = getActiveProfileStateLocation(userDataPath)
      if (!location) {
        return {
          ok: false,
          code: 'runtime_error',
          message:
            'Profile state has no active profile index. Start Orca once so this profile exists, stop it, then retry.'
        }
      }
      return {
        ok: true,
        result: await backfillTaskRecords({
          location,
          task: parsed.data.task,
          now: Date.now(),
          // The same two observations the archive snapshot is wired with; passing
          // them here is what keeps one resolver rule for both writers.
          sessionIndexLookup,
          transcriptCheck: createTranscriptCheckProbe()
        })
      }
    } finally {
      maintenance.release()
    }
  } catch (error) {
    return {
      ok: false,
      code: isHistoryBackfillCommandError(error) ? error.code : 'runtime_error',
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

function invalidLaunch(): HistoryBackfillResponse {
  return {
    ok: false,
    code: 'invalid_argument',
    message: 'Invalid history backfill launch. Run `orca history backfill --task <repo>#<number>`.'
  }
}

/** The refusal the deadline arm reports. It states the bound it hit and that the write,
 *  which always follows the scan, had not started. */
function deadlineExceeded(deadlineMs: number): HistoryBackfillResponse {
  return {
    ok: false,
    code: 'runtime_error',
    message: `history backfill did not finish within ${deadlineMs} ms, its upper bound for one bounded session scan and its write, so it was refused. Nothing was written: the run was still waiting for the session scan, which happens before the one profile-state write. Retry when the host is less busy; if it keeps happening, inspect this host's session scanner.`
  }
}

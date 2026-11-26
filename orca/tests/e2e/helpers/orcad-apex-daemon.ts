/**
 * Reclaim the **PTY daemon** an apex forked, and prove it is gone.
 *
 * Why this is needed at all: the daemon is detached on purpose (`main/orcad/orcad-daemon-supervision.ts`
 * calls `disconnectDaemon`, never `shutdownDaemon`), because a *product* restart must not kill every
 * terminal. That is the right behaviour for the product and the wrong outcome for an e2e case: after
 * `orcad` exits, one `daemon-entry.js` per case stays behind on the case's temp profile and, once that
 * profile is deleted, is unreachable by any later cleanup. Measured consequence on this host: 103
 * accumulated `out/orcad/daemon-entry.js` orphans between runs.
 *
 * How a daemon is **owned** — two conditions, both required, never a substring match:
 * 1. the pid is the one this profile published in its own pid record,
 *    `<daemonDir>/daemon-v38.pid` (JSON: `pid`, `launchNonce`, `entryPath` —
 *    `main/daemon/daemon-spawner.ts:139`), and
 * 2. that pid's command line carries **this profile's** `--socket <daemonDir>/daemon-v38.sock` and
 *    `--pid-record <daemonDir>/daemon-v38.pid` as whole arguments (`daemon-entry.ts:60-80`).
 *
 * Why whole arguments and the record: a pure cmdline-substring scan is not ownership. `.../daemon` is
 * a prefix of `.../daemon-other`, and `--inspect <daemonDir>` names the directory without being this
 * daemon's socket (both were W19 counterexamples that matched). The recorded pid is what rules out a
 * different instance, and the exact socket/pid-record arguments are what rule out a recycled pid.
 *
 * What happens when the two disagree: nothing is signalled. A missing pid record, a recorded pid that
 * is gone, a recorded pid that now belongs to another process (pid reuse), or a mismatched command
 * line all mean "this case has no reclaimable daemon" — and each of those appends a **note** so the
 * reason is recorded rather than silently swallowed.
 *
 * The stop follows the same rule as `real-agent-process.ts`: a signal that was merely sent is not a
 * reclaim. SIGTERM, then SIGKILL after the grace window, and the **exit has to be observed**; what
 * cannot be confirmed is thrown at the caller so a failed cleanup is reported, not skipped.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

export type ApexDaemonProcess = {
  pid: number
  commandLine: string
}

type ApexDaemonSeams = {
  /** Every live process on the host, keyed by pid. Injectable so the unit test needs no `ps`. */
  listProcesses?: () => Map<number, string>
  signal?: (pid: number, signal: NodeJS.Signals) => void
  sleep?: (ms: number) => Promise<void>
  /** Called for every "why there was nothing to reclaim" note, so a throw cannot lose them. */
  recordNote?: (note: string) => void
}

export type ReclaimApexDaemonsInput = {
  /** `<userDataDir>/daemon`: the profile-private directory holding socket, token and pid record. */
  daemonDir: string
  /** How long SIGTERM gets before SIGKILL (default 5 s: a daemon has no UI to restore). */
  graceMs?: number
  /** How long SIGKILL gets to be observed (default 3 s). */
  killGraceMs?: number
  pollMs?: number
  seams?: ApexDaemonSeams
}

export type ApexDaemonReclaim = {
  /** Pids this case signalled and then **observed** to exit. Never "signals sent". */
  reclaimed: number[]
  /** Owned daemons still in the process table when the last observation timed out. */
  surviving: ApexDaemonProcess[]
  /** Why a scan found nothing to reclaim (missing/foreign pid record...). Recorded, not silent. */
  notes: string[]
}

const DEFAULT_GRACE_MS = 5_000
const DEFAULT_KILL_GRACE_MS = 3_000
const DEFAULT_POLL_MS = 100
const DAEMON_ENTRY = 'daemon-entry.js'
/** Protocol-versioned names the daemon publishes in its own runtime dir (`daemon-spawner.ts:139-143`). */
const SOCKET_NAME = 'daemon-v38.sock'
const PID_RECORD_NAME = 'daemon-v38.pid'

/** `ps -eo pid=,args=` (or the PowerShell equivalent): pid → full command line. */
export function readProcessCommandLines(): Map<number, string> {
  if (process.platform === 'win32') {
    const stdout = execFileSync(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress'
      ],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, windowsHide: true }
    )
    const parsed = JSON.parse(stdout || '[]') as
      | { ProcessId?: unknown; CommandLine?: unknown }
      | { ProcessId?: unknown; CommandLine?: unknown }[]
    const rows = Array.isArray(parsed) ? parsed : [parsed]
    const lines = new Map<number, string>()
    for (const row of rows) {
      const pid = Number(row.ProcessId)
      if (Number.isInteger(pid) && typeof row.CommandLine === 'string') {
        lines.set(pid, row.CommandLine)
      }
    }
    return lines
  }
  const stdout = execFileSync('ps', ['-eo', 'pid=,args='], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024
  })
  const lines = new Map<number, string>()
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (match) {
      lines.set(Number(match[1]), match[2])
    }
  }
  return lines
}

export type ApexDaemonPidRecord = {
  pidFile: string
  pid: number
  entryPath: string | null
  launchNonce: string | null
}

export type ApexDaemonPidRecordRead = {
  record: ApexDaemonPidRecord | null
  /** Why no record could be used; set exactly when `record` is null. */
  problem: string | null
}

/**
 * This profile's own pid record — the identity half of the ownership fence. Returns the reason
 * instead of throwing, because "no record" is a note to record, not an exception to lose.
 */
export function readApexDaemonPidRecord(daemonDir: string): ApexDaemonPidRecordRead {
  const pidFile = path.join(daemonDir, PID_RECORD_NAME)
  if (!existsSync(daemonDir)) {
    return { record: null, problem: `the profile daemon dir ${daemonDir} does not exist: no daemon was forked` }
  }
  if (!existsSync(pidFile)) {
    return { record: null, problem: `no daemon pid record at ${pidFile}` }
  }
  try {
    const parsed = JSON.parse(readFileSync(pidFile, 'utf8')) as {
      pid?: unknown
      launchNonce?: unknown
      entryPath?: unknown
    }
    const pid = Number(parsed.pid)
    if (!Number.isInteger(pid)) {
      return { record: null, problem: `the daemon pid record ${pidFile} carries no usable pid` }
    }
    return {
      record: {
        pidFile,
        pid,
        entryPath: typeof parsed.entryPath === 'string' ? parsed.entryPath : null,
        launchNonce: typeof parsed.launchNonce === 'string' ? parsed.launchNonce : null
      },
      problem: null
    }
  } catch (error) {
    return {
      record: null,
      problem: `the daemon pid record ${pidFile} could not be read (${String(error)})`
    }
  }
}

/** Every pid record under the daemon dir, for evidence: what this profile published, and why. */
export function readApexDaemonPidRecords(
  daemonDir: string
): { pidFile: string; pid: number; launchNonce: string | null }[] {
  if (!existsSync(daemonDir)) {
    return []
  }
  const records: { pidFile: string; pid: number; launchNonce: string | null }[] = []
  for (const entry of readdirSync(daemonDir)) {
    if (!entry.endsWith('.pid')) {
      continue
    }
    const pidFile = path.join(daemonDir, entry)
    try {
      const parsed = JSON.parse(readFileSync(pidFile, 'utf8')) as {
        pid?: unknown
        launchNonce?: unknown
      }
      const pid = Number(parsed.pid)
      if (Number.isInteger(pid)) {
        records.push({
          pidFile,
          pid,
          launchNonce: typeof parsed.launchNonce === 'string' ? parsed.launchNonce : null
        })
      }
    } catch {
      // A record mid-replace is not evidence of a live daemon; the process scan decides.
    }
  }
  return records
}

/** True when `value` appears in `commandLine` as a **whole argument**, not as a path prefix. */
export function namesExactArgument(commandLine: string, value: string): boolean {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|[\\s"'])${escaped}(?=$|[\\s"'])`).test(commandLine)
}

/**
 * The command-line half of the ownership fence: the daemon entry plus **this profile's exact** socket
 * and pid-record paths. `.../daemon` is a prefix of `.../daemon-other`, so both are compared as whole
 * arguments and a mere mention of the directory (`--inspect <daemonDir>`) does not qualify.
 */
export function commandLineIsOwnDaemon(commandLine: string, daemonDir: string): boolean {
  return (
    commandLine.includes(DAEMON_ENTRY) &&
    namesExactArgument(commandLine, path.join(daemonDir, SOCKET_NAME)) &&
    namesExactArgument(commandLine, path.join(daemonDir, PID_RECORD_NAME))
  )
}

export type ApexDaemonScan = {
  /** The one process this case can prove it owns, or null: the only pid a signal may ever reach. */
  target: ApexDaemonProcess | null
  /** Every reason the scan concluded there was nothing (or something unattributable) to reclaim. */
  notes: string[]
}

/**
 * The ownership scan: pid record first, then the recorded pid's own command line. A process that is a
 * `daemon-entry.js` but **not** the recorded pid is reported, never targeted — a stale record must not
 * hide a live daemon, and a stranger must not be signalled because it mentions this directory.
 */
export function scanApexDaemon(
  daemonDir: string,
  commandLines: Map<number, string> = readProcessCommandLines()
): ApexDaemonScan {
  const notes: string[] = []
  const { record, problem } = readApexDaemonPidRecord(daemonDir)
  if (record === null) {
    notes.push(problem ?? `no usable daemon pid record under ${daemonDir}`)
    return { target: null, notes }
  }

  const recorded = commandLines.get(record.pid)
  let target: ApexDaemonProcess | null = null
  if (recorded === undefined) {
    notes.push(
      `the daemon pid record ${record.pidFile} names pid ${record.pid}, which is not in the process ` +
        'table: it already exited'
    )
  } else if (!commandLineIsOwnDaemon(recorded, daemonDir)) {
    notes.push(
      `the daemon pid record ${record.pidFile} names pid ${record.pid}, but that pid is another ` +
        `process now (pid reuse): not signalled\n${recorded}`
    )
  } else {
    target = { pid: record.pid, commandLine: recorded }
  }

  for (const [pid, commandLine] of commandLines) {
    if (pid === record.pid || !commandLine.includes(DAEMON_ENTRY) || !commandLine.includes(daemonDir)) {
      continue
    }
    notes.push(
      `pid ${pid} mentions ${daemonDir} but is not the pid ${record.pid} from the record: ` +
        `not signalled\n${commandLine}`
    )
  }
  return { target, notes }
}

/**
 * Stop this profile's daemon and confirm it is gone. Throws when it survives — the caller must report a
 * failed cleanup and keep the temp root, rather than deleting a directory a live daemon is still
 * writing into. Every observation re-checks the **same** pid against the same ownership fence, so a
 * process that appears later (or a recycled pid) is neither signalled nor reported as a survivor.
 */
export async function reclaimApexDaemons(
  input: ReclaimApexDaemonsInput
): Promise<ApexDaemonReclaim> {
  const seams = input.seams ?? {}
  const signal =
    seams.signal ??
    ((pid: number, value: NodeJS.Signals): void => {
      process.kill(pid, value)
    })
  const list = seams.listProcesses ?? readProcessCommandLines
  const sleep = seams.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const graceMs = input.graceMs ?? DEFAULT_GRACE_MS
  const killGraceMs = input.killGraceMs ?? DEFAULT_KILL_GRACE_MS
  const pollMs = input.pollMs ?? DEFAULT_POLL_MS

  const scan = scanApexDaemon(input.daemonDir, list())
  const notes = scan.notes
  for (const note of notes) {
    seams.recordNote?.(note)
  }
  const target = scan.target
  if (target === null) {
    return { reclaimed: [], surviving: [], notes }
  }

  const observe = (): ApexDaemonProcess | null => {
    const commandLine = list().get(target.pid)
    if (commandLine === undefined) {
      return null
    }
    if (!commandLineIsOwnDaemon(commandLine, input.daemonDir)) {
      // Our daemon exited and its pid went to something else: not our survivor, not our signal.
      const recycled = `pid ${target.pid} was recycled after our daemon exited: not signalled`
      if (!notes.includes(recycled)) {
        notes.push(recycled)
        seams.recordNote?.(recycled)
      }
      return null
    }
    return { pid: target.pid, commandLine }
  }

  const waitForGone = async (timeoutMs: number): Promise<ApexDaemonProcess | null> => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const survivor = observe()
      if (survivor === null) {
        return null
      }
      if (Date.now() > deadline) {
        return survivor
      }
      await sleep(pollMs)
    }
  }

  try {
    signal(target.pid, 'SIGTERM')
  } catch {
    // Already gone, or not ours to signal: the observation below is what decides.
  }
  let survivor = await waitForGone(graceMs)
  if (survivor === null) {
    return { reclaimed: [target.pid], surviving: [], notes }
  }
  try {
    signal(target.pid, 'SIGKILL')
  } catch {
    // Same: the second observation decides.
  }
  survivor = await waitForGone(killGraceMs)
  if (survivor === null) {
    return { reclaimed: [target.pid], surviving: [], notes }
  }
  const described = `pid ${survivor.pid}: ${survivor.commandLine}`
  const reason = notes.length > 0 ? `\nscan notes:\n${notes.join('\n')}` : ''
  throw new Error(
    `the apex daemon for ${input.daemonDir} was not reclaimed after SIGTERM+${graceMs}ms and ` +
      `SIGKILL+${killGraceMs}ms; it still appears in the process table:\n${described}${reason}`
  )
}

/**
 * The assertion form, for a caller that must not delete the profile it is checking: throws naming the
 * daemon of this profile that is still owned, and reports the scan notes when there was none.
 */
export async function assertNoApexDaemons(daemonDir: string): Promise<string[]> {
  const scan = scanApexDaemon(daemonDir)
  if (scan.target !== null) {
    const daemon = scan.target
    const survivor = `an apex daemon survived the case for ${daemonDir}:\npid ${daemon.pid}: ${daemon.commandLine}`
    const reason = scan.notes.length > 0 ? `\nscan notes:\n${scan.notes.join('\n')}` : ''
    throw new Error(`${survivor}${reason}`)
  }
  return scan.notes
}

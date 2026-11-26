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
 * How a daemon is identified — never by process name:
 * 1. the daemon's own pid record, `<userDataDir>/daemon/daemon-v<protocol>.pid` (JSON: `pid`,
 *    `launchNonce`, `entryPath` — `main/daemon/daemon-spawner.ts:20`), and
 * 2. its command line, which carries `daemon-entry.js` plus the **socket, token and pid-record paths
 *    of this profile** (`--socket <daemonDir>/daemon-v38.sock`).
 * Both have to name this case's daemon dir, so a pid that was reused by an unrelated process, or a
 * daemon serving the host's real profile, can neither be signalled nor counted as this case's.
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

const DEFAULT_GRACE_MS = 5_000
const DEFAULT_KILL_GRACE_MS = 3_000
const DEFAULT_POLL_MS = 100
const DAEMON_ENTRY = 'daemon-entry.js'

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

/**
 * Live `daemon-entry.js` processes **of this profile**: the daemon dir appears in the command line, so
 * the host's production daemon and any other case's daemon are out of scope by construction.
 */
export function listApexDaemons(
  daemonDir: string,
  commandLines: Map<number, string> = readProcessCommandLines()
): ApexDaemonProcess[] {
  return [...commandLines]
    .filter(([, commandLine]) => commandLine.includes(DAEMON_ENTRY) && commandLine.includes(daemonDir))
    .map(([pid, commandLine]) => ({ pid, commandLine }))
}

/** The daemon's own pid record, for evidence: which pid and launch nonce this profile published. */
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

async function waitForAbsent(
  daemonDir: string,
  seams: ApexDaemonSeams,
  timeoutMs: number,
  pollMs: number
): Promise<ApexDaemonProcess[]> {
  const list = seams.listProcesses ?? readProcessCommandLines
  const sleep = seams.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const remaining = listApexDaemons(daemonDir, list())
    if (remaining.length === 0 || Date.now() > deadline) {
      return remaining
    }
    await sleep(pollMs)
  }
}

/**
 * Stop this profile's daemon(s) and confirm they are gone. Throws when one survives — the caller must
 * report a failed cleanup and keep the temp root, rather than deleting a directory a live daemon is
 * still writing into.
 */
export async function reclaimApexDaemons(
  input: ReclaimApexDaemonsInput
): Promise<{ reclaimed: number[]; surviving: ApexDaemonProcess[] }> {
  const seams = input.seams ?? {}
  const signal =
    seams.signal ??
    ((pid: number, value: NodeJS.Signals): void => {
      process.kill(pid, value)
    })
  const graceMs = input.graceMs ?? DEFAULT_GRACE_MS
  const killGraceMs = input.killGraceMs ?? DEFAULT_KILL_GRACE_MS
  const pollMs = input.pollMs ?? DEFAULT_POLL_MS

  const initial = listApexDaemons(input.daemonDir, (seams.listProcesses ?? readProcessCommandLines)())
  if (initial.length === 0) {
    return { reclaimed: [], surviving: [] }
  }
  for (const target of initial) {
    try {
      signal(target.pid, 'SIGTERM')
    } catch {
      // Already gone, or not ours to signal: the observation below is what decides.
    }
  }
  let remaining = await waitForAbsent(input.daemonDir, seams, graceMs, pollMs)
  if (remaining.length > 0) {
    for (const target of remaining) {
      try {
        signal(target.pid, 'SIGKILL')
      } catch {
        // Same: the second observation decides.
      }
    }
    remaining = await waitForAbsent(input.daemonDir, seams, killGraceMs, pollMs)
  }
  if (remaining.length > 0) {
    const described = remaining
      .map((daemon) => `pid ${daemon.pid}: ${daemon.commandLine}`)
      .join('\n')
    throw new Error(
      `the apex daemon for ${input.daemonDir} was not reclaimed after SIGTERM+${graceMs}ms and ` +
        `SIGKILL+${killGraceMs}ms; it still appears in the process table:\n${described}`
    )
  }
  return { reclaimed: initial.map((daemon) => daemon.pid), surviving: [] }
}

/**
 * The assertion form, for a caller that must not delete the profile it is checking: throws naming
 * every surviving daemon of this profile.
 */
export async function assertNoApexDaemons(daemonDir: string): Promise<void> {
  const surviving = listApexDaemons(daemonDir)
  if (surviving.length > 0) {
    const described = surviving
      .map((daemon) => `pid ${daemon.pid}: ${daemon.commandLine}`)
      .join('\n')
    throw new Error(`an apex daemon survived the case for ${daemonDir}:\n${described}`)
  }
}

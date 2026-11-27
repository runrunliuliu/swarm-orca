/**
 * Record the **PTY daemon** an apex forked, and print the exact command that stops it. Never signal it.
 *
 * Why the daemon is still alive after the case: it is detached on purpose
 * (`main/orcad/orcad-daemon-supervision.ts` calls `disconnectDaemon`, never `shutdownDaemon`) because a
 * *product* restart must not kill every terminal. The e2e consequence is one `daemon-entry.js` per case
 * holding that case's temp profile; deleting the profile does not stop it.
 *
 * Why this no longer reclaims automatically (W25, after W19/W20/W22/W23/W24): every ownership test
 * this repo could build failed open. Argv content is not ownership (`--inspect <dir>` names the
 * directory without being the endpoint, both paths inside one `--message` argument are not options at
 * all). The kernel's group/session columns are not ownership either: a recycled pid can be the leader
 * of its own new session, and the start-tick/boot fence was only ever consulted when it happened to be
 * readable, so a missing or unreadable fence was silently accepted. The only thing the automation
 * bought was one fewer process after the run; the cost was a signal that could land on a process this
 * case does not own. So the whole path is gone — this module contains no `kill`, no process scan and
 * no ownership guess.
 *
 * What it does instead, all read-only:
 * 1. reads **this profile's own** pid record `<daemonDir>/daemon-v38.pid` (written by the daemon
 *    through `main/daemon/daemon-pid-file-parse.ts`);
 * 2. reports whether `<daemonDir>/daemon-v38.sock` still exists — a live daemon keeps its socket;
 * 3. reads the pid's process group from the kernel (`/proc/<pid>/stat` field 5, `ps -o pgid=` where
 *    there is no `/proc`) and prints **one** paste-ready command: `kill -TERM -<pgid>`, or
 *    `kill -TERM <pid>` when the group cannot be read.
 *
 * The printed command is a POSIX shell command, for exactly the pid on record: the operator decides
 * whether to run it, and the log line says which pid/pgid it belongs to.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

/** Protocol-versioned names the daemon publishes in its own runtime dir (`daemon-spawner.ts:139-143`). */
const PID_RECORD_NAME = 'daemon-v38.pid'
const SOCKET_NAME = 'daemon-v38.sock'

export type ApexDaemonSeams = {
  /** Kernel process group of a live pid; injectable so the unit test needs no `/proc` or `ps`. */
  readPgid?: (pid: number) => number | null
}

export type ApexDaemonLeftover = {
  /** `<userDataDir>/daemon`: the profile-private directory holding socket, token and pid record. */
  daemonDir: string
  /** The pid this profile's own record published, or null when there is no usable record. */
  pid: number | null
  /** Kernel process group of that pid, or null when it could not be read. */
  pgid: number | null
  /** Whether `daemon-v38.sock` is still there. Evidence, not an ownership test. */
  socketPresent: boolean
  /** The lines the teardown logs, in order. A record of what was seen. */
  lines: string[]
  /** The exact command to paste, or null when this profile names no pid. */
  cleanupCommand: string | null
}

/**
 * `/proc/<pid>/stat` field 5 (process group). Field 2 is `(comm)` and may contain spaces or
 * parentheses, so counting starts after the last ')': index 0 is then field 3 (state), 2 is field 5.
 */
function readLinuxPgid(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)
    const pgid = Number(fields[2])
    return Number.isInteger(pgid) ? pgid : null
  } catch {
    return null
  }
}

/** The pid's process group, read only. `ps` is the fallback for hosts without `/proc` (macOS). */
function readPgid(pid: number): number | null {
  if (process.platform === 'win32') {
    return null
  }
  const fromProc = readLinuxPgid(pid)
  if (fromProc !== null) {
    return fromProc
  }
  try {
    const stdout = execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' })
    const pgid = Number(stdout.trim())
    return Number.isInteger(pgid) ? pgid : null
  } catch {
    return null
  }
}

type PidRecordRead = { pid: number | null; problem: string | null }

/** This profile's own pid record: the only source of the pid whose command is printed. */
function readPidRecord(daemonDir: string): PidRecordRead {
  const pidFile = path.join(daemonDir, PID_RECORD_NAME)
  if (!existsSync(pidFile)) {
    return { pid: null, problem: `no pid record at ${pidFile}` }
  }
  try {
    const parsed = JSON.parse(readFileSync(pidFile, 'utf8')) as Record<string, unknown>
    const pid = Number(parsed.pid)
    return Number.isInteger(pid)
      ? { pid, problem: null }
      : { pid: null, problem: `the pid record ${pidFile} carries no usable pid` }
  } catch (error) {
    return { pid: null, problem: `the pid record ${pidFile} could not be read (${String(error)})` }
  }
}

/**
 * Record the daemon this profile forked: pid, process group and the command that stops it.
 *
 * Never throws, never signals and never gates anything else: a profile that forked no daemon dir gets
 * no lines at all, and one whose pid record is missing or unreadable gets a "no pid record" line with
 * no command — because guessing a pid here is exactly the failure mode this module retired.
 */
export function recordLeftoverApexDaemon(
  daemonDir: string,
  seams: ApexDaemonSeams = {}
): ApexDaemonLeftover {
  const socketPath = path.join(daemonDir, SOCKET_NAME)
  if (!existsSync(daemonDir)) {
    return {
      daemonDir,
      pid: null,
      pgid: null,
      socketPresent: false,
      lines: [],
      cleanupCommand: null
    }
  }
  const socketPresent = existsSync(socketPath)
  const socketNote = `socket ${socketPath} ${socketPresent ? 'present' : 'absent'}`
  const { pid, problem } = readPidRecord(daemonDir)
  if (pid === null) {
    return {
      daemonDir,
      pid: null,
      pgid: null,
      socketPresent,
      cleanupCommand: null,
      lines: [
        `e2e daemon left running: no pid record (${problem}; ${socketNote}); nothing was signalled`,
        'e2e daemon cleanup: none printed, because this profile names no pid'
      ]
    }
  }
  const pgid = (seams.readPgid ?? readPgid)(pid)
  const cleanupCommand = pgid === null ? `kill -TERM ${pid}` : `kill -TERM -${pgid}`
  return {
    daemonDir,
    pid,
    pgid,
    socketPresent,
    cleanupCommand,
    lines: [
      `e2e daemon left running: pid=${pid} pgid=${pgid === null ? 'unknown' : pgid} ` +
        '(product keeps the PTY daemon alive by design)',
      `e2e daemon record: ${path.join(daemonDir, PID_RECORD_NAME)} ${socketNote}`,
      `e2e daemon cleanup (copy-paste): ${cleanupCommand}`
    ]
  }
}

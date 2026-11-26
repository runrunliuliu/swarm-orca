/**
 * Reclaim the **PTY daemon** an apex forked, and prove it is gone — by **process group**.
 *
 * Why the daemon has to be reclaimed at all: it is detached on purpose
 * (`main/orcad/orcad-daemon-supervision.ts` calls `disconnectDaemon`, never `shutdownDaemon`) because a
 * *product* restart must not kill every terminal. The e2e consequence is one `daemon-entry.js` per case
 * holding that case's temp profile; once the profile is deleted the process is unreachable by any later
 * cleanup. Measured on this host: 103 accumulated `out/orcad/daemon-entry.js` orphans between runs.
 *
 * Why ownership is a process group and no longer a command line: W19, W20 and W22 each tried to *infer*
 * ownership from argv, and each was refuted by a counterexample (`--inspect <daemonDir>` names the
 * directory without being the endpoint, `--entry daemon-entry.js` is not the daemon entry argument, and
 * both paths inside one `--message` argument are not options at all). Content cannot prove ownership.
 * The kernel can: `main/daemon/daemon-launched-child-spawn.ts:71` spawns the daemon with
 * `detached: true`, so the daemon leads its own session and process group (`pgid === sid === pid`,
 * measured on this host), and a process group can only be joined by the leader's own descendants.
 * The case therefore stops `kill(-pgid)` and nothing else.
 *
 * What still has to be established, from kernel facts only (never from a command line):
 * 1. the pid comes from **this profile's own pid record** — `<daemonDir>/daemon-v38.pid` inside a
 *    directory this case created with `mkdtemp`;
 * 2. that pid is still **its own session and process-group leader** (`pgid === sid === pid`), which is
 *    what a recycled pid is not;
 * 3. it is still the same *instance*: the record's `linuxStartTicks`/`bootId`
 *    (`main/daemon/daemon-pid-file-parse.ts`) are compared with `/proc/<pid>/stat` field 22 and
 *    `/proc/sys/kernel/random/boot_id`, which pid reuse cannot forge.
 *
 * Any of those failing means "not attributable": **nothing is signalled**, the reason is recorded, and
 * the reclaim throws so the caller keeps the profile. A leader that has already exited while session
 * members remain is still reclaimable — such members can only be its descendants.
 *
 * Windows has no POSIX process groups, so `readProcessTable` reports `pgid: null` there and the
 * identification refuses (throws, profile kept) instead of guessing a tree from parent links.
 *
 * The stop follows the same rule as `real-agent-process.ts`: a signal that was merely sent is not a
 * reclaim. SIGTERM the unit, observe it gone, SIGKILL it, observe again; what cannot be observed gone is
 * thrown at the caller instead of being reported as a cleanup.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

export type ApexDaemonProcessEntry = {
  pid: number
  /** Kernel process group; `null` where the platform has none (Windows). */
  pgid: number | null
  /** Kernel session id; `null` where the platform has none (Windows). */
  sid: number | null
  /** Evidence for a failure message. Never an ownership test. */
  commandLine: string
}

/** The unit this case owns: the detached daemon's session, which is also its process group. */
export type ApexDaemonInstance = {
  /** Process group and session id: `kill(-groupId)` reaches the unit in one call. */
  groupId: number
  /** The pid this profile's pid record published: the leader of that unit. */
  pid: number
  /** Every live pid of that session/group when the unit was identified. */
  members: number[]
}

type ApexDaemonSeams = {
  /** The live process table, keyed by pid. Injectable so the unit test needs no `ps`. */
  listProcesses?: () => Map<number, ApexDaemonProcessEntry>
  /** Signal the whole owned unit (group plus session members). */
  signalUnit?: (instance: ApexDaemonInstance, signal: NodeJS.Signals) => void
  /** True while the kernel still has a process in that group (`kill(-pgid, 0)` without ESRCH). */
  unitIsAlive?: (groupId: number) => boolean
  /** `/proc/<pid>/stat` field 22, the per-instance fence. */
  readStartTicks?: (pid: number) => string | null
  readBootId?: () => string | null
  sleep?: (ms: number) => Promise<void>
  /** Called for every note, so a throw cannot lose the reasons. */
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
  /** Pids of the owned unit, every one of them **observed** gone. Never "signals sent". */
  reclaimed: number[]
  /** Owned unit rows still in the process table when the last observation timed out. */
  surviving: ApexDaemonProcessEntry[]
  /** Why the reclaim went the way it did. Recorded, not silent. */
  notes: string[]
}

const DEFAULT_GRACE_MS = 5_000
const DEFAULT_KILL_GRACE_MS = 3_000
const DEFAULT_POLL_MS = 100
/** Protocol-versioned name the daemon publishes in its own runtime dir (`daemon-spawner.ts:139-143`). */
const PID_RECORD_NAME = 'daemon-v38.pid'

function readWindowsCommandLines(): Map<number, string> {
  const args = [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress'
  ]
  const stdout = execFileSync('powershell.exe', args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true
  })
  const parsed = JSON.parse(stdout || '[]') as
    | { ProcessId?: unknown; CommandLine?: unknown }
    | { ProcessId?: unknown; CommandLine?: unknown }[]
  const lines = new Map<number, string>()
  for (const row of Array.isArray(parsed) ? parsed : [parsed]) {
    const pid = Number(row.ProcessId)
    if (Number.isInteger(pid) && typeof row.CommandLine === 'string') {
      lines.set(pid, row.CommandLine)
    }
  }
  return lines
}

/**
 * The live process table with the kernel's own group/session columns.
 *
 * `pgid`/`sid` are `null` on Windows, which has no POSIX process groups: the identification below then
 * refuses to signal instead of guessing a tree from parent links.
 */
export function readProcessTable(): Map<number, ApexDaemonProcessEntry> {
  const table = new Map<number, ApexDaemonProcessEntry>()
  if (process.platform === 'win32') {
    for (const [pid, commandLine] of readWindowsCommandLines()) {
      table.set(pid, { pid, pgid: null, sid: null, commandLine })
    }
    return table
  }
  const stdout = execFileSync('ps', ['-eo', 'pid=,ppid=,pgid=,sid=,args='], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024
  })
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (match) {
      const pid = Number(match[1])
      table.set(pid, { pid, pgid: Number(match[3]), sid: Number(match[4]), commandLine: match[5] })
    }
  }
  return table
}

/**
 * `/proc/<pid>/stat` field 22: this boot's tick count at which the pid started. Field 2 is `(comm)` and
 * may contain spaces or parentheses, so counting starts after the last ')' (index 19 is then field 22).
 */
function readLinuxStartTicks(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[19] ?? null
  } catch {
    return null
  }
}

const readLinuxBootId = (): string | null => {
  try {
    return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
  } catch {
    return null
  }
}

export type ApexDaemonPidRecord = {
  pidFile: string
  pid: number
  entryPath: string | null
  launchNonce: string | null
  /** Kernel instance fence written by the daemon itself (`daemon-pid-file-parse.ts`). */
  linuxStartTicks: string | null
  bootId: string | null
}

export type ApexDaemonPidRecordRead = {
  record: ApexDaemonPidRecord | null
  /** Why no record could be used; set exactly when `record` is null. */
  problem: string | null
}

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null)

/** This profile's own pid record: the only source of the pid this case may ever signal. */
export function readApexDaemonPidRecord(daemonDir: string): ApexDaemonPidRecordRead {
  const pidFile = path.join(daemonDir, PID_RECORD_NAME)
  if (!existsSync(daemonDir)) {
    const problem = `the profile daemon dir ${daemonDir} does not exist: no daemon was forked`
    return { record: null, problem }
  }
  if (!existsSync(pidFile)) {
    return { record: null, problem: `no daemon pid record at ${pidFile}` }
  }
  try {
    const parsed = JSON.parse(readFileSync(pidFile, 'utf8')) as Record<string, unknown>
    const pid = Number(parsed.pid)
    if (!Number.isInteger(pid)) {
      return { record: null, problem: `the daemon pid record ${pidFile} carries no usable pid` }
    }
    const record = {
      pidFile,
      pid,
      entryPath: text(parsed.entryPath),
      launchNonce: text(parsed.launchNonce),
      linuxStartTicks: text(parsed.linuxStartTicks),
      bootId: text(parsed.bootId)
    }
    return { record, problem: null }
  } catch (error) {
    return {
      record: null,
      problem: `the daemon pid record ${pidFile} could not be read (${String(error)})`
    }
  }
}

export type ApexDaemonIdentification = {
  /** The unit this case owns, or null when it provably has none left. */
  instance: ApexDaemonInstance | null
  notes: string[]
  /** Set exactly when ownership could not be established: the caller must not signal anything. */
  unconfirmed: string | null
}

/**
 * Establish **which process group** this profile's daemon owns — from the profile's own pid record plus
 * the kernel's group/session columns and the record's instance fence. Never from a command line.
 */
export function identifyApexDaemonGroup(
  daemonDir: string,
  table: Map<number, ApexDaemonProcessEntry> = readProcessTable(),
  seams: ApexDaemonSeams = {}
): ApexDaemonIdentification {
  const notes: string[] = []
  const { record, problem } = readApexDaemonPidRecord(daemonDir)
  // "No record" is not "no daemon": the profile dir exists, so something may hold it. Not signalable.
  if (record === null) {
    return { instance: null, notes, unconfirmed: problem ?? `no usable pid record under ${daemonDir}` }
  }
  const groupId = record.pid
  const rows = [...table.values()].filter((e) => e.pgid === groupId || e.sid === groupId)
  const members = rows.map((e) => e.pid)
  const confirm = (members2: number[]): ApexDaemonIdentification => ({
    instance: { groupId, pid: groupId, members: members2 },
    notes,
    unconfirmed: null
  })
  const refuse = (unconfirmed: string): ApexDaemonIdentification => ({ instance: null, notes, unconfirmed })
  const leader = table.get(groupId)
  if (leader === undefined) {
    if (members.length === 0) {
      notes.push(
        `the daemon pid record ${record.pidFile} names pid ${groupId}, which is gone from the process ` +
          'table with no session or group member left: it already exited'
      )
      return { instance: null, notes, unconfirmed: null }
    }
    notes.push(
      `the daemon pid record ${record.pidFile} names pid ${groupId}, which already exited; ` +
        `${members.length} process(es) of its session remain (${members.join(', ')}), which can only ` +
        'be its descendants: reclaiming the group'
    )
    return confirm(members)
  }
  if (leader.pgid !== groupId || leader.sid !== groupId) {
    return refuse(
      `the daemon pid record ${record.pidFile} names pid ${groupId}, but that pid no longer leads its ` +
        `own session and process group (pgid ${String(leader.pgid)}, sid ${String(leader.sid)}): pid ` +
        `reuse, not this case's daemon\n${leader.commandLine}`
    )
  }
  const ticks = record.linuxStartTicks
  if (ticks !== null) {
    const actual = (seams.readStartTicks ?? readLinuxStartTicks)(groupId)
    if (actual !== null && actual !== ticks) {
      return refuse(
        `the daemon pid record ${record.pidFile} names pid ${groupId}, but that pid started at tick ` +
          `${actual} and the record says ${ticks}: pid reuse`
      )
    }
  }
  const bootId = record.bootId
  if (bootId !== null) {
    const current = (seams.readBootId ?? readLinuxBootId)()
    if (current !== null && current !== bootId) {
      return refuse(
        `the daemon pid record ${record.pidFile} was written under boot ${bootId} but this host ` +
          `booted as ${current}: pid reuse`
      )
    }
  }
  return confirm(members)
}

/** Signal the owned unit: the group in one `kill(-pgid)`, then each session member by pid. */
function signalApexDaemonUnit(instance: ApexDaemonInstance, signal: NodeJS.Signals): void {
  try {
    process.kill(-instance.groupId, signal)
  } catch {
    // ESRCH (already gone) or EPERM (not ours to signal): the observation below decides.
  }
  for (const pid of instance.members) {
    try {
      // A job-control group inside the same session has its own pgid, which `-pgid` does not reach.
      process.kill(pid, signal)
    } catch {
      // Same.
    }
  }
}

function apexDaemonUnitIsAlive(groupId: number): boolean {
  try {
    process.kill(-groupId, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

const describeUnit = (rows: ApexDaemonProcessEntry[]): string =>
  rows.map((r) => `pid ${r.pid} (pgid ${String(r.pgid)}, sid ${String(r.sid)}): ${r.commandLine}`).join('\n')

/**
 * Stop this profile's daemon group and confirm it is gone. Throws when it survives **or when ownership
 * cannot be established** — the caller must report a failed cleanup and keep the temp root, rather than
 * deleting a directory a live daemon is still writing into.
 */
export async function reclaimApexDaemons(input: ReclaimApexDaemonsInput): Promise<ApexDaemonReclaim> {
  const seams = input.seams ?? {}
  const list = seams.listProcesses ?? readProcessTable
  const signalUnit = seams.signalUnit ?? signalApexDaemonUnit
  const unitIsAlive = seams.unitIsAlive ?? apexDaemonUnitIsAlive
  const sleep = seams.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const graceMs = input.graceMs ?? DEFAULT_GRACE_MS
  const killGraceMs = input.killGraceMs ?? DEFAULT_KILL_GRACE_MS
  const pollMs = input.pollMs ?? DEFAULT_POLL_MS

  const identification = identifyApexDaemonGroup(input.daemonDir, list(), seams)
  const notes = identification.notes
  for (const note of notes) {
    seams.recordNote?.(note)
  }
  if (identification.unconfirmed !== null) {
    throw new Error(
      `cannot establish which process group belongs to the apex daemon for ${input.daemonDir} ` +
        `(nothing was signalled and the profile is kept):\n${identification.unconfirmed}`
    )
  }
  const instance = identification.instance
  if (instance === null) {
    return { reclaimed: [], surviving: [], notes }
  }

  const groupId = instance.groupId
  const owned = instance.members.length > 0 ? instance.members : [instance.pid]
  const observeUnit = (): ApexDaemonProcessEntry[] => {
    const rows = [...list().values()].filter((e) => e.pgid === groupId || e.sid === groupId)
    if (rows.length > 0 || !unitIsAlive(groupId)) {
      return rows
    }
    // The group answers signal 0 but the snapshot has no row for it: still alive, still ours.
    return [{ pid: groupId, pgid: groupId, sid: groupId, commandLine: 'answers signal 0; no row matched it' }]
  }
  const waitForGone = async (timeoutMs: number): Promise<ApexDaemonProcessEntry[] | null> => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const survivors = observeUnit()
      if (survivors.length === 0) {
        return null
      }
      if (Date.now() > deadline) {
        return survivors
      }
      await sleep(pollMs)
    }
  }

  signalUnit(instance, 'SIGTERM')
  let survivors = await waitForGone(graceMs)
  if (survivors !== null) {
    signalUnit(instance, 'SIGKILL')
    survivors = await waitForGone(killGraceMs)
  }
  if (survivors === null) {
    return { reclaimed: owned, surviving: [], notes }
  }
  const reason = notes.length > 0 ? `\nscan notes:\n${notes.join('\n')}` : ''
  throw new Error(
    `the apex daemon process group ${groupId} for ${input.daemonDir} was not reclaimed after ` +
      `SIGTERM+${graceMs}ms and SIGKILL+${killGraceMs}ms; it still appears in the process table:\n` +
      `${describeUnit(survivors)}${reason}`
  )
}

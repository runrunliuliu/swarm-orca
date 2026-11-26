/**
 * The daemon reclaim rule, driven with a fake process table: no `ps`, no daemon, no product state.
 *
 * Why these cases: the ways this cleanup can be wrong are (a) signalling a process that is not this
 * profile's daemon — the host's own runtime daemon is one `ps` away — and (b) reporting a reclaim after
 * sending a signal the process ignored. Both are visible here without a daemon.
 *
 * W23: ownership is the **process group** of the pid this profile published, never a command line. W19
 * (`--inspect <dir>` names the directory), W20 (whole-argument matching) and W22 (`--entry
 * daemon-entry.js`, both paths inside one `--message` argument) were all refuted by counterexamples,
 * which is why the last case here drives a stranger whose command line is byte-for-byte our daemon's:
 * content is not ownership, the kernel's group/session columns are.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  identifyApexDaemonGroup,
  reclaimApexDaemons,
  type ApexDaemonProcessEntry
} from './orcad-apex-daemon'

const profiles: string[] = []

type RecordOptions = { pid: number; startTicks?: string | null; bootId?: string | null }

/** A profile daemon dir as the apex would leave it: socket/token names plus a pid record. */
function makeProfile(record: RecordOptions | null): { root: string; daemonDir: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'orca-daemon-unit-'))
  const daemonDir = path.join(root, 'userdata', 'daemon')
  mkdirSync(daemonDir, { recursive: true })
  if (record !== null) {
    writeFileSync(
      path.join(daemonDir, 'daemon-v38.pid'),
      JSON.stringify({
        pid: record.pid,
        launchNonce: 'unit-launch',
        entryPath: '/tmp/orca-e2e-case/apex/daemon-entry.js',
        ...(record.startTicks === undefined || record.startTicks === null
          ? {}
          : { linuxStartTicks: record.startTicks }),
        ...(record.bootId === undefined || record.bootId === null ? {} : { bootId: record.bootId })
      })
    )
  }
  profiles.push(root)
  return { root, daemonDir }
}

/** The command line of the daemon a case leaves behind; used as *evidence text* only. */
function daemonCommand(daemonDir: string): string {
  return (
    '/tmp/orca-e2e-case/apex/bun-runtime /tmp/orca-e2e-case/apex/daemon-entry.js ' +
    `--socket ${daemonDir}/daemon-v38.sock --token ${daemonDir}/daemon-v38.token ` +
    `--pid-record ${daemonDir}/daemon-v38.pid --app-version 1.4.219`
  )
}

/** One process-table row, defaulting to "a normal non-leader process". */
function row(
  pid: number,
  overrides: Partial<ApexDaemonProcessEntry> = {}
): ApexDaemonProcessEntry {
  return { pid, pgid: pid, sid: pid, commandLine: `node /tmp/p${pid}.js`, ...overrides }
}

type FakeHost = {
  table: Map<number, ApexDaemonProcessEntry>
  signalled: { groupId: number; pids: number[]; signal: NodeJS.Signals }[]
  notes: string[]
  seams: Parameters<typeof reclaimApexDaemons>[0]['seams']
}

/**
 * A process table plus a kernel that honours (or ignores) signals per signal name. Killed rows leave the
 * table, like a real exit; `unitIsAlive` is derived from the table so the two cannot disagree.
 */
function fakeHost(
  entries: ApexDaemonProcessEntry[],
  honours: (signal: NodeJS.Signals) => boolean = () => true
): FakeHost {
  const table = new Map(entries.map((entry) => [entry.pid, entry]))
  const signalled: FakeHost['signalled'] = []
  const notes: string[] = []
  return {
    table,
    signalled,
    notes,
    seams: {
      listProcesses: () => new Map(table),
      signalUnit: (instance, signal) => {
        signalled.push({ groupId: instance.groupId, pids: instance.members, signal })
        if (!honours(signal)) {
          return
        }
        for (const [pid, entry] of table) {
          if (entry.pgid === instance.groupId || entry.sid === instance.groupId) {
            table.delete(pid)
          }
        }
      },
      unitIsAlive: (groupId) =>
        [...table.values()].some((entry) => entry.pgid === groupId || entry.sid === groupId),
      // The wait loop is about observation, not wall-clock time.
      sleep: () => Promise.resolve(),
      recordNote: (note) => notes.push(note)
    }
  }
}

afterEach(() => {
  for (const root of profiles.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('identifyApexDaemonGroup', () => {
  it('takes the recorded pid as the owned group when the kernel still shows it leading its own session', () => {
    const { daemonDir } = makeProfile({ pid: 11 })
    const table = new Map<number, ApexDaemonProcessEntry>([
      [11, row(11, { commandLine: daemonCommand(daemonDir) })],
      // A second member of the same session (a PTY child in its own job-control group).
      [12, row(12, { pgid: 12, sid: 11 })],
      // The host's own runtime daemon: a daemon-entry process that is not this profile's group.
      [13, row(13, { commandLine: daemonCommand('/home/somebody/.local/state/orca/daemon') })]
    ])

    const identification = identifyApexDaemonGroup(daemonDir, table)

    expect(identification.unconfirmed).toBeNull()
    expect(identification.instance).toEqual({ groupId: 11, pid: 11, members: [11, 12] })
    expect(identification.notes).toEqual([])
  })

  it('refuses a recorded pid that no longer leads its own group (pid reuse)', () => {
    const { daemonDir } = makeProfile({ pid: 11 })
    // The daemon exited; the kernel handed pid 11 to an unrelated, non-leader process.
    const table = new Map<number, ApexDaemonProcessEntry>([
      [11, row(11, { pgid: 900, sid: 900, commandLine: 'node /tmp/unrelated-worker.js --serve' })]
    ])

    const identification = identifyApexDaemonGroup(daemonDir, table)

    expect(identification.instance).toBeNull()
    expect(identification.unconfirmed).toMatch(/pid reuse/)
    expect(identification.unconfirmed).toMatch(/pid 11/)
  })

  it('refuses when the kernel start tick of the recorded pid disagrees with the record', () => {
    const { daemonDir } = makeProfile({ pid: 11, startTicks: '100', bootId: 'boot-a' })
    const table = new Map<number, ApexDaemonProcessEntry>([[11, row(11)]])

    const identification = identifyApexDaemonGroup(daemonDir, table, {
      readStartTicks: () => '222',
      readBootId: () => 'boot-a'
    })

    expect(identification.unconfirmed).toMatch(/started at tick 222 and the record says 100/)
  })

  it('refuses when the record was written under another boot', () => {
    const { daemonDir } = makeProfile({ pid: 11, startTicks: '100', bootId: 'boot-a' })
    const table = new Map<number, ApexDaemonProcessEntry>([[11, row(11)]])

    const identification = identifyApexDaemonGroup(daemonDir, table, {
      readStartTicks: () => '100',
      readBootId: () => 'boot-b'
    })

    expect(identification.unconfirmed).toMatch(/written under boot boot-a but this host booted as boot-b/)
  })

  it('still reclaims the group of a leader that exited while its session members remain', () => {
    const { daemonDir } = makeProfile({ pid: 11 })
    const table = new Map<number, ApexDaemonProcessEntry>([[12, row(12, { pgid: 12, sid: 11 })]])

    const identification = identifyApexDaemonGroup(daemonDir, table)

    expect(identification.unconfirmed).toBeNull()
    expect(identification.instance).toMatchObject({ groupId: 11, members: [12] })
    expect(identification.notes.join('\n')).toMatch(/can only be its descendants/)
  })

  it('reports "already exited" only when neither the leader nor any session member is left', () => {
    const { daemonDir } = makeProfile({ pid: 11 })

    const identification = identifyApexDaemonGroup(daemonDir, new Map())

    expect(identification.instance).toBeNull()
    expect(identification.unconfirmed).toBeNull()
    expect(identification.notes.join('\n')).toMatch(/already exited/)
  })

  it('cannot confirm ownership without a pid record, and says why', () => {
    const { daemonDir } = makeProfile(null)

    const identification = identifyApexDaemonGroup(daemonDir, new Map())

    expect(identification.instance).toBeNull()
    expect(identification.unconfirmed).toMatch(/no daemon pid record/)
  })
})

describe('reclaimApexDaemons', () => {
  it('recovers the group with SIGTERM and confirms the whole unit is gone', async () => {
    const { daemonDir } = makeProfile({ pid: 11 })
    const host = fakeHost([
      row(11, { commandLine: daemonCommand(daemonDir) }),
      row(12, { pgid: 12, sid: 11 })
    ])

    const result = await reclaimApexDaemons({ daemonDir, seams: host.seams })

    expect(result.surviving).toEqual([])
    expect(result.reclaimed).toEqual([11, 12])
    expect(host.signalled).toEqual([{ groupId: 11, pids: [11, 12], signal: 'SIGTERM' }])
    expect(host.table.size).toBe(0)
  })

  it('escalates to SIGKILL for a session member that ignores SIGTERM, and still confirms the exit', async () => {
    const { daemonDir } = makeProfile({ pid: 11 })
    const host = fakeHost(
      [row(11, { commandLine: daemonCommand(daemonDir) }), row(12, { pgid: 12, sid: 11 })],
      (signal) => signal === 'SIGKILL'
    )

    const result = await reclaimApexDaemons({ daemonDir, seams: host.seams })

    expect(host.signalled.map((entry) => entry.signal)).toEqual(['SIGTERM', 'SIGKILL'])
    expect(result.surviving).toEqual([])
    expect(host.table.size).toBe(0)
  })

  it('does not signal anything when the recorded pid belongs to another process now, and keeps the profile', async () => {
    const { daemonDir, root } = makeProfile({ pid: 11 })
    const host = fakeHost([
      row(11, { pgid: 900, sid: 900, commandLine: 'node /tmp/unrelated-worker.js --serve' })
    ])

    const error = await reclaimApexDaemons({ daemonDir, seams: host.seams }).catch(
      (reason: unknown) => reason
    )

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(/cannot establish which process group belongs/)
    expect((error as Error).message).toMatch(/pid reuse/)
    // Nothing was signalled and the stranger is untouched: the profile is the evidence, so it stays.
    expect(host.signalled).toEqual([])
    expect(host.table.has(11)).toBe(true)
    expect(existsSync(root)).toBe(true)
  })

  it('throws, names the survivor and keeps the profile when a session member outlives both signals', async () => {
    const { daemonDir, root } = makeProfile({ pid: 11 })
    const host = fakeHost([row(11, { commandLine: daemonCommand(daemonDir) })], () => false)

    const error = await reclaimApexDaemons({ daemonDir, seams: host.seams }).catch(
      (reason: unknown) => reason
    )

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(
      /was not reclaimed after SIGTERM\+5000ms and SIGKILL\+3000ms/
    )
    expect((error as Error).message).toMatch(/pid 11 \(pgid 11, sid 11\): .*daemon-entry\.js/)
    expect(host.table.has(11)).toBe(true)
    expect(existsSync(root)).toBe(true)
  })

  it('never signals a stranger whose command line is byte-for-byte this daemon’s', async () => {
    const { daemonDir } = makeProfile({ pid: 11 })
    // W22's counterexamples, taken to the limit: same entry, same --socket, same --pid-record, but not
    // the recorded group. Ownership is the kernel's group identity, not the text.
    const host = fakeHost([
      row(11, { pgid: 900, sid: 900, commandLine: daemonCommand(daemonDir) }),
      row(12, { commandLine: daemonCommand(daemonDir) })
    ])

    const error = await reclaimApexDaemons({ daemonDir, seams: host.seams }).catch(
      (reason: unknown) => reason
    )

    expect(error).toBeInstanceOf(Error)
    expect(host.signalled).toEqual([])
    expect(host.table.size).toBe(2)
  })

  it('reclaims a group whose leader already exited, without touching a stranger that mentions the dir', async () => {
    const { daemonDir } = makeProfile({ pid: 11 })
    const host = fakeHost([
      row(12, { pgid: 12, sid: 11, commandLine: daemonCommand(daemonDir) }),
      row(13, { commandLine: daemonCommand(daemonDir) })
    ])

    const result = await reclaimApexDaemons({ daemonDir, seams: host.seams })

    expect(result.reclaimed).toEqual([12])
    expect(host.signalled).toEqual([{ groupId: 11, pids: [12], signal: 'SIGTERM' }])
    expect(host.table.has(13)).toBe(true)
  })

  it('reports "nothing to reclaim" only when the recorded group provably exited', async () => {
    const { daemonDir } = makeProfile({ pid: 11 })
    const host = fakeHost([])

    const result = await reclaimApexDaemons({ daemonDir, seams: host.seams })

    expect(result).toEqual({ reclaimed: [], surviving: [], notes: expect.any(Array) })
    expect(result.notes.join('\n')).toMatch(/already exited/)
    expect(host.signalled).toEqual([])
    expect(host.notes).toEqual(result.notes)
  })

  it('throws instead of reporting a pass when the profile published no pid record', async () => {
    const { daemonDir, root } = makeProfile(null)
    const host = fakeHost([row(12, { commandLine: daemonCommand(daemonDir) })])

    const error = await reclaimApexDaemons({ daemonDir, seams: host.seams }).catch(
      (reason: unknown) => reason
    )

    // W22/B2: "no record" is an unknown owner, not a confirmed exit. It must not read as success.
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(/no daemon pid record/)
    expect(host.signalled).toEqual([])
    expect(host.table.has(12)).toBe(true)
    expect(existsSync(root)).toBe(true)
  })
})

/**
 * The daemon reclaim rule, driven with a fake process table: no `ps`, no daemon, no product state.
 *
 * Why these cases: the ways this cleanup can be wrong are (a) signalling a process that is not this
 * profile's daemon — the host's real runtime daemon is one `ps` away — and (b) reporting a reclaim
 * after sending a signal the process ignored. Both are visible here without a daemon.
 *
 * W20: the identity half is a real pid record on disk, because that is what the fence reads. W19's
 * counterexamples (`--inspect <dir>` naming the directory, `daemon-other/...` sharing a prefix) were
 * pure-logic false positives; a pid record that is missing, or that names a pid now belonging to
 * someone else, has to end in "nothing to reclaim, for this recorded reason" — never in a signal.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  commandLineIsOwnDaemon,
  namesExactArgument,
  reclaimApexDaemons,
  scanApexDaemon
} from './orcad-apex-daemon'

const profiles: string[] = []

/** A profile daemon dir as the apex would leave it: socket/token names plus a pid record. */
function makeProfile(recordPid: number | null): { root: string; daemonDir: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), 'orca-daemon-unit-'))
  const daemonDir = path.join(root, 'userdata', 'daemon')
  mkdirSync(daemonDir, { recursive: true })
  if (recordPid !== null) {
    writeFileSync(
      path.join(daemonDir, 'daemon-v38.pid'),
      JSON.stringify({
        pid: recordPid,
        launchNonce: 'unit-launch',
        entryPath: '/tmp/orca-e2e-case/apex/daemon-entry.js'
      })
    )
  }
  profiles.push(root)
  return { root, daemonDir }
}

function daemonCommand(
  daemonDir: string,
  options: { entry?: string; extra?: string } = {}
): string {
  const entry = options.entry ?? '/tmp/orca-e2e-case/apex/daemon-entry.js'
  return (
    `/tmp/orca-e2e-case/apex/bun-runtime ${entry} ` +
    `--socket ${daemonDir}/daemon-v38.sock --token ${daemonDir}/daemon-v38.token ` +
    `--pid-record ${daemonDir}/daemon-v38.pid --app-version 1.4.219${options.extra ?? ''}`
  )
}

type FakeHost = {
  table: Map<number, string>
  signalled: { pid: number; signal: NodeJS.Signals }[]
  notes: string[]
  /** Signals the fake process honours; anything else is ignored, like a real stuck daemon. */
  honours: (signal: NodeJS.Signals) => boolean
  seams: Parameters<typeof reclaimApexDaemons>[0]['seams']
}

function fakeHost(
  entries: [number, string][],
  honours: (s: NodeJS.Signals) => boolean = () => true
): FakeHost {
  const table = new Map(entries)
  const signalled: { pid: number; signal: NodeJS.Signals }[] = []
  const notes: string[] = []
  return {
    table,
    signalled,
    notes,
    honours,
    seams: {
      listProcesses: () => new Map(table),
      signal: (pid, signal) => {
        signalled.push({ pid, signal })
        if (honours(signal)) {
          table.delete(pid)
        }
      },
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

describe('the ownership fence', () => {
  it('compares the socket and pid-record paths as whole arguments, not as substrings', () => {
    const { daemonDir } = makeProfile(11)
    expect(commandLineIsOwnDaemon(daemonCommand(daemonDir), daemonDir)).toBe(true)
    // The W19 counterexamples: the directory is mentioned, but not as this daemon's endpoint.
    expect(
      commandLineIsOwnDaemon(
        `node /tmp/diagnostic.js --entry daemon-entry.js --inspect ${daemonDir}`,
        daemonDir
      )
    ).toBe(false)
    expect(
      commandLineIsOwnDaemon(
        `node /tmp/apex/daemon-entry.js --socket ${daemonDir}-other/daemon-v38.sock ` +
          `--pid-record ${daemonDir}-other/daemon-v38.pid`,
        daemonDir
      )
    ).toBe(false)
    expect(namesExactArgument(`--socket ${daemonDir}/daemon-v38.sock`, `${daemonDir}/daemon-v38.sock`)).toBe(true)
    expect(
      namesExactArgument(`--socket ${daemonDir}-other/daemon-v38.sock`, `${daemonDir}/daemon-v38.sock`)
    ).toBe(false)
  })
})

describe('scanApexDaemon', () => {
  it('selects the recorded pid when its command line names this profile', () => {
    const { daemonDir } = makeProfile(11)
    const table = new Map<number, string>([
      [11, daemonCommand(daemonDir)],
      // The host's own runtime daemon: a daemon-entry process, but not this profile's.
      [12, daemonCommand('/home/somebody/.local/state/orca/daemon')],
      // A process that merely mentions the directory but is not the daemon entry.
      [13, `node /tmp/orca-e2e-case/apex/orcad.js --user-data ${daemonDir}`]
    ])

    const scan = scanApexDaemon(daemonDir, table)

    expect(scan.target?.pid).toBe(11)
    expect(scan.notes).toEqual([])
  })

  it('records the reason and signals nothing when the pid record is missing', () => {
    const { daemonDir } = makeProfile(null)
    const table = new Map<number, string>([[11, daemonCommand(daemonDir)]])

    const scan = scanApexDaemon(daemonDir, table)

    expect(scan.target).toBeNull()
    expect(scan.notes.join('\n')).toMatch(/no daemon pid record/)
  })

  it('refuses the recorded pid when that pid is another process now (pid reuse)', () => {
    const { daemonDir } = makeProfile(11)
    // The daemon exited and the kernel handed pid 11 to an unrelated process.
    const table = new Map<number, string>([[11, 'node /tmp/unrelated-worker.js --serve']])

    const scan = scanApexDaemon(daemonDir, table)

    expect(scan.target).toBeNull()
    expect(scan.notes.join('\n')).toMatch(/pid reuse/)
    expect(scan.notes.join('\n')).toMatch(/pid 11/)
  })
})

describe('reclaimApexDaemons', () => {
  it('does nothing, for a recorded reason, when this profile published no pid record', async () => {
    const { daemonDir } = makeProfile(null)
    const host = fakeHost([[11, daemonCommand(daemonDir)]])

    const result = await reclaimApexDaemons({ daemonDir, seams: host.seams })

    expect(result).toEqual({ reclaimed: [], surviving: [], notes: expect.any(Array) })
    expect(result.notes.join('\n')).toMatch(/no daemon pid record/)
    expect(host.signalled).toEqual([])
    // The process that only *looks* like this case's daemon survives untouched.
    expect(host.table.has(11)).toBe(true)
    expect(host.notes).toEqual(result.notes)
  })

  it('does not signal a recorded pid that was reused by an unrelated process', async () => {
    const { daemonDir } = makeProfile(11)
    const host = fakeHost([[11, 'node /tmp/unrelated-worker.js --serve']])

    const result = await reclaimApexDaemons({ daemonDir, seams: host.seams })

    expect(result.reclaimed).toEqual([])
    expect(result.notes.join('\n')).toMatch(/pid reuse/)
    expect(host.signalled).toEqual([])
    expect(host.table.has(11)).toBe(true)
  })

  it('does nothing when the recorded pid already exited', async () => {
    const { daemonDir } = makeProfile(11)
    const host = fakeHost([])

    const result = await reclaimApexDaemons({ daemonDir, seams: host.seams })

    expect(result.reclaimed).toEqual([])
    expect(result.notes.join('\n')).toMatch(/already exited/)
    expect(host.signalled).toEqual([])
  })

  it('reclaims the recorded daemon with SIGTERM when the exit is observed', async () => {
    const { daemonDir } = makeProfile(11)
    const host = fakeHost([[11, daemonCommand(daemonDir)]])

    const result = await reclaimApexDaemons({ daemonDir, seams: host.seams })

    expect(result.reclaimed).toEqual([11])
    expect(result.surviving).toEqual([])
    expect(host.signalled).toEqual([{ pid: 11, signal: 'SIGTERM' }])
    expect(host.table.size).toBe(0)
  })

  it('escalates to SIGKILL and still requires the exit before reporting a reclaim', async () => {
    const { daemonDir } = makeProfile(11)
    const host = fakeHost([[11, daemonCommand(daemonDir)]], (signal) => signal === 'SIGKILL')

    const result = await reclaimApexDaemons({ daemonDir, seams: host.seams })

    expect(host.signalled).toEqual([
      { pid: 11, signal: 'SIGTERM' },
      { pid: 11, signal: 'SIGKILL' }
    ])
    expect(result.reclaimed).toEqual([11])
  })

  it('throws naming the survivor when neither signal is observed to take effect', async () => {
    const { daemonDir, root } = makeProfile(11)
    const host = fakeHost([[11, daemonCommand(daemonDir)]], () => false)

    const error = await reclaimApexDaemons({ daemonDir, seams: host.seams }).catch(
      (reason: unknown) => reason
    )

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(/was not reclaimed after SIGTERM\+5000ms and SIGKILL\+3000ms/)
    expect((error as Error).message).toMatch(/pid 11: .*daemon-entry\.js/)
    // The profile survives the failure: the caller must not delete it behind a live daemon.
    expect(host.table.has(11)).toBe(true)
    expect(root).not.toBe('')
  })

  it('never treats a stranger that appears mid-wait as our survivor', async () => {
    const { daemonDir } = makeProfile(11)
    const table = new Map<number, string>([[11, daemonCommand(daemonDir)]])
    const signalled: { pid: number; signal: NodeJS.Signals }[] = []
    const notes: string[] = []
    let observations = 0

    const result = await reclaimApexDaemons({
      daemonDir,
      seams: {
        listProcesses: () => {
          observations += 1
          const next = new Map(table)
          // Our daemon ignores TERM and exits; the kernel hands its pid to a stranger.
          if (observations > 1) {
            next.set(11, 'node /tmp/stranger.js')
          }
          return next
        },
        signal: (pid, signal) => signalled.push({ pid, signal }),
        sleep: () => Promise.resolve(),
        recordNote: (note) => notes.push(note)
      }
    })

    // Gone is gone: the recorded pid was ours when it was signalled, and it is not ours any more.
    expect(result.reclaimed).toEqual([11])
    expect(result.surviving).toEqual([])
    expect(notes.join('\n')).toMatch(/recycled after our daemon exited/)
    // The stranger was never a target and was never signalled.
    expect(signalled).toEqual([{ pid: 11, signal: 'SIGTERM' }])
  })
})

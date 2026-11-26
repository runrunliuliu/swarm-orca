/**
 * The daemon reclaim rule, driven with a fake process table: no `ps`, no daemon, no product state.
 *
 * Why these cases: the two ways this cleanup can be wrong are (a) signalling a process that is not
 * this profile's daemon — the host's real runtime daemon is one `ps` away — and (b) reporting a
 * reclaim after sending a signal that the process ignored. Both are visible here without a daemon.
 */

import { describe, expect, it } from 'vitest'
import { listApexDaemons, reclaimApexDaemons } from './orcad-apex-daemon'

const PROFILE_DAEMON_DIR = '/tmp/orca-e2e-case/userdata/daemon'

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
  /** Signals the fake process honours; anything else is ignored, like a real stuck daemon. */
  honours: (signal: NodeJS.Signals) => boolean
  seams: Parameters<typeof reclaimApexDaemons>[0]['seams']
}

function fakeHost(entries: [number, string][], honours: (s: NodeJS.Signals) => boolean = () => true): FakeHost {
  const table = new Map(entries)
  const signalled: { pid: number; signal: NodeJS.Signals }[] = []
  return {
    table,
    signalled,
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
      sleep: () => Promise.resolve()
    }
  }
}

describe('listApexDaemons', () => {
  it('selects only daemon-entry processes whose command line names this profile daemon dir', () => {
    const table = new Map<number, string>([
      [11, daemonCommand(PROFILE_DAEMON_DIR)],
      // The host's own runtime daemon: a daemon-entry process, but not this profile's.
      [12, daemonCommand('/home/somebody/.local/state/orca/daemon')],
      // A process that merely mentions the directory but is not the daemon entry.
      [13, `node /tmp/orca-e2e-case/apex/orcad.js --user-data ${PROFILE_DAEMON_DIR}`],
      // A daemon entry with no profile path at all: not attributable, so not ours to kill.
      [14, '/opt/orca/bun-runtime /opt/orca/daemon-entry.js --socket /tmp/other.sock']
    ])

    expect(listApexDaemons(PROFILE_DAEMON_DIR, table).map((process) => process.pid)).toEqual([11])
  })
})

describe('reclaimApexDaemons', () => {
  it('does nothing when this profile forked no daemon', async () => {
    const host = fakeHost([[12, daemonCommand('/home/somebody/.local/state/orca/daemon')]])

    const result = await reclaimApexDaemons({ daemonDir: PROFILE_DAEMON_DIR, seams: host.seams })

    expect(result).toEqual({ reclaimed: [], surviving: [] })
    expect(host.signalled).toEqual([])
    expect(host.table.has(12)).toBe(true)
  })

  it('reclaims this profile daemon with SIGTERM when the exit is observed', async () => {
    const host = fakeHost([[11, daemonCommand(PROFILE_DAEMON_DIR)]])

    const result = await reclaimApexDaemons({ daemonDir: PROFILE_DAEMON_DIR, seams: host.seams })

    expect(result.reclaimed).toEqual([11])
    expect(host.signalled).toEqual([{ pid: 11, signal: 'SIGTERM' }])
    expect(host.table.size).toBe(0)
  })

  it('escalates to SIGKILL and still requires the exit before reporting a reclaim', async () => {
    const host = fakeHost([[11, daemonCommand(PROFILE_DAEMON_DIR)]], (signal) => signal === 'SIGKILL')

    const result = await reclaimApexDaemons({ daemonDir: PROFILE_DAEMON_DIR, seams: host.seams })

    expect(host.signalled).toEqual([
      { pid: 11, signal: 'SIGTERM' },
      { pid: 11, signal: 'SIGKILL' }
    ])
    expect(result.reclaimed).toEqual([11])
  })

  it('throws naming the survivor when neither signal is observed to take effect', async () => {
    const host = fakeHost([[11, daemonCommand(PROFILE_DAEMON_DIR)]], () => false)

    const error = await reclaimApexDaemons({ daemonDir: PROFILE_DAEMON_DIR, seams: host.seams }).catch(
      (reason: unknown) => reason
    )

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(/was not reclaimed after SIGTERM\+5000ms and SIGKILL\+3000ms/)
    expect((error as Error).message).toMatch(/pid 11: .*daemon-entry\.js/)
    // The profile survives the failure: the caller must not delete it behind a live daemon.
    expect(host.table.has(11)).toBe(true)
  })
})

/**
 * The daemon teardown rule: **record** the forked PTY daemon and print one exact command, never signal.
 *
 * Why these cases: W19–W24 each shipped an automatic reclaim and each one was refuted, because every
 * ownership test available from outside the process (argv content, kernel group/session, start-tick and
 * boot fence) can fail open on a pid the kernel has already reused. The dangerous direction was a
 * signal landing on a process this case does not own; the benefit was one fewer process after the run.
 * So the rule under test is now negative as well as positive: a record that names a pid must produce
 * the right pid/pgid and a paste-ready command, a profile with no usable record must produce a
 * "no pid record" line and nothing else, and the module must contain no signalling call at all.
 *
 * The last describe block is a source-level assertion on purpose: a future edit could reintroduce
 * `process.kill` and still pass every behavioural case above (nothing here would exercise it), and that
 * is precisely the regression this round has to make impossible.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { recordLeftoverApexDaemon } from './orcad-apex-daemon'

const profiles: string[] = []

/** A profile daemon dir as the apex would leave it: socket/token names plus a pid record. */
function makeProfile(record: { pid: number } | null, socket = true): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'orca-daemon-unit-'))
  const daemonDir = path.join(root, 'userdata', 'daemon')
  mkdirSync(daemonDir, { recursive: true })
  if (socket) {
    writeFileSync(path.join(daemonDir, 'daemon-v38.sock'), '')
  }
  if (record !== null) {
    writeFileSync(path.join(daemonDir, 'daemon-v38.pid'), JSON.stringify(record))
  }
  profiles.push(root)
  return daemonDir
}

afterEach(() => {
  for (const root of profiles.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('recordLeftoverApexDaemon', () => {
  it('prints the recorded pid, its process group and a group-scoped cleanup command', () => {
    const daemonDir = makeProfile({ pid: 11 })
    const readPgid = vi.fn(() => 11)

    const leftover = recordLeftoverApexDaemon(daemonDir, { readPgid })

    expect(leftover.pid).toBe(11)
    expect(leftover.pgid).toBe(11)
    expect(leftover.socketPresent).toBe(true)
    expect(leftover.cleanupCommand).toBe('kill -TERM -11')
    expect(leftover.lines).toEqual([
      'e2e daemon left running: pid=11 pgid=11 (product keeps the PTY daemon alive by design)',
      `e2e daemon record: ${path.join(daemonDir, 'daemon-v38.pid')} socket ${path.join(daemonDir, 'daemon-v38.sock')} present`,
      'e2e daemon cleanup (copy-paste): kill -TERM -11'
    ])
    // The pid in the command is the pid from this profile's own record, and nothing else was probed.
    expect(readPgid.mock.calls).toEqual([[11]])
  })

  it('falls back to a single-pid command when the process group cannot be read', () => {
    const daemonDir = makeProfile({ pid: 12 })

    const leftover = recordLeftoverApexDaemon(daemonDir, { readPgid: () => null })

    expect(leftover.pgid).toBeNull()
    expect(leftover.cleanupCommand).toBe('kill -TERM 12')
    expect(leftover.lines[0]).toMatch(/pid=12 pgid=unknown .*PTY daemon alive by design/)
    expect(leftover.lines[2]).toBe('e2e daemon cleanup (copy-paste): kill -TERM 12')
  })

  it('reports a socket that is already gone instead of assuming the daemon still holds the profile', () => {
    const daemonDir = makeProfile({ pid: 13 }, false)

    const leftover = recordLeftoverApexDaemon(daemonDir, { readPgid: () => 13 })

    expect(leftover.socketPresent).toBe(false)
    expect(leftover.lines[1]).toMatch(/daemon-v38\.sock absent$/)
  })

  it('records "no pid record" and prints no command — no throw, no probe, no signal', () => {
    const daemonDir = makeProfile(null)
    const readPgid = vi.fn(() => 11)

    const leftover = recordLeftoverApexDaemon(daemonDir, { readPgid })

    expect(leftover.pid).toBeNull()
    expect(leftover.pgid).toBeNull()
    expect(leftover.cleanupCommand).toBeNull()
    expect(leftover.lines.join('\n')).toMatch(/e2e daemon left running: no pid record/)
    expect(leftover.lines.join('\n')).toMatch(/socket .*daemon-v38\.sock present/)
    expect(leftover.lines.join('\n')).toMatch(/nothing was signalled/)
    // No pid to attribute → not even a process-group lookup: guessing is what was retired.
    expect(readPgid).not.toHaveBeenCalled()
  })

  it('treats an unparseable pid record the same way as a missing one', () => {
    const daemonDir = makeProfile(null)
    writeFileSync(path.join(daemonDir, 'daemon-v38.pid'), '{ not json')

    const leftover = recordLeftoverApexDaemon(daemonDir, { readPgid: () => 11 })

    expect(leftover.cleanupCommand).toBeNull()
    expect(leftover.lines.join('\n')).toMatch(/could not be read/)
  })

  it('records nothing at all for a profile that never forked a daemon dir', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'orca-daemon-unit-'))
    profiles.push(root)

    const leftover = recordLeftoverApexDaemon(path.join(root, 'userdata', 'daemon'))

    expect(leftover).toEqual({
      daemonDir: path.join(root, 'userdata', 'daemon'),
      pid: null,
      pgid: null,
      socketPresent: false,
      lines: [],
      cleanupCommand: null
    })
  })
})

describe('the daemon teardown contains no signalling path (W25)', () => {
  const HELPERS = ['orcad-apex-daemon.ts', 'orcad-apex-host.ts']

  function helperSource(name: string): string {
    return readFileSync(new URL(name, import.meta.url), 'utf8')
  }

  it.each(HELPERS)('%s sends no signal and scans no process table', (name) => {
    const source = helperSource(name)

    expect(source).not.toContain('process.kill')
    // The retired reclaim machinery, by name: a partial reintroduction would otherwise pass silently.
    for (const retired of [
      'reclaimApexDaemons',
      'scanApexDaemon',
      'identifyApexDaemonGroup',
      'readProcessTable',
      'linuxStartTicks',
      'readLinuxStartTicks',
      'bootId'
    ]) {
      expect(source, `${name} still references ${retired}`).not.toContain(retired)
    }
  })

  it('the daemon helper names no signal at all, only the shell command it prints', () => {
    const source = helperSource('orcad-apex-daemon.ts')

    // `kill -TERM` is text handed to the operator, not a call: the Node signal constants must be gone.
    expect(source).not.toMatch(/\bSIG(TERM|KILL|INT|QUIT|HUP)\b/)
    expect(source).toContain('kill -TERM ${pid}')
    expect(source).toContain('kill -TERM -${pgid}')
  })
})

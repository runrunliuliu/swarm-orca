import { EventEmitter } from 'node:events'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startOrcadApex, type ApexChildSpawn, type OrcadApexHost } from './orcad-apex-host'

// Why: the host under test reaches the runtime only through the RPC client, which this unit test
// never calls. Mocking it keeps the case about process/temp-dir ownership instead of loading the
// whole CLI transport graph.
vi.mock('../../../src/cli/runtime/client', () => ({
  RuntimeClient: class {
    constructor(
      readonly userDataDir: string,
      readonly timeoutMs: number
    ) {}
  }
}))

const READINESS_LINE = JSON.stringify({
  type: 'orca_server_ready',
  pairing: { available: true, url: 'orca://pair/unit-test' }
})

type FakeApexChild = EventEmitter & {
  stdout: PassThrough
  stderr: PassThrough
  pid: number | undefined
  killedWith: (NodeJS.Signals | undefined)[]
  exitedWith: (NodeJS.Signals | null)[]
  kill: (signal?: NodeJS.Signals) => boolean
  /** Deliver the exit a signal the fake refused to honour would eventually cause. */
  exitNow: (signal?: NodeJS.Signals | null) => void
}

type FakeApexChildBehaviour = {
  publishReadiness: boolean
  /** A spawn failure: no `pid`, no `spawn` event and never an `exit`, like ENOENT/EACCES. */
  spawnError?: Error
  /** Signals the fake actually honours (default SIGTERM and SIGKILL). */
  honours?: NodeJS.Signals[]
  /** Milliseconds between the honoured signal and the `exit` event. */
  exitDelayMs?: number
  /** `kill()` throws, as Node's does when the signal cannot be delivered. */
  killThrows?: Error
  /** `kill()` reports a failed delivery as an `error` event on a live child. */
  killErrorEvent?: Error
  /** Runs immediately before the `exit` event: what was still on disk when the child exited. */
  onExit?: () => void
}

/**
 * A stand-in for the spawned `orcad` apex. It only has to behave like a child process in the ways the
 * host observes: stdout lines, a `pid` that exists only after a successful spawn, an `exit` event
 * that a signal may or may not earn, and an `error` event that Node emits both for "never spawned"
 * and for "could not deliver a signal to a live child".
 */
function createFakeApexChild(behaviour: FakeApexChildBehaviour): FakeApexChild {
  const child = new EventEmitter() as unknown as FakeApexChild
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  // Why undefined: `child.pid` is exactly how Node distinguishes "no process was created" from "a
  // signal to an existing process failed", and the host has to make the same distinction.
  child.pid = behaviour.spawnError ? undefined : 4242
  child.killedWith = []
  child.exitedWith = []
  const exitNow = (signal: NodeJS.Signals | null = 'SIGKILL'): void => {
    child.exitedWith.push(signal)
    behaviour.onExit?.()
    child.emit('exit', null, signal)
  }
  child.exitNow = exitNow
  const honours = behaviour.honours ?? ['SIGTERM', 'SIGKILL']
  let exitScheduled = false
  child.kill = (signal) => {
    child.killedWith.push(signal)
    if (behaviour.killThrows) {
      throw behaviour.killThrows
    }
    if (behaviour.killErrorEvent) {
      setImmediate(() => child.emit('error', behaviour.killErrorEvent))
      return true
    }
    if (signal && honours.includes(signal) && !exitScheduled) {
      exitScheduled = true
      const delay = behaviour.exitDelayMs ?? 0
      if (delay > 0) {
        setTimeout(() => exitNow(signal), delay)
      } else {
        setImmediate(() => exitNow(signal))
      }
    }
    return true
  }
  setImmediate(() => {
    if (behaviour.spawnError) {
      child.emit('error', behaviour.spawnError)
      return
    }
    child.emit('spawn')
    if (behaviour.publishReadiness) {
      child.stdout.write(`${READINESS_LINE}\n`)
    }
  })
  return child
}

const tempDirs: string[] = []

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true })
  }
})

function createTempDir(prefix: string): string {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(tempDir)
  return tempDir
}

/** A tiny but structurally complete artifact: the copy path, not the launch, is what is under test. */
function createFakeArtifact(): { root: string; apexDir: string } {
  const root = createTempDir('orca-apex-host-unit-')
  const apexDir = path.join(root, 'artifact')
  mkdirSync(path.join(apexDir, 'cli'), { recursive: true })
  writeFileSync(path.join(apexDir, 'orcad.js'), '// orcad bundle\n')
  writeFileSync(path.join(apexDir, 'bun-runtime'), '#!/bin/sh\nexit 0\n')
  writeFileSync(path.join(apexDir, 'cli', 'index.cjs'), 'module.exports = {}\n')
  writeFileSync(path.join(apexDir, '.version'), '0.1.0|abc123\n')
  writeFileSync(path.join(apexDir, '.build-target'), 'linux-x64-glibc\n')
  writeFileSync(path.join(apexDir, 'package.json'), '{"name":"orcad"}\n')
  writeFileSync(path.join(apexDir, '.orca-build.json'), '{"schemaVersion":1,"buildId":"aaa"}\n')
  writeFileSync(path.join(apexDir, '.orca-cli-argv'), `${path.join(apexDir, 'bun-runtime')}\n`)
  return { root, apexDir }
}

/** A spawn seam that hands out the next scripted child and records every launch request. */
function scriptedSpawn(children: FakeApexChild[], script: FakeApexChildBehaviour[]): ApexChildSpawn {
  return () => {
    const behaviour = script[children.length]
    if (!behaviour) {
      throw new Error(`unexpected ${children.length + 1}. launch: the test scripted only ${script.length}`)
    }
    const child = createFakeApexChild(behaviour)
    children.push(child)
    return child as unknown as ChildProcess
  }
}

/** Grace windows small enough to keep a "this process ignores signals" case fast. */
const FAST_GRACE = { shutdownGraceMs: 20, killGraceMs: 20 }

function settle<T>(promise: Promise<T>): Promise<unknown> {
  return promise.then(
    () => null,
    (reason: unknown) => reason
  )
}

describe('startOrcadApex startup failure reclamation', () => {
  it('terminates the child and removes the temp root when readiness never arrives', async () => {
    const artifact = createFakeArtifact()
    const parent = createTempDir('orca-apex-host-parent-')
    const children: FakeApexChild[] = []
    const spawnApexChild = scriptedSpawn(children, [{ publishReadiness: false }])

    const error = await settle(
      startOrcadApex({
        apexDir: artifact.apexDir,
        userDataParent: parent,
        readinessTimeoutMs: 100,
        seams: { spawnApexChild }
      })
    )

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(/never published readiness/)
    expect(children).toHaveLength(1)
    expect(children[0].killedWith).toContain('SIGTERM')
    // Why: the root may only go away once the child is confirmed gone; an empty parent proves both
    // the copy and the profile directory were reclaimed, not just the process.
    expect(readdirSync(parent)).toEqual([])
  })

  it('surfaces a spawn error with its cause and reclaims without signalling a missing process', async () => {
    const artifact = createFakeArtifact()
    const parent = createTempDir('orca-apex-host-parent-')
    const spawnError = Object.assign(new Error('spawn EACCES'), { code: 'EACCES' })
    const children: FakeApexChild[] = []
    const spawnApexChild = scriptedSpawn(children, [{ publishReadiness: false, spawnError }])

    const error = await settle(
      startOrcadApex({
        apexDir: artifact.apexDir,
        userDataParent: parent,
        readinessTimeoutMs: 5_000,
        ...FAST_GRACE,
        seams: { spawnApexChild }
      })
    )

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(/failed to spawn/)
    // The original error has to survive the wrapping: "it failed" without EACCES is not actionable.
    expect((error as Error).cause).toBe(spawnError)
    // No process was created, so there is nothing to signal — and nothing to wait an exit for.
    expect(children[0].killedWith).toEqual([])
    expect(readdirSync(parent)).toEqual([])
  })
})

describe('startOrcadApex isolation and dispose', () => {
  it('launches from a private copy, never writes the source, and removes the copy on dispose', async () => {
    const artifact = createFakeArtifact()
    const parent = createTempDir('orca-apex-host-parent-')
    const sourceBuildJson = readFileSync(path.join(artifact.apexDir, '.orca-build.json'), 'utf8')
    const sourceMtime = statSync(path.join(artifact.apexDir, '.orca-build.json')).mtimeMs
    const spawnRequests: { command: string; args: string[] }[] = []
    const children: FakeApexChild[] = []

    const host = await startOrcadApex({
      apexDir: artifact.apexDir,
      userDataParent: parent,
      seams: {
        spawnApexChild: (request) => {
          spawnRequests.push({ command: request.command, args: request.args })
          return scriptedSpawn(children, [{ publishReadiness: true }])(request)
        }
      }
    })
    try {
      expect(host.apexDir).not.toBe(artifact.apexDir)
      expect(host.sourceApexDir).toBe(artifact.apexDir)
      expect(existsSync(path.join(host.apexDir, 'orcad.js'))).toBe(true)
      // A link would report the source inode; only a real copy reports its own.
      expect(statSync(path.join(host.apexDir, 'orcad.js')).ino).not.toBe(
        statSync(path.join(artifact.apexDir, 'orcad.js')).ino
      )
      expect(spawnRequests).toHaveLength(1)
      expect(spawnRequests[0].args[0]).toBe(path.join(host.apexDir, 'orcad.js'))
      expect(host.readiness).toMatchObject({ type: 'orca_server_ready' })
      expect(host.offer.pairingUrl).toBe('orca://pair/unit-test')

      // What publishing does to an install root: it rewrites the provenance files. That has to land
      // in the copy, and the source artifact's bytes must not move.
      writeFileSync(path.join(host.apexDir, '.orca-build.json'), '{"publishedAt":"copy"}\n')
      writeFileSync(path.join(host.apexDir, '.orca-cli-argv'), 'copy\n')
      expect(readFileSync(path.join(artifact.apexDir, '.orca-build.json'), 'utf8')).toBe(
        sourceBuildJson
      )
      expect(host.verifySourceUntouched().files).toEqual(host.sourceWitness.files)
    } finally {
      await host.dispose()
    }

    expect(children[0].killedWith).toContain('SIGTERM')
    expect(readdirSync(parent)).toEqual([])
    expect(statSync(path.join(artifact.apexDir, '.orca-build.json')).mtimeMs).toBe(sourceMtime)
  })

  it('reports a source artifact that changed during the case instead of cleaning up silently', async () => {
    const artifact = createFakeArtifact()
    const parent = createTempDir('orca-apex-host-parent-')
    const children: FakeApexChild[] = []

    const host = await startOrcadApex({
      apexDir: artifact.apexDir,
      userDataParent: parent,
      seams: { spawnApexChild: scriptedSpawn(children, [{ publishReadiness: true }]) }
    })
    // Simulate the leak B1 described: the install root's provenance rewritten underneath a run.
    writeFileSync(path.join(artifact.apexDir, '.orca-build.json'), '{"publishedAt":"leaked"}\n')

    const error = await settle(host.dispose())

    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors[0]).toBeInstanceOf(Error)
    expect(((error as AggregateError).errors[0] as Error).message).toMatch(
      /wrote into the artifact it only reads/
    )
    // The report must not leave the temp root behind just because the assertion failed.
    expect(readdirSync(parent)).toEqual([])
  })
})

/**
 * B2: a stop that cannot prove the exit must not cost the caller the evidence root or the process
 * owner, and Node's `error` event is not an exit. Every case below drives the same ownership rule
 * from a real `startOrcadApex` host with a scripted child; none of them starts an `orcad` process.
 */
describe('orcad apex stop ownership (B2)', () => {
  async function startWithChild(
    children: FakeApexChild[],
    script: FakeApexChildBehaviour[],
    parent: string,
    artifact: { apexDir: string },
    options: { readinessTimeoutMs?: number; shutdownGraceMs?: number; killGraceMs?: number } = {}
  ): Promise<OrcadApexHost> {
    return await startOrcadApex({
      apexDir: artifact.apexDir,
      userDataParent: parent,
      readinessTimeoutMs: options.readinessTimeoutMs ?? 1_000,
      shutdownGraceMs: options.shutdownGraceMs ?? FAST_GRACE.shutdownGraceMs,
      killGraceMs: options.killGraceMs ?? FAST_GRACE.killGraceMs,
      seams: { spawnApexChild: scriptedSpawn(children, script) }
    })
  }

  it('keeps the root and the owner when neither SIGTERM nor SIGKILL is honoured, and stays retryable', async () => {
    const artifact = createFakeArtifact()
    const parent = createTempDir('orca-apex-host-parent-')
    const children: FakeApexChild[] = []
    const host = await startWithChild(children, [{ publishReadiness: true, honours: [] }], parent, artifact)
    const root = path.dirname(host.userDataDir)

    const error = await settle(host.dispose())

    expect(error).toBeInstanceOf(AggregateError)
    expect(children[0].killedWith).toEqual(['SIGTERM', 'SIGKILL'])
    // The child never exited, so the profile copy it may still be writing into must survive...
    expect(children[0].exitedWith).toEqual([])
    expect(existsSync(root)).toBe(true)
    expect(readdirSync(parent)).toHaveLength(1)
    // The stop failure comes first: it is what explains the retained root.
    expect(((error as AggregateError).errors[0] as Error).message).toMatch(
      /did not exit after SIGTERM\+20ms and SIGKILL\+20ms \(pid 4242\)/
    )
    // ...and `dispose()` must not be recorded as finished behind a failure.
    expect(((error as AggregateError).errors[1] as Error).message).toMatch(/was not confirmed gone/)

    // The owner is still held: the exit arriving late lets the same host finish the cleanup.
    children[0].exitNow('SIGKILL')
    await host.dispose()
    expect(readdirSync(parent)).toEqual([])
  })

  it('treats an `error` reported by a live child as a failed signal, not as an exit', async () => {
    const artifact = createFakeArtifact()
    const parent = createTempDir('orca-apex-host-parent-')
    const children: FakeApexChild[] = []
    const killError = Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
    const host = await startWithChild(
      children,
      [{ publishReadiness: true, honours: [], killErrorEvent: killError }],
      parent,
      artifact
    )
    const root = path.dirname(host.userDataDir)

    const error = await settle(host.dispose())

    // Node documents `error` for "the process could not be killed" too: reading it as an exit would
    // let this stop report success for a process that is still running.
    expect(error).toBeInstanceOf(AggregateError)
    expect(((error as AggregateError).errors[0] as Error).message).toMatch(
      /did not exit after SIGTERM\+20ms and SIGKILL\+20ms/
    )
    expect(((error as AggregateError).errors[0] as Error).message).toMatch(
      /signalling reported: kill EPERM/
    )
    expect(children[0].exitedWith).toEqual([])
    expect(existsSync(root)).toBe(true)
    expect(readdirSync(parent)).toHaveLength(1)
  })

  it('keeps the root when kill() throws and no exit ever arrives', async () => {
    const artifact = createFakeArtifact()
    const parent = createTempDir('orca-apex-host-parent-')
    const children: FakeApexChild[] = []
    const host = await startWithChild(
      children,
      [{ publishReadiness: true, honours: [], killThrows: new Error('ESRCH: no such process') }],
      parent,
      artifact
    )
    const root = path.dirname(host.userDataDir)

    const error = await settle(host.dispose())

    expect(error).toBeInstanceOf(AggregateError)
    expect(((error as AggregateError).errors[0] as Error).message).toMatch(/did not exit/)
    expect(children[0].exitedWith).toEqual([])
    expect(existsSync(root)).toBe(true)
    expect(readdirSync(parent)).toHaveLength(1)
  })

  it('does not launch a replacement when the old child cannot be confirmed gone', async () => {
    const artifact = createFakeArtifact()
    const parent = createTempDir('orca-apex-host-parent-')
    const children: FakeApexChild[] = []
    const host = await startWithChild(children, [{ publishReadiness: true, honours: [] }], parent, artifact)

    const restartError = await settle(host.restart())

    expect(restartError).toBeInstanceOf(Error)
    expect((restartError as Error).message).toMatch(/did not exit/)
    // A replacement would have nobody to reclaim it: the old process is still alive.
    expect(children).toHaveLength(1)
    expect(readdirSync(parent)).toHaveLength(1)

    // And the host still owns the old child, so `dispose()` cannot pretend the root is garbage.
    const disposeError = await settle(host.dispose())
    expect(disposeError).toBeInstanceOf(AggregateError)
    expect(((disposeError as AggregateError).errors[0] as Error).message).toMatch(/did not exit/)
    expect(readdirSync(parent)).toHaveLength(1)
  })

  it('keeps the launch failure and the stop failure when a restart cannot be reclaimed', async () => {
    const artifact = createFakeArtifact()
    const parent = createTempDir('orca-apex-host-parent-')
    const children: FakeApexChild[] = []
    const host = await startWithChild(
      children,
      [
        { publishReadiness: true },
        // The replacement never becomes ready and refuses both signals.
        { publishReadiness: false, honours: [] }
      ],
      parent,
      artifact,
      { readinessTimeoutMs: 100 }
    )
    const root = path.dirname(host.userDataDir)

    const error = await settle(host.restart())

    expect(error).toBeInstanceOf(AggregateError)
    // The launch failure is the first error: it is the reason the run failed, the stop failure is why
    // the root was kept. Losing either one makes the failure unattributable.
    expect(((error as AggregateError).errors[0] as Error).message).toMatch(/never published readiness/)
    expect(((error as AggregateError).errors[1] as Error).message).toMatch(/did not exit/)
    expect(children).toHaveLength(2)
    expect(existsSync(root)).toBe(true)
    expect(readdirSync(parent)).toHaveLength(1)

    const disposeError = await settle(host.dispose())
    expect(disposeError).toBeInstanceOf(AggregateError)
    expect(((disposeError as AggregateError).errors[0] as Error).message).toMatch(/did not exit/)
    expect(existsSync(root)).toBe(true)
  })

  it('removes the temp root only after the confirmed exit', async () => {
    const artifact = createFakeArtifact()
    const parent = createTempDir('orca-apex-host-parent-')
    const children: FakeApexChild[] = []
    let root: string | null = null
    const atExit: { rootExisted: boolean; parentEntries: number }[] = []
    const host = await startWithChild(
      children,
      [
        {
          publishReadiness: true,
          // Why the delay: with an immediate exit the order cannot be observed, and the point of this
          // case is that the deletion happens *after* the exit event, not merely that both happened.
          exitDelayMs: 25,
          onExit: () => {
            atExit.push({
              rootExisted: root !== null && existsSync(root),
              parentEntries: readdirSync(parent).length
            })
          }
        }
      ],
      parent,
      artifact,
      // A grace window longer than the exit delay keeps this a plain SIGTERM case, so the only thing
      // the assertion can be reading is the order of exit and deletion.
      { shutdownGraceMs: 300, killGraceMs: 300 }
    )
    root = path.dirname(host.userDataDir)

    await host.dispose()

    expect(atExit).toEqual([{ rootExisted: true, parentEntries: 1 }])
    expect(children[0].killedWith).toEqual(['SIGTERM'])
    expect(children[0].exitedWith).toEqual(['SIGTERM'])
    expect(readdirSync(parent)).toEqual([])
  })

  it('escalates to SIGKILL and still deletes only after that exit', async () => {
    const artifact = createFakeArtifact()
    const parent = createTempDir('orca-apex-host-parent-')
    const children: FakeApexChild[] = []
    let root: string | null = null
    const atExit: { rootExisted: boolean; parentEntries: number }[] = []
    const host = await startWithChild(
      children,
      [
        {
          publishReadiness: true,
          honours: ['SIGKILL'],
          exitDelayMs: 5,
          onExit: () => {
            atExit.push({
              rootExisted: root !== null && existsSync(root),
              parentEntries: readdirSync(parent).length
            })
          }
        }
      ],
      parent,
      artifact
    )
    root = path.dirname(host.userDataDir)

    await host.dispose()

    expect(children[0].killedWith).toEqual(['SIGTERM', 'SIGKILL'])
    expect(children[0].exitedWith).toEqual(['SIGKILL'])
    // Same order as the SIGTERM case: the escalation is not an excuse to clean up early.
    expect(atExit).toEqual([{ rootExisted: true, parentEntries: 1 }])
    expect(readdirSync(parent)).toEqual([])
  })
})

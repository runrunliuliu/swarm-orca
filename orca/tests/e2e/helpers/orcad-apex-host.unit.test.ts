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
import { startOrcadApex, type ApexChildSpawn } from './orcad-apex-host'

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
  pid: number
  killedWith: (NodeJS.Signals | undefined)[]
  kill: (signal?: NodeJS.Signals) => boolean
}

/**
 * A stand-in for the spawned `orcad` apex. It only has to behave like a child process in the three
 * ways the host observes: stdout lines, an `exit` event after a signal, and a spawn `error` that
 * arrives instead of both.
 */
function createFakeApexChild(behaviour: {
  publishReadiness: boolean
  spawnError?: Error
}): FakeApexChild {
  const child = new EventEmitter() as unknown as FakeApexChild
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.pid = 4242
  child.killedWith = []
  child.kill = (signal) => {
    child.killedWith.push(signal)
    setImmediate(() => child.emit('exit', null, signal ?? null))
    return true
  }
  setImmediate(() => {
    if (behaviour.spawnError) {
      child.emit('error', behaviour.spawnError)
      return
    }
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

describe('startOrcadApex startup failure reclamation', () => {
  it('terminates the child and removes the temp root when readiness never arrives', async () => {
    const artifact = createFakeArtifact()
    const parent = createTempDir('orca-apex-host-parent-')
    const children: FakeApexChild[] = []
    const spawnApexChild: ApexChildSpawn = () => {
      children.push(createFakeApexChild({ publishReadiness: false }))
      return children[0] as unknown as ChildProcess
    }

    const error = await startOrcadApex({
      apexDir: artifact.apexDir,
      userDataParent: parent,
      readinessTimeoutMs: 100,
      seams: { spawnApexChild }
    }).then(
      () => null,
      (reason: unknown) => reason
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
    const spawnApexChild: ApexChildSpawn = () => {
      children.push(createFakeApexChild({ publishReadiness: false, spawnError }))
      return children[0] as unknown as ChildProcess
    }

    const error = await startOrcadApex({
      apexDir: artifact.apexDir,
      userDataParent: parent,
      readinessTimeoutMs: 5_000,
      seams: { spawnApexChild }
    }).then(
      () => null,
      (reason: unknown) => reason
    )

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(/failed to spawn/)
    // The original error has to survive the wrapping: "it failed" without EACCES is not actionable.
    expect((error as Error).cause).toBe(spawnError)
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
    const spawnApexChild: ApexChildSpawn = (request) => {
      spawnRequests.push({ command: request.command, args: request.args })
      children.push(createFakeApexChild({ publishReadiness: true }))
      return children[0] as unknown as ChildProcess
    }

    const host = await startOrcadApex({
      apexDir: artifact.apexDir,
      userDataParent: parent,
      seams: { spawnApexChild }
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
    const spawnApexChild: ApexChildSpawn = () => {
      const child = createFakeApexChild({ publishReadiness: true })
      return child as unknown as ChildProcess
    }

    const host = await startOrcadApex({
      apexDir: artifact.apexDir,
      userDataParent: parent,
      seams: { spawnApexChild }
    })
    // Simulate the leak B1 described: the install root's provenance rewritten underneath a run.
    writeFileSync(path.join(artifact.apexDir, '.orca-build.json'), '{"publishedAt":"leaked"}\n')

    const error = await host.dispose().then(
      () => null,
      (reason: unknown) => reason
    )

    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors[0]).toBeInstanceOf(Error)
    expect(((error as AggregateError).errors[0] as Error).message).toMatch(
      /wrote into the artifact it only reads/
    )
    // The report must not leave the temp root behind just because the assertion failed.
    expect(readdirSync(parent)).toEqual([])
  })
})

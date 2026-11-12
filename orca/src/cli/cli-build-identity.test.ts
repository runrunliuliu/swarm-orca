import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ORCA_BUILD_CLI_ARGV_FILENAME,
  ORCA_BUILD_IDENTITY_FILENAME,
  formatOrcaBuildCliArgv,
  formatOrcaBuildIdentity,
  type OrcaBuildIdentity
} from '../shared/build-pointer'
import { describeCliBuildIdentityFailure, readCliBuildIdentity } from './cli-build-identity'

const created: string[] = []

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-cli-build-identity-'))
  created.push(root)
  return root
}

afterEach(() => {
  for (const root of created.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

/** A CLI package boundary: `<root>/package.json` version + the compiled `cli/` directory. */
function makeLocalCli(root: string, version: string): string {
  const runtimeDir = join(root, 'cli')
  mkdirSync(runtimeDir, { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version }))
  return runtimeDir
}

function makeArtifact(root: string, name: string): OrcaBuildIdentity {
  const installDir = join(root, name)
  mkdirSync(installDir, { recursive: true })
  const launcher = join(installDir, 'bun-runtime')
  writeFileSync(launcher, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 })
  chmodSync(launcher, 0o755)
  const document: OrcaBuildIdentity = {
    schemaVersion: 1,
    artifact: 'orcad',
    version: '0.1.0',
    buildId: '4046bdb7dbaa',
    buildTarget: 'linux-x64-glibc',
    installDir,
    cli: { executable: launcher, args: [join(installDir, 'cli/index.cjs')] },
    publishedAt: '2026-11-11T08:50:00.000Z',
    publisher: { kind: 'orcad', pid: 1, version: '0.1.0' }
  }
  writeFileSync(join(installDir, ORCA_BUILD_IDENTITY_FILENAME), formatOrcaBuildIdentity(document))
  writeFileSync(join(installDir, ORCA_BUILD_CLI_ARGV_FILENAME), formatOrcaBuildCliArgv(document.cli))
  return document
}

describe('readCliBuildIdentity', () => {
  it.skipIf(process.platform === 'win32')(
    'reports the artifact the pointer names, not this package version',
    () => {
      const root = makeRoot()
      const runtimeDir = makeLocalCli(root, '1.4.219')
      const artifact = makeArtifact(root, 'orcad-apex-0.1.0-4046bdb7dbaa')
      const pointerPath = join(root, 'current')
      symlinkSync(artifact.installDir, pointerPath)

      const { report, exitCode } = readCliBuildIdentity({ runtimeDir, pointerPath, env: {} })

      expect(exitCode).toBe(0)
      expect(report).toMatchObject({
        source: 'pointer',
        version: '0.1.0',
        artifact: 'orcad',
        buildId: '4046bdb7dbaa',
        buildTarget: 'linux-x64-glibc',
        installDir: artifact.installDir,
        pointer: { state: 'ok', reason: null, required: false },
        local: { version: '1.4.219', installDir: root }
      })
      expect(report.cli).toEqual(artifact.cli)
    }
  )

  it('answers from this package when no pointer exists, and says so', () => {
    const root = makeRoot()
    const runtimeDir = makeLocalCli(root, '1.4.219')

    const { report, exitCode } = readCliBuildIdentity({
      runtimeDir,
      pointerPath: join(root, 'current'),
      env: {}
    })

    expect(exitCode).toBe(0)
    expect(report).toMatchObject({
      source: 'local-package',
      version: '1.4.219',
      buildId: null,
      artifact: null,
      cli: null,
      pointer: { state: 'missing', reason: `no build pointer at ${join(root, 'current')}` }
    })
    expect(describeCliBuildIdentityFailure(report)).toContain('no build pointer')
  })

  it('fails when a deployment says a pointer is mandatory and none exists', () => {
    const root = makeRoot()
    const runtimeDir = makeLocalCli(root, '1.4.219')

    const { exitCode } = readCliBuildIdentity({
      runtimeDir,
      pointerPath: join(root, 'current'),
      env: { ORCA_BUILD_POINTER_REQUIRED: '1' }
    })

    expect(exitCode).toBe(1)
  })

  it.skipIf(process.platform === 'win32')('fails when the pointer exists but cannot be followed', () => {
    const root = makeRoot()
    const runtimeDir = makeLocalCli(root, '1.4.219')
    const pointerPath = join(root, 'current')
    symlinkSync(join(root, 'removed-artifact'), pointerPath)

    const { report, exitCode } = readCliBuildIdentity({ runtimeDir, pointerPath, env: {} })

    expect(exitCode).toBe(1)
    expect(report).toMatchObject({
      source: 'local-package',
      buildId: null,
      pointer: { state: 'dangling', reason: expect.stringContaining('target-missing') }
    })
  })
})

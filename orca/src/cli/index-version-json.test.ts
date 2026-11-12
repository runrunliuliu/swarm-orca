import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ORCA_BUILD_CLI_ARGV_FILENAME,
  ORCA_BUILD_IDENTITY_FILENAME,
  formatOrcaBuildCliArgv,
  formatOrcaBuildIdentity,
  type OrcaBuildIdentity
} from '../shared/build-pointer'
import { main } from './index'

const created: string[] = []
const originalPointerEnv = process.env.ORCA_BUILD_POINTER_PATH
const originalExitCode = process.exitCode

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-cli-version-json-'))
  created.push(root)
  return root
}

function makeArtifact(root: string): OrcaBuildIdentity {
  const installDir = join(root, 'orcad-apex-0.1.0-4046bdb7dbaa')
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

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  process.exitCode = originalExitCode
  if (originalPointerEnv === undefined) {
    delete process.env.ORCA_BUILD_POINTER_PATH
  } else {
    process.env.ORCA_BUILD_POINTER_PATH = originalPointerEnv
  }
  for (const root of created.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function captureStdout(): string[] {
  const writes: string[] = []
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    writes.push(String(chunk))
    return true
  })
  return writes
}

describe.skipIf(process.platform === 'win32')('orca --version --json', () => {
  it('answers which build the pointer names, not just a version string', async () => {
    const root = makeRoot()
    const artifact = makeArtifact(root)
    const pointerPath = join(root, 'current')
    symlinkSync(artifact.installDir, pointerPath)
    vi.stubEnv('ORCA_BUILD_POINTER_PATH', pointerPath)
    const writes = captureStdout()

    await main(['--version', '--json'])

    expect(process.exitCode ?? 0).toBe(0)
    const report = JSON.parse(writes.join(''))
    expect(report).toMatchObject({
      source: 'pointer',
      version: '0.1.0',
      artifact: 'orcad',
      buildId: '4046bdb7dbaa',
      buildTarget: 'linux-x64-glibc',
      installDir: artifact.installDir,
      pointer: { path: pointerPath, state: 'ok' }
    })
  })

  it('reports a broken pointer with a non-zero exit instead of a healthy-looking version', async () => {
    const root = makeRoot()
    const pointerPath = join(root, 'current')
    symlinkSync(join(root, 'removed'), pointerPath)
    vi.stubEnv('ORCA_BUILD_POINTER_PATH', pointerPath)
    const writes = captureStdout()
    const stderrWrites: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderrWrites.push(String(chunk))
      return true
    })

    await main(['--version', '--json'])

    expect(process.exitCode).toBe(1)
    expect(JSON.parse(writes.join(''))).toMatchObject({
      source: 'local-package',
      pointer: { state: 'dangling', reason: expect.stringContaining('target-missing') }
    })
    expect(stderrWrites.join('')).toContain('target-missing')
  })

  it('keeps the plain --version output unchanged (no JSON, no build id)', async () => {
    const root = makeRoot()
    const artifact = makeArtifact(root)
    const pointerPath = join(root, 'current')
    symlinkSync(artifact.installDir, pointerPath)
    vi.stubEnv('ORCA_BUILD_POINTER_PATH', pointerPath)
    const writes = captureStdout()

    await main(['--version'])

    // Why: the pointer must not change what existing version audits parse — one bare token.
    const output = writes.join('')
    expect(output).not.toContain('{')
    expect(output).not.toContain('4046bdb7dbaa')
  })
})

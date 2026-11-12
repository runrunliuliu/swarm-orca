import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ORCA_BUILD_CLI_ARGV_FILENAME,
  ORCA_BUILD_IDENTITY_FILENAME,
  ORCA_BUILD_POINTER_DEFAULT_PATH,
  ORCA_BUILD_POINTER_ENV,
  describeOrcaBuildPointerFailure,
  formatOrcaBuildCliArgv,
  formatOrcaBuildIdentity,
  isOrcaBuildPointerRequired,
  parseOrcaBuildCliArgv,
  parseOrcaBuildIdentity,
  resolveOrcaBuildPointer,
  resolveOrcaBuildPointerPath,
  type OrcaBuildIdentity
} from './build-pointer'

const created: string[] = []

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-build-pointer-'))
  created.push(root)
  return root
}

afterEach(() => {
  for (const root of created.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function identity(installDir: string, overrides: Partial<OrcaBuildIdentity> = {}): OrcaBuildIdentity {
  return {
    schemaVersion: 1,
    artifact: 'orcad',
    version: '0.1.0',
    buildId: '4046bdb7dbaa',
    buildTarget: 'linux-x64-glibc',
    installDir,
    cli: { executable: join(installDir, 'bun-runtime'), args: [join(installDir, 'cli/index.cjs')] },
    publishedAt: '2026-11-11T08:50:00.000Z',
    publisher: { kind: 'orcad', pid: 42, version: '0.1.0' },
    ...overrides
  }
}

/** A conforming artifact root: a named launcher plus the two contract files. */
function makeArtifact(root: string, name: string): { installDir: string; launcher: string } {
  const installDir = join(root, name)
  mkdirSync(installDir, { recursive: true })
  const launcher = join(installDir, 'bun-runtime')
  writeFileSync(launcher, `#!/usr/bin/env bash\nprintf '%s\\n' ${name}\n`, { mode: 0o755 })
  chmodSync(launcher, 0o755)
  const document = identity(installDir, {
    cli: { executable: launcher, args: [join(installDir, 'cli/index.cjs')] }
  })
  writeFileSync(join(installDir, ORCA_BUILD_IDENTITY_FILENAME), formatOrcaBuildIdentity(document))
  writeFileSync(
    join(installDir, ORCA_BUILD_CLI_ARGV_FILENAME),
    formatOrcaBuildCliArgv(document.cli)
  )
  return { installDir, launcher }
}

describe('resolveOrcaBuildPointerPath', () => {
  it('defaults to the machine-wide pointer and honours an explicit override', () => {
    expect(resolveOrcaBuildPointerPath({})).toBe(ORCA_BUILD_POINTER_DEFAULT_PATH)
    expect(resolveOrcaBuildPointerPath({ [ORCA_BUILD_POINTER_ENV]: '/tmp/p' })).toBe('/tmp/p')
    // Empty is unset, matching how every other ORCA_* path variable is read.
    expect(resolveOrcaBuildPointerPath({ [ORCA_BUILD_POINTER_ENV]: '' })).toBe(
      ORCA_BUILD_POINTER_DEFAULT_PATH
    )
  })

  it('treats only 1/true as "this host must have a pointer"', () => {
    expect(isOrcaBuildPointerRequired({})).toBe(false)
    expect(isOrcaBuildPointerRequired({ ORCA_BUILD_POINTER_REQUIRED: '1' })).toBe(true)
    expect(isOrcaBuildPointerRequired({ ORCA_BUILD_POINTER_REQUIRED: 'true' })).toBe(true)
    expect(isOrcaBuildPointerRequired({ ORCA_BUILD_POINTER_REQUIRED: 'yes' })).toBe(false)
  })
})

describe('parseOrcaBuildIdentity', () => {
  it('round-trips a published document', () => {
    const document = identity('/opt/orca/orcad-apex-0.1.0-4046bdb7dbaa')
    expect(parseOrcaBuildIdentity(formatOrcaBuildIdentity(document))).toEqual(document)
  })

  it('rejects a version-only document, so a stale reader cannot mistake it for identity', () => {
    const { buildId: _buildId, ...withoutBuildId } = identity(
      '/opt/orca/orcad-apex-0.1.0-4046bdb7dbaa'
    ) as unknown as OrcaBuildIdentity & { buildId?: string }
    expect(parseOrcaBuildIdentity(JSON.stringify(withoutBuildId))).toBeNull()
  })

  it('rejects malformed, unversioned, and non-absolute documents', () => {
    const valid = identity('/opt/orca/orcad-apex-0.1.0-4046bdb7dbaa')
    const cases: unknown[] = [
      '{',
      { ...valid, schemaVersion: 2 },
      { ...valid, artifact: 'appimage' },
      { ...valid, buildId: 'not-a-sha' },
      { ...valid, installDir: 'opt/orca/relative' },
      { ...valid, cli: { executable: 'relative', args: [] } },
      { ...valid, cli: { executable: '/bin/true', args: [1] } },
      { ...valid, publishedAt: 'yesterday' },
      { ...valid, publisher: { kind: 'orcad', pid: '42', version: '0.1.0' } }
    ]
    for (const value of cases) {
      expect(parseOrcaBuildIdentity(JSON.stringify(value))).toBeNull()
    }
  })

  it('accepts a null build id — an artifact may be built from no known revision', () => {
    const document = identity('/opt/orca/1.4.219', { artifact: 'electron-app', buildId: null })
    expect(parseOrcaBuildIdentity(JSON.stringify(document))?.buildId).toBeNull()
  })
})

describe('cli argv file', () => {
  it('is one element per line, executable first, and round-trips argv exactly', () => {
    const cli = { executable: '/opt/orca/x/bun-runtime', args: ['/opt/orca/x/cli/index.cjs'] }
    const text = formatOrcaBuildCliArgv(cli)
    expect(text).toBe('/opt/orca/x/bun-runtime\n/opt/orca/x/cli/index.cjs\n')
    expect(parseOrcaBuildCliArgv(text)).toEqual(cli)
  })

  it('refuses an element a line-oriented reader would split', () => {
    expect(() => formatOrcaBuildCliArgv({ executable: '/bin/sh', args: ['a\nb'] })).toThrow(
      'orca_build_cli_argv_unrepresentable_element'
    )
    expect(() => formatOrcaBuildCliArgv({ executable: '', args: [] })).toThrow(
      'orca_build_cli_argv_empty_element'
    )
  })
})

describe.skipIf(process.platform === 'win32')('resolveOrcaBuildPointer', () => {
  it('reports ok for a published artifact and names the real directory', () => {
    const root = makeRoot()
    const artifact = makeArtifact(root, 'orcad-apex-0.1.0-4046bdb7dbaa')
    symlinkSync('orcad-apex-0.1.0-4046bdb7dbaa', join(root, 'current'))

    const resolution = resolveOrcaBuildPointer(join(root, 'current'))

    expect(resolution).toMatchObject({
      state: 'ok',
      installDir: artifact.installDir,
      identity: { buildId: '4046bdb7dbaa', version: '0.1.0' }
    })
    expect(describeOrcaBuildPointerFailure(resolution)).toBeNull()
  })

  it('reports missing for an absent link and does not invent a target', () => {
    const root = makeRoot()
    const resolution = resolveOrcaBuildPointer(join(root, 'current'))
    expect(resolution).toEqual({ state: 'missing', pointerPath: join(root, 'current') })
    expect(describeOrcaBuildPointerFailure(resolution)).toContain('no build pointer')
  })

  it('reports dangling when the link survived its target', () => {
    const root = makeRoot()
    symlinkSync(join(root, 'gone'), join(root, 'current'))
    const resolution = resolveOrcaBuildPointer(join(root, 'current'))
    expect(resolution).toMatchObject({ state: 'dangling', failure: 'target-missing' })
  })

  it('rejects a regular file or directory in place of the link', () => {
    const root = makeRoot()
    writeFileSync(join(root, 'current'), 'not a link\n')
    expect(resolveOrcaBuildPointer(join(root, 'current'))).toMatchObject({
      state: 'invalid',
      failure: 'pointer-not-a-symlink'
    })
  })

  it('rejects a target with no identity document', () => {
    const root = makeRoot()
    const artifact = makeArtifact(root, 'orcad-apex-0.1.0-4046bdb7dbaa')
    rmSync(join(artifact.installDir, ORCA_BUILD_IDENTITY_FILENAME))
    symlinkSync(artifact.installDir, join(root, 'current'))
    expect(resolveOrcaBuildPointer(join(root, 'current'))).toMatchObject({
      state: 'invalid',
      failure: 'identity-missing'
    })
  })

  it('rejects a copied artifact that still claims another install dir', () => {
    const root = makeRoot()
    const artifact = makeArtifact(root, 'orcad-apex-0.1.0-4046bdb7dbaa')
    const copy = join(root, 'orcad-apex-0.1.0-4046bdb7dbaa-copy')
    mkdirSync(copy)
    symlinkSync(artifact.launcher, join(copy, 'bun-runtime'))
    // The identity still names the original directory: a copy is not a promotion.
    writeFileSync(
      join(copy, ORCA_BUILD_IDENTITY_FILENAME),
      formatOrcaBuildIdentity(
        identity(artifact.installDir, {
          cli: { executable: artifact.launcher, args: [] }
        })
      )
    )
    writeFileSync(join(copy, ORCA_BUILD_CLI_ARGV_FILENAME), formatOrcaBuildCliArgv({ executable: artifact.launcher, args: [] }))
    symlinkSync(copy, join(root, 'current'))
    expect(resolveOrcaBuildPointer(join(root, 'current'))).toMatchObject({
      state: 'invalid',
      failure: 'install-dir-mismatch'
    })
  })

  it('rejects a CLI that is missing or not executable', () => {
    const root = makeRoot()
    const artifact = makeArtifact(root, 'orcad-apex-0.1.0-4046bdb7dbaa')
    symlinkSync(artifact.installDir, join(root, 'current'))
    chmodSync(artifact.launcher, 0o644)
    expect(resolveOrcaBuildPointer(join(root, 'current'))).toMatchObject({
      state: 'invalid',
      failure: 'cli-not-executable'
    })
    rmSync(artifact.launcher)
    expect(resolveOrcaBuildPointer(join(root, 'current'))).toMatchObject({
      state: 'invalid',
      failure: 'cli-executable-missing'
    })
  })
})

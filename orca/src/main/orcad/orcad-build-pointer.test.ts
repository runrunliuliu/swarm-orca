import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ORCA_BUILD_CLI_ARGV_FILENAME,
  ORCA_BUILD_IDENTITY_FILENAME,
  resolveOrcaBuildPointer
} from '../../shared/build-pointer'
import { parseOrcadVersionMarker } from '../../shared/orcad-artifacts'
import {
  publishOrcadServingBuildPointer,
  readOrcadArtifactIdentity
} from './orcad-build-pointer'

const created: string[] = []

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-orcad-build-pointer-'))
  created.push(root)
  return root
}

afterEach(() => {
  for (const root of created.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

/** The layout build-orcad.mjs writes: bundle entries beside `.version` and `.build-target`. */
function makePackagedRoot(root: string, marker = '0.1.0+4046bdb7dbaa'): {
  installRoot: string
  cli: { executable: string; args: string[] }
} {
  const installRoot = join(root, 'orcad-apex-0.1.0-4046bdb7dbaa')
  mkdirSync(join(installRoot, 'cli'), { recursive: true })
  writeFileSync(join(installRoot, '.version'), `${marker}\n`)
  writeFileSync(join(installRoot, '.build-target'), 'linux-x64-glibc\n')
  writeFileSync(join(installRoot, 'orcad.js'), '// bundle\n')
  const executable = join(installRoot, 'bun-runtime')
  writeFileSync(executable, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 })
  chmodSync(executable, 0o755)
  writeFileSync(join(installRoot, 'cli', 'index.cjs'), '// cli\n')
  return { installRoot, cli: { executable, args: [join(installRoot, 'cli', 'index.cjs')] } }
}

describe('parseOrcadVersionMarker', () => {
  it('reads the build id out of the marker the packager writes', () => {
    expect(parseOrcadVersionMarker('0.1.0+4046bdb7dbaa\n')).toEqual({
      version: '0.1.0',
      buildId: '4046bdb7dbaa'
    })
    expect(parseOrcadVersionMarker('0.1.0')).toEqual({ version: '0.1.0', buildId: null })
    expect(parseOrcadVersionMarker('1.4.178-rc.2+abcdef123456')).toEqual({
      version: '1.4.178-rc.2',
      buildId: 'abcdef123456'
    })
    expect(parseOrcadVersionMarker('not a version')).toBeNull()
  })
})

describe('readOrcadArtifactIdentity', () => {
  it('is null for a checkout that was never packaged', () => {
    const root = makeRoot()
    expect(readOrcadArtifactIdentity(root)).toBeNull()
  })

  it('names the build a packaged root carries', () => {
    const root = makeRoot()
    const { installRoot } = makePackagedRoot(root)
    expect(readOrcadArtifactIdentity(installRoot)).toEqual({
      version: '0.1.0',
      buildId: '4046bdb7dbaa',
      buildTarget: 'linux-x64-glibc'
    })
  })

  it('keeps a null target rather than inventing one', () => {
    const root = makeRoot()
    const { installRoot } = makePackagedRoot(root)
    rmSync(join(installRoot, '.build-target'))
    expect(readOrcadArtifactIdentity(installRoot)).toMatchObject({ buildTarget: null })
  })
})

describe.skipIf(process.platform === 'win32')('publishOrcadServingBuildPointer', () => {
  it('publishes the pointer and the owned bare-orca dispatcher in one step', async () => {
    const root = makeRoot()
    const packaged = makePackagedRoot(root)
    const homePath = join(root, 'home')
    const pointerPath = join(root, 'opt', 'current')

    const outcome = await publishOrcadServingBuildPointer({
      installRoot: packaged.installRoot,
      cli: packaged.cli,
      homePath,
      pointerPath,
      now: () => new Date('2026-11-12T06:00:00.000Z'),
      pid: 1234
    })

    expect(outcome.state).toBe('published')
    expect(resolveOrcaBuildPointer(pointerPath)).toMatchObject({
      state: 'ok',
      installDir: packaged.installRoot,
      identity: {
        artifact: 'orcad',
        version: '0.1.0',
        buildId: '4046bdb7dbaa',
        buildTarget: 'linux-x64-glibc',
        publisher: { kind: 'orcad', pid: 1234 }
      }
    })
    expect(existsSync(join(packaged.installRoot, ORCA_BUILD_IDENTITY_FILENAME))).toBe(true)
    expect(readFileSync(join(packaged.installRoot, ORCA_BUILD_CLI_ARGV_FILENAME), 'utf8')).toBe(
      `${packaged.cli.executable}\n${packaged.cli.args[0]}\n`
    )
    const dispatcherPath = join(homePath, '.local', 'bin', 'orca')
    expect(readFileSync(dispatcherPath, 'utf8')).toContain("pointer=")
  })

  it('is idempotent across restarts of the same build', async () => {
    const root = makeRoot()
    const packaged = makePackagedRoot(root)
    const options = {
      installRoot: packaged.installRoot,
      cli: packaged.cli,
      homePath: join(root, 'home'),
      pointerPath: join(root, 'opt', 'current')
    }

    expect((await publishOrcadServingBuildPointer(options)).state).toBe('published')
    expect((await publishOrcadServingBuildPointer(options)).state).toBe('unchanged')
  })

  it('does nothing at all for a dev checkout, so a test run cannot retarget the machine', async () => {
    const root = makeRoot()
    const homePath = join(root, 'home')

    const outcome = await publishOrcadServingBuildPointer({
      installRoot: root,
      homePath,
      pointerPath: join(root, 'opt', 'current')
    })

    expect(outcome).toEqual({ state: 'skipped', reason: 'not-a-packaged-artifact' })
    expect(existsSync(join(homePath, '.local', 'bin', 'orca'))).toBe(false)
  })
})

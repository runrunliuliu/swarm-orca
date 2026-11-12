import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'

vi.mock('electron', () => ({
  app: { isPackaged: true }
}))

import { resolveAppImageLauncherEndpointPath } from './appimage-stable-launcher'
import { publishOrcaBuildPointer } from './build-pointer'
import { ensureLinuxTerminalOrcaCliShimDir } from './linux-terminal-orca-cli-shim'
import {
  ORCA_BUILD_CLI_ARGV_FILENAME,
  ORCA_BUILD_IDENTITY_FILENAME,
  formatOrcaBuildCliArgv,
  formatOrcaBuildIdentity,
  type OrcaBuildIdentity
} from '../../shared/build-pointer'

const created: string[] = []
const canFenceAppImageRuntime = process.platform === 'linux' && existsSync('/proc/self/stat')

async function makeFixture(): Promise<{ userDataPath: string; resourcesPath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'orca-terminal-cli-shim-'))
  created.push(root)
  const resourcesPath = join(root, 'resources')
  // The bundled orca-ide launcher must exist for the shim to be written.
  mkdirSync(join(resourcesPath, 'bin'), { recursive: true })
  writeFileSync(join(resourcesPath, 'bin', 'orca-ide'), '#!/usr/bin/env bash\n', 'utf8')
  return { userDataPath: join(root, 'user-data'), resourcesPath }
}

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('ensureLinuxTerminalOrcaCliShimDir', () => {
  it('uses the mounted bundled launcher when only APPDIR is inherited', async () => {
    const { userDataPath, resourcesPath } = await makeFixture()
    vi.stubEnv('APPIMAGE', '')
    vi.stubEnv('APPDIR', resourcesPath)

    const shimDir = ensureLinuxTerminalOrcaCliShimDir({ userDataPath, resourcesPath })

    expect(shimDir).toBe(join(userDataPath, 'linux-orca-cli-shim'))
    expect(readFileSync(join(shimDir!, 'orca'), 'utf8')).toContain(
      `exec '${join(resourcesPath, 'bin', 'orca-ide')}' "$@"`
    )
  })

  it('writes an executable bare-orca shim that execs the bundled orca-ide launcher', async () => {
    const { userDataPath, resourcesPath } = await makeFixture()

    const shimDir = ensureLinuxTerminalOrcaCliShimDir({
      userDataPath,
      resourcesPath,
      appImagePath: null
    })

    expect(shimDir).toBe(join(userDataPath, 'linux-orca-cli-shim'))
    const content = readFileSync(join(shimDir!, 'orca'), 'utf8')
    // Single-quoted so a resources path with shell metacharacters can't break out.
    expect(content).toContain(`exec '${join(resourcesPath, 'bin', 'orca-ide')}' "$@"`)
    const mode = statSync(join(shimDir!, 'orca')).mode & 0o777
    expect(mode & 0o111).not.toBe(0)
  })

  it('reuses the shim path and re-asserts its exec bit', async () => {
    const { userDataPath, resourcesPath } = await makeFixture()
    const options = { userDataPath, resourcesPath, appImagePath: null }

    const first = ensureLinuxTerminalOrcaCliShimDir(options)
    expect(first).not.toBeNull()
    const shimPath = join(first!, 'orca')
    chmodSync(shimPath, 0o644)

    const second = ensureLinuxTerminalOrcaCliShimDir(options)
    expect(second).toBe(first)
    expect(statSync(shimPath).mode & 0o111).not.toBe(0)

    const root = await mkdtemp(join(tmpdir(), 'orca-terminal-cli-shim-2-'))
    created.push(root)
    const otherUserData = join(root, 'user-data')
    mkdirSync(join(otherUserData, 'linux-orca-cli-shim'), { recursive: true })
    writeFileSync(join(otherUserData, 'linux-orca-cli-shim', 'orca'), 'stale contents', 'utf8')
    chmodSync(join(otherUserData, 'linux-orca-cli-shim', 'orca'), 0o644)

    const healed = ensureLinuxTerminalOrcaCliShimDir({
      userDataPath: otherUserData,
      resourcesPath,
      appImagePath: null
    })
    expect(healed).not.toBeNull()
    const healedPath = join(healed!, 'orca')
    expect(readFileSync(healedPath, 'utf8')).toContain('orca-ide')
    expect(statSync(healedPath).mode & 0o111).not.toBe(0)
  })

  it.skipIf(process.platform === 'win32')(
    'binds a clean or foreign shell to its owner and preserves caller identity and argv',
    async () => {
      const fixture = await makeFixture()
      const userDataPath = join(fixture.userDataPath, "Owner's $profile")
      const launcherPath = join(fixture.resourcesPath, 'bin', 'orca-ide')
      writeFileSync(
        launcherPath,
        `#!/usr/bin/env bash
printf '%s\\n' "$ORCA_USER_DATA_PATH" "$ORCA_CLI_COMMAND" "\${ORCA_ENVIRONMENT-unset}" "\${ORCA_PAIRING_CODE-unset}" "\${ORCA_DEV_REPO_ROOT-unset}" "\${ORCA_USER_DATA-unset}" "$ORCA_TERMINAL_ID" "$@"
`,
        { mode: 0o755 }
      )
      chmodSync(launcherPath, 0o755)
      const shimDir = ensureLinuxTerminalOrcaCliShimDir({
        userDataPath,
        resourcesPath: fixture.resourcesPath,
        appImagePath: null
      })
      const shimPath = join(shimDir!, 'orca')
      for (const foreign of [false, true]) {
        const result = await runProcess({
          program: shimPath,
          args: ['orchestration', 'check', '--body', "text with ' and $value"],
          env: {
            PATH: process.env.PATH ?? '/usr/bin:/bin',
            ORCA_TERMINAL_ID: 'caller-terminal',
            ...(foreign
              ? {
                  ORCA_ENVIRONMENT: 'foreign-runtime',
                  ORCA_PAIRING_CODE: 'synthetic-pairing',
                  ORCA_DEV_REPO_ROOT: '/foreign/dev',
                  ORCA_USER_DATA: '/foreign/legacy',
                  ORCA_USER_DATA_PATH: '/foreign/profile',
                  ORCA_CLI_COMMAND: '/foreign/orca'
                }
              : {})
          },
          timeoutMs: 3_000
        })
        expect(result).toMatchObject({
          code: 0,
          stdout: [
            userDataPath,
            shimPath,
            'unset',
            'unset',
            'unset',
            'unset',
            'caller-terminal',
            'orchestration',
            'check',
            '--body',
            "text with ' and $value",
            ''
          ].join('\n')
        })
      }
    }
  )

  it.skipIf(!canFenceAppImageRuntime)(
    'routes first-use AppImage terminals through a fenced current mount without a live endpoint',
    async () => {
      const { userDataPath, resourcesPath } = await makeFixture()
      const appImagePath = join(userDataPath, 'Orca.AppImage')
      await mkdir(userDataPath, { recursive: true })
      await writeFile(appImagePath, '#!/usr/bin/env bash\n', { encoding: 'utf8', mode: 0o755 })
      const cacheRootPath = join(userDataPath, 'cache')
      const liveLauncherPath = join(resourcesPath, 'bin', 'orca-ide')
      writeFileSync(liveLauncherPath, '#!/usr/bin/env bash\nprintf live', 'utf8')
      chmodSync(liveLauncherPath, 0o755)
      const shimDir = ensureLinuxTerminalOrcaCliShimDir({
        userDataPath,
        resourcesPath,
        appImagePath,
        appImageCacheRootPath: cacheRootPath
      })

      const shimPath = join(shimDir!, 'orca')
      const content = readFileSync(shimPath, 'utf8')
      expect(content).toContain(liveLauncherPath)
      expect(content).toContain('runtime_pid=')
      expect(content).toContain('/proc/$runtime_pid/stat')
      expect(existsSync(resolveAppImageLauncherEndpointPath(cacheRootPath, 'live'))).toBe(false)
      await expect(
        runProcess({ program: shimPath, args: [], timeoutMs: 3_000 })
      ).resolves.toMatchObject({ code: 0, stdout: 'live' })
    }
  )

  it.skipIf(!canFenceAppImageRuntime)(
    'refreshes restored terminals to the current AppImage mount',
    async () => {
      const { userDataPath, resourcesPath } = await makeFixture()
      const appImagePath = join(userDataPath, 'Orca.AppImage')
      await mkdir(userDataPath, { recursive: true })
      await writeFile(appImagePath, '#!/usr/bin/env bash\n', { encoding: 'utf8', mode: 0o755 })
      const cacheRootPath = join(userDataPath, 'cache')
      const firstLauncher = join(resourcesPath, 'bin', 'orca-ide')
      writeFileSync(firstLauncher, '#!/usr/bin/env bash\nprintf first', 'utf8')
      chmodSync(firstLauncher, 0o755)
      const options = {
        userDataPath,
        resourcesPath,
        appImagePath,
        appImageCacheRootPath: cacheRootPath
      }
      const shimDir = ensureLinuxTerminalOrcaCliShimDir(options)
      const shimPath = join(shimDir!, 'orca')
      const originalShim = readFileSync(shimPath, 'utf8')

      const nextResourcesPath = join(userDataPath, 'next-mount', 'resources')
      const nextLauncher = join(nextResourcesPath, 'bin', 'orca-ide')
      await mkdir(join(nextResourcesPath, 'bin'), { recursive: true })
      await writeFile(nextLauncher, '#!/usr/bin/env bash\nprintf next', { mode: 0o755 })
      await rm(firstLauncher)
      expect(
        ensureLinuxTerminalOrcaCliShimDir({ ...options, resourcesPath: nextResourcesPath })
      ).toBe(shimDir)

      const refreshedShim = readFileSync(shimPath, 'utf8')
      expect(refreshedShim).not.toBe(originalShim)
      expect(refreshedShim).toContain(nextLauncher)
      expect(existsSync(resolveAppImageLauncherEndpointPath(cacheRootPath, 'live'))).toBe(false)
      await expect(
        runProcess({ program: shimPath, args: [], timeoutMs: 3_000 })
      ).resolves.toMatchObject({ code: 0, stdout: 'next' })
    }
  )

  it.skipIf(!canFenceAppImageRuntime)(
    'rejects a stale shim when its mount path is removed and reused',
    async () => {
      const { userDataPath, resourcesPath } = await makeFixture()
      const appImagePath = join(userDataPath, 'Orca.AppImage')
      const cacheRootPath = join(userDataPath, 'cache')
      await mkdir(userDataPath, { recursive: true })
      await writeFile(appImagePath, '#!/usr/bin/env bash\n', { mode: 0o755 })
      const liveLauncher = join(resourcesPath, 'bin', 'orca-ide')
      writeFileSync(liveLauncher, '#!/usr/bin/env bash\nprintf original', { mode: 0o755 })
      const shimDir = ensureLinuxTerminalOrcaCliShimDir({
        userDataPath,
        resourcesPath,
        appImagePath,
        appImageCacheRootPath: cacheRootPath
      })
      const shimPath = join(shimDir!, 'orca')
      await rm(liveLauncher)
      await writeFile(liveLauncher, '#!/usr/bin/env bash\nprintf replaced-by-another-mount', {
        mode: 0o755
      })

      await expect(
        runProcess({ program: shimPath, args: [], timeoutMs: 3_000 })
      ).resolves.toMatchObject({ code: 1, stdout: '' })
    }
  )

  it.skipIf(!canFenceAppImageRuntime)(
    'rejects a shim after its owning AppImage process generation changes',
    async () => {
      const { userDataPath, resourcesPath } = await makeFixture()
      const appImagePath = join(userDataPath, 'Orca.AppImage')
      await mkdir(userDataPath, { recursive: true })
      await writeFile(appImagePath, '#!/usr/bin/env bash\n', { mode: 0o755 })
      const liveLauncher = join(resourcesPath, 'bin', 'orca-ide')
      writeFileSync(liveLauncher, '#!/usr/bin/env bash\nprintf original', { mode: 0o755 })
      const shimDir = ensureLinuxTerminalOrcaCliShimDir({
        userDataPath,
        resourcesPath,
        appImagePath,
        appImageCacheRootPath: join(userDataPath, 'cache')
      })
      const shimPath = join(shimDir!, 'orca')
      const staleContent = readFileSync(shimPath, 'utf8').replace(
        /runtime_start_time='[^']*'/,
        "runtime_start_time='stale-process'"
      )
      writeFileSync(shimPath, staleContent, { mode: 0o755 })

      await expect(
        runProcess({ program: shimPath, args: [], timeoutMs: 3_000 })
      ).resolves.toMatchObject({ code: 1, stdout: '' })
    }
  )

  it('returns null (and does not memoize) when the bundled launcher is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-terminal-cli-shim-missing-'))
    created.push(root)
    const userDataPath = join(root, 'user-data')

    const missing = ensureLinuxTerminalOrcaCliShimDir({
      userDataPath,
      resourcesPath: join(root, 'resources'),
      appImagePath: null
    })
    expect(missing).toBeNull()

    // Once the launcher exists (e.g. later probe with real resources), the same
    // userData path succeeds — proving failures are not cached.
    const resourcesPath = join(root, 'resources')
    mkdirSync(join(resourcesPath, 'bin'), { recursive: true })
    writeFileSync(join(resourcesPath, 'bin', 'orca-ide'), '#!/usr/bin/env bash\n', 'utf8')
    const recovered = ensureLinuxTerminalOrcaCliShimDir({
      userDataPath,
      resourcesPath,
      appImagePath: null
    })
    expect(recovered).toBe(join(userDataPath, 'linux-orca-cli-shim'))
  })

  it.skipIf(process.platform === 'win32')(
    'follows the version pointer inside terminals and picks up a promotion without a rewrite',
    async () => {
      const { userDataPath, resourcesPath } = await makeFixture()
      const root = await mkdtemp(join(tmpdir(), 'orca-terminal-cli-shim-pointer-'))
      created.push(root)
      const pointerPath = join(root, 'opt', 'current')
      const first = makePointerArtifact(root, 'orcad-apex-0.1.0-4046bdb7dbaa')
      const second = makePointerArtifact(root, 'orcad-apex-0.1.0-c3db8076b401')
      publishOrcaBuildPointer({ pointerPath, identity: first.identity })
      const shimDir = ensureLinuxTerminalOrcaCliShimDir({
        userDataPath,
        resourcesPath,
        appImagePath: null,
        buildPointerPath: pointerPath
      })
      const shimPath = join(shimDir!, 'orca')
      const written = readFileSync(shimPath, 'utf8')
      expect(written).toContain(`pointer='${pointerPath}'`)

      const run = () =>
        runProcess({
          program: shimPath,
          args: [],
          env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
          timeoutMs: 3_000
        })
      await expect(run()).resolves.toMatchObject({
        code: 0,
        stdout: 'orcad-apex-0.1.0-4046bdb7dbaa\n'
      })

      // Only the pointer moves: the terminal shim was written once.
      publishOrcaBuildPointer({ pointerPath, identity: second.identity })
      expect(readFileSync(shimPath, 'utf8')).toBe(written)
      await expect(run()).resolves.toMatchObject({
        code: 0,
        stdout: 'orcad-apex-0.1.0-c3db8076b401\n'
      })
    }
  )

  it.skipIf(process.platform === 'win32')(
    'fails closed inside terminals when the version pointer dangles',
    async () => {
      const { userDataPath, resourcesPath } = await makeFixture()
      const root = await mkdtemp(join(tmpdir(), 'orca-terminal-cli-shim-pointer-broken-'))
      created.push(root)
      const pointerPath = join(root, 'opt', 'current')
      const artifact = makePointerArtifact(root, 'orcad-apex-0.1.0-4046bdb7dbaa')
      publishOrcaBuildPointer({ pointerPath, identity: artifact.identity })
      ensureLinuxTerminalOrcaCliShimDir({
        userDataPath,
        resourcesPath,
        appImagePath: null,
        buildPointerPath: pointerPath
      })
      rmSync(artifact.identity.installDir, { recursive: true, force: true })

      const result = await runProcess({
        program: join(userDataPath, 'linux-orca-cli-shim', 'orca'),
        args: [],
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
        timeoutMs: 3_000
      })
      // Why no fallback to the bundled launcher: a half-promoted host must say so, not serve an
      // older build that happens to still be on disk.
      expect(result.code).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toContain('dangling')
    }
  )
})

/** A published artifact whose launcher prints its own directory name. */
function makePointerArtifact(
  root: string,
  name: string
): { identity: OrcaBuildIdentity } {
  const installDir = join(root, name)
  mkdirSync(installDir, { recursive: true })
  const launcher = join(installDir, 'bun-runtime')
  writeFileSync(launcher, `#!/usr/bin/env bash\nprintf '%s\\n' '${name}'\n`, { mode: 0o755 })
  const identity: OrcaBuildIdentity = {
    schemaVersion: 1,
    artifact: 'orcad',
    version: '0.1.0',
    buildId: name.slice(-12),
    buildTarget: 'linux-x64-glibc',
    installDir,
    cli: { executable: launcher, args: [] },
    publishedAt: '2026-11-11T08:50:00.000Z',
    publisher: { kind: 'orcad', pid: 1, version: '0.1.0' }
  }
  writeFileSync(join(installDir, ORCA_BUILD_IDENTITY_FILENAME), formatOrcaBuildIdentity(identity))
  writeFileSync(join(installDir, ORCA_BUILD_CLI_ARGV_FILENAME), formatOrcaBuildCliArgv(identity.cli))
  return { identity }
}

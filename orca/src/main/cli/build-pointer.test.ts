import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import {
  ORCA_BUILD_CLI_ARGV_FILENAME,
  ORCA_BUILD_IDENTITY_FILENAME,
  resolveOrcaBuildPointer,
  type OrcaBuildCli,
  type OrcaBuildIdentity
} from '../../shared/build-pointer'
import {
  buildElectronServingBuildIdentity,
  planOrcaCliScript,
  publishOrcaBuildPointer,
  readPublishedIdentity,
  resolveElectronInstallRoot,
  withStablePublishedAt
} from './build-pointer'
import {
  installBareOrcaBuildPointerDispatcher,
  installLinuxBareOrcaDispatcher
} from './linux-bare-orca-dispatcher'

const created: string[] = []

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-build-pointer-publish-'))
  created.push(root)
  return root
}

afterEach(() => {
  for (const root of created.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function makeArtifact(
  root: string,
  name: string,
  overrides: Partial<OrcaBuildIdentity> = {}
): { installDir: string; cli: OrcaBuildCli } {
  const installDir = join(root, name)
  mkdirSync(installDir, { recursive: true })
  const launcher = join(installDir, 'bun-runtime')
  // `printf <name>` so a test can tell which artifact a script actually exec'd.
  writeFileSync(launcher, `#!/usr/bin/env bash\nprintf '%s\\n' '${name}' "$@"\n`, { mode: 0o755 })
  chmodSync(launcher, 0o755)
  const cli = { executable: launcher, args: [] }
  publishOrcaBuildPointer({
    pointerPath: join(root, '.probe-pointer'),
    identity: identityFor(installDir, cli, overrides)
  })
  return { installDir, cli }
}

function identityFor(
  installDir: string,
  cli: OrcaBuildCli,
  overrides: Partial<OrcaBuildIdentity> = {}
): OrcaBuildIdentity {
  return {
    schemaVersion: 1,
    artifact: 'orcad',
    version: '0.1.0',
    buildId: '4046bdb7dbaa',
    buildTarget: 'linux-x64-glibc',
    installDir,
    cli,
    publishedAt: '2026-11-11T08:50:00.000Z',
    publisher: { kind: 'orcad', pid: 42, version: '0.1.0' },
    ...overrides
  }
}

function runScript(
  program: string,
  args: string[] = [],
  env: NodeJS.ProcessEnv = {}
): Promise<{ code: number; stdout: string; stderr: string }> {
  return runProcess({
    program,
    args,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env },
    timeoutMs: 5_000
  })
}

describe.skipIf(process.platform === 'win32')('publishOrcaBuildPointer', () => {
  it('writes identity beside the artifact, then links the pointer relative to it', () => {
    const root = makeRoot()
    const artifact = makeArtifact(root, 'orcad-apex-0.1.0-4046bdb7dbaa')
    const pointerPath = join(root, 'current')

    const result = publishOrcaBuildPointer({
      pointerPath,
      identity: identityFor(artifact.installDir, artifact.cli)
    })

    expect(result).toMatchObject({ state: 'published', pointerPath, installDir: artifact.installDir })
    expect(readlinkSync(pointerPath)).toBe('orcad-apex-0.1.0-4046bdb7dbaa')
    expect(readPublishedIdentity(artifact.installDir)).toMatchObject({
      buildId: '4046bdb7dbaa',
      installDir: artifact.installDir
    })
    expect(resolveOrcaBuildPointer(pointerPath)).toMatchObject({ state: 'ok' })
  })

  it('is idempotent: the same build republishes nothing, not even publishedAt', () => {
    const root = makeRoot()
    const artifact = makeArtifact(root, 'orcad-apex-0.1.0-4046bdb7dbaa')
    const pointerPath = join(root, 'current')
    publishOrcaBuildPointer({
      pointerPath,
      identity: identityFor(artifact.installDir, artifact.cli, { publishedAt: '2026-11-11T08:50:00.000Z' })
    })
    const identityBefore = readFileSync(join(artifact.installDir, ORCA_BUILD_IDENTITY_FILENAME), 'utf8')

    const second = publishOrcaBuildPointer({
      pointerPath,
      identity: identityFor(artifact.installDir, artifact.cli, { publishedAt: '2026-11-12T09:00:00.000Z' })
    })

    expect(second.state).toBe('published')
    const identityAfter = readFileSync(join(artifact.installDir, ORCA_BUILD_IDENTITY_FILENAME), 'utf8')
    expect(JSON.parse(identityAfter).publishedAt).toBe('2026-11-12T09:00:00.000Z')
    expect(identityBefore).not.toBe(identityAfter)

    const third = publishOrcaBuildPointer({
      pointerPath,
      identity: identityFor(artifact.installDir, artifact.cli, { publishedAt: '2026-11-12T09:00:00.000Z' })
    })
    expect(third.state).toBe('unchanged')
  })

  it('refuses to point at a root it cannot identify, and leaves the old pointer in place', () => {
    const root = makeRoot()
    const first = makeArtifact(root, 'orcad-apex-0.1.0-4046bdb7dbaa')
    const pointerPath = join(root, 'current')
    publishOrcaBuildPointer({ pointerPath, identity: identityFor(first.installDir, first.cli) })

    expect(() =>
      publishOrcaBuildPointer({
        pointerPath,
        identity: identityFor(join(root, 'missing-artifact'), first.cli)
      })
    ).toThrow('orca_build_pointer_install_dir_missing')
    expect(readlinkSync(pointerPath)).toBe('orcad-apex-0.1.0-4046bdb7dbaa')

    const nonExecutable = makeArtifact(root, 'orcad-apex-0.1.0-b0610184b4b1')
    chmodSync(nonExecutable.cli.executable, 0o644)
    expect(() =>
      publishOrcaBuildPointer({
        pointerPath,
        identity: identityFor(nonExecutable.installDir, nonExecutable.cli)
      })
    ).toThrow('orca_build_pointer_cli_not_executable')
    expect(readlinkSync(pointerPath)).toBe('orcad-apex-0.1.0-4046bdb7dbaa')
  })

  it('keeps the publishedAt of the same build across restarts of the same publisher', () => {
    const base = identityFor('/opt/orca/a', { executable: '/opt/orca/a/bun-runtime', args: [] })
    const existing = { ...base, publishedAt: '2026-11-11T08:50:00.000Z' }
    const next = { ...base, publishedAt: '2026-11-12T09:00:00.000Z' }

    expect(withStablePublishedAt(next, existing).publishedAt).toBe('2026-11-11T08:50:00.000Z')
    expect(
      withStablePublishedAt({ ...next, buildId: 'c3db8076b401' }, existing).publishedAt
    ).toBe('2026-11-12T09:00:00.000Z')
    expect(withStablePublishedAt(next, null).publishedAt).toBe('2026-11-12T09:00:00.000Z')
  })
})

describe.skipIf(process.platform === 'win32')('pointer-following bare orca dispatcher', () => {
  it('runs the promoted build and follows a later promotion without being rewritten', async () => {
    const root = makeRoot()
    const homePath = join(root, 'home')
    const pointerPath = join(root, 'opt', 'current')
    const first = makeArtifact(root, 'orcad-apex-0.1.0-4046bdb7dbaa')
    const second = makeArtifact(root, 'orcad-apex-0.1.0-c3db8076b401')
    publishOrcaBuildPointer({ pointerPath, identity: identityFor(first.installDir, first.cli) })

    const published = await installBareOrcaBuildPointerDispatcher({
      homePath,
      buildPointerPath: pointerPath,
      localCli: first.cli
    })
    expect(published).toMatchObject({ state: 'installed', target: pointerPath })

    const dispatcherPath = join(homePath, '.local', 'bin', 'orca')
    expect(readFileSync(dispatcherPath, 'utf8')).toContain('# orca-serve-bare-orca-dispatcher')
    const before = readFileSync(dispatcherPath, 'utf8')
    const mtimeBefore = statSync(dispatcherPath).mtimeMs

    await expect(runScript(dispatcherPath)).resolves.toMatchObject({
      code: 0,
      stdout: 'orcad-apex-0.1.0-4046bdb7dbaa\n'
    })

    // Promotion is the only thing that changes: the script is untouched, the pointer moves.
    publishOrcaBuildPointer({ pointerPath, identity: identityFor(second.installDir, second.cli) })

    expect(readFileSync(dispatcherPath, 'utf8')).toBe(before)
    expect(statSync(dispatcherPath).mtimeMs).toBe(mtimeBefore)
    await expect(runScript(dispatcherPath, ['orchestration', 'check'])).resolves.toMatchObject({
      code: 0,
      stdout: 'orcad-apex-0.1.0-c3db8076b401\norchestration\ncheck\n'
    })
  })

  it('exports the pointer path so the CLI it execs reports the same pointer', async () => {
    const root = makeRoot()
    const homePath = join(root, 'home')
    const pointerPath = join(root, 'opt', 'current')
    const artifact = makeArtifact(root, 'orcad-apex-0.1.0-4046bdb7dbaa')
    // A launcher that echoes the environment the dispatcher handed it.
    const launcher = join(artifact.installDir, 'env-probe')
    writeFileSync(launcher, '#!/usr/bin/env bash\necho "$ORCA_BUILD_POINTER_PATH"\n', {
      mode: 0o755
    })
    publishOrcaBuildPointer({
      pointerPath,
      identity: identityFor(artifact.installDir, { executable: launcher, args: [] })
    })
    await installBareOrcaBuildPointerDispatcher({
      homePath,
      buildPointerPath: pointerPath,
      localCli: { executable: launcher, args: [] }
    })

    await expect(runScript(join(homePath, '.local', 'bin', 'orca'))).resolves.toMatchObject({
      code: 0,
      stdout: `${pointerPath}\n`
    })
  })

  it('fails closed on a dangling pointer instead of falling back to the launcher that wrote it', async () => {
    const root = makeRoot()
    const homePath = join(root, 'home')
    const pointerPath = join(root, 'opt', 'current')
    const artifact = makeArtifact(root, 'orcad-apex-0.1.0-4046bdb7dbaa')
    publishOrcaBuildPointer({ pointerPath, identity: identityFor(artifact.installDir, artifact.cli) })
    await installBareOrcaBuildPointerDispatcher({
      homePath,
      buildPointerPath: pointerPath,
      localCli: artifact.cli
    })
    const dispatcherPath = join(homePath, '.local', 'bin', 'orca')

    rmSync(artifact.installDir, { recursive: true, force: true })

    const result = await runScript(dispatcherPath)
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('is dangling')
  })

  it('fails closed on an unidentifiable target (no argv file)', async () => {
    const root = makeRoot()
    const homePath = join(root, 'home')
    const pointerPath = join(root, 'opt', 'current')
    const artifact = makeArtifact(root, 'orcad-apex-0.1.0-4046bdb7dbaa')
    publishOrcaBuildPointer({ pointerPath, identity: identityFor(artifact.installDir, artifact.cli) })
    await installBareOrcaBuildPointerDispatcher({
      homePath,
      buildPointerPath: pointerPath,
      localCli: artifact.cli
    })
    rmSync(join(artifact.installDir, ORCA_BUILD_CLI_ARGV_FILENAME))

    const result = await runScript(join(homePath, '.local', 'bin', 'orca'))
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('.orca-cli-argv')
  })

  it('keeps a self-contained install working while no pointer exists', async () => {
    const root = makeRoot()
    const homePath = join(root, 'home')
    const artifact = makeArtifact(root, 'orcad-apex-0.1.0-4046bdb7dbaa')
    const pointerPath = join(root, 'opt', 'current')

    const published = await installBareOrcaBuildPointerDispatcher({
      homePath,
      buildPointerPath: pointerPath,
      localCli: artifact.cli
    })
    // No pointer yet: the script still follows it once it appears, so this is not "local mode".
    expect(published).toMatchObject({ state: 'installed', target: pointerPath })
    await expect(runScript(join(homePath, '.local', 'bin', 'orca'))).resolves.toMatchObject({
      code: 0,
      stdout: 'orcad-apex-0.1.0-4046bdb7dbaa\n'
    })

    // A deployment that promises a pointer turns absence into an error.
    const required = await runScript(join(homePath, '.local', 'bin', 'orca'), [], {
      ORCA_BUILD_POINTER_REQUIRED: '1'
    })
    expect(required.code).toBe(1)
    expect(required.stdout).toBe('')
    expect(required.stderr).toContain('no build pointer')
  })

  it('never clobbers a bare orca the user owns', async () => {
    const root = makeRoot()
    const homePath = join(root, 'home')
    const dispatcherPath = join(homePath, '.local', 'bin', 'orca')
    mkdirSync(join(homePath, '.local', 'bin'), { recursive: true })
    writeFileSync(dispatcherPath, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 })
    const artifact = makeArtifact(root, 'orcad-apex-0.1.0-4046bdb7dbaa')

    const published = await installBareOrcaBuildPointerDispatcher({
      homePath,
      buildPointerPath: join(root, 'opt', 'current'),
      localCli: artifact.cli
    })

    expect(published.state).toBe('skipped-foreign')
    expect(readFileSync(dispatcherPath, 'utf8')).toBe('#!/usr/bin/env bash\nexit 0\n')
  })

  it('writes a fail-closed script when the pointer is already broken at install time', async () => {
    const root = makeRoot()
    const homePath = join(root, 'home')
    const pointerPath = join(root, 'opt', 'current')
    mkdirSync(join(root, 'opt'), { recursive: true })
    symlinkSync(join(root, 'gone'), pointerPath)

    const published = await installBareOrcaBuildPointerDispatcher({
      homePath,
      buildPointerPath: pointerPath,
      localCli: null
    })

    expect(published).toMatchObject({ state: 'installed', target: null })
    expect(published.failure).toContain('dangling')
    const result = await runScript(join(homePath, '.local', 'bin', 'orca'))
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('refusing to fall back')
  })
})

describe('planOrcaCliScript', () => {
  it('is a local launcher only when there is no pointer mechanism at all', () => {
    const plan = planOrcaCliScript({
      pointerPath: null,
      localCli: { executable: '/opt/orca/1.4.219/resources/bin/orca-ide', args: [] }
    })
    expect(plan.mode).toBe('local')
    expect(plan.script).toContain("exec '/opt/orca/1.4.219/resources/bin/orca-ide' \"$@\"")
  })

  it('treats a missing pointer as "follow it when it appears", not as local mode', () => {
    const plan = planOrcaCliScript({
      pointerPath: '/opt/orca/current',
      localCli: { executable: '/bin/true', args: [] },
      resolution: { state: 'missing', pointerPath: '/opt/orca/current' }
    })
    expect(plan.mode).toBe('pointer')
    expect(plan.script).toContain("pointer='/opt/orca/current'")
    expect(plan.script).toContain("exec '/bin/true' \"$@\"")
  })

  it('never falls back when the pointer exists but cannot be followed', () => {
    const plan = planOrcaCliScript({
      pointerPath: '/opt/orca/current',
      localCli: { executable: '/bin/true', args: [] },
      resolution: {
        state: 'invalid',
        pointerPath: '/opt/orca/current',
        installDir: '/opt/orca/orcad-apex-0.1.0-4046bdb7dbaa',
        failure: 'identity-invalid'
      }
    })
    expect(plan.mode).toBe('fail-closed')
    expect(plan.script).not.toContain("exec '/bin/true'")
  })
})

describe('Electron install root', () => {
  it('strips the AppImage extraction level and nothing else', () => {
    expect(resolveElectronInstallRoot('/opt/orca/1.4.219/squashfs-root/resources')).toBe(
      '/opt/orca/1.4.219'
    )
    expect(resolveElectronInstallRoot('/opt/orca/resources')).toBe('/opt/orca')
  })

  it('describes a serve host with the version it has and no invented build id', () => {
    const document = buildElectronServingBuildIdentity({
      resourcesPath: '/opt/orca/1.4.219/squashfs-root/resources',
      version: '1.4.219',
      buildId: null,
      cli: { executable: '/opt/orca/1.4.219/squashfs-root/resources/bin/orca-ide', args: [] },
      now: () => new Date('2026-11-12T00:00:00.000Z'),
      pid: 7
    })
    expect(document).toMatchObject({
      artifact: 'electron-app',
      version: '1.4.219',
      buildId: null,
      installDir: '/opt/orca/1.4.219',
      publishedAt: '2026-11-12T00:00:00.000Z',
      publisher: { kind: 'electron-serve', pid: 7 }
    })
  })
})

describe.skipIf(process.platform === 'win32')('installLinuxBareOrcaDispatcher with a pointer', () => {
  it('does not extract an AppImage when a usable pointer already names the CLI', async () => {
    const root = makeRoot()
    const homePath = join(root, 'home')
    const pointerPath = join(root, 'opt', 'current')
    const artifact = makeArtifact(root, 'orcad-apex-0.1.0-4046bdb7dbaa')
    publishOrcaBuildPointer({ pointerPath, identity: identityFor(artifact.installDir, artifact.cli) })

    const result = await installLinuxBareOrcaDispatcher({
      resourcesPath: join(root, 'resources-that-do-not-exist'),
      homePath,
      buildPointerPath: pointerPath
    })

    expect(result).toMatchObject({ state: 'installed', target: pointerPath })
    await expect(runScript(join(homePath, '.local', 'bin', 'orca'))).resolves.toMatchObject({
      stdout: 'orcad-apex-0.1.0-4046bdb7dbaa\n'
    })
  })
})

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import { resolveOrcaBuildPointer } from '../../shared/build-pointer'
import {
  describeServeBuildPointerPublication,
  publishServeBuildPointer
} from './serve-build-pointer'

const created: string[] = []

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-serve-build-pointer-'))
  created.push(root)
  return root
}

afterEach(() => {
  for (const root of created.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

/** The packaged Electron shape: `<root>/resources/bin/orca-ide` inside the artifact root. */
function makeElectronInstall(root: string): { resourcesPath: string; launcher: string } {
  const resourcesPath = join(root, 'resources')
  mkdirSync(join(resourcesPath, 'bin'), { recursive: true })
  const launcher = join(resourcesPath, 'bin', 'orca-ide')
  writeFileSync(launcher, "#!/usr/bin/env bash\nprintf 'electron-1.4.219\\n'\n", { mode: 0o755 })
  chmodSync(launcher, 0o755)
  return { resourcesPath, launcher }
}

describe.skipIf(process.platform !== 'linux')('publishServeBuildPointer', () => {
  it('names this Electron install, then points bare orca at the pointer', async () => {
    const root = makeRoot()
    const { resourcesPath, launcher } = makeElectronInstall(root)
    const pointerPath = join(root, 'opt', 'current')
    const homePath = join(root, 'home')

    const publication = await publishServeBuildPointer({
      resourcesPath,
      appVersion: '1.4.219',
      env: { ORCA_BUILD_POINTER_PATH: pointerPath },
      arch: 'x64',
      homePath
    })

    expect(publication.failure).toBeNull()
    expect(publication.pointer).toMatchObject({ state: 'published', installDir: root })
    expect(publication.dispatcher).toMatchObject({ state: 'installed', target: pointerPath })
    expect(resolveOrcaBuildPointer(pointerPath)).toMatchObject({
      state: 'ok',
      identity: {
        artifact: 'electron-app',
        version: '1.4.219',
        buildId: null,
        installDir: root,
        cli: { executable: launcher, args: [] }
      }
    })

    const dispatcherPath = join(homePath, '.local', 'bin', 'orca')
    expect(readFileSync(dispatcherPath, 'utf8')).toContain(`pointer='${pointerPath}'`)
    await expect(
      runProcess({
        program: dispatcherPath,
        args: [],
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
        timeoutMs: 5_000
      })
    ).resolves.toMatchObject({ code: 0, stdout: 'electron-1.4.219\n' })

    const line = describeServeBuildPointerPublication(publication)
    expect(line).toContain('build pointer published')
    expect(line).toContain('bare orca dispatcher installed')
  })

  it.skipIf(process.getuid?.() === 0)(
    'reports an unwritable install root instead of silently keeping the old pointer',
    async () => {
      const root = makeRoot()
      const { resourcesPath } = makeElectronInstall(root)
      const pointerPath = join(root, 'opt', 'current')
      // A separate writable home: the point is that only the install root is unwritable.
      const homePath = makeRoot()
      // A root-owned /opt/orca layout is the production case this models.
      chmodSync(root, 0o555)

      const publication = await publishServeBuildPointer({
        resourcesPath,
        appVersion: '1.4.219',
        env: { ORCA_BUILD_POINTER_PATH: pointerPath },
        arch: 'x64',
        homePath
      })
      chmodSync(root, 0o755)

      expect(publication.pointer).toBeNull()
      expect(publication.failure).toMatch(/orca_build_pointer|EACCES/)
      // The dispatcher is still written: it follows the pointer once a writable build publishes it.
      expect(publication.dispatcher).toMatchObject({ state: 'installed', target: pointerPath })
      expect(describeServeBuildPointerPublication(publication)).toContain(
        'build pointer not published'
      )
      expect(readFileSync(join(homePath, '.local', 'bin', 'orca'), 'utf8')).toContain(
        `pointer='${pointerPath}'`
      )
    }
  )
})

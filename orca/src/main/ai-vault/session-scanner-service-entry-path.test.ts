import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  resolveAiVaultServiceEntryPath,
  resolveAiVaultServiceEntryPathWithoutApp
} from './session-scanner-service-entry-path'

describe('resolveAiVaultServiceEntryPath', () => {
  it('uses the adjacent electron-vite output when present', () => {
    const outMain = join(process.cwd(), 'out', 'main')
    const adjacent = join(outMain, 'session-scanner-service-entry.js')

    expect(resolveAiVaultServiceEntryPath(outMain, false, (path) => path === adjacent)).toBe(
      adjacent
    )
  })

  it('uses the nested output from a project root', () => {
    expect(resolveAiVaultServiceEntryPath(process.cwd(), false, () => false)).toBe(
      join(process.cwd(), 'out', 'main', 'session-scanner-service-entry.js')
    )
  })

  it('uses app.asar.unpacked for packaged Electron', () => {
    const appPath = join('C:', 'Orca', 'resources', 'app.asar')

    expect(resolveAiVaultServiceEntryPath(appPath, true)).toBe(
      join(
        'C:',
        'Orca',
        'resources',
        'app.asar.unpacked',
        'out',
        'main',
        'session-scanner-service-entry.js'
      )
    )
  })

  it('uses resourcesPath from packaged Electron-as-Node runtimes', () => {
    const resourcesPath = join('Applications', 'Orca.app', 'Contents', 'Resources')
    const entry = join(
      resourcesPath,
      'app.asar.unpacked',
      'out',
      'main',
      'session-scanner-service-entry.js'
    )

    expect(
      resolveAiVaultServiceEntryPathWithoutApp(
        '/unrelated/cwd',
        resourcesPath,
        (path) => path === entry
      )
    ).toBe(entry)
  })

  // The orcad artifact is a packaged non-Electron host: its app root holds orcad.js and
  // has no asar, and it answers `isPackaged() === true`. That combination skips the
  // adjacent probe, so `config/scripts/build-orcad.mjs` has to emit the entry under
  // `out/main` of the install root. Pinned here because the build's landing path is a
  // consequence of this resolver, not an independent choice.
  it('nests the entry under out/main for the packaged orcad install root', () => {
    const installRoot = '/opt/orca/orcad-install'
    const adjacent = join(installRoot, 'session-scanner-service-entry.js')

    expect(resolveAiVaultServiceEntryPath(installRoot, true, (path) => path === adjacent)).toBe(
      join(installRoot, 'out', 'main', 'session-scanner-service-entry.js')
    )
  })
})

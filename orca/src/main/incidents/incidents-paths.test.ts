/**
 * Path resolution (§6.1): the incident database lives in per-host user data, never in a Run archive,
 * the orchestration database, or a working tree.
 */
import { sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getAppEnvironment } from '../../shared/app-environment'
import {
  cliUserDataPathFor,
  incidentsDatabaseFileFor,
  mainProcessUserDataPath,
  resolveLocalHostId,
  resolveMainProcessIncidentsDatabaseFile
} from './incidents-paths'

describe('incidentsDatabaseFileFor', () => {
  it('puts the database in an incidents subdirectory of the user-data root', () => {
    expect(incidentsDatabaseFileFor(['', 'home', 'someone', '.config', 'orca'].join(sep))).toBe(
      ['', 'home', 'someone', '.config', 'orca', 'incidents', 'incidents.db'].join(sep)
    )
  })

  it('never resolves inside a Run archive or orchestration state', () => {
    const path = incidentsDatabaseFileFor(['', 'home', 'someone', '.config', 'orca'].join(sep))
    expect(path).not.toContain('orchestration')
    expect(path).not.toContain('archive')
  })
})

describe('resolveMainProcessIncidentsDatabaseFile', () => {
  it('anchors the database under the installed app environment user-data path', () => {
    // vitest installs a per-file userData directory, so this is the same resolution the desktop
    // performs after `initDataPath()`: the store must follow the host's data directory, not invent one.
    const userData = getAppEnvironment().getPath('userData')
    expect(mainProcessUserDataPath()).toBe(userData)
    expect(resolveMainProcessIncidentsDatabaseFile()).toBe(
      incidentsDatabaseFileFor(userData as string)
    )
  })

  it('keeps the file out of the working tree and out of the orchestration database', () => {
    const path = resolveMainProcessIncidentsDatabaseFile()
    expect(path).not.toBeNull()
    expect(path?.endsWith(['incidents', 'incidents.db'].join(sep))).toBe(true)
    expect(path).not.toContain('orchestration')
  })
})

describe('cliUserDataPathFor', () => {
  it('mirrors the platform bases the runtime metadata uses', () => {
    expect(cliUserDataPathFor('darwin', ['', 'Users', 'someone'].join(sep))).toBe(
      ['', 'Users', 'someone', 'Library', 'Application Support', 'orca'].join(sep)
    )
    // The separator comes from the running platform's `join`, exactly as `getDefaultUserDataPath`
    // does, so the assertion is about the base directory, not about Windows path syntax.
    expect(
      cliUserDataPathFor('win32', 'C:\\Users\\someone', 'C:\\Users\\someone\\AppData\\Roaming')
    ).toMatch(/orca$/)
    expect(cliUserDataPathFor('linux', ['', 'home', 'someone'].join(sep))).toMatch(/orca$/)
  })

  it('refuses to guess on Windows without APPDATA', () => {
    expect(() => cliUserDataPathFor('win32', 'C:\\Users\\someone', undefined)).toThrow(/APPDATA/)
  })
})

describe('resolveLocalHostId', () => {
  it('is a non-empty, bounded token', () => {
    const id = resolveLocalHostId()
    expect(id.length).toBeGreaterThan(0)
    expect(id.length).toBeLessThanOrEqual(200)
    expect(id).toBe(id.trim())
  })
})

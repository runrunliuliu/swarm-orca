import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { runProcess } from '../../shared/child-process/run-process'
import { prependOrcaCliDirToChildPath } from './orca-cli-child-path'

const roots: string[] = []
afterEach(() => {
  installFakeAppEnvironment()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'orca-cli-owner-'))
  roots.push(root)
  const profile = join(root, "Owner's $profile")
  const entry = join(root, 'cli', 'index.cjs')
  mkdirSync(dirname(entry), { recursive: true })
  installFakeAppEnvironment({ isPackaged: () => true, getCliEntryPath: () => entry })
  return { root, profile, entry }
}

describe('standalone managed CLI', () => {
  it.skipIf(process.platform === 'win32')(
    'binds its profile and CLI while preserving caller proof and arguments',
    async () => {
      const { profile, entry } = fixture()
      writeFileSync(
        entry,
        `console.log(JSON.stringify({args:process.argv.slice(2),profile:process.env.ORCA_USER_DATA_PATH,caller:process.env.ORCA_TERMINAL_ID,environment:process.env.ORCA_ENVIRONMENT,cli:process.env.ORCA_CLI_COMMAND}))`
      )
      const env = { PATH: '/usr/bin' }
      const launcher = prependOrcaCliDirToChildPath(env, {
        isPackaged: true,
        userDataPath: profile
      })
      expect(launcher).toBeTruthy()
      if (!launcher) {
        throw new Error('missing launcher')
      }
      expect(env.PATH.split(':')[0]).toBe(dirname(launcher))
      const result = await runProcess({
        program: launcher,
        args: ['a b', '--flag=--value', "quote'$value"],
        env: {
          ...process.env,
          ORCA_USER_DATA_PATH: '/foreign',
          ORCA_ENVIRONMENT: 'foreign',
          ORCA_TERMINAL_ID: 'native-caller'
        }
      })
      expect(result.code).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({
        args: ['a b', '--flag=--value', "quote'$value"],
        profile,
        caller: 'native-caller',
        cli: launcher
      })
      expect(readFileSync(launcher, 'utf8')).toContain(entry)
      expect(prependOrcaCliDirToChildPath(env, { isPackaged: true, userDataPath: profile })).toBe(
        launcher
      )
      expect(env.PATH.split(':').filter((p) => p === dirname(launcher))).toHaveLength(1)
    }
  )

  it('refuses missing packages instead of inheriting a foreign CLI', () => {
    const { profile } = fixture()
    expect(() =>
      prependOrcaCliDirToChildPath(
        { PATH: '/foreign/bin' },
        { isPackaged: true, userDataPath: profile, platform: 'linux' }
      )
    ).toThrow('orcad_cli_missing')
  })

  it('does not pretend a POSIX launcher supports Windows', () => {
    const { profile } = fixture()
    expect(() =>
      prependOrcaCliDirToChildPath(
        {},
        { isPackaged: true, userDataPath: profile, platform: 'win32' }
      )
    ).toThrow('orcad_cli_windows_launcher_unavailable')
  })
})

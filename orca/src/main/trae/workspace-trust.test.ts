import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lock } from 'proper-lockfile'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { escapeTomlBasicString } from '../codex/config-toml-syntax'
import { appendTraeWorkspaceTrust } from './workspace-trust-content'
import { markTraeWorkspaceTrusted, resolveTraeTrustConfigFile } from './workspace-trust'

let root: string
let workspace: string
let config: string

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'orca-trae-trust-')))
  workspace = join(root, 'worker.with dots and spaces')
  mkdirSync(workspace)
  config = join(root, '.trae', 'traecli.toml')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function writeConfig(content: string): void {
  mkdirSync(join(root, '.trae'), { recursive: true })
  writeFileSync(config, content, { mode: 0o600 })
}

describe('Trae workspace trust', () => {
  it('writes only the exact directory, with private permissions, and is idempotent', async () => {
    await markTraeWorkspaceTrusted(workspace, config, 1500)
    const first = readFileSync(config, 'utf-8')
    expect(first).toBe(
      `[projects."${escapeTomlBasicString(workspace)}"]\ntrust_level = "trusted"\n`
    )
    if (process.platform !== 'win32') {
      expect(statSync(config).mode & 0o777).toBe(0o600)
    }
    await markTraeWorkspaceTrusted(workspace, config, 1500)
    expect(readFileSync(config, 'utf-8')).toBe(first)
    expect(existsSync(`${config}.bak`)).toBe(false)
  })

  it('preserves unrelated bytes and keeps a backup and restrictive mode', async () => {
    const original = '# keep this comment\r\nmodel = "example"\r\n[features]\r\nflag = true\r\n'
    writeConfig(original)
    await markTraeWorkspaceTrusted(workspace, config, 1500)
    expect(readFileSync(config, 'utf-8')).toBe(
      `${original}\r\n\r\n[projects."${escapeTomlBasicString(workspace)}"]\r\ntrust_level = "trusted"\r\n`
    )
    expect(readFileSync(`${config}.bak`, 'utf-8')).toBe(original)
    if (process.platform !== 'win32') {
      expect(statSync(config).mode & 0o777).toBe(0o600)
    }
  })

  it('does not override explicit untrusted policy through either path of a symlink', async () => {
    const alias = join(root, 'workspace-alias')
    symlinkSync(workspace, alias, 'junction')
    const original = `[projects."${escapeTomlBasicString(workspace)}"]\ntrust_level = "untrusted"\n`
    writeConfig(original)
    await markTraeWorkspaceTrusted(alias, config, 1500)
    expect(readFileSync(config, 'utf-8')).toBe(original)
  })

  it('keeps a symlinked config intact while trusting both spellings of the same workspace', async () => {
    const alias = join(root, 'workspace-alias')
    symlinkSync(workspace, alias, 'junction')
    const target = join(root, 'dotfiles.toml')
    writeFileSync(target, '# dotfiles\n', { mode: 0o600 })
    mkdirSync(join(root, '.trae'))
    symlinkSync(target, config)
    await markTraeWorkspaceTrusted(alias, config, 1500)
    expect(lstatSync(config).isSymbolicLink()).toBe(true)
    const content = readFileSync(target, 'utf-8')
    for (const key of [workspace, alias]) {
      expect(content).toContain(`[projects."${escapeTomlBasicString(key)}"]`)
    }
  })

  it('retains all 16 concurrent Worker grants, including when config directories are aliases', async () => {
    mkdirSync(join(root, '.trae'))
    const configAlias = join(root, 'config-alias')
    symlinkSync(join(root, '.trae'), configAlias, 'junction')
    const workspaces = Array.from({ length: 16 }, (_, n) => join(root, `worker-${n}`))
    for (const path of workspaces) {
      mkdirSync(path)
    }
    await Promise.all(
      workspaces.map((path, n) =>
        markTraeWorkspaceTrusted(path, n % 2 ? join(configAlias, 'traecli.toml') : config, 1500)
      )
    )
    const content = readFileSync(config, 'utf-8')
    expect(content.match(/trust_level = "trusted"/g)).toHaveLength(16)
    for (const path of workspaces) {
      expect(content).toContain(`[projects."${escapeTomlBasicString(path)}"]`)
    }
    expect(readdirSync(join(root, '.trae')).sort()).toEqual(['traecli.toml', 'traecli.toml.bak'])
  })

  it('does not break another writer’s lock or modify its config', async () => {
    writeConfig('# original\n')
    const release = await lock(config, { realpath: false })
    try {
      await expect(markTraeWorkspaceTrusted(workspace, config, 1500)).rejects.toThrow()
      expect(readFileSync(config, 'utf-8')).toBe('# original\n')
      expect(existsSync(`${config}.lock`)).toBe(true)
    } finally {
      await release()
    }
  })

  it('does not grant a queued write whose launch deadline has expired', async () => {
    await expect(markTraeWorkspaceTrusted(workspace, config, 0)).rejects.toThrow('expired')
    expect(existsSync(config)).toBe(false)
  })

  it('refuses dangling config links and nonexistent workspaces', async () => {
    mkdirSync(join(root, '.trae'))
    symlinkSync(join(root, 'missing.toml'), config)
    await expect(markTraeWorkspaceTrusted(workspace, config, 1500)).rejects.toThrow()
    expect(lstatSync(config).isSymbolicLink()).toBe(true)
    await expect(markTraeWorkspaceTrusted(join(root, 'missing'), config, 1500)).rejects.toThrow()
  })

  it('resolves only an absolute TRAE_HOME, otherwise defaults to the launched agent’s home', () => {
    expect(resolveTraeTrustConfigFile(root, {})).toBe(config)
    expect(resolveTraeTrustConfigFile(root, { TRAE_HOME: join(root, 'custom') })).toBe(
      join(root, 'custom', 'traecli.toml')
    )
    expect(() => resolveTraeTrustConfigFile(root, { TRAE_HOME: 'relative' })).toThrow()
  })
})

describe('append-only Trae trust content', () => {
  it('escapes dots, quotes, backslashes and non-ASCII paths as TOML keys, not dotted CLI overrides', () => {
    const path = '/work/项目.v1/quote"/back\\slash'
    expect(appendTraeWorkspaceTrust('', [path])).toBe(
      '[projects."/work/项目.v1/quote\\"/back\\\\slash"]\ntrust_level = "trusted"\n'
    )
  })

  it.each(['trusted', 'untrusted'])(
    'preserves an existing %s decision even with quoted keys',
    (trust) => {
      const original = `["projects".'/repo.wt']\n"trust_level" = '${trust}'\n`
      expect(appendTraeWorkspaceTrust(original, ['/repo.wt'])).toBe(original)
    }
  )

  it('does not mistake project-shaped text inside a multiline string for policy', () => {
    const original = 'message = """\n[projects."/repo.wt"]\ntrust_level = "untrusted"\n"""\n'
    const next = appendTraeWorkspaceTrust(original, ['/repo.wt'])
    expect(next.startsWith(original)).toBe(true)
    expect(next.endsWith('[projects."/repo.wt"]\ntrust_level = "trusted"\n')).toBe(true)
  })

  it.each([
    'projects = { "/repo.wt" = { trust_level = "untrusted" } }',
    'projects."/repo.wt".trust_level = "untrusted"',
    '[projects]\n"/repo.wt" = { trust_level = "untrusted" }',
    '[[projects]]\npath = "/repo.wt"',
    'message = """unfinished',
    'items = [\n"unfinished"',
    '[broken header',
    '[features]\nflag = true\n[features]\nflag = false',
    'invalid config'
  ])('refuses unsupported or incomplete config without repairing it: %s', (original) => {
    expect(() => appendTraeWorkspaceTrust(original, ['/repo.wt'])).toThrow()
  })
})

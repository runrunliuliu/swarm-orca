import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { markCodexArkWorkspaceTrusted, resolveCodexArkTrustConfigFile } from './workspace-trust'

let root: string
let home: string
let workspace: string
let config: string

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'orca-codex-ark-trust-')))
  home = join(root, 'home', 'me')
  mkdirSync(home, { recursive: true })
  workspace = join(root, 'worktrees', 'feature.with dots')
  mkdirSync(workspace, { recursive: true })
  config = join(home, '.codex-ark', 'config.toml')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** The subset of the wrapper's own config that makes a read-back meaningful. */
const WRAPPER_CONFIG = [
  'model = "ep-ark"',
  'model_provider = "ark_local"',
  '',
  '[model_providers.ark_local]',
  'base_url = "http://127.0.0.1:8791/v1"',
  ''
].join('\n')

function writeArkConfig(content = WRAPPER_CONFIG): void {
  mkdirSync(join(home, '.codex-ark'), { recursive: true })
  writeFileSync(config, content, { mode: 0o600 })
}

describe('resolveCodexArkTrustConfigFile', () => {
  it("points at the wrapper's own home, not the inherited CODEX_HOME", () => {
    writeArkConfig()
    expect(
      resolveCodexArkTrustConfigFile(home, { HOME: home, CODEX_HOME: join(root, 'codex-home') })
    ).toBe(realpathSync.native(config))
  })

  it('returns null when the wrapper has not written its config', () => {
    expect(resolveCodexArkTrustConfigFile(home, { HOME: home })).toBeNull()
  })

  it('follows CODEX_ARK_HOME when the wrapper lives elsewhere', () => {
    const arkHome = join(root, 'opt', 'ark')
    mkdirSync(arkHome, { recursive: true })
    writeFileSync(join(arkHome, 'config.toml'), WRAPPER_CONFIG, { mode: 0o600 })
    expect(resolveCodexArkTrustConfigFile(home, { CODEX_ARK_HOME: arkHome })).toBe(
      realpathSync.native(join(arkHome, 'config.toml'))
    )
  })

  it('refuses a relative CODEX_ARK_HOME instead of guessing', () => {
    writeArkConfig()
    expect(resolveCodexArkTrustConfigFile(home, { CODEX_ARK_HOME: 'relative/ark' })).toBeNull()
  })
})

describe('markCodexArkWorkspaceTrusted', () => {
  it('appends one project record and leaves the wrapper keys byte-for-byte intact', async () => {
    writeArkConfig()
    await markCodexArkWorkspaceTrusted(workspace, config)
    const written = readFileSync(config, 'utf-8')
    expect(written.startsWith(WRAPPER_CONFIG)).toBe(true)
    expect(written).toContain(`[projects."${workspace}"]`)
    expect(written).toContain('trust_level = "trusted"')
  })

  it('is idempotent across repeated grants', async () => {
    writeArkConfig()
    await markCodexArkWorkspaceTrusted(workspace, config)
    const once = readFileSync(config, 'utf-8')
    await markCodexArkWorkspaceTrusted(workspace, config)
    expect(readFileSync(config, 'utf-8')).toBe(once)
  })

  it('never creates the config, which the wrapper alone may write', async () => {
    await markCodexArkWorkspaceTrusted(workspace, config)
    expect(existsSync(config)).toBe(false)
  })

  it('keeps existing trusted and untrusted decisions for other paths', async () => {
    const other = join(root, 'other')
    mkdirSync(other, { recursive: true })
    writeArkConfig(
      `${WRAPPER_CONFIG}\n[projects."${other}"]\ntrust_level = "untrusted"\n`
    )
    await markCodexArkWorkspaceTrusted(workspace, config)
    const written = readFileSync(config, 'utf-8')
    expect(written).toContain(`[projects."${other}"]\ntrust_level = "untrusted"`)
    expect(written).toContain(`[projects."${workspace}"]`)
  })
})

import { lstatSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { lock } from 'proper-lockfile'
import { runKeyedSerializedOperation } from '../cli/keyed-promise-queue'
import { writeTomlConfigAtomically } from '../codex/config-toml-atomic-write'
import { appendTraeWorkspaceTrust } from './workspace-trust-content'

const writesByConfig = new Map<string, Promise<void>>()
const NEVER_STALE_MS = 2 ** 30

export function resolveTraeTrustConfigFile(
  agentHome: string,
  env: Record<string, string | undefined>
): string {
  const traeHome = env.TRAE_HOME || join(agentHome, '.trae')
  if (!isAbsolute(traeHome)) {
    throw new Error('Relative TRAE_HOME cannot be pre-trusted')
  }
  return join(traeHome, 'traecli.toml')
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function resolveConfigTarget(configFile: string): string {
  try {
    lstatSync(configFile)
  } catch (error) {
    if (!isMissing(error)) {
      throw error
    }
    mkdirSync(dirname(configFile), { recursive: true, mode: 0o700 })
    return join(realpathSync.native(dirname(configFile)), basename(configFile))
  }
  // Why: realpath rejects dangling symlinks; replacing one would destroy a user's dotfiles link.
  const target = realpathSync.native(configFile)
  if (!statSync(target).isFile()) {
    throw new Error('Trae config is not a regular file')
  }
  return target
}

/** Pre-grants only this launch directory, serialized across Swarm's concurrent workers. */
export async function markTraeWorkspaceTrusted(
  workspacePath: string,
  configFile: string,
  deadlineMs: number
): Promise<void> {
  if (!isAbsolute(workspacePath) || !isAbsolute(configFile)) {
    throw new Error('Trae trust requires absolute paths')
  }
  const canonicalWorkspace = realpathSync.native(workspacePath)
  if (!statSync(canonicalWorkspace).isDirectory()) {
    throw new Error('Trae workspace is not a folder')
  }
  const keys = [...new Set([resolve(workspacePath), canonicalWorkspace])]
  // oxlint-disable-next-line no-control-regex -- Refuse path bytes that cannot be safely written as TOML keys.
  if (keys.some((key) => /[\x00-\x1f\x7f]/.test(key))) {
    throw new Error('Trae workspace contains control characters')
  }
  const expiresAt = Date.now() + deadlineMs
  const target = resolveConfigTarget(configFile)
  return runKeyedSerializedOperation(writesByConfig, target, async () => {
    if (Date.now() >= expiresAt) {
      throw new Error('Trae trust write expired in queue')
    }
    const release = await lock(target, {
      realpath: false,
      stale: NEVER_STALE_MS,
      retries: { retries: 4, factor: 1, minTimeout: 50, maxTimeout: 50 }
    })
    try {
      if (Date.now() >= expiresAt) {
        throw new Error('Trae trust write expired waiting for lock')
      }
      if (resolveConfigTarget(configFile) !== target) {
        throw new Error('Trae config target changed')
      }
      let existing = ''
      try {
        existing = readFileSync(target, 'utf-8')
      } catch (error) {
        if (!isMissing(error)) {
          throw error
        }
      }
      const next = appendTraeWorkspaceTrust(existing, keys)
      if (next !== existing) {
        writeTomlConfigAtomically(target, next, { newFileMode: 0o600 })
      }
    } finally {
      await release()
    }
  })
}

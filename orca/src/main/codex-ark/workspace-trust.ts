import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { runExclusivelyForCodexTrustConfig } from '../codex/codex-trust-config-mutation-queue'
import {
  upsertProjectTrustLevelInContent,
  writeConfigAtomically
} from '../codex/config-toml-trust'

/**
 * Codex Ark stores the same `[projects."<realpath>"] trust_level = "trusted"` record as Codex, but
 * in the wrapper's own `CODEX_HOME`: the `codex-ark` launcher forces `CODEX_HOME` to its install
 * root, so the inherited `~/.codex` Orca writes for Codex is never what Ark reads.
 *
 * `CODEX_ARK_HOME` here is an Orca-side pointer at that install root for a relocated wrapper; the
 * launcher itself pins its own directory and does not read the variable. When the two disagree the
 * entry lands where Ark does not look and the CLI simply asks.
 */
export function resolveCodexArkTrustConfigFile(
  agentHome: string,
  env: Record<string, string | undefined>
): string | null {
  const arkHome = env.CODEX_ARK_HOME?.trim() || join(agentHome, '.codex-ark')
  if (!isAbsolute(arkHome)) {
    return null
  }
  const configFile = join(arkHome, 'config.toml')
  try {
    // Why realpath: a symlinked Ark home would split the write from the file the wrapper validates.
    return existsSync(configFile) ? realpathSync.native(configFile) : null
  } catch {
    return null
  }
}

/**
 * Appends one project trust record, serialized in the same lane Orca's other `config.toml` edits
 * use. Ark only exists when the wrapper wrote and validated this file, so it is never created here:
 * a config without the wrapper's provider/model/catalog keys makes `codex-ark` refuse to start.
 */
export function markCodexArkWorkspaceTrusted(
  workspacePath: string,
  configFile: string
): Promise<void> {
  // Why realpath: Ark compares the stored key against the launched folder after resolving links,
  // so a worktree under a symlinked parent would otherwise be asked again.
  const key = canonicalizeWorkspace(workspacePath)
  return runExclusivelyForCodexTrustConfig(configFile, async () => {
    let existing: string
    try {
      const raw = readFileSync(configFile, 'utf-8')
      existing = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
    } catch {
      // Why fail closed: the wrapper owns creation, and an Ark config this side invented is invalid.
      return
    }
    const updated = upsertProjectTrustLevelInContent(existing, key, 'trusted')
    if (updated !== existing) {
      writeConfigAtomically(configFile, updated)
    }
  })
}

function canonicalizeWorkspace(workspacePath: string): string {
  try {
    return realpathSync.native(workspacePath)
  } catch {
    return workspacePath
  }
}

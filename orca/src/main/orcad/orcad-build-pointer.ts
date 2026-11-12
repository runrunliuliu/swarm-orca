/**
 * orcad publishes the version pointer for the build it is actually serving.
 *
 * Why orcad and not only the Electron app: the bare-`orca` dispatcher used to be written by
 * `installLinuxBareOrcaDispatcher` from the desktop main process, so a headless update changed
 * *nothing* about what bare `orca` ran until somebody rebuilt and restarted the desktop app —
 * which is exactly how one host ended up serving a 2026-11 build while its shell resolved a
 * 2026-10 one. orcad knows its own artifact root and its own CLI argv, so it can name itself.
 *
 * Why after the RPC transport binds and not before: the pointer is a promise that this host's
 * CLI answers for the running runtime. A daemon that failed to bind has to leave the previous
 * promise intact, which means publish last and never publish from a partially started process.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import {
  resolveOrcaBuildPointerPath,
  type OrcaBuildIdentity
} from '../../shared/build-pointer'
import {
  ORCAD_BUILD_TARGET_FILENAME,
  ORCAD_VERSION_FILENAME,
  parseOrcadVersionMarker
} from '../../shared/orcad-artifacts'
import type { LinuxBareOrcaDispatcherResult } from '../cli/linux-bare-orca-dispatcher'
import {
  publishOrcaBuildPointer,
  readPublishedIdentity,
  withStablePublishedAt,
  type PublishOrcaBuildPointerResult
} from '../cli/build-pointer'

export type OrcadBuildPointerOutcome =
  | { state: 'skipped'; reason: string }
  | {
      state: 'published' | 'unchanged'
      pointer: PublishOrcaBuildPointerResult
      dispatcher: LinuxBareOrcaDispatcherResult
    }

export type OrcadBuildPointerOptions = {
  /** Artifact root — the directory `orcad.js` and `cli/index.cjs` were launched from. */
  installRoot: string
  /** The CLI this bundle runs; defaults to `process.execPath <installRoot>/cli/index.cjs`. */
  cli?: { executable: string; args: string[] }
  pointerPath?: string
  homePath?: string
  /** Test seam — production stamps the current instant. */
  now?: () => Date
  pid?: number
}

/**
 * Any install root without `.version` is not a packaged artifact (a dev checkout, a test
 * fixture), and pointing a machine-wide name at one would be wrong. Publishing stays silent —
 * this is a normal condition, not a failure.
 */
export function readOrcadArtifactIdentity(installRoot: string): {
  version: string
  buildId: string | null
  buildTarget: string | null
} | null {
  let marker: string
  try {
    marker = readFileSync(join(installRoot, ORCAD_VERSION_FILENAME), 'utf8')
  } catch {
    return null
  }
  const parsed = parseOrcadVersionMarker(marker)
  if (!parsed) {
    return null
  }
  let buildTarget: string | null = null
  try {
    const target = readFileSync(join(installRoot, ORCAD_BUILD_TARGET_FILENAME), 'utf8').trim()
    buildTarget = target.length > 0 ? target : null
  } catch {
    buildTarget = null
  }
  return { ...parsed, buildTarget }
}

export async function publishOrcadServingBuildPointer(
  options: OrcadBuildPointerOptions
): Promise<OrcadBuildPointerOutcome> {
  const artifact = readOrcadArtifactIdentity(options.installRoot)
  if (!artifact) {
    return { state: 'skipped', reason: 'not-a-packaged-artifact' }
  }
  const cli = options.cli ?? {
    executable: process.execPath,
    args: [join(options.installRoot, 'cli', 'index.cjs')]
  }
  const pointerPath = options.pointerPath ?? resolveOrcaBuildPointerPath()
  const existing = readPublishedIdentity(options.installRoot)
  const desired: OrcaBuildIdentity = withStablePublishedAt(
    {
      schemaVersion: 1,
      artifact: 'orcad',
      version: artifact.version,
      buildId: artifact.buildId,
      buildTarget: artifact.buildTarget,
      installDir: options.installRoot,
      cli,
      publishedAt: (options.now?.() ?? new Date()).toISOString(),
      publisher: { kind: 'orcad', pid: options.pid ?? process.pid, version: artifact.version }
    },
    existing
  )

  const pointer = publishOrcaBuildPointer({ pointerPath, identity: desired })
  // Imported lazily: the dispatcher module pulls the AppImage extraction helpers, which are
  // irrelevant to a host that resolves its CLI by pointer and only bloat orcad's startup graph.
  const { installBareOrcaBuildPointerDispatcher } = await import('../cli/linux-bare-orca-dispatcher')
  const dispatcher = await installBareOrcaBuildPointerDispatcher({
    homePath: options.homePath ?? homedir(),
    buildPointerPath: pointerPath,
    localCli: cli
  })
  return { state: pointer.state, pointer, dispatcher }
}

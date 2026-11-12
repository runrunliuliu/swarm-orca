/**
 * What an Electron `--serve` start says about itself, extracted so the startup file stays readable.
 *
 * Two things happen here and their order matters: name this build in the version pointer, then point
 * bare `orca` at the pointer. Before this, the second step wrote a script naming *this* bundle, which
 * is why a headless `orcad` update could never become bare `orca` — that file was only ever rewritten
 * by a desktop rebuild.
 *
 * A publish failure is reported, never fatal: an install root this process may not write to still
 * serves correctly, and refusing to start over a machine-wide name would be disproportionate. It is
 * not silent either — a stale target nobody noticed is the bug being replaced.
 */

import { resolveOrcaBuildPointerPath } from '../../shared/build-pointer'
import { getBundledLauncherPath } from '../cli/bundled-cli-launcher-path'
import {
  buildElectronServingBuildIdentity,
  publishOrcaBuildPointer,
  type PublishOrcaBuildPointerResult
} from '../cli/build-pointer'
import {
  installLinuxBareOrcaDispatcher,
  type LinuxBareOrcaDispatcherResult
} from '../cli/linux-bare-orca-dispatcher'

export type ServeBuildPointerPublication = {
  pointer: PublishOrcaBuildPointerResult | null
  dispatcher: LinuxBareOrcaDispatcherResult | null
  /** Why the pointer was not published, when it was not. */
  failure: string | null
}

export async function publishServeBuildPointer(options: {
  resourcesPath: string
  appVersion: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  arch?: string
  /**
   * Home directory whose `~/.local/bin/orca` this refreshes. Required on purpose: the default
   * (`homedir()`) writes to the real account, which a test must never do by omission.
   */
  homePath: string
}): Promise<ServeBuildPointerPublication> {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const pointerPath = resolveOrcaBuildPointerPath(env)
  const fallbackLauncher = getBundledLauncherPath('linux', options.resourcesPath)

  let pointer: PublishOrcaBuildPointerResult | null = null
  let failure: string | null = null
  if (fallbackLauncher) {
    try {
      pointer = publishOrcaBuildPointer({
        pointerPath,
        identity: buildElectronServingBuildIdentity({
          resourcesPath: options.resourcesPath,
          version: options.appVersion,
          // Why env and not a constant: this fork's package never rebuilt, so its version cannot
          // distinguish builds. A packaging step that knows its commit can say so; nothing is invented.
          buildId: env.ORCA_BUILD_ID?.trim() || null,
          cli: { executable: fallbackLauncher, args: [] },
          buildTarget: `${platform}-${options.arch ?? process.arch}`
        })
      })
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }
  }

  const dispatcher = await installLinuxBareOrcaDispatcher({
    resourcesPath: options.resourcesPath,
    homePath: options.homePath,
    buildPointerPath: pointerPath,
    buildPointerFallbackLauncher: fallbackLauncher
  })
  return { pointer, dispatcher, failure }
}

/** One line a serve start can log: what bare `orca` will run, and why not when it cannot. */
export function describeServeBuildPointerPublication(
  publication: ServeBuildPointerPublication
): string {
  const { dispatcher, pointer, failure } = publication
  if (!dispatcher) {
    return `build pointer not published: ${failure ?? 'no bundled launcher'}`
  }
  return (
    `bare orca dispatcher ${dispatcher.state}: ${dispatcher.dispatcherPath}` +
    `${dispatcher.target ? ` -> ${dispatcher.target}` : ''}` +
    `${pointer ? `; build pointer ${pointer.state} -> ${pointer.installDir}` : ''}` +
    `${failure ? `; build pointer not published: ${failure}` : ''}` +
    `${dispatcher.failure ? `; dispatcher fails closed: ${dispatcher.failure}` : ''}`
  )
}

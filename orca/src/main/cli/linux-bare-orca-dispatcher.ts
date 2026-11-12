import { randomUUID } from 'node:crypto'
import { constants, existsSync } from 'node:fs'
import { copyFile, link, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  hasAppImagePathEnvironment,
  resolveAppImageRuntimeIdentity
} from '../appimage-runtime-identity'
import {
  ensureAppImageExtractedRoot,
  resolveAppImageCacheRootPath
} from './appimage-extracted-root'
import { pruneAppImageExtractedRoots } from './appimage-extraction-pruning'
import { withAppImageRegistrationLock } from './appimage-registration-lock'
import { getBundledLauncherPath } from './bundled-cli-launcher-path'
import { planOrcaCliScript, type OrcaCliScriptPlan } from './build-pointer'
import { quoteShell } from './cli-install-path-format'
import type { OrcaBuildCli } from '../../shared/build-pointer'

// Why: marks a dispatcher this function wrote so repeat serve starts overwrite
// our own file idempotently but never clobber a user's own ~/.local/bin/orca.
const DISPATCHER_MARKER = '# orca-serve-bare-orca-dispatcher'

export type LinuxBareOrcaDispatcherOptions = {
  /** Packaged app resources root; the bundled `orca-ide` launcher lives under it. */
  resourcesPath: string
  /** Test seam — defaults to the real home directory. */
  homePath?: string
  /** Trusted caller override; production requires the complete AppImage runtime identity. */
  appImagePath?: string | null
  /** Test seam — defaults to $XDG_CACHE_HOME/orca/appimage. */
  appImageCacheRootPath?: string
  /** Test seam — defaults to running the AppImage's own `--appimage-extract`. */
  appImageExtractRunner?: (appImagePath: string, cwd: string) => Promise<void>
  /**
   * Version pointer to follow (see `src/shared/build-pointer.ts`). Unset keeps the historical
   * fixed-launcher script, which is what a self-contained install wants: nothing outside this
   * bundle decides what bare `orca` runs.
   */
  buildPointerPath?: string | null
  /** Local launcher a pointer-following script falls back to when no pointer exists at all. */
  buildPointerFallbackLauncher?: string | null
}

export type LinuxBareOrcaDispatcherState =
  | 'installed'
  | 'skipped-foreign'
  | 'skipped-launcher-missing'

export type LinuxBareOrcaDispatcherResult = {
  state: LinuxBareOrcaDispatcherState
  dispatcherPath: string
  /** The launcher or version pointer the dispatcher resolves at exec time. */
  target: string | null
  /** Set when the written script refuses to run: why the version pointer was unusable. */
  failure?: string | null
}

// Why: on Linux the CLI installs as `orca-ide`, not bare `orca`, to avoid
// shadowing GNOME Orca's /usr/bin/orca. But the Claude Team launcher typed into
// the initial managed terminal invokes the literal `orca claude-teams`, so a
// headless serve box needs a bare-`orca` dispatcher on the managed-terminal PATH
// (~/.local/bin, which patchPackagedProcessPath puts ahead of /usr/bin). It is a
// plain file, not a managed symlink, so CliInstaller.removeLegacyLinuxCommandIfManaged
// never reclaims it.
export async function installLinuxBareOrcaDispatcher(
  options: LinuxBareOrcaDispatcherOptions
): Promise<LinuxBareOrcaDispatcherResult> {
  const dispatcherPath = resolveBareOrcaDispatcherPath(options.homePath)
  if (existsSync(dispatcherPath) && !(await isOwnedDispatcher(dispatcherPath))) {
    return { state: 'skipped-foreign', dispatcherPath, target: null }
  }

  const pointerPath = options.buildPointerPath ?? null
  if (pointerPath) {
    // Why before resolveStableLauncherPath: a usable pointer names the CLI itself, so an AppImage
    // copy does not have to be extracted (a slow, disk-writing step) only to be ignored.
    const plan = planOrcaCliScript({
      pointerPath,
      localCli: options.buildPointerFallbackLauncher
        ? { executable: options.buildPointerFallbackLauncher, args: [] }
        : null
    })
    if (plan.mode !== 'local') {
      return publishBareOrcaDispatcher(
        dispatcherPath,
        plan,
        plan.mode === 'pointer' ? pointerPath : null
      )
    }
  }

  const launcher = await resolveStableLauncherPath(options)
  if (!launcher) {
    return { state: 'skipped-launcher-missing', dispatcherPath, target: null }
  }
  return publishBareOrcaDispatcher(
    dispatcherPath,
    { mode: 'local', script: buildBareOrcaCliScript(launcher), failure: null },
    launcher
  )
}

/**
 * Publish `~/.local/bin/orca` on a host that promotes builds by pointer, without an Electron
 * resource tree: the caller supplies its own launcher as the no-pointer fallback. orcad calls
 * this on every start, so a headless update becomes the CLI of the next shell even though the
 * desktop app (which used to own this file) was never rebuilt.
 */
export async function installBareOrcaBuildPointerDispatcher(options: {
  homePath?: string
  buildPointerPath: string
  localCli: OrcaBuildCli | null
}): Promise<LinuxBareOrcaDispatcherResult> {
  const dispatcherPath = resolveBareOrcaDispatcherPath(options.homePath)
  if (existsSync(dispatcherPath) && !(await isOwnedDispatcher(dispatcherPath))) {
    return { state: 'skipped-foreign', dispatcherPath, target: null }
  }
  const plan = planOrcaCliScript({
    pointerPath: options.buildPointerPath,
    localCli: options.localCli
  })
  return publishBareOrcaDispatcher(
    dispatcherPath,
    plan,
    plan.mode === 'pointer' ? options.buildPointerPath : null
  )
}

async function publishBareOrcaDispatcher(
  dispatcherPath: string,
  plan: OrcaCliScriptPlan,
  target: string | null
): Promise<LinuxBareOrcaDispatcherResult> {
  const installed = await publishDispatcher(dispatcherPath, insertDispatcherMarker(plan.script))
  return {
    state: installed ? 'installed' : 'skipped-foreign',
    dispatcherPath,
    target: installed ? target : null,
    failure: plan.failure
  }
}

function resolveBareOrcaDispatcherPath(homePath?: string): string {
  return join(homePath ?? homedir(), '.local', 'bin', 'orca')
}

/** Bare-`orca` script that execs the one Linux CLI launcher. */
export function buildBareOrcaCliScript(launcherPath: string): string {
  return `#!/usr/bin/env bash\nexec ${quoteShell(launcherPath)} "$@"\n`
}

/**
 * The launcher path this dispatcher can still reach on a later boot. Under an
 * AppImage `process.resourcesPath` is an ephemeral FUSE mount that dies with the
 * app, so extract the payload once and point at that stable copy instead.
 */
async function resolveStableLauncherPath(
  options: LinuxBareOrcaDispatcherOptions
): Promise<string | null> {
  const hasExplicitAppImagePath = Object.hasOwn(options, 'appImagePath')
  const runtimeIdentity = resolveAppImageRuntimeIdentity({ resourcesPath: options.resourcesPath })
  if (!hasExplicitAppImagePath && hasAppImagePathEnvironment() && !runtimeIdentity) {
    return null
  }
  const appImagePath = hasExplicitAppImagePath
    ? (options.appImagePath ?? null)
    : (runtimeIdentity?.appImagePath ?? null)
  if (appImagePath) {
    const extractionOptions = {
      appImagePath,
      cacheRootPath: options.appImageCacheRootPath,
      runExtract: options.appImageExtractRunner
    }
    return withAppImageRegistrationLock(
      resolveAppImageCacheRootPath(extractionOptions),
      async () => {
        const extractedRoot = await ensureAppImageExtractedRoot(extractionOptions)
        if (extractedRoot) {
          await pruneAppImageExtractedRoots(extractedRoot.rootPath)
        }
        return extractedRoot?.stableLauncherPath ?? null
      }
    )
  }
  const launcher = getBundledLauncherPath('linux', options.resourcesPath)
  // Why: getBundledLauncherPath only joins the path; guard existence so we never
  // write a script pointing at a missing launcher (which would fail at exec
  // time with a confusing error instead of the command-not-found we fix).
  return launcher && existsSync(launcher) ? launcher : null
}

function insertDispatcherMarker(script: string): string {
  return script.replace('\n', `\n${DISPATCHER_MARKER}\n`)
}

async function isOwnedDispatcher(dispatcherPath: string): Promise<boolean> {
  try {
    return (
      (await lstat(dispatcherPath)).isFile() &&
      (await readFile(dispatcherPath, 'utf8')).split('\n')[1] === DISPATCHER_MARKER
    )
  } catch {
    return false
  }
}

async function publishDispatcher(dispatcherPath: string, content: string): Promise<boolean> {
  const directoryPath = dirname(dispatcherPath)
  const temporaryPath = join(directoryPath, `.orca-dispatcher-${process.pid}-${randomUUID()}`)
  await mkdir(directoryPath, { recursive: true })
  await writeFile(temporaryPath, content, { encoding: 'utf8', flag: 'wx', mode: 0o755 })
  try {
    if (await publishIfVacant(temporaryPath, dispatcherPath)) {
      return true
    }

    const displacedPath = join(
      directoryPath,
      `.orca-preserved-dispatcher-${process.pid}-${randomUUID()}`
    )
    try {
      await rename(dispatcherPath, displacedPath)
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) {
        throw error
      }
      return await publishIfVacant(temporaryPath, dispatcherPath)
    }

    if (!(await isOwnedDispatcher(displacedPath))) {
      await restoreDisplacedDispatcher(displacedPath, dispatcherPath)
      return false
    }

    try {
      if (
        (await publishIfVacant(temporaryPath, dispatcherPath)) ||
        (await isExactExecutableDispatcher(dispatcherPath, content))
      ) {
        await unlink(displacedPath)
        return true
      }
      // A concurrently published foreign command owns the public path now.
      await unlink(displacedPath)
      return false
    } catch (error) {
      await restoreDisplacedDispatcher(displacedPath, dispatcherPath)
      throw error
    }
  } finally {
    await unlink(temporaryPath).catch(() => {})
  }
}

async function publishIfVacant(sourcePath: string, destinationPath: string): Promise<boolean> {
  try {
    await link(sourcePath, destinationPath)
    return true
  } catch (error) {
    if (hasErrorCode(error, 'EEXIST')) {
      return false
    }
  }
  try {
    await copyFile(sourcePath, destinationPath, constants.COPYFILE_EXCL)
    return true
  } catch (error) {
    if (hasErrorCode(error, 'EEXIST')) {
      return false
    }
    throw error
  }
}

async function restoreDisplacedDispatcher(
  displacedPath: string,
  dispatcherPath: string
): Promise<void> {
  if (await publishIfVacant(displacedPath, dispatcherPath)) {
    await unlink(displacedPath)
  }
}

async function isExactExecutableDispatcher(
  dispatcherPath: string,
  content: string
): Promise<boolean> {
  try {
    const [actual, metadata] = await Promise.all([
      readFile(dispatcherPath, 'utf8'),
      lstat(dispatcherPath)
    ])
    return metadata.isFile() && (metadata.mode & 0o111) !== 0 && actual === content
  } catch {
    return false
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

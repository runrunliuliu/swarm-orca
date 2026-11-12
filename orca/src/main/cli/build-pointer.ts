/**
 * The write side of the version pointer contract (`src/shared/build-pointer.ts` says what it is).
 *
 * Two producers publish it — an Electron `--serve` start and a headless `orcad` start — and they
 * must produce byte-identical artifacts, so both go through here instead of each assembling a
 * script of its own. A build that has not been published is still invokable by its absolute path;
 * what publishing buys is that bare `orca` follows it without anyone editing a file by hand.
 */

import { randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import {
  ORCA_BUILD_CLI_ARGV_FILENAME,
  ORCA_BUILD_IDENTITY_FILENAME,
  ORCA_BUILD_POINTER_ENV,
  ORCA_BUILD_POINTER_REQUIRED_ENV,
  formatOrcaBuildCliArgv,
  formatOrcaBuildIdentity,
  parseOrcaBuildCliArgv,
  parseOrcaBuildIdentity,
  resolveOrcaBuildPointer,
  type OrcaBuildCli,
  type OrcaBuildIdentity,
  type OrcaBuildPointerResolution
} from '../../shared/build-pointer'
import { quoteShell } from './cli-install-path-format'

const POINTER_SCRIPT_MARKER = '# orca-build-pointer'

export type OrcaCliScriptMode = 'pointer' | 'local' | 'fail-closed'

export type OrcaCliScriptPlan = {
  mode: OrcaCliScriptMode
  /** Ready to write as a bare-`orca` replacement (shebang first, argv preserving). */
  script: string
  /** Set for `fail-closed`; also logged by the publisher. */
  failure: string | null
}

/** Shell prelude shared by every generated launcher: message shape and exit code. */
function scriptPrelude(): string {
  return `#!/usr/bin/env bash
${POINTER_SCRIPT_MARKER}
fail() {
  printf 'orca: %s\\n' "$1" >&2
  exit 1
}
`
}

/**
 * Follow the pointer at exec time. Why the script does the resolution instead of the writer:
 * the whole point is that a later promotion changes what bare `orca` runs without the writer
 * being restarted, and a script that names today's directory can never do that.
 *
 * `${EXEC}` is baked in as the fallback for a self-contained install (no pointer at all).
 * Once the pointer exists, breakage is fatal even with that fallback — a half-promoted build
 * must not silently keep serving the old one.
 */
export function buildOrcaBuildPointerScript(
  pointerPath: string,
  localCli: OrcaBuildCli | null
): string {
  const fallback = localCli
    ? `exec ${[localCli.executable, ...localCli.args].map(quoteShell).join(' ')} "$@"`
    : `fail "no build pointer at $pointer and no local Orca CLI to run"`
  // Why export the path: the script resolves the pointer, but the CLI it execs reports the
  // pointer too (`--version --json`). Without this, a deployment that moved the pointer with
  // ORCA_BUILD_POINTER_PATH would be followed by the script and *missed* by the report — the one
  // diagnostic whose job is to agree with what actually ran.
  return `${scriptPrelude()}export ${ORCA_BUILD_POINTER_ENV}=${quoteShell(pointerPath)}
pointer=${quoteShell(pointerPath)}
if [[ ! -e "$pointer" && ! -L "$pointer" ]]; then
  case "\${${ORCA_BUILD_POINTER_REQUIRED_ENV}:-0}" in
    1 | true) fail "no build pointer at $pointer; refusing to guess which Orca build to run" ;;
  esac
  ${fallback}
fi
target="$(readlink -f -- "$pointer" 2>/dev/null)" || fail "build pointer $pointer is unreadable"
[[ -n "$target" && -d "$target" ]] || fail "build pointer $pointer is dangling: $target"
argv_file="$target/${ORCA_BUILD_CLI_ARGV_FILENAME}"
[[ -r "$argv_file" ]] || fail "build pointer $pointer names an artifact with no ${ORCA_BUILD_CLI_ARGV_FILENAME}: $target"
cli=()
while IFS= read -r line; do
  [[ -n "$line" ]] && cli+=("$line")
done <"$argv_file"
[[ \${#cli[@]} -ge 1 ]] || fail "build pointer $pointer names an empty argv file: $argv_file"
[[ -x "\${cli[0]}" ]] || fail "build pointer $pointer names a non-executable CLI: \${cli[0]}"
exec "\${cli[@]}" "$@"
`
}

/** Fixed launcher for one concrete install: the behaviour a self-contained build has always had. */
export function buildOrcaCliExecScript(cli: OrcaBuildCli): string {
  const argv = [cli.executable, ...cli.args].map(quoteShell).join(' ')
  return `${scriptPrelude()}exec ${argv} "$@"
`
}

/** Nothing to run, and nothing worth guessing: say why and stop. */
export function buildOrcaCliFailureScript(pointerPath: string, failure: string): string {
  return `${scriptPrelude()}fail ${quoteShell(
    `build pointer ${pointerPath} is unusable: ${failure}. Repair it or remove it; refusing to fall back to an older Orca build.`
  )}`
}

/**
 * The one decision every launcher consumer shares. Absent pointer is a self-contained install
 * (local launcher); present-but-unusable fails closed; a usable pointer wins over the local
 * launcher even when the local one is this very process.
 */
export function planOrcaCliScript(options: {
  pointerPath: string | null | undefined
  localCli: OrcaBuildCli | null
  /** Test seam — production resolves the pointer from the filesystem. */
  resolution?: OrcaBuildPointerResolution
}): OrcaCliScriptPlan {
  if (!options.pointerPath) {
    return options.localCli
      ? { mode: 'local', script: buildOrcaCliExecScript(options.localCli), failure: null }
      : {
          mode: 'fail-closed',
          script: buildOrcaCliFailureScript('<none>', 'no local launcher'),
          failure: 'no local launcher'
        }
  }
  const resolution = options.resolution ?? resolveOrcaBuildPointer(options.pointerPath)
  if (resolution.state === 'ok' || resolution.state === 'missing') {
    return {
      mode: 'pointer',
      script: buildOrcaBuildPointerScript(options.pointerPath, options.localCli),
      failure: null
    }
  }
  const failure =
    resolution.state === 'dangling'
      ? `dangling (${resolution.failure})`
      : `invalid (${resolution.failure})`
  return {
    mode: 'fail-closed',
    script: buildOrcaCliFailureScript(options.pointerPath, failure),
    failure
  }
}

export type PublishOrcaBuildPointerResult = {
  state: 'published' | 'unchanged'
  pointerPath: string
  installDir: string
}

/**
 * Publish identity into the artifact root, then swap the symlink. Order is the contract: a
 * pointer must never be visible before its target can answer `--version --json`, so the swap is
 * last and the link itself is replaced by rename — a reader sees the old target or the new one,
 * never a missing link.
 */
export function publishOrcaBuildPointer(options: {
  pointerPath: string
  identity: OrcaBuildIdentity
}): PublishOrcaBuildPointerResult {
  const { pointerPath } = options
  if (!isAbsolute(pointerPath)) {
    throw new Error('orca_build_pointer_path_not_absolute')
  }
  let installDir: string
  try {
    installDir = realpathSync(options.identity.installDir)
  } catch {
    throw new Error(`orca_build_pointer_install_dir_missing — ${options.identity.installDir}`)
  }
  if (!statSync(installDir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`orca_build_pointer_install_dir_missing — ${installDir}`)
  }

  const identity: OrcaBuildIdentity = { ...options.identity, installDir }
  const identityText = formatOrcaBuildIdentity(identity)
  const argvText = formatOrcaBuildCliArgv(identity.cli)
  const executableStats = statSync(identity.cli.executable, { throwIfNoEntry: false })
  if (!executableStats?.isFile()) {
    throw new Error(`orca_build_pointer_cli_missing — ${identity.cli.executable}`)
  }
  if (process.platform !== 'win32' && (executableStats.mode & 0o111) === 0) {
    throw new Error(`orca_build_pointer_cli_not_executable — ${identity.cli.executable}`)
  }

  const unchanged =
    readIfPresent(join(installDir, ORCA_BUILD_IDENTITY_FILENAME)) === identityText &&
    readIfPresent(join(installDir, ORCA_BUILD_CLI_ARGV_FILENAME)) === argvText &&
    currentPointerTarget(pointerPath) === installDir

  if (unchanged) {
    return { state: 'unchanged', pointerPath, installDir }
  }

  writeFileAtomically(join(installDir, ORCA_BUILD_IDENTITY_FILENAME), identityText)
  writeFileAtomically(join(installDir, ORCA_BUILD_CLI_ARGV_FILENAME), argvText)
  swapPointer(pointerPath, installDir)
  return { state: 'published', pointerPath, installDir }
}

/**
 * Republishing on every start would rewrite `publishedAt` and churn the link. Keep the existing
 * timestamp when the rest of the identity is the same build published by the same kind of host.
 */
export function withStablePublishedAt(
  identity: OrcaBuildIdentity,
  existing: OrcaBuildIdentity | null
): OrcaBuildIdentity {
  if (!existing || existing.publishedAt === identity.publishedAt) {
    return identity
  }
  const comparable = (value: OrcaBuildIdentity): string =>
    JSON.stringify({ ...value, publishedAt: '', installDir: '' })
  return comparable(existing) === comparable(identity)
    ? { ...identity, publishedAt: existing.publishedAt }
    : identity
}

export function readPublishedIdentity(installDir: string): OrcaBuildIdentity | null {
  const text = readIfPresent(join(installDir, ORCA_BUILD_IDENTITY_FILENAME))
  return text === null ? null : parseOrcaBuildIdentity(text)
}

export function readPublishedCliArgv(installDir: string): OrcaBuildCli | null {
  const text = readIfPresent(join(installDir, ORCA_BUILD_CLI_ARGV_FILENAME))
  return text === null ? null : parseOrcaBuildCliArgv(text)
}

function readIfPresent(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function writeFileAtomically(path: string, content: string): void {
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`
  writeFileSync(temporaryPath, content, { encoding: 'utf8', mode: 0o644 })
  try {
    renameSync(temporaryPath, path)
  } catch (error) {
    try {
      unlinkSync(temporaryPath)
    } catch {
      // The rename failure is the error worth reporting; a leftover temp file is not.
    }
    throw error
  }
}

function currentPointerTarget(pointerPath: string): string | null {
  try {
    if (!lstatSync(pointerPath).isSymbolicLink()) {
      return null
    }
    return resolve(dirname(pointerPath), readlinkSync(pointerPath))
  } catch {
    return null
  }
}

function swapPointer(pointerPath: string, installDir: string): void {
  mkdirSync(dirname(pointerPath), { recursive: true })
  const temporaryPath = join(
    dirname(pointerPath),
    `.${process.pid}-${randomUUID()}.orca-current`
  )
  // A relative link to a sibling directory is what `/opt/orca/current` is meant to look like on
  // disk; fall back to the absolute path when the artifact lives elsewhere.
  const relativeTarget = relativeLinkTarget(pointerPath, installDir)
  symlinkSync(relativeTarget, temporaryPath)
  try {
    renameSync(temporaryPath, pointerPath)
  } catch (error) {
    try {
      unlinkSync(temporaryPath)
    } catch {
      // Same as above: keep the original failure.
    }
    throw error
  }
}

function relativeLinkTarget(pointerPath: string, installDir: string): string {
  const parent = dirname(pointerPath)
  return dirname(installDir) === parent ? basename(installDir) : installDir
}

/** Convenience for callers that only have a directory and want "is this a usable artifact?". */
export function isPublishedArtifactRoot(installDir: string): boolean {
  return (
    existsSync(join(installDir, ORCA_BUILD_IDENTITY_FILENAME)) &&
    existsSync(join(installDir, ORCA_BUILD_CLI_ARGV_FILENAME))
  )
}

/**
 * The artifact root an Electron install was unpacked into.
 *
 * Why not `dirname(resourcesPath)`: an AppImage extraction root has an extra `squashfs-root`
 * level, and the two layouts are told apart by that name rather than by probing for markers —
 * the marker files are what this function's callers are about to write.
 */
export function resolveElectronInstallRoot(resourcesPath: string): string {
  const resourcesParent = dirname(resourcesPath)
  return basename(resourcesParent) === 'squashfs-root'
    ? dirname(resourcesParent)
    : resourcesParent
}

/** Identity of an Electron `--serve` host: the artifact that is serving, named as it really is. */
export function buildElectronServingBuildIdentity(options: {
  resourcesPath: string
  version: string
  buildId: string | null
  cli: OrcaBuildCli
  buildTarget?: string | null
  now?: () => Date
  pid?: number
}): OrcaBuildIdentity {
  return {
    schemaVersion: 1,
    artifact: 'electron-app',
    version: options.version,
    buildId: options.buildId,
    buildTarget: options.buildTarget ?? null,
    installDir: resolveElectronInstallRoot(options.resourcesPath),
    cli: options.cli,
    publishedAt: (options.now?.() ?? new Date()).toISOString(),
    publisher: { kind: 'electron-serve', pid: options.pid ?? process.pid, version: options.version }
  }
}

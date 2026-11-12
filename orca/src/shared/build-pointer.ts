/**
 * The version pointer: one symlink that names the build this host serves.
 *
 * Why this exists: three different binaries can call themselves `orca` on one box (a frozen
 * Electron bundle, a headless `orcad` artifact, a dev build), and a version string cannot tell
 * them apart — `orca/package.json` stayed at 1.4.219 across every rebuild here, and the pool of
 * `/opt/orca/<artifact>-<version>-<buildsha>` directories is the only real identity. Before this
 * module, each producer baked an absolute launcher path into the shell script it wrote, so a
 * newly installed build only became the CLI of the *next* start of whoever wrote that script
 * last. Bare `orca` therefore tracked the Electron app that had been built weeks earlier.
 *
 * The contract, in one paragraph: `<pointer>` is a symlink whose target is an artifact root.
 * That root must carry `.orca-build.json` (identity, this schema) and `.orca-cli-argv` (the
 * exact argv a shell should exec, one element per line, executable first). Whoever is *serving*
 * this host publishes it; every consumer that turns a name into a path reads it. A pointer that
 * is present but unusable (dangling target, missing or malformed identity, argv naming a
 * different install or a non-executable) is an error — never a reason to fall back to a stale
 * directory. Absence is different from breakage: a self-contained install (an AppImage a user
 * launched from their downloads) has no pointer at all, so consumers fall back to their own
 * launcher there, and only there. Deployments that must not run without a pointer set
 * `ORCA_BUILD_POINTER_REQUIRED=1`, which turns absence into an error too.
 *
 * Read-only: nothing here writes. The publisher is `src/main/cli/build-pointer.ts`.
 */

import { lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export const ORCA_BUILD_POINTER_ENV = 'ORCA_BUILD_POINTER_PATH'
export const ORCA_BUILD_POINTER_DEFAULT_PATH = '/opt/orca/current'
export const ORCA_BUILD_POINTER_REQUIRED_ENV = 'ORCA_BUILD_POINTER_REQUIRED'
export const ORCA_BUILD_IDENTITY_FILENAME = '.orca-build.json'
export const ORCA_BUILD_CLI_ARGV_FILENAME = '.orca-cli-argv'
export const ORCA_BUILD_IDENTITY_SCHEMA_VERSION = 1

/** Which kind of artifact the pointer names. They are packaged, installed and updated differently. */
export type OrcaBuildArtifactKind = 'orcad' | 'electron-app'

/** The exact argv that invokes the build's CLI: executable first, then fixed arguments. */
export type OrcaBuildCli = {
  executable: string
  args: string[]
}

export type OrcaBuildIdentity = {
  schemaVersion: typeof ORCA_BUILD_IDENTITY_SCHEMA_VERSION
  artifact: OrcaBuildArtifactKind
  /** Product version (`1.4.219`, `0.1.0`) — never build identity on its own. */
  version: string
  /** Build commit/tree discriminator (`4046bdb7dbaa`), or null when the artifact was not built from a known revision. */
  buildId: string | null
  /** Packaged target triple (`linux-x64-glibc`), or null when the artifact does not record one. */
  buildTarget: string | null
  /** Absolute artifact root the pointer must resolve to. */
  installDir: string
  cli: OrcaBuildCli
  publishedAt: string
  publisher: {
    kind: 'orcad' | 'electron-serve' | string
    pid: number
    version: string
  }
}

export const ORCA_BUILD_POINTER_STATES = [
  'ok',
  'missing',
  'dangling',
  'invalid'
] as const

export type OrcaBuildPointerState = (typeof ORCA_BUILD_POINTER_STATES)[number]

/** Why a pointer that exists cannot be followed. Closed set, so a report never says "broken". */
export const ORCA_BUILD_POINTER_FAILURES = [
  'pointer-not-a-symlink',
  'target-missing',
  'identity-missing',
  'identity-invalid',
  'install-dir-mismatch',
  'cli-executable-missing',
  'cli-not-executable'
] as const

export type OrcaBuildPointerFailure = (typeof ORCA_BUILD_POINTER_FAILURES)[number]

export type OrcaBuildPointerResolution =
  | {
      state: 'ok'
      pointerPath: string
      /** Real path of the artifact root — what the symlink actually reaches. */
      installDir: string
      identity: OrcaBuildIdentity
    }
  | { state: 'missing'; pointerPath: string }
  | {
      state: 'dangling'
      pointerPath: string
      /** Where the symlink points, as written, when it could be read at all. */
      installDir: string | null
      failure: OrcaBuildPointerFailure
    }
  | {
      state: 'invalid'
      pointerPath: string
      installDir: string | null
      failure: OrcaBuildPointerFailure
    }

/** `$ORCA_BUILD_POINTER_PATH` wins so a test or a staging deployment can move the whole contract. */
export function resolveOrcaBuildPointerPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env[ORCA_BUILD_POINTER_ENV]
  return explicit && explicit.length > 0 ? explicit : ORCA_BUILD_POINTER_DEFAULT_PATH
}

/** No-pointer is the default; a deployment that promises a pointer opts into failing on absence. */
export function isOrcaBuildPointerRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[ORCA_BUILD_POINTER_REQUIRED_ENV]
  return value === '1' || value === 'true'
}

const BUILD_ID_PATTERN = /^[0-9a-f]{7,40}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isAbsoluteNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && isAbsolute(value)
}

function parseCli(value: unknown): OrcaBuildCli | null {
  if (!isRecord(value) || !isAbsoluteNonEmpty(value.executable)) {
    return null
  }
  const args = value.args
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) {
    return null
  }
  return { executable: value.executable, args: args as string[] }
}

/**
 * Strict on purpose: a half-written or hand-edited identity must be rejected, not coerced.
 * `installDir` is checked here only for shape; whether it matches the pointer target is the
 * resolver's job, because that is the check that catches a copied artifact directory.
 */
export function parseOrcaBuildIdentity(text: string): OrcaBuildIdentity | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== ORCA_BUILD_IDENTITY_SCHEMA_VERSION) {
    return null
  }
  const { artifact, version, buildId, buildTarget, installDir, cli, publishedAt, publisher } =
    parsed
  if (artifact !== 'orcad' && artifact !== 'electron-app') {
    return null
  }
  if (typeof version !== 'string' || version.length === 0) {
    return null
  }
  if (buildId !== null && (typeof buildId !== 'string' || !BUILD_ID_PATTERN.test(buildId))) {
    return null
  }
  if (
    buildTarget !== null &&
    (typeof buildTarget !== 'string' || buildTarget.length === 0)
  ) {
    return null
  }
  if (!isAbsoluteNonEmpty(installDir)) {
    return null
  }
  const parsedCli = parseCli(cli)
  if (!parsedCli) {
    return null
  }
  if (typeof publishedAt !== 'string' || Number.isNaN(Date.parse(publishedAt))) {
    return null
  }
  if (
    !isRecord(publisher) ||
    typeof publisher.kind !== 'string' ||
    publisher.kind.length === 0 ||
    !Number.isInteger(publisher.pid) ||
    typeof publisher.version !== 'string' ||
    publisher.version.length === 0
  ) {
    return null
  }
  return {
    schemaVersion: ORCA_BUILD_IDENTITY_SCHEMA_VERSION,
    artifact,
    version,
    buildId,
    buildTarget,
    installDir,
    cli: parsedCli,
    publishedAt,
    publisher: {
      kind: publisher.kind,
      pid: publisher.pid as number,
      version: publisher.version
    }
  }
}

export function formatOrcaBuildIdentity(identity: OrcaBuildIdentity): string {
  return `${JSON.stringify(identity, null, 2)}\n`
}

/** One argv element per line: readable by `read` in a shell, and rejects values that would split. */
export function formatOrcaBuildCliArgv(cli: OrcaBuildCli): string {
  const elements = [cli.executable, ...cli.args]
  for (const element of elements) {
    if (element.length === 0) {
      throw new Error('orca_build_cli_argv_empty_element')
    }
    if (/[\n\r\0]/.test(element)) {
      throw new Error('orca_build_cli_argv_unrepresentable_element')
    }
  }
  return `${elements.join('\n')}\n`
}

export function parseOrcaBuildCliArgv(text: string): OrcaBuildCli | null {
  const elements = text.split('\n').filter((line) => line.length > 0)
  if (elements.length === 0 || !isAbsolute(elements[0])) {
    return null
  }
  return { executable: elements[0], args: elements.slice(1) }
}

/**
 * Follow the pointer without trusting it. Order matters: the link is read first, so a target
 * that exists but is not where the link points can never be mistaken for a match.
 */
export function resolveOrcaBuildPointer(pointerPath: string): OrcaBuildPointerResolution {
  let linkStats
  try {
    linkStats = lstatSync(pointerPath)
  } catch {
    return { state: 'missing', pointerPath }
  }
  if (!linkStats.isSymbolicLink()) {
    return { state: 'invalid', pointerPath, installDir: null, failure: 'pointer-not-a-symlink' }
  }

  let rawTarget: string | null = null
  try {
    rawTarget = readlinkSync(pointerPath)
  } catch {
    rawTarget = null
  }
  const writtenTarget = rawTarget === null ? null : resolve(dirname(pointerPath), rawTarget)

  let installDir: string | null = null
  try {
    installDir = realpathSync(pointerPath)
  } catch {
    installDir = null
  }
  if (installDir === null || !statSync(installDir, { throwIfNoEntry: false })?.isDirectory()) {
    return {
      state: 'dangling',
      pointerPath,
      installDir: writtenTarget,
      failure: 'target-missing'
    }
  }

  let identityText: string
  try {
    identityText = readFileSync(join(installDir, ORCA_BUILD_IDENTITY_FILENAME), 'utf8')
  } catch {
    return { state: 'invalid', pointerPath, installDir, failure: 'identity-missing' }
  }
  const identity = parseOrcaBuildIdentity(identityText)
  if (!identity) {
    return { state: 'invalid', pointerPath, installDir, failure: 'identity-invalid' }
  }
  let claimedDir: string | null = null
  try {
    claimedDir = realpathSync(identity.installDir)
  } catch {
    claimedDir = null
  }
  if (claimedDir !== installDir) {
    return { state: 'invalid', pointerPath, installDir, failure: 'install-dir-mismatch' }
  }

  const executableStats = statSync(identity.cli.executable, { throwIfNoEntry: false })
  if (!executableStats?.isFile()) {
    return { state: 'invalid', pointerPath, installDir, failure: 'cli-executable-missing' }
  }
  if (process.platform !== 'win32' && (executableStats.mode & 0o111) === 0) {
    return { state: 'invalid', pointerPath, installDir, failure: 'cli-not-executable' }
  }

  return { state: 'ok', pointerPath, installDir, identity }
}

/** One line a human can act on. The writer logs it; the CLI reports it in `pointer.reason`. */
export function describeOrcaBuildPointerFailure(
  resolution: OrcaBuildPointerResolution
): string | null {
  if (resolution.state === 'ok') {
    return null
  }
  if (resolution.state === 'missing') {
    return `no build pointer at ${resolution.pointerPath}`
  }
  const where = resolution.installDir ? ` (${resolution.installDir})` : ''
  return `build pointer ${resolution.pointerPath}${where} is ${resolution.state}: ${resolution.failure}`
}

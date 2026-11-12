/**
 * `orca --version --json`: what build am I, and which build does this host consider current?
 *
 * Why the plain `--version` is not enough: it prints `package.json`'s version, and every build of
 * this repository has answered `1.4.219` (or `0.1.0` for orcad) since the initial import, so it
 * cannot tell two artifacts apart. The fields a machine needs to answer "which build?" are the
 * build discriminator and the install directory — neither is derivable from the version string.
 * Those two live in the version pointer's identity document, so this report reads it instead of
 * inventing a second source of truth.
 *
 * Two sources are reported, never merged silently: `source: 'pointer'` means the pointer named a
 * usable artifact and the report describes it; `source: 'local-package'` means the report
 * describes this process's own package boundary, because no pointer exists (or it is broken).
 */

import { resolve } from 'node:path'
import {
  ORCA_BUILD_POINTER_REQUIRED_ENV,
  describeOrcaBuildPointerFailure,
  isOrcaBuildPointerRequired,
  resolveOrcaBuildPointer,
  resolveOrcaBuildPointerPath,
  type OrcaBuildArtifactKind,
  type OrcaBuildCli,
  type OrcaBuildPointerState
} from '../shared/build-pointer'
import { readOrcaCliVersion } from './cli-version'

export const CLI_BUILD_IDENTITY_SCHEMA_VERSION = 1

export type CliBuildIdentityReport = {
  schemaVersion: typeof CLI_BUILD_IDENTITY_SCHEMA_VERSION
  /** Version of the build being described (pointer target when available, else this package). */
  version: string | null
  artifact: OrcaBuildArtifactKind | null
  /** Build discriminator (`4046bdb7dbaa`); null means "this artifact does not record one". */
  buildId: string | null
  buildTarget: string | null
  installDir: string | null
  cli: OrcaBuildCli | null
  source: 'pointer' | 'local-package'
  pointer: {
    path: string
    state: OrcaBuildPointerState
    /** Human-readable reason when `state` is not `ok`; null otherwise. */
    reason: string | null
    required: boolean
  }
  local: {
    version: string | null
    installDir: string
  }
}

export type CliBuildIdentityReadResult = {
  report: CliBuildIdentityReport
  /** 0 for a usable answer; 1 when the pointer is present but unusable, or absent and required. */
  exitCode: 0 | 1
}

export type CliBuildIdentityOptions = {
  /** Where the compiled CLI lives; `..` from here is this build's package boundary. */
  runtimeDir?: string
  pointerPath?: string
  env?: NodeJS.ProcessEnv
}

export function readCliBuildIdentity(
  options: CliBuildIdentityOptions = {}
): CliBuildIdentityReadResult {
  const runtimeDir = options.runtimeDir ?? __dirname
  const localInstallDir = resolve(runtimeDir, '..')
  const localVersion = readOrcaCliVersion(runtimeDir)
  const pointerPath = options.pointerPath ?? resolveOrcaBuildPointerPath(options.env)
  const required = isOrcaBuildPointerRequired(options.env)
  const resolution = resolveOrcaBuildPointer(pointerPath)
  const reason = describeOrcaBuildPointerFailure(resolution)

  const local = { version: localVersion, installDir: localInstallDir }
  const pointer = { path: pointerPath, state: resolution.state, reason, required }

  if (resolution.state === 'ok') {
    return {
      exitCode: 0,
      report: {
        schemaVersion: CLI_BUILD_IDENTITY_SCHEMA_VERSION,
        version: resolution.identity.version,
        artifact: resolution.identity.artifact,
        buildId: resolution.identity.buildId,
        buildTarget: resolution.identity.buildTarget,
        installDir: resolution.installDir,
        cli: resolution.identity.cli,
        source: 'pointer',
        pointer,
        local
      }
    }
  }

  return {
    exitCode: resolution.state === 'missing' && !required ? 0 : 1,
    report: {
      schemaVersion: CLI_BUILD_IDENTITY_SCHEMA_VERSION,
      version: localVersion,
      artifact: null,
      buildId: null,
      buildTarget: null,
      installDir: localInstallDir,
      cli: null,
      source: 'local-package',
      pointer,
      local
    }
  }
}

/** The one-line hint printed next to a non-zero `--version --json` exit. */
export function describeCliBuildIdentityFailure(report: CliBuildIdentityReport): string | null {
  if (report.pointer.state === 'ok') {
    return null
  }
  const requirement = report.pointer.required
    ? ` (${ORCA_BUILD_POINTER_REQUIRED_ENV} is set, so this host must have one)`
    : ''
  return `${report.pointer.reason}${requirement}`
}

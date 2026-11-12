// Where the incident database lives (issue-sedimentation.md v2.2 §6.1, §11.1).
//
// The file belongs to the per-host user-data directory:
//   * NOT in a Run archive — an incident outlives its Run, and a bare terminal has none;
//   * NOT in the orchestration database — that would touch `SCHEMA_VERSION` and couple two
//     retention policies;
//   * NOT in the user's working tree — it is host state, keyed by nothing the repo owns.
//
// Two processes open it: the desktop runtime (writer) and the CLI (reader/triage). They resolve the
// same directory by two different conventions because they are different kinds of process — the
// runtime has Electron's `app`, and the CLI has only the platform itself. Keeping both in one file
// makes the pairing explicit instead of leaving two unstated assumptions to drift.

import { hostname } from 'node:os'
import { join } from 'node:path'
import { getAppEnvironment, hasAppEnvironment } from '../../shared/app-environment'
import { getCanonicalUserDataPath } from '../persistence/loading-store/user-data-path'

export const INCIDENTS_DIRECTORY_NAME = 'incidents'
export const INCIDENTS_DATABASE_FILENAME = 'incidents.db'

/** `<userData>/incidents` — one directory for the database and the shadow family. */
export function incidentsDirectoryFor(userDataPath: string): string {
  return join(userDataPath, INCIDENTS_DIRECTORY_NAME)
}

/** `<userData>/incidents/incidents.db`. */
export function incidentsDatabaseFileFor(userDataPath: string): string {
  return join(incidentsDirectoryFor(userDataPath), INCIDENTS_DATABASE_FILENAME)
}

/**
 * The runtime's copy. `null` when no app environment is installed (unit tests, or a host process
 * that never booted Electron): the writer then reports a typed skip instead of inventing a path.
 *
 * `getCanonicalUserDataPath()` — not a fresh `getPath('userData')` — because the canonical directory
 * is captured before `app.setName()` can change how the path resolves on a case-sensitive filesystem.
 */
export function resolveMainProcessIncidentsDatabaseFile(): string | null {
  if (!hasAppEnvironment()) {
    return null
  }
  try {
    return incidentsDatabaseFileFor(getCanonicalUserDataPath())
  } catch {
    // A half-installed environment must not turn a PTY exit into a thrown error.
    return null
  }
}

/**
 * A stable local host id for rows and for the future mirror (§11.1).
 *
 * A hostname is host state, not a secret, and it stays in this host's own database. An empty or
 * throwing `hostname()` degrades to `local` rather than failing a write.
 */
export function resolveLocalHostId(): string {
  try {
    const name = hostname().trim().toLowerCase()
    return name.length > 0 ? name.slice(0, 200) : 'local'
  } catch {
    return 'local'
  }
}

/** Exposed for the CLI path-resolution test: the same platform base the runtime metadata uses. */
export function cliUserDataPathFor(platform: NodeJS.Platform, homeDir: string, appData?: string): string {
  if (platform === 'darwin') {
    return join(homeDir, 'Library', 'Application Support', 'orca')
  }
  if (platform === 'win32') {
    if (!appData) {
      throw new Error('APPDATA is not set, so the Orca user-data path cannot be resolved.')
    }
    return join(appData, 'orca')
  }
  return join(process.env.XDG_CONFIG_HOME || join(homeDir, '.config'), 'orca')
}

/** The runtime's userData path, or `null` when no environment is installed. */
export function mainProcessUserDataPath(): string | null {
  if (!hasAppEnvironment()) {
    return null
  }
  try {
    return getAppEnvironment().getPath('userData')
  } catch {
    return null
  }
}

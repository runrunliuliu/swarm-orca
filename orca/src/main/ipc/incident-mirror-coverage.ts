// The seam between the snapshot read model and the remote mirror's coverage read (M7-C).
//
// Why a registration instead of a direct import: the mirror read lives in `main/incidents`, and the
// panel's read model must not depend on the mirror being present (a build without remote support still
// renders a list). The mirror module registers its reader once, at runtime startup; this file calls it
// per snapshot and degrades to `undefined` — "not reported" — when nothing is registered or the read
// throws.
//
// It is also why the renderer never computes this: `capture` and `unsynced` are the mirror's claims
// about its own completeness (§11.1, §11.5), and a second computation here would be a second answer.
//
// The 1-line wiring M7-C lands at merge time:
//   registerIncidentMirrorCoverageReader((db) => readIncidentMirrorCoverage(db))

import type Database from '../sqlite/sync-database'
import type { IncidentRemoteMirrorDto } from '../../shared/incident-api-types'

export type IncidentMirrorCoverageReader = (
  db: Database.Database
) => IncidentRemoteMirrorDto | undefined

let active: IncidentMirrorCoverageReader | null = null

export function registerIncidentMirrorCoverageReader(reader: IncidentMirrorCoverageReader): void {
  active = reader
}

export function resetIncidentMirrorCoverageReaderForTests(): void {
  active = null
}

/**
 * Read the mirror's coverage for one snapshot.
 *
 * Failure policy mirrors the counts push: a diagnostics read must never fail the list. An absent
 * reader and a throwing read both produce `undefined`, which the DTO reserves for "not reported".
 */
export function readIncidentRemoteMirror(
  db: Database.Database
): IncidentRemoteMirrorDto | undefined {
  if (active === null) {
    return undefined
  }
  try {
    return active(db)
  } catch {
    return undefined
  }
}

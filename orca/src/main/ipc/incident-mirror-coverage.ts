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
// The wiring M7-C lands at merge time is one call from the startup path, not from here:
//   installIncidentMirrorCoverageReader()   // ipc/incident-mirror-coverage-install.ts
// which registers `(db) => toIncidentRemoteMirrorDto(readIncidentMirrorCoverage(db))`. The adapter lives
// there so this file never imports the mirror module.

import type Database from '../sqlite/sync-database'
import type { IncidentCountsDto, IncidentRemoteMirrorDto } from '../../shared/incident-api-types'

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

/**
 * Attach the mirror's coverage to a coverage object, or return it untouched.
 *
 * One helper for all three readers (snapshot, counts, the coalesced push) so the three cannot drift:
 * a push that omitted the mirror would make a badge's secondary hint blink off between writes.
 *
 * Absent stays absent: with no reader registered the key is not added at all, because `undefined`
 * ("not reported") is a different fact from `false`/`0` ("reported, and nothing is missing").
 *
 * It touches only `remoteMirror`. `gap`, `untriaged` and the local coverage fields are copied through
 * untouched — a remote hole must never re-grade the local count or the local tone.
 */
export function attachIncidentRemoteMirror<C extends object>(
  db: Database.Database,
  coverage: C
): C & { remoteMirror?: IncidentRemoteMirrorDto } {
  const remoteMirror = readIncidentRemoteMirror(db)
  return remoteMirror === undefined ? coverage : { ...coverage, remoteMirror }
}

/**
 * The same attachment for the counts push: `counts.coverage.remoteMirror` and nothing else.
 *
 * Kept next to the coverage helper so the explicit read and the coalesced push share one line, and so
 * neither can start folding the mirror into `coverage.gap` or re-counting `untriaged`.
 */
export function attachIncidentRemoteMirrorToCounts(
  db: Database.Database,
  counts: IncidentCountsDto
): IncidentCountsDto {
  return { ...counts, coverage: attachIncidentRemoteMirror(db, counts.coverage) }
}

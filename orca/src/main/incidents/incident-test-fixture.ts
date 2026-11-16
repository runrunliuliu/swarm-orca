// Shared rows and a real store for the incident main-process suites.
//
// Why one file instead of a builder per suite: three suites each rebuilt the same tmpdir harness
// (`mkdtempSync` -> `openIncidentsDatabase` -> close + `rmSync`) and the same `IncidentRecord`
// literal. The row shape is load-bearing — `UNIQUE(source_kind, source_id, facet)` decides whether
// an insert is a new fact, and the archive bucket reads `run_id`/`host_id` — so a copy that drifts
// fails a test that is about something else. The boring defaults live here; a case states only the
// field it is about.
//
// Not a test module itself (nothing matches `*.test.ts`): it exports the cleanup a suite registers
// with `afterEach`, so this file imports no test runner.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openIncidentsDatabase, type OpenIncidentsDatabase } from './incidents-database'
import { createIncidentStore, type IncidentStore } from './incident-store'
import type { IncidentRecord } from './incident-types'

const directories: string[] = []
const databases: OpenIncidentsDatabase[] = []

/** Where the store file lives inside a user-data directory. */
export function databasePath(userData: string): string {
  return join(userData, 'incidents', 'incidents.db')
}

/** A real store on a fresh tmpdir database; `closeStorePairs()` closes and removes it. */
export function openStorePair(): {
  opened: OpenIncidentsDatabase
  store: IncidentStore
  userData: string
} {
  const userData = mkdtempSync(join(tmpdir(), 'orca-incident-fixture-'))
  directories.push(userData)
  const opened = openIncidentsDatabase(databasePath(userData))
  databases.push(opened)
  return {
    opened,
    store: createIncidentStore({ db: opened.db, fileSizeBytes: opened.fileSizeBytes }),
    userData
  }
}

/** A connection a test opened itself (a second writer, a reopened file) is closed too. */
export function trackDatabase(opened: OpenIncidentsDatabase): OpenIncidentsDatabase {
  databases.push(opened)
  return opened
}

export function closeStorePairs(): void {
  for (const opened of databases.splice(0)) {
    try {
      opened.db.close()
    } catch {
      // Already closed.
    }
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
}

/**
 * One boring incident row: a self-report inside `run-1`, fingerprint `f`*64 and empty evidence.
 *
 * `sourceId` is derived from `id` so two rows in one store cannot collide on
 * `UNIQUE(source_kind, source_id, facet)` by accident; pass `sourceId` when the key itself is the
 * thing under test. Overrides win over every default, including the derived id.
 */
export function record(overrides: Partial<IncidentRecord> = {}): IncidentRecord {
  const id = overrides.id ?? 'inc_test_1'
  return {
    id,
    sourceKind: 'self_report',
    sourceId: `src-${id}`,
    facet: 'report',
    hostId: 'host-a',
    worktreeId: 'wt-1',
    runId: 'run-1',
    taskId: null,
    dispatchId: null,
    agentSessionId: null,
    ptyIncarnationId: null,
    class: 'tool_error',
    status: 'untriaged',
    exitCause: null,
    fingerprint: 'f'.repeat(64),
    evidence: { pointers: [], unknownBoundaries: [] },
    summary: 'reported',
    createdAt: 1_700_000_000_000,
    ...overrides
  }
}

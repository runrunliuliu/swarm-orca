/**
 * Shared fixture for the mining tests (simplify S3).
 *
 * The rule tests need no database at all; the build and apply tests both need a real one, plus the same
 * "seed a row" helper and the same `coverage`-supplying wrapper. Keeping that in one support module is
 * what lets the three suites be split without copying 60 lines of setup into each.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openIncidentsDatabase, type OpenIncidentsDatabase } from './incidents-database'
import { createIncidentStore, type IncidentStore } from './incident-store'
import type { IncidentClass, IncidentRecord, IncidentSourceKind } from './incident-types'
import { buildIncidentMine } from './incident-mine-build'

/** Seed timestamps default here so a window anchored at `T0 + n days` includes them. */
export const SEED_TIME = 1_700_000_000_000
const directories: string[] = []
const opened: OpenIncidentsDatabase[] = []
let sequence = 0

export type MineFixture = {
  db: OpenIncidentsDatabase['db']
  store: IncidentStore
}

export function createMineFixture(): MineFixture {
  const directory = mkdtempSync(join(tmpdir(), 'orca-mine-'))
  directories.push(directory)
  const database = openIncidentsDatabase(join(directory, 'incidents', 'incidents.db'))
  opened.push(database)
  return {
    db: database.db,
    store: createIncidentStore({ db: database.db, fileSizeBytes: database.fileSizeBytes })
  }
}

/** Alias used by the suites' existing bodies. */
export const fixture = createMineFixture

export function disposeMineFixtures(): void {
  for (const database of opened.splice(0)) {
    try {
      database.db.close()
    } catch {
      // Already closed.
    }
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
}

export type SeedOptions = {
  fingerprint: string
  sourceId?: string
  class?: IncidentClass
  sourceKind?: IncidentSourceKind
  facet?: string
  createdAt?: number
  worktreeId?: string | null
  runId?: string | null
  agentSessionId?: string | null
  dispatchId?: string | null
  exitCause?: IncidentRecord['exitCause']
}

export function seedIncident(store: IncidentStore, options: SeedOptions): IncidentRecord {
  sequence += 1
  const cls = options.class ?? 'crash'
  const sourceKind = options.sourceKind ?? 'pty_exit'
  const facet = options.facet ?? 'exit'
  const record: IncidentRecord = {
    id: `inc_mine_${sequence}`,
    sourceKind,
    sourceId: options.sourceId ?? `src_${sequence}`,
    facet,
    hostId: 'host-a',
    worktreeId: options.worktreeId === undefined ? 'wt-a' : options.worktreeId,
    runId: options.runId === undefined ? 'run-a' : options.runId,
    taskId: null,
    dispatchId: options.dispatchId ?? null,
    agentSessionId: options.agentSessionId ?? null,
    ptyIncarnationId: null,
    class: cls,
    status: 'untriaged',
    exitCause: options.exitCause ?? { kind: 'exited', exitCode: 1 },
    fingerprint: options.fingerprint,
    evidence: { pointers: [], unknownBoundaries: [] },
    summary: `seeded ${cls}`,
    createdAt: options.createdAt ?? SEED_TIME
  }
  store.insertIncident(record)
  return record
}

/** Every mining pass embeds the digest, which needs the store's own coverage report. */
export function mineWindow(
  db: OpenIncidentsDatabase['db'],
  store: IncidentStore,
  options: Omit<Parameters<typeof buildIncidentMine>[1], 'coverage'>
) {
  return buildIncidentMine(db, { ...options, coverage: store.coverage() })
}

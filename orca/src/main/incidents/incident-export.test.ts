/**
 * The triage seam (M8-1): what `orca incident export` promises a skill, without judgement.
 *
 * The two failure modes this suite exists to catch are the ones the subtraction could reintroduce:
 *   * a row that omits the entity columns or evidence pointers, so the skill cannot reproduce a
 *     decision the old miner made from them;
 *   * a truncated window reported as if it were the total.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openIncidentsDatabase, type OpenIncidentsDatabase } from './incidents-database'
import { createIncidentStore, type IncidentStore } from './incident-store'
import type { IncidentRecord } from './incident-types'
import {
  INCIDENT_EXPORT_VERSION,
  INCIDENT_EXPORT_VIEW,
  clampExportLimit,
  parseExportWindow,
  readIncidentExport
} from './incident-export'

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_700_000_000_000

const directories: string[] = []
const opened: OpenIncidentsDatabase[] = []

function pair(): { opened: OpenIncidentsDatabase; store: IncidentStore } {
  const directory = mkdtempSync(join(tmpdir(), 'orca-incident-export-'))
  directories.push(directory)
  const database = openIncidentsDatabase(join(directory, 'incidents.db'))
  opened.push(database)
  return {
    opened: database,
    store: createIncidentStore({
      db: database.db,
      fileSizeBytes: database.fileSizeBytes,
      now: () => NOW
    })
  }
}

function record(overrides: Partial<IncidentRecord> = {}): IncidentRecord {
  const id = overrides.id ?? 'inc_1'
  return {
    id,
    sourceKind: 'pty_exit',
    sourceId: `source-${id}`,
    facet: 'exit',
    hostId: 'host-a',
    worktreeId: 'wt-1',
    runId: 'run-1',
    taskId: 'task-1',
    dispatchId: 'disp-1',
    agentSessionId: 'session-1',
    ptyIncarnationId: `pty-${id}`,
    class: 'crash',
    status: 'untriaged',
    exitCause: { kind: 'signaled', signal: 9 },
    fingerprint: 'f'.repeat(64),
    evidence: {
      pointers: [
        {
          kind: 'transcript',
          path: '/tmp/transcript.jsonl',
          sha256: 'a'.repeat(64),
          startOffset: 10,
          endOffset: 20,
          bytes: 10
        }
      ],
      unknownBoundaries: ['no exit receipt']
    },
    summary: 'agent killed by signal 9',
    createdAt: NOW,
    ...overrides
  }
}

afterEach(() => {
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
})

describe('readIncidentExport', () => {
  it('carries the entity columns and evidence pointers a triage needs', () => {
    const { opened: database, store } = pair()
    store.insertIncident(record())
    const result = readIncidentExport(database.db, { now: NOW, coverage: store.coverage() })
    expect(result.rows).toHaveLength(1)
    const row = result.rows[0]
    expect(row).toMatchObject({
      id: 'inc_1',
      sourceKind: 'pty_exit',
      sourceId: 'source-inc_1',
      runId: 'run-1',
      taskId: 'task-1',
      dispatchId: 'disp-1',
      agentSessionId: 'session-1',
      class: 'crash',
      status: 'untriaged',
      effectiveStatus: 'untriaged',
      decisionCount: 0,
      lastDecisionAt: null
    })
    expect(row.evidence.pointers[0]).toMatchObject({
      path: '/tmp/transcript.jsonl',
      sha256: 'a'.repeat(64),
      startOffset: 10,
      endOffset: 20
    })
    expect(row.evidence.unknownBoundaries).toEqual(['no exit receipt'])
  })

  it('projects the effective status from the decision log', () => {
    const { opened: database, store } = pair()
    store.insertIncident(record())
    store.appendDecision({ incidentId: 'inc_1', toStatus: 'watch', actor: 'alice', reason: 'seen twice' })
    const result = readIncidentExport(database.db, { now: NOW, coverage: store.coverage() })
    expect(result.rows[0].effectiveStatus).toBe('watch')
    expect(result.rows[0].status).toBe('untriaged')
    expect(result.rows[0].decisionCount).toBe(1)
    expect(result.rows[0].lastDecisionAt).toBe(NOW)
  })

  it('filters by window and reports the window total', () => {
    const { opened: database, store } = pair()
    store.insertIncident(record({ id: 'inc_new', sourceId: 's-new', createdAt: NOW }))
    store.insertIncident(
      record({ id: 'inc_old', sourceId: 's-old', createdAt: NOW - 3 * DAY, exitCause: { kind: 'exited', exitCode: 1 } })
    )
    const result = readIncidentExport(database.db, {
      now: NOW,
      windowMs: DAY,
      coverage: store.coverage()
    })
    expect(result.rows.map((row) => row.id)).toEqual(['inc_new'])
    expect(result.total).toBe(1)
    expect(result.truncated).toBe(false)
    expect(result.since).toBe(NOW - DAY)
  })

  it('states truncation instead of applying the limit quietly', () => {
    const { opened: database, store } = pair()
    for (const id of ['inc_1', 'inc_2', 'inc_3']) {
      store.insertIncident(record({ id, sourceId: `s-${id}` }))
    }
    const result = readIncidentExport(database.db, {
      now: NOW,
      limit: 2,
      coverage: store.coverage()
    })
    expect(result.rows).toHaveLength(2)
    expect(result.truncated).toBe(true)
    expect(result.total).toBe(3)
  })

  it('passes coverage through, so an empty window is not read as "no incidents"', () => {
    const { opened: database, store } = pair()
    const result = readIncidentExport(database.db, { now: NOW, coverage: store.coverage() })
    expect(result.rows).toEqual([])
    expect(result.coverage.remoteIncidentCapture).toBe('unsupported')
    expect(result.coverage.shadowReplay.incomplete).toBe(false)
    expect(INCIDENT_EXPORT_VERSION).toBe(1)
    expect(INCIDENT_EXPORT_VIEW).toBe('incident_triage_rows')
  })

  it('ships the view the export reads', () => {
    const { opened: database } = pair()
    const row = database.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'view' AND name = ?")
      .get(INCIDENT_EXPORT_VIEW) as { name?: string } | undefined
    expect(row?.name).toBe(INCIDENT_EXPORT_VIEW)
  })
})

describe('export flag helpers', () => {
  it('parses the same durations the digest used to accept', () => {
    expect(parseExportWindow('24h')).toBe(DAY)
    expect(parseExportWindow('7d')).toBe(7 * DAY)
    expect(parseExportWindow('90m')).toBe(90 * 60_000)
    expect(parseExportWindow('3600s')).toBe(3_600_000)
    expect(parseExportWindow('yesterday')).toBeNull()
  })

  it('clamps the limit so one command cannot ask for the whole store', () => {
    expect(clampExportLimit(0)).toBe(1)
    expect(clampExportLimit(Number.NaN)).toBe(2000)
    expect(clampExportLimit(10_000_000)).toBe(20_000)
  })
})

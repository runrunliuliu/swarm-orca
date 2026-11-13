// The grayscale views over IPC (§7.2, §7.3; M7-B).
//
// Two properties are pinned here: the projection carries the facts the panel needs to say "observed,
// not recorded" (the switch, `written`, the stall age basis, the provider coverage gap), and neither
// function has a write path — a read of an absent store is a closed failure, and reading twice leaves
// the store byte-identical.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openIncidentsDatabase, type OpenIncidentsDatabase } from '../incidents/incidents-database'
import { createIncidentStore, type IncidentStore } from '../incidents/incident-store'
import {
  __configureIncidentStoreForTests,
  __resetIncidentWriterForTests
} from '../incidents/incident-writer'
import { replacePaneClocks } from '../incidents/incident-pane-clocks'
import { samplePaneClocks } from '../incidents/incidents-stall-sampler'
import { recordToolFailure } from '../incidents/incident-tool-failures'
import { readIncidentPaneClocksView, readIncidentToolFailuresView } from './incident-gray-views'

const directories: string[] = []
const databases: OpenIncidentsDatabase[] = []

afterEach(() => {
  __configureIncidentStoreForTests(null)
  __resetIncidentWriterForTests()
  for (const opened of databases.splice(0)) {
    opened.db.close()
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function configuredStore(): { store: IncidentStore; opened: OpenIncidentsDatabase } {
  const directory = mkdtempSync(join(tmpdir(), 'orca-incident-gray-'))
  directories.push(directory)
  const opened = openIncidentsDatabase(join(directory, 'incidents', 'incidents.db'))
  databases.push(opened)
  const store = createIncidentStore({ db: opened.db, fileSizeBytes: opened.fileSizeBytes })
  __configureIncidentStoreForTests(store, opened.db)
  return { store, opened }
}

describe('readIncidentPaneClocksView', () => {
  it('returns the stored facts and the coverage, with no verdict field', () => {
    const { opened } = configuredStore()
    samplePaneClocks({
      db: opened.db,
      now: 1_700_000_000_000,
      rows: [
        {
          paneKey: 'pane-1',
          terminalHandle: 'term-1',
          state: 'working',
          stateStartedAt: 1_700_000_000_000,
          turnStartedAt: null,
          lastSemanticEventAt: null
        }
      ]
    })

    const result = readIncidentPaneClocksView()
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.value.rows).toHaveLength(1)
    expect(result.value.rows[0]).toMatchObject({
      paneKey: 'pane-1',
      state: 'working',
      ageBasis: 'state_fallback',
      observedAt: 1_700_000_000_000
    })
    expect(result.value.rows[0]).not.toHaveProperty('wouldWriteIfEnabled')
    expect(result.value.coverage.paneClock).toMatchObject({ panes: 1, errors: 0 })
    expect(result.value.coverage.remoteIncidentCapture).toBe('unsupported')
  })

  it('does not write: two reads leave the fact table untouched', () => {
    const { opened } = configuredStore()
    replacePaneClocks(opened.db, [], 1_700_000_000_000)
    const before = opened.db.prepare('SELECT COUNT(*) AS n FROM incident_pane_clocks').get()
    readIncidentPaneClocksView()
    readIncidentPaneClocksView()
    const after = opened.db.prepare('SELECT COUNT(*) AS n FROM incident_pane_clocks').get()
    expect(after).toEqual(before)
  })
})

describe('readIncidentToolFailuresView', () => {
  it('returns the raw facts and states the provider gap', () => {
    const { opened } = configuredStore()
    recordToolFailure(opened.db, {
      sessionId: 'sess-1',
      itemKey: 'item-1',
      ordinal: 0,
      turn: 'turn-1',
      toolName: 'bash',
      errorKind: null,
      exitCode: 2,
      observedAt: Date.now()
    })

    const result = readIncidentToolFailuresView()
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.value.total).toBe(1)
    expect(result.value.rows[0]).toMatchObject({
      sessionId: 'sess-1',
      toolName: 'bash',
      errorKind: null,
      exitCode: 2
    })
    expect(result.value.rows[0]).not.toHaveProperty('code')
    expect(result.value.rows[0]).not.toHaveProperty('written')
    // Coverage is a claim: an uncovered provider must be named, not implied away.
    expect(result.value.coveredProviders).toContain('claude')
    expect(result.value.coveredProviders).toContain('codex')
    expect(result.value.uncoveredProviders).toContain('pi')
  })

  it('reports an empty store as empty, never as an error', () => {
    configuredStore()
    const result = readIncidentToolFailuresView()
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.value.rows).toEqual([])
    expect(result.value.total).toBe(0)
    expect(result.value.dropped).toBe(0)
  })
})

describe('unavailable store', () => {
  it('returns a closed failure from both views, not a thrown bridge', () => {
    __configureIncidentStoreForTests(null)
    expect(readIncidentPaneClocksView()).toMatchObject({
      ok: false,
      code: 'incident_store_unavailable'
    })
    expect(readIncidentToolFailuresView()).toMatchObject({
      ok: false,
      code: 'incident_store_unavailable'
    })
  })
})

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
import { writeMeta } from '../incidents/incident-store-meta'
import { TOOL_ERROR_WINDOWS_META } from '../incidents/incident-tool-error-report'
import { readIncidentPaneClocksView, readIncidentToolErrorsView } from './incident-gray-views'

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

describe('readIncidentToolErrorsView', () => {
  it('returns the published windows with written/would-write kept apart and the provider gap stated', () => {
    const { opened } = configuredStore()
    writeMeta(
      opened.db,
      TOOL_ERROR_WINDOWS_META,
      JSON.stringify({
        updatedAt: 1_700_000_000_000,
        writeEnabled: false,
        published: 2,
        total: 3,
        evicted: 1,
        windows: [
          {
            sessionId: 'sess-1',
            turn: 'turn-1',
            toolName: 'bash',
            code: 'non_zero_exit',
            count: 5,
            windowStart: 1_699_999_000_000,
            lastAt: 1_700_000_000_000,
            highSeverity: false,
            wouldWriteIfEnabled: true,
            written: false
          },
          {
            sessionId: 'sess-1',
            turn: 'turn-2',
            toolName: 'edit',
            code: 'permission_denied',
            count: 1,
            windowStart: 1_699_999_500_000,
            lastAt: 1_700_000_000_000,
            highSeverity: true,
            wouldWriteIfEnabled: true,
            written: true
          }
        ]
      })
    )

    const result = readIncidentToolErrorsView()
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.value.published).toBe(2)
    expect(result.value.total).toBe(3)
    expect(result.value.evicted).toBe(1)
    expect(result.value.windows.map((window) => window.written)).toEqual([false, true])
    expect(result.value.windows[1]).toMatchObject({ code: 'permission_denied', highSeverity: true })
    // Coverage is a claim: an uncovered provider must be named, not implied away.
    expect(result.value.coveredProviders).toContain('claude')
    expect(result.value.coveredProviders).toContain('codex')
    expect(result.value.uncoveredProviders).toContain('pi')
  })

  it('reports an unpublished snapshot as empty rather than as an error', () => {
    configuredStore()
    const result = readIncidentToolErrorsView()
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.value.updatedAt).toBeNull()
    expect(result.value.windows).toEqual([])
  })
})

describe('unavailable store', () => {
  it('returns a closed failure from both views, not a thrown bridge', () => {
    __configureIncidentStoreForTests(null)
    expect(readIncidentPaneClocksView()).toMatchObject({
      ok: false,
      code: 'incident_store_unavailable'
    })
    expect(readIncidentToolErrorsView()).toMatchObject({
      ok: false,
      code: 'incident_store_unavailable'
    })
  })
})

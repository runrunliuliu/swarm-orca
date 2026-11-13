/**
 * End to end for M4-1 on a real database: the default writes nothing, the switch writes one row per
 * window, a re-sent item never double counts, and a refused key is counted instead of stored.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openIncidentsDatabase, type OpenIncidentsDatabase } from './incidents-database'
import { createIncidentStore, type IncidentStore } from './incident-store'
import {
  TOOL_ERROR_WRITE_ENV,
  __resetToolErrorObserverForTests,
  observeToolErrorItem,
  readToolErrorWindows
} from './incident-tool-error-observer'
import { TOOL_ERROR_KEY_REJECTED_META } from './incident-tool-error-report'
import type { AgentJournalItemBody } from '../../shared/agent-session-journal-types'

const T0 = 1_700_000_000_000
const TURN = { kind: 'turn', turnItemId: 'turn-1' } as const

const directories: string[] = []
const databases: OpenIncidentsDatabase[] = []

function fixture(): { store: IncidentStore; runtime: { store: IncidentStore; db: OpenIncidentsDatabase['db'] } } {
  const directory = mkdtempSync(join(tmpdir(), 'orca-tool-error-'))
  directories.push(directory)
  const opened = openIncidentsDatabase(join(directory, 'incidents', 'incidents.db'))
  databases.push(opened)
  const store = createIncidentStore({ db: opened.db, fileSizeBytes: opened.fileSizeBytes })
  return { store, runtime: { store, db: opened.db } }
}

function failedCall(name = 'Bash', head = 'process exited with code 2'): AgentJournalItemBody {
  return {
    kind: 'tool-call',
    name,
    input: {},
    state: 'failed',
    output: { head, byteLength: head.length, digest: 'a'.repeat(64), truncated: false }
  }
}

function countRows(store: IncidentStore): number {
  return store.countIncidents()
}

let previousWriteEnv: string | undefined

beforeEach(() => {
  previousWriteEnv = process.env[TOOL_ERROR_WRITE_ENV]
  delete process.env[TOOL_ERROR_WRITE_ENV]
  __resetToolErrorObserverForTests()
})

afterEach(() => {
  __resetToolErrorObserverForTests()
  if (previousWriteEnv === undefined) {
    delete process.env[TOOL_ERROR_WRITE_ENV]
  } else {
    process.env[TOOL_ERROR_WRITE_ENV] = previousWriteEnv
  }
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
})

describe('default mode (switch off)', () => {
  it('counts the window but writes no incident end to end', () => {
    const { store, runtime } = fixture()
    for (let index = 0; index < 5; index += 1) {
      observeToolErrorItem({
        sessionId: 's-1',
        itemKey: `item-${index}`,
        turnScope: TURN,
        body: failedCall(),
        now: T0 + index,
        runtime,
        shadow: false
      })
    }
    expect(countRows(store)).toBe(0)
    const snapshot = readToolErrorWindows(runtime.db)
    expect(snapshot).toMatchObject({ writeEnabled: false })
    expect(snapshot.windows[0]).toMatchObject({
      code: 'non_zero_exit',
      count: 5,
      wouldWriteIfEnabled: true,
      written: false
    })
  })
})

describe('switch on', () => {
  beforeEach(() => {
    process.env[TOOL_ERROR_WRITE_ENV] = 'on'
  })

  it('writes one tool_error row at the fifth event, keyed by session/turn/code/windowStart', () => {
    const { store, runtime } = fixture()
    for (let index = 0; index < 5; index += 1) {
      observeToolErrorItem({
        sessionId: 's-1',
        itemKey: `item-${index}`,
        turnScope: TURN,
        body: failedCall(),
        now: T0 + index,
        runtime,
        shadow: false
      })
    }
    expect(countRows(store)).toBe(1)
    const incident = store.getIncident(store.listIncidents().incidents[0].id)!
    expect(incident).toMatchObject({
      class: 'tool_error',
      sourceKind: 'tool_error',
      facet: 'tool:non_zero_exit',
      sourceId: `s-1:turn-1:non_zero_exit:${T0}`,
      status: 'untriaged'
    })
    expect(incident.evidence.code).toBe('non_zero_exit')

    // A sixth event in the same window is a duplicate, not a second row.
    observeToolErrorItem({
      sessionId: 's-1',
      itemKey: 'item-6',
      turnScope: TURN,
      body: failedCall(),
      now: T0 + 6,
      runtime,
      shadow: false
    })
    expect(countRows(store)).toBe(1)
  })

  it('writes immediately for a high-severity code', () => {
    const { store, runtime } = fixture()
    observeToolErrorItem({
      sessionId: 's-1',
      itemKey: 'item-1',
      turnScope: TURN,
      body: failedCall('Bash', 'permission denied: /root/x'),
      now: T0,
      runtime,
      shadow: false
    })
    expect(countRows(store)).toBe(1)
    expect(store.listIncidents().incidents[0].class).toBe('tool_error')
  })
})

describe('replay and re-sent items', () => {
  it('counts the same item once even if it is appended again', () => {
    const { store, runtime } = fixture()
    process.env[TOOL_ERROR_WRITE_ENV] = 'on'
    // The same item re-sent five times (a coalesced re-append / a reattach) is ONE tool error, so the
    // threshold is not reached — this is what keeps replay from manufacturing incidents.
    for (let index = 0; index < 6; index += 1) {
      observeToolErrorItem({
        sessionId: 's-1',
        itemKey: 'item-same',
        turnScope: TURN,
        body: failedCall(),
        now: T0 + index,
        runtime,
        shadow: false
      })
    }
    expect(countRows(store)).toBe(0)
    expect(readToolErrorWindows(runtime.db).windows[0].count).toBe(1)
  })

  it('counts a genuinely new item, so a real burst still opens', () => {
    const { store, runtime } = fixture()
    process.env[TOOL_ERROR_WRITE_ENV] = 'on'
    for (let index = 0; index < 5; index += 1) {
      observeToolErrorItem({
        sessionId: 's-1',
        itemKey: `item-${index}`,
        turnScope: TURN,
        body: failedCall(),
        now: T0 + index,
        runtime,
        shadow: false
      })
    }
    expect(countRows(store)).toBe(1)
  })
})

describe('key validation', () => {
  it('refuses an unkeyable session/turn/code and counts the refusal', () => {
    const { store, runtime } = fixture()
    process.env[TOOL_ERROR_WRITE_ENV] = 'on'
    // A turn id containing the key separator cannot form a source_id.
    for (let index = 0; index < 5; index += 1) {
      observeToolErrorItem({
        sessionId: 's-1',
        itemKey: `item-${index}`,
        turnScope: { kind: 'turn', turnItemId: 'turn:with:colons' },
        body: failedCall(),
        now: T0 + index,
        runtime,
        shadow: false
      })
    }
    expect(countRows(store)).toBe(0)
    const row = runtime.db
      .prepare('SELECT value FROM incident_store_meta WHERE key = ?')
      .get(TOOL_ERROR_KEY_REJECTED_META)
    expect(Number(row?.value)).toBeGreaterThan(0)
  })
})

describe('non-error items', () => {
  it('observes nothing for a completed call or an ordinary message', () => {
    const { store, runtime } = fixture()
    const completed: AgentJournalItemBody = { kind: 'tool-call', name: 'Bash', input: {}, state: 'completed' }
    expect(
      observeToolErrorItem({
        sessionId: 's-1',
        itemKey: 'item-1',
        turnScope: TURN,
        body: completed,
        now: T0,
        runtime,
        shadow: false
      })
    ).toMatchObject({ observations: 0 })
    expect(countRows(store)).toBe(0)
  })
})

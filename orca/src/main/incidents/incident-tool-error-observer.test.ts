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

function failedCall(
  name = 'Bash',
  head = 'process exited with code 2',
  extra: { exitCode?: number; errorKind?: string } = { exitCode: 2 }
): AgentJournalItemBody {
  return {
    kind: 'tool-call',
    name,
    input: {},
    state: 'failed',
    ...extra,
    output: { head, byteLength: head.length, digest: 'a'.repeat(64), truncated: false }
  }
}

function observe(
  runtime: { store: IncidentStore; db: OpenIncidentsDatabase['db'] },
  input: { itemKey: string; body: AgentJournalItemBody; now: number; turn?: string }
) {
  return observeToolErrorItem({
    sessionId: 's-1',
    itemKey: input.itemKey,
    turnScope: { kind: 'turn', turnItemId: input.turn ?? 'turn-1' },
    body: input.body,
    now: input.now,
    runtime,
    shadow: false
  })
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
      written: false,
      turn: 'turn-1'
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

  it('writes immediately for a structured permission refusal', () => {
    const { store, runtime } = fixture()
    observe(runtime, {
      itemKey: 'item-1',
      body: failedCall('Bash', 'denied', { errorKind: 'permission_denied' }),
      now: T0
    })
    expect(countRows(store)).toBe(1)
    const view = store.getIncident(store.listIncidents().incidents[0].id)!
    expect(view.class).toBe('tool_error')
    expect(view.evidence.code).toBe('permission_denied')
  })

  it('does NOT write on the first textual "permission denied" (M4-C1)', () => {
    const { store, runtime } = fixture()
    observe(runtime, {
      itemKey: 'item-1',
      // Text-only: the fixture carries no structured exit code and no errorKind.
      body: failedCall('Bash', 'bash: permission denied: /root/x', {}),
      now: T0
    })
    expect(countRows(store)).toBe(0)
    const window = readToolErrorWindows(runtime.db).windows[0]
    expect(window).toMatchObject({ code: 'unknown', count: 1, wouldWriteIfEnabled: false, highSeverity: false })
  })

  it('treats a build log with permission text and exit code 2 as non_zero_exit', () => {
    const { store, runtime } = fixture()
    for (let index = 0; index < 5; index += 1) {
      observe(runtime, {
        itemKey: `item-${index}`,
        body: failedCall('Bash', 'npm ERR! permission denied / 403', { exitCode: 2 }),
        now: T0 + index
      })
    }
    expect(countRows(store)).toBe(1)
    const view = store.getIncident(store.listIncidents().incidents[0].id)!
    expect(view.evidence.code).toBe('non_zero_exit')
    expect(view.summary).not.toContain('structured denial')
  })
})

describe('turn boundaries (M4-C2)', () => {
  it('does not open across two turns (3 in turn A + 2 in turn B)', () => {
    const { store, runtime } = fixture()
    process.env[TOOL_ERROR_WRITE_ENV] = 'on'
    for (let index = 0; index < 3; index += 1) {
      observe(runtime, { itemKey: `a-${index}`, body: failedCall(), now: T0 + index, turn: 'turn-A' })
    }
    for (let index = 0; index < 2; index += 1) {
      observe(runtime, { itemKey: `b-${index}`, body: failedCall(), now: T0 + 10 + index, turn: 'turn-B' })
    }
    expect(countRows(store)).toBe(0)
    expect(readToolErrorWindows(runtime.db).windows).toHaveLength(2)
  })

  it('opens when one turn reaches five', () => {
    const { store, runtime } = fixture()
    process.env[TOOL_ERROR_WRITE_ENV] = 'on'
    for (let index = 0; index < 5; index += 1) {
      observe(runtime, { itemKey: `t-${index}`, body: failedCall(), now: T0 + index, turn: 'turn-A' })
    }
    expect(countRows(store)).toBe(1)
  })
})

describe('provider coverage (M4-C3)', () => {
  it('claude: is_error with permission text and no structured kind stays unknown', async () => {
    const { claudeToolBody } = await import('../claude/claude-structured-item-translation')
    const body = claudeToolBody({
      tool: { id: 'toolu-1', name: 'Bash', input: {} },
      result: { toolUseId: 'toolu-1', output: 'permission denied: /root/x', failed: true }
    })
    const { store, runtime } = fixture()
    process.env[TOOL_ERROR_WRITE_ENV] = 'on'
    observe(runtime, { itemKey: 'claude-1', body, now: T0 })
    expect(countRows(store)).toBe(0)
    expect(readToolErrorWindows(runtime.db).windows[0]).toMatchObject({
      code: 'unknown',
      wouldWriteIfEnabled: false
    })
  })

  it('codex: a failed command carries the structured exit code, so it is non_zero_exit', async () => {
    const { codexItemBody } = await import('../codex/codex-structured-item-translation')
    const body = codexItemBody({
      type: 'commandExecution',
      id: 'cmd-1',
      command: 'npm test',
      status: 'failed',
      exitCode: 2,
      aggregatedOutput: 'npm ERR! permission denied / 403'
    })
    expect(body).not.toBeNull()
    const { store, runtime } = fixture()
    process.env[TOOL_ERROR_WRITE_ENV] = 'on'
    for (let index = 0; index < 5; index += 1) {
      observe(runtime, { itemKey: `codex-${index}`, body: body as AgentJournalItemBody, now: T0 + index })
    }
    expect(countRows(store)).toBe(1)
    const view = store.getIncident(store.listIncidents().incidents[0].id)!
    expect(view.evidence.code).toBe('non_zero_exit')
  })

  it('names the providers that are not wired instead of claiming coverage', async () => {
    const coverage = await import('./incident-tool-error-coverage')
    expect(coverage.TOOL_ERROR_COVERED_PROVIDERS).toEqual(['claude', 'codex'])
    expect(coverage.TOOL_ERROR_UNCOVERED_PROVIDERS).toEqual(
      expect.arrayContaining(['claude-agent-teams', 'grok', 'omp', 'trae', 'cursor'])
    )
    expect(coverage.TOOL_ERROR_COVERED_PROVIDERS).not.toContain('grok')
    expect(coverage.TOOL_ERROR_COVERAGE_NOTES.join(' ')).toMatch(/no provider stamps one yet/)
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

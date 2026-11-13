/**
 * The M1 human loop, end to end at the process boundary: a crash row that the runtime wrote is
 * visible to `list`, triageable with `decide`, and untouched by `prune --dry-run` (§12, §13 M1).
 *
 * The store is a real SQLite file in a temp user-data directory and the handlers are the real ones,
 * so this covers path resolution + store + formatter together rather than mocking the middle.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommandHandler, HandlerContext } from '../dispatch'
import { RuntimeClientError } from '../runtime/types'
import { openIncidentsDatabase, type OpenIncidentsDatabase } from '../../main/incidents/incidents-database'
import { createIncidentStore, type IncidentStore } from '../../main/incidents/incident-store'
import { incidentsDatabaseFileFor } from '../../main/incidents/incidents-paths'
import { recordPtyExitIncidentTo } from '../../main/incidents/incident-writer'
import { samplePaneClocks } from '../../main/incidents/incidents-stall-sampler'
import { recordToolFailure } from '../../main/incidents/incident-tool-failures'
import { listActiveWaits } from '../../main/incidents/incident-wait'
import {
  declareAcceptanceRule,
  openAcceptanceStop,
  writeAcceptanceVerdict
} from '../../main/incidents/dispatch-acceptance-store'
import { REPEATED_FLAG_SEPARATOR as REPEATED } from '../args'
import type { PtyExitIncidentFacts } from '../../main/incidents/incident-pty-exit'
import { INCIDENT_HANDLERS } from './incident'

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_700_000_000_000

let userData: string
/** The fixture's userData doubles as the authorized worktree root for acceptance declarations (C5). */
let worktreeRoot: string
let opened: OpenIncidentsDatabase | null = null
let previousUserDataPath: string | undefined

function store(): IncidentStore {
  opened = openIncidentsDatabase(incidentsDatabaseFileFor(userData))
  return createIncidentStore({ db: opened.db, fileSizeBytes: opened.fileSizeBytes, now: () => NOW })
}

function facts(overrides: Partial<PtyExitIncidentFacts> = {}): PtyExitIncidentFacts {
  return {
    ptyId: 'wt-1__pty-1',
    incarnationId: 'ptyinc-e2e-1',
    paneKey: 'tab-1:leaf-1',
    worktreeId: 'wt-1',
    agentSessionId: null,
    agentIdentityDigest: null,
    exitCode: 137,
    exitCause: { kind: 'signaled', signal: 9 },
    hostExitConfirmed: true,
    providerExitObserved: true,
    surface: 'local',
    hasAgentBinding: true,
    ...overrides
  }
}

function context(
  handler: string,
  flags: Record<string, string | boolean> = {},
  json = false
): { ctx: HandlerContext; output: string[] } {
  const output: string[] = []
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    output.push(args.map((arg) => String(arg)).join(' '))
  })
  const ctx: HandlerContext = {
    flags: new Map(Object.entries(flags)),
    // The incident handlers never touch the runtime client: they open the store directly so they
    // work on a host whose desktop app is not running.
    client: {} as HandlerContext['client'],
    cwd: userData,
    json
  }
  const resolved = INCIDENT_HANDLERS[handler] as CommandHandler
  expect(resolved).toBeTypeOf('function')
  return { ctx, output }
}

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'orca-incident-cli-'))
  // A linked worktree root is a directory with a `.git` ENTRY; the check only requires it to exist.
  worktreeRoot = mkdtempSync(join(tmpdir(), 'orca-incident-worktree-'))
  writeFileSync(join(worktreeRoot, '.git'), 'gitdir: /tmp/not-a-real-gitdir\n')
  previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  process.env.ORCA_USER_DATA_PATH = userData
})

afterEach(() => {
  vi.restoreAllMocks()
  if (previousUserDataPath === undefined) {
    delete process.env.ORCA_USER_DATA_PATH
  } else {
    process.env.ORCA_USER_DATA_PATH = previousUserDataPath
  }
  try {
    opened?.db.close()
  } catch {
    // Already closed by the handler under test.
  }
  opened = null
  rmSync(userData, { recursive: true, force: true })
})

describe('incident list', () => {
  it('reports an empty store with the coverage gaps instead of failing', async () => {
    const { ctx, output } = context('incident list')
    await INCIDENT_HANDLERS['incident list'](ctx)
    const text = output.join('\n')
    expect(text).toContain('No incidents recorded on this host')
    expect(text).toContain('remote_incident_capture=unsupported')
    expect(text).toContain('capacity_latch_set=false')
    expect(text).toContain('currently_limited=false')
  })

  it('creates nothing on disk when no store exists yet (C4)', async () => {
    const { ctx } = context('incident list')
    await INCIDENT_HANDLERS['incident list'](ctx)
    expect(existsSync(incidentsDatabaseFileFor(userData))).toBe(false)
    expect(existsSync(join(userData, 'incidents'))).toBe(false)
  })

  it('shows a crash the runtime wrote, with its exit cause', async () => {
    recordPtyExitIncidentTo(store(), facts(), { hostId: 'host-a', now: NOW })
    const { ctx, output } = context('incident list')
    await INCIDENT_HANDLERS['incident list'](ctx)
    const text = output.join('\n')
    expect(text).toContain('crash')
    expect(text).toContain('signaled(9)')
    expect(text).toContain('wt-1')
  })

  it('emits JSON with the coverage object when --json is passed', async () => {
    recordPtyExitIncidentTo(store(), facts(), { hostId: 'host-a', now: NOW })
    const { ctx, output } = context('incident list', {}, true)
    await INCIDENT_HANDLERS['incident list'](ctx)
    const parsed = JSON.parse(output.join('\n')) as {
      total: number
      coverage: {
        remoteIncidentCapture: string
        capacityLatchSet: boolean
        currentlyLimited: boolean
      }
    }
    expect(parsed.total).toBe(1)
    expect(parsed.coverage.remoteIncidentCapture).toBe('unsupported')
    expect(parsed.coverage.capacityLatchSet).toBe(false)
    expect(parsed.coverage.currentlyLimited).toBe(false)
  })

  it('refuses a selector that would answer for another host', async () => {
    const { ctx } = context('incident list', { host: 'runtime:other' })
    await expect(INCIDENT_HANDLERS['incident list'](ctx)).rejects.toMatchObject({
      code: 'invalid_argument'
    })
  })

  it('rejects an unknown status filter', async () => {
    const { ctx } = context('incident list', { status: 'not-a-status' })
    await expect(INCIDENT_HANDLERS['incident list'](ctx)).rejects.toBeInstanceOf(RuntimeClientError)
  })
})

describe('incident show', () => {
  it('prints the incident with its unknown boundaries and decisions', async () => {
    const writable = store()
    const written = recordPtyExitIncidentTo(writable, facts({ surface: 'ssh', hostExitConfirmed: false, exitCause: { kind: 'unknown', reason: 'stop_unverified' } }), {
      hostId: 'host-a',
      now: NOW
    })
    const { ctx, output } = context('incident show', { id: written.id ?? '' })
    await INCIDENT_HANDLERS['incident show'](ctx)
    const text = output.join('\n')
    expect(text).toContain('Unknown boundaries:')
    expect(text).toContain('SSH 宿主未确认退出')
    expect(text).toContain('durable=false')
  })

  it('renders markdown with --md, including the unknown section', async () => {
    const writable = store()
    const written = recordPtyExitIncidentTo(writable, facts(), { hostId: 'host-a', now: NOW })
    const { ctx, output } = context('incident show', { id: written.id ?? '', md: true })
    await INCIDENT_HANDLERS['incident show'](ctx)
    const markdown = output.join('\n')
    expect(markdown).toContain('## 5. 未知边界')
    expect(markdown).toContain('## 4. 机制分析')
    expect(markdown).toContain('未填写')
  })

  it('fails on an unknown id and on an empty store', async () => {
    const missingStore = context('incident show', { id: 'inc_nope' })
    await expect(INCIDENT_HANDLERS['incident show'](missingStore.ctx)).rejects.toMatchObject({
      code: 'invalid_argument'
    })
  })
})

describe('incident decide', () => {
  it('appends a decision and keeps the row immutable', async () => {
    const writable = store()
    const written = recordPtyExitIncidentTo(writable, facts(), { hostId: 'host-a', now: NOW })
    const id = written.id as string

    const decided = context('incident decide', {
      id,
      to: 'watch',
      reason: 'waiting for a second occurrence'
    })
    await INCIDENT_HANDLERS['incident decide'](decided.ctx)
    expect(decided.output.join('\n')).toContain('untriaged → watch')

    const shown = context('incident show', { id })
    await INCIDENT_HANDLERS['incident show'](shown.ctx)
    expect(shown.output.join('\n')).toContain('watch')
    expect(shown.output.join('\n')).toContain('entry status: untriaged')
  })

  it('requires an explicit actor for confirmed and defaults to unspecified otherwise', async () => {
    const writable = store()
    const written = recordPtyExitIncidentTo(writable, facts(), { hostId: 'host-a', now: NOW })
    const id = written.id as string

    const confirmedWithoutActor = context('incident decide', {
      id,
      to: 'confirmed',
      reason: 'reproduced'
    })
    await expect(INCIDENT_HANDLERS['incident decide'](confirmedWithoutActor.ctx)).rejects.toMatchObject(
      { code: 'invalid_argument' }
    )

    const watch = context('incident decide', { id, to: 'watch', reason: 'watch it' })
    await INCIDENT_HANDLERS['incident decide'](watch.ctx)
    const view = store().getIncident(id)!
    expect(view.decisions[0].actor).toBe('unspecified')

    const confirmed = context('incident decide', {
      id,
      to: 'confirmed',
      actor: 'alice',
      reason: 'reproduced'
    })
    await INCIDENT_HANDLERS['incident decide'](confirmed.ctx)
    expect(store().getIncident(id)!.decisions[1].actor).toBe('alice')
  })

  it('rejects a terminal-state reversal and a missing reason', async () => {
    const writable = store()
    const written = recordPtyExitIncidentTo(writable, facts(), { hostId: 'host-a', now: NOW })
    const id = written.id as string
    const invalid = context('incident decide', { id, to: 'invalid', reason: 'not a bug' })
    await INCIDENT_HANDLERS['incident decide'](invalid.ctx)

    const reopen = context('incident decide', { id, to: 'confirmed', actor: 'a', reason: 'back' })
    await expect(INCIDENT_HANDLERS['incident decide'](reopen.ctx)).rejects.toMatchObject({
      code: 'invalid_argument'
    })
    const noReason = context('incident decide', { id, to: 'watch' })
    await expect(INCIDENT_HANDLERS['incident decide'](noReason.ctx)).rejects.toMatchObject({
      code: 'invalid_argument'
    })
  })
})

describe('incident export (M8-1)', () => {
  function lines(output: string[]): Record<string, unknown>[] {
    return output.map((line) => JSON.parse(line) as Record<string, unknown>)
  }

  it('emits meta, one record per incident and an end record without writing', async () => {
    const writable = store()
    recordPtyExitIncidentTo(writable, facts(), { hostId: 'host-a', now: Date.now() })
    const before = readFileSync(join(userData, 'incidents', 'incidents.db')).length
    const run = context('incident export', { since: '7d' }, true)
    await INCIDENT_HANDLERS['incident export'](run.ctx)
    const records = lines(run.output)
    expect(records[0]).toMatchObject({
      kind: 'meta',
      view: 'incident_triage_rows',
      exportVersion: 1
    })
    expect(records[0].coverage).toMatchObject({ remoteIncidentCapture: 'unsupported' })
    const incident = records.find((record) => record.kind === 'incident')
    expect(incident).toMatchObject({ class: 'crash', effectiveStatus: 'untriaged', runId: null })
    expect(incident?.evidence).toEqual({ pointers: [], unknownBoundaries: expect.any(Array) })
    expect(records.at(-1)).toMatchObject({
      kind: 'end',
      counts: { incident: 1 },
      truncated: { incident: false }
    })
    expect(readFileSync(join(userData, 'incidents', 'incidents.db')).length).toBe(before)
  })

  it('prints the coverage line and a hint instead of a stream without --json', async () => {
    store()
    const run = context('incident export', { since: '24h' })
    await INCIDENT_HANDLERS['incident export'](run.ctx)
    const text = run.output.join('\n')
    expect(text).toContain('Pass --json for the NDJSON stream.')
    expect(text).toContain('Coverage: remote_incident_capture=unsupported')
  })

  it('rejects an unparseable --since and a non-positive --limit', async () => {
    await expect(
      INCIDENT_HANDLERS['incident export'](context('incident export', { since: 'yesterday' }).ctx)
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    await expect(
      INCIDENT_HANDLERS['incident export'](context('incident export', { limit: '0' }).ctx)
    ).rejects.toMatchObject({ code: 'invalid_argument' })
  })

  it('refuses a selector that would answer for another host', async () => {
    await expect(
      INCIDENT_HANDLERS['incident export'](context('incident export', { host: 'other' }).ctx)
    ).rejects.toMatchObject({ code: 'invalid_argument' })
  })
})

describe('incident pane-clocks (M8-2)', () => {
  it('shows the stored fact row without a verdict and without writing an incident', async () => {
    const opened = openIncidentsDatabase(incidentsDatabaseFileFor(userData))
    try {
      samplePaneClocks({
        db: opened.db,
        now: 1_700_000_000_000,
        rows: [
          {
            paneKey: 'tab-1:leaf-1',
            terminalHandle: 'term-1',
            state: 'working',
            stateStartedAt: 1_700_000_000_000 - 46 * 60_000,
            turnStartedAt: null,
            lastSemanticEventAt: 1_700_000_000_000 - 46 * 60_000
          }
        ]
      })
    } finally {
      opened.db.close()
    }

    const shown = context('incident pane-clocks')
    await INCIDENT_HANDLERS['incident pane-clocks'](shown.ctx)
    const text = shown.output.join('\n')
    expect(text).toContain('tab-1:leaf-1')
    expect(text).toContain('working')
    expect(text).toContain('event')
    expect(text).toContain('These are facts, not a verdict')
    expect(text).not.toContain('would write')
    expect(text).not.toContain('wouldWriteIfEnabled')
    expect(store().countIncidents()).toBe(0)
  })

  it('reports an empty sample instead of failing when the store has none yet', async () => {
    const shown = context('incident pane-clocks')
    await INCIDENT_HANDLERS['incident pane-clocks'](shown.ctx)
    expect(shown.output.join('\n')).toContain('No panes sampled')
  })
})

describe('incident tool-failures (M8-3)', () => {
  it('reports an empty fact set instead of failing on a host with no store', async () => {
    const shown = context('incident tool-failures')
    await INCIDENT_HANDLERS['incident tool-failures'](shown.ctx)
    const text = shown.output.join('\n')
    expect(text).toContain('No failed tool calls recorded')
    expect(text).toContain('Coverage: covered=claude,codex')
    expect(text).toContain('Coverage gap: no tool-failure data from')
  })

  it('shows raw facts with the provider fields and no normalized code', async () => {
    const opened = openIncidentsDatabase(incidentsDatabaseFileFor(userData))
    try {
      recordToolFailure(opened.db, {
        sessionId: 'sess-1',
        itemKey: 'item-1',
        ordinal: 0,
        turn: 'turn-1',
        toolName: 'Bash',
        errorKind: 'permission_denied',
        exitCode: null,
        observedAt: Date.now()
      })
    } finally {
      opened.db.close()
    }
    const shown = context('incident tool-failures', {}, true)
    await INCIDENT_HANDLERS['incident tool-failures'](shown.ctx)
    const payload = JSON.parse(shown.output.join('\n')) as {
      rows: { toolName: string; errorKind: string | null; exitCode: number | null }[]
    }
    expect(payload.rows[0]).toMatchObject({
      toolName: 'Bash',
      errorKind: 'permission_denied',
      exitCode: null
    })
    expect(payload.rows[0]).not.toHaveProperty('code')
    expect(store().countIncidents()).toBe(0)
  })

  it('rejects an unparseable --since and a non-positive --limit', async () => {
    await expect(
      INCIDENT_HANDLERS['incident tool-failures'](context('incident tool-failures', { since: 'yesterday' }).ctx)
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    await expect(
      INCIDENT_HANDLERS['incident tool-failures'](context('incident tool-failures', { limit: '0' }).ctx)
    ).rejects.toMatchObject({ code: 'invalid_argument' })
  })
})

describe('incident acceptance (M5)', () => {
  it('declares argv rules idempotently and lists them with the gate state', async () => {
    // C5: a declaration names an existing git worktree root on this host, and cwd must be inside it.
    // The test's own userData directory plays that role.
    const declared = context('incident acceptance declare', {
      dispatch: 'disp_1',
      rule: 'tests',
      cwd: worktreeRoot,
      'worktree-root': worktreeRoot,
      command: `npm${REPEATED} test`,
      'expect-exit': '0',
      actor: 'alice'
    })
    await INCIDENT_HANDLERS['incident acceptance declare'](declared.ctx)
    expect(declared.output.join('\n')).toContain('Declared acceptance rule tests')
    expect(declared.output.join('\n')).toContain('self-reported')

    // Same rule again: still one row.
    const again = context('incident acceptance declare', {
      dispatch: 'disp_1',
      rule: 'tests',
      cwd: worktreeRoot,
      'worktree-root': worktreeRoot,
      command: `npm${REPEATED} test`,
      'expect-exit': '1'
    })
    await INCIDENT_HANDLERS['incident acceptance declare'](again.ctx)

    const listed = context('incident acceptance list', {}, true)
    await INCIDENT_HANDLERS['incident acceptance list'](listed.ctx)
    const payload = JSON.parse(listed.output.join('\n')) as {
      dispatches: { dispatchId: string; rules: unknown[]; gate: { state: string } }[]
    }
    expect(payload.dispatches).toHaveLength(1)
    expect(payload.dispatches[0].rules).toHaveLength(1)
    // No verdict yet: settlement is blocked (fail-closed), visible in the list.
    expect(payload.dispatches[0].gate.state).toBe('blocked')
  })

  it('shows expected vs actual per rule and never the command output', async () => {
    const opened = openIncidentsDatabase(incidentsDatabaseFileFor(userData))
    const rule = declareAcceptanceRule(opened.db, {
      hostId: 'host-a',
      dispatchId: 'disp_2',
      ruleId: 'tests',
      program: 'npm',
      args: ['test'],
      expect: { exitCode: 0 },
      cwd: worktreeRoot,
      worktreeRoot,
      actor: 'alice'
    })
    writeAcceptanceVerdict(opened.db, {
      dispatchId: 'disp_2',
      ruleId: 'tests',
      verdict: 'failed',
      exitCode: 2,
      signal: null,
      stdoutDigest: 'b'.repeat(64),
      stdoutBytes: 42,
      detail: 'exit_code_expected_0_got_2',
      evaluatedAt: 1_700_000_000_000,
      ruleDigest: rule.digest,
      ruleDeclaredAt: rule.createdAt
    })
    const shown = context('incident acceptance show', { dispatch: 'disp_2' })
    await INCIDENT_HANDLERS['incident acceptance show'](shown.ctx)
    const text = shown.output.join('\n')
    expect(text).toContain('exit=0')
    expect(text).toContain('exit=2')
    expect(text).toContain('stdout_sha256=bbbbbbbbbbbb')
    expect(text).toContain('not stored')
    opened.db.close()
    expect(store().countIncidents()).toBe(0)
  })

  it('refuses to resolve without a stop, and requires an actor', async () => {
    const missingStop = context('incident acceptance resolve', {
      dispatch: 'disp_3',
      accept: true,
      actor: 'alice',
      reason: 'ok'
    })
    await expect(
      INCIDENT_HANDLERS['incident acceptance resolve'](missingStop.ctx)
    ).rejects.toMatchObject({ code: 'invalid_argument' })

    const opened = openIncidentsDatabase(incidentsDatabaseFileFor(userData))
    openAcceptanceStop(opened.db, { dispatchId: 'disp_4', incidentId: null, now: Date.now() })
    opened.db.close()

    const noActor = context('incident acceptance resolve', {
      dispatch: 'disp_4',
      accept: true,
      reason: 'ok'
    })
    await expect(INCIDENT_HANDLERS['incident acceptance resolve'](noActor.ctx)).rejects.toMatchObject(
      { code: 'invalid_argument' }
    )

    const resolved = context('incident acceptance resolve', {
      dispatch: 'disp_4',
      reject: true,
      actor: 'alice',
      reason: 'worker must retry'
    })
    await INCIDENT_HANDLERS['incident acceptance resolve'](resolved.ctx)
    expect(resolved.output.join('\n')).toContain('Rejected disp_4')
    expect(resolved.output.join('\n')).toContain('self-reported')
  })
})

describe('incident wait (M3-1)', () => {
  function seedSample(): void {
    const opened = openIncidentsDatabase(incidentsDatabaseFileFor(userData))
    try {
      samplePaneClocks({
        db: opened.db,
        now: 1_700_000_000_000,
        rows: [
          {
            paneKey: 'tab-1:leaf-1',
            terminalHandle: 'term-1',
            state: 'working',
            stateStartedAt: 1_699_999_000_000,
            turnStartedAt: null,
            lastSemanticEventAt: 1_699_999_999_000
          }
        ]
      })
    } finally {
      opened.db.close()
    }
  }

  it('declares a wait bound to the observed epoch, then clears it', async () => {
    seedSample()
    const declared = context('incident wait', {
      terminal: 'term-1',
      reason: 'long training run',
      actor: 'alice'
    })
    await INCIDENT_HANDLERS['incident wait'](declared.ctx)
    expect(declared.output.join('\n')).toContain('Declared wait for tab-1:leaf-1')
    expect(declared.output.join('\n')).toContain('epoch 1699999000000')

    const opened = openIncidentsDatabase(incidentsDatabaseFileFor(userData))
    try {
      const active = listActiveWaits(opened.db, { now: Date.now() })
      expect(active).toHaveLength(1)
      expect(active[0]).toMatchObject({ epoch: '1699999000000', reason: 'long training run' })
    } finally {
      opened.db.close()
    }

    const cleared = context('incident wait', { terminal: 'tab-1:leaf-1', clear: true })
    await INCIDENT_HANDLERS['incident wait'](cleared.ctx)
    expect(cleared.output.join('\n')).toContain('Cleared 1 wait declaration')
  })

  it('refuses to mix --clear with declaration fields (M3-C4)', async () => {
    seedSample()
    const mixed = context('incident wait', {
      terminal: 'term-1',
      clear: true,
      reason: 'still waiting'
    })
    await expect(INCIDENT_HANDLERS['incident wait'](mixed.ctx)).rejects.toMatchObject({
      code: 'invalid_argument'
    })
    const withUntil = context('incident wait', {
      terminal: 'term-1',
      clear: true,
      until: '2030-01-01T00:00:00Z'
    })
    await expect(INCIDENT_HANDLERS['incident wait'](withUntil.ctx)).rejects.toMatchObject({
      code: 'invalid_argument'
    })
  })

  it('refuses an unknown terminal, a missing reason, and a past deadline', async () => {
    seedSample()
    const unknown = context('incident wait', { terminal: 'nope', reason: 'r' })
    await expect(INCIDENT_HANDLERS['incident wait'](unknown.ctx)).rejects.toMatchObject({
      code: 'invalid_argument'
    })
    const noReason = context('incident wait', { terminal: 'term-1' })
    await expect(INCIDENT_HANDLERS['incident wait'](noReason.ctx)).rejects.toMatchObject({
      code: 'invalid_argument'
    })
    const past = context('incident wait', {
      terminal: 'term-1',
      reason: 'r',
      until: '2001-01-01T00:00:00Z'
    })
    await expect(INCIDENT_HANDLERS['incident wait'](past.ctx)).rejects.toMatchObject({
      code: 'invalid_argument'
    })
  })
})

describe('incident prune', () => {
  it('does not touch a freshly watched incident in a dry run, and deletes only old triaged rows on apply', async () => {
    const writable = store()
    const live = recordPtyExitIncidentTo(writable, facts(), { hostId: 'host-a', now: NOW })
    const liveId = live.id as string
    const decided = context('incident decide', { id: liveId, to: 'watch', reason: 'not yet' })
    await INCIDENT_HANDLERS['incident decide'](decided.ctx)

    // An old, triaged-away row: the only thing prune is ever allowed to remove.
    const oldInvalid = writable.insertIncident({
      id: 'inc_old_invalid',
      sourceKind: 'pty_exit',
      sourceId: 'ptyinc-old',
      facet: 'exit',
      hostId: 'host-a',
      worktreeId: null,
      runId: null,
      taskId: null,
      dispatchId: null,
      agentSessionId: null,
      ptyIncarnationId: 'ptyinc-old',
      class: 'crash',
      status: 'untriaged',
      exitCause: { kind: 'signaled', signal: 15 },
      fingerprint: 'f'.repeat(64),
      evidence: { pointers: [], unknownBoundaries: [] },
      summary: 'old crash',
      createdAt: NOW - 200 * DAY
    })
    expect(oldInvalid.outcome).toBe('inserted')
    writable.appendDecision({ incidentId: 'inc_old_invalid', toStatus: 'invalid', actor: 'a', reason: 'r' })

    const dry = context('incident prune', { 'dry-run': true }, true)
    await INCIDENT_HANDLERS['incident prune'](dry.ctx)
    const dryResult = JSON.parse(dry.output.join('\n')) as {
      candidates: number
      deleted: number
      candidateIds: string[]
      deletedIds: string[]
      candidateIdsTruncated: boolean
    }
    expect(dryResult).toMatchObject({
      candidates: 1,
      deleted: 0,
      candidateIds: ['inc_old_invalid'],
      deletedIds: [],
      candidateIdsTruncated: false
    })
    expect(store().countIncidents()).toBe(2)

    const text = context('incident prune', { 'dry-run': true })
    await INCIDENT_HANDLERS['incident prune'](text.ctx)
    expect(text.output.join('\n')).toContain('Nothing was deleted')

    const apply = context('incident prune', { apply: true }, true)
    await INCIDENT_HANDLERS['incident prune'](apply.ctx)
    const applyResult = JSON.parse(apply.output.join('\n')) as {
      deleted: number
      deletedIds: string[]
      deletedIdsTruncated: boolean
    }
    expect(applyResult).toMatchObject({
      deleted: 1,
      deletedIds: ['inc_old_invalid'],
      deletedIdsTruncated: false
    })
    const after = store()
    expect(after.countIncidents()).toBe(1)
    expect(after.getIncident(liveId)).not.toBeNull()
    expect(after.getIncident('inc_old_invalid')).toBeNull()
  })

  it('refuses --dry-run together with --apply', async () => {
    const { ctx } = context('incident prune', { 'dry-run': true, apply: true })
    await expect(INCIDENT_HANDLERS['incident prune'](ctx)).rejects.toMatchObject({
      code: 'invalid_argument'
    })
  })
})

describe('incident report', () => {
  it('creates the store on the first report and records an untriaged row', async () => {
    expect(existsSync(incidentsDatabaseFileFor(userData))).toBe(false)
    const reported = context('incident report', {
      class: 'tool_error',
      code: 'tool_schema_mismatch',
      summary: 'write tool rejected a valid patch'
    })
    await INCIDENT_HANDLERS['incident report'](reported.ctx)
    const text = reported.output.join('\n')
    expect(text).toContain('Reported:')
    expect(text).toContain('status=untriaged')
    expect(text).toContain('not independently verified')

    const listed = context('incident list')
    await INCIDENT_HANDLERS['incident list'](listed.ctx)
    const listText = listed.output.join('\n')
    expect(listText).toContain('tool_error')
    expect(listText).toContain('untriaged')
    expect(listText).toContain('tool_schema_mismatch')
    // The shadow hint is written for the CLI path too, so a crash between here and the next start
    // does not lose the report.
    expect(existsSync(join(userData, 'incidents', 'shadow.ndjson'))).toBe(true)
  })

  it('requires --class and --code', async () => {
    const noClass = context('incident report', { code: 'x' })
    await expect(INCIDENT_HANDLERS['incident report'](noClass.ctx)).rejects.toMatchObject({
      code: 'invalid_argument'
    })
    const noCode = context('incident report', { class: 'crash' })
    await expect(INCIDENT_HANDLERS['incident report'](noCode.ctx)).rejects.toMatchObject({
      code: 'invalid_argument'
    })
  })

  it('refuses an evidence path that does not exist, before creating anything', async () => {
    const reported = context('incident report', {
      class: 'crash',
      code: 'worker_died',
      evidence: join(userData, 'missing.log')
    })
    await expect(INCIDENT_HANDLERS['incident report'](reported.ctx)).rejects.toMatchObject({
      code: 'invalid_argument'
    })
    expect(existsSync(join(userData, 'incidents'))).toBe(false)
  })

  it('refuses an oversized evidence file with a typed message (M2-C5)', async () => {
    const evidencePath = join(userData, 'huge.log')
    writeFileSync(evidencePath, '')
    truncateSync(evidencePath, 64 * 1024 * 1024 + 1)
    const reported = context('incident report', {
      class: 'crash',
      code: 'worker_died',
      evidence: evidencePath
    })
    await expect(INCIDENT_HANDLERS['incident report'](reported.ctx)).rejects.toMatchObject({
      code: 'invalid_argument'
    })
    expect(existsSync(incidentsDatabaseFileFor(userData))).toBe(false)
  })

  it('says a same-key report does not overwrite the existing record (M2-C5)', async () => {
    const flags = { class: 'crash', code: 'worker_died', 'source-id': 'req-dup' }
    const first = context('incident report', { ...flags, summary: 'first text' })
    await INCIDENT_HANDLERS['incident report'](first.ctx)
    const second = context('incident report', { ...flags, summary: 'second text' })
    await INCIDENT_HANDLERS['incident report'](second.ctx)
    const text = second.output.join('\n')
    expect(text).toContain('Already recorded')
    expect(text).toContain('NOT overwritten')
    // The stored summary is still the first one.
    expect(store().listIncidents().incidents[0].summary).toContain('first text')
  })

  it('redacts a secret in --repro before it reaches the row (M2-C2)', async () => {
    const reported = context('incident report', {
      class: 'tool_error',
      code: 'leaky',
      repro: 'run with sk-ant-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH',
      'source-id': 'req-repro'
    })
    await INCIDENT_HANDLERS['incident report'](reported.ctx)
    const view = store().getIncident(store().listIncidents().incidents[0].id)!
    expect(JSON.stringify(view)).not.toContain('sk-ant-abcdefghijklmnopqrstuvwxyz')
    expect(existsSync(join(userData, 'incidents', 'shadow.ndjson'))).toBe(true)
  })

  it('stores an evidence POINTER for a real file and never the body', async () => {
    const evidencePath = join(userData, 'agent.log')
    writeFileSync(evidencePath, 'line one\nline two\n')

    const reported = context('incident report', {
      class: 'crash',
      code: 'worker_died',
      evidence: evidencePath,
      'source-id': 'req-evidence'
    })
    await INCIDENT_HANDLERS['incident report'](reported.ctx)

    const view = store().getIncident(store().listIncidents().incidents[0].id)!
    // The digest and byte count are pinned by incident-report.test.ts; what the CLI adds is that
    // `--evidence` wiring produces a POINTER and the file body never reaches the row or the shadow.
    expect(view.evidence.pointers).toHaveLength(1)
    expect(view.evidence.pointers[0]?.path).toBe(evidencePath)
    expect(readFileSync(join(userData, 'incidents', 'shadow.ndjson'), 'utf8')).not.toContain(
      'line one'
    )
  })
})

/**
 * The M1 human loop, end to end at the process boundary: a crash row that the runtime wrote is
 * visible to `list`, triageable with `decide`, and untouched by `prune --dry-run` (§12, §13 M1).
 *
 * The store is a real SQLite file in a temp user-data directory and the handlers are the real ones,
 * so this covers path resolution + store + formatter together rather than mocking the middle.
 */
import { createHash } from 'node:crypto'
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
import { sampleStallState } from '../../main/incidents/incidents-stall-sampler'
import { listActiveWaits } from '../../main/incidents/incident-wait'
import type { PtyExitIncidentFacts } from '../../main/incidents/incident-pty-exit'
import { INCIDENT_HANDLERS } from './incident'

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_700_000_000_000

let userData: string
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

describe('incident stalls (M3-3)', () => {
  it('shows the last sample without writing anything', async () => {
    const writable = store()
    const opened = openIncidentsDatabase(incidentsDatabaseFileFor(userData))
    try {
      sampleStallState({
        db: opened.db,
        store: writable,
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
        ],
        writeEnabled: false,
        userDataPath: userData
      })
    } finally {
      opened.db.close()
    }

    const shown = context('incident stalls')
    await INCIDENT_HANDLERS['incident stalls'](shown.ctx)
    const text = shown.output.join('\n')
    expect(text).toContain('tab-1:leaf-1')
    expect(text).toContain('working')
    expect(text).toContain('insufficient_cycles')
    expect(text).toContain('event')
    expect(text).toContain('wouldWriteIfEnabled=yes means')
    expect(text).toContain('Writing incidents: off')
    expect(store().countIncidents()).toBe(0)
  })

  it('reports an empty sample instead of failing when the store has none yet', async () => {
    const shown = context('incident stalls')
    await INCIDENT_HANDLERS['incident stalls'](shown.ctx)
    expect(shown.output.join('\n')).toContain('No panes sampled')
  })
})

describe('incident wait (M3-1)', () => {
  function seedSample(): void {
    const opened = openIncidentsDatabase(incidentsDatabaseFileFor(userData))
    try {
      sampleStallState({
        db: opened.db,
        store: store(),
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
        ],
        writeEnabled: false,
        userDataPath: userData
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

  it('is idempotent for a repeated --source-id', async () => {
    const flags = { class: 'crash', code: 'worker_died', 'source-id': 'req-pinned' }
    const first = context('incident report', flags, true)
    await INCIDENT_HANDLERS['incident report'](first.ctx)
    const firstPayload = JSON.parse(first.output.join('\n')) as { incidentId: string; outcome: string }
    expect(firstPayload.outcome).toBe('inserted')

    const second = context('incident report', flags, true)
    await INCIDENT_HANDLERS['incident report'](second.ctx)
    const secondPayload = JSON.parse(second.output.join('\n')) as {
      incidentId: string
      outcome: string
    }
    expect(secondPayload.outcome).toBe('duplicate')
    expect(secondPayload.incidentId).toBe(firstPayload.incidentId)
    expect(store().countIncidents()).toBe(1)
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

  it('stores a verified pointer (digest + size) for a real evidence file', async () => {
    const evidencePath = join(userData, 'agent.log')
    writeFileSync(evidencePath, 'line one\nline two\n')
    const digest = createHash('sha256').update('line one\nline two\n').digest('hex')

    const reported = context('incident report', {
      class: 'crash',
      code: 'worker_died',
      evidence: evidencePath,
      'source-id': 'req-evidence'
    })
    await INCIDENT_HANDLERS['incident report'](reported.ctx)

    const view = store().getIncident(store().listIncidents().incidents[0].id)!
    expect(view.evidence.pointers).toHaveLength(1)
    expect(view.evidence.pointers[0]).toMatchObject({ path: evidencePath, sha256: digest, bytes: 18 })
    // Pointers only: the file body is not copied into the row or the shadow.
    expect(readFileSync(join(userData, 'incidents', 'shadow.ndjson'), 'utf8')).not.toContain(
      'line one'
    )
  })
})

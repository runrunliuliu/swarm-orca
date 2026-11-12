/**
 * The M1 human loop, end to end at the process boundary: a crash row that the runtime wrote is
 * visible to `list`, triageable with `decide`, and untouched by `prune --dry-run` (§12, §13 M1).
 *
 * The store is a real SQLite file in a temp user-data directory and the handlers are the real ones,
 * so this covers path resolution + store + formatter together rather than mocking the middle.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommandHandler, HandlerContext } from '../dispatch'
import { RuntimeClientError } from '../runtime/types'
import { openIncidentsDatabase, type OpenIncidentsDatabase } from '../../main/incidents/incidents-database'
import { createIncidentStore, type IncidentStore } from '../../main/incidents/incident-store'
import { incidentsDatabaseFileFor } from '../../main/incidents/incidents-paths'
import { recordPtyExitIncidentTo } from '../../main/incidents/incident-writer'
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
    expect(text).toContain('store_capacity_limited=false')
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
      coverage: { remoteIncidentCapture: string; storeCapacityLimited: boolean }
    }
    expect(parsed.total).toBe(1)
    expect(parsed.coverage.remoteIncidentCapture).toBe('unsupported')
    expect(parsed.coverage.storeCapacityLimited).toBe(false)
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

    const dry = context('incident prune', { 'dry-run': true })
    await INCIDENT_HANDLERS['incident prune'](dry.ctx)
    expect(dry.output.join('\n')).toContain('Nothing was deleted')
    expect(store().countIncidents()).toBe(2)

    const apply = context('incident prune', { apply: true })
    await INCIDENT_HANDLERS['incident prune'](apply.ctx)
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

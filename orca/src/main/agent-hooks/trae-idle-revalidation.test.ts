import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener/listener-event'
import { AgentHookServer } from './server'
import { PANE } from './server.test-fixtures'
import { sanitizeHydratedEntry } from './server/server-persistence-validation'
import {
  matchesTraeIdleRevalidation,
  type TraeIdleRevalidationRequest
} from './trae-idle-revalidation'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn(() => ({})) }))
afterEach(() => vi.restoreAllMocks())

class RevalidationServer extends AgentHookServer {
  seed(overrides: Partial<AgentHookEventPayload> = {}) {
    return this.applyNormalizedStatus({
      paneKey: PANE,
      connectionId: null,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      launchToken: 'launch',
      source: 'trae',
      hookEventName: 'Stop',
      payload: { agentType: 'trae', state: 'done', prompt: '' },
      providerSession: { key: 'session_id', id: 'session', transcriptPath: '/rollout.jsonl' },
      ...overrides
    })!
  }
  serialized() {
    return this.serializeStatusFile()
  }
}

function harness() {
  const server = new RevalidationServer()
  const row = server.seed()
  const request: TraeIdleRevalidationRequest = {
    expected: server.getStatusSnapshot()[0]!,
    proof: { hookObservedAt: row.evidenceObservedAt!, inputSequence: 1, processIncarnation: 'inc' }
  }
  const publish = () =>
    server.ingestTerminalStatus({
      paneKey: PANE,
      connectionId: null,
      origin: 'process',
      payload: { agentType: 'trae', state: 'done', prompt: '' },
      traeIdleRevalidation: request
    })
  return { server, row, request, publish }
}

describe('canonical Trae idle revalidation CAS', () => {
  it('refreshes evidence without a new turn and excludes runtime proof from disk and hydration', () => {
    const { server, request, publish } = harness()
    const listener = vi.fn()
    server.setListener(listener)
    listener.mockClear()
    publish()
    const accepted = server.getStatusSnapshot()[0]!
    expect(accepted.traeIdleRevalidation).toEqual(request.proof)
    expect(accepted.stateStartedAt).toBe(request.expected.stateStartedAt)
    expect(accepted.turnStartedAt).toBe(request.expected.turnStartedAt)
    expect(accepted.observation).toMatchObject({ origin: 'process', kind: 'snapshot' })
    expect(accepted.observation?.boundary).toBeUndefined()
    expect(listener).toHaveBeenCalledOnce()
    expect(server.serialized()).not.toContain('traeIdleRevalidation')
    const hydrated = sanitizeHydratedEntry(PANE, {
      ...server.seed(),
      traeIdleRevalidation: request.proof
    })
    expect(hydrated).not.toBeNull()
    expect(hydrated?.traeIdleRevalidation).toBeUndefined()
  })

  it('rejects a superseded revision even when every timestamp is unchanged', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000)
    const { server, request, publish } = harness()
    server.seed()
    expect(server.getStatusSnapshot()[0]?.receivedAt).toBe(request.expected.receivedAt)
    publish()
    expect(server.getStatusSnapshot()[0]?.traeIdleRevalidation).toBeUndefined()
  })

  it('revalidates a restart-hydrated Stop row using the launch hash carried by snapshot', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-trae-revalidation-'))
    try {
      const first = new RevalidationServer()
      await first.start({ env: 'production', userDataPath })
      const original = first.seed()
      const launchToken = original.launchToken!
      const launchTokenHash = createHash('sha256').update(launchToken.trim()).digest('hex')
      first.flushStatusPersistSync()
      first.stop()

      const restarted = new RevalidationServer()
      await restarted.start({ env: 'production', userDataPath })
      try {
        const expected = restarted.getStatusSnapshotForPane(PANE)[0]!
        expect(expected.launchToken).toBeUndefined()
        expect(expected.launchTokenHash).toBe(launchTokenHash)
        expect(expected.observation).toBeUndefined()

        const internalRow = restarted._getStateForTests().lastStatusByPaneKey.get(PANE)!
        expect(internalRow.launchToken).toBeUndefined()
        expect(Reflect.get(internalRow, 'launchTokenHash')).toBeUndefined()

        const request: TraeIdleRevalidationRequest = {
          expected,
          proof: {
            hookObservedAt: expected.evidenceObservedAt ?? expected.receivedAt,
            inputSequence: 1,
            processIncarnation: 'inc'
          }
        }
        // The raw hydrated row intentionally has no bearer and no public hash. The server must bridge
        // its private hydrated commitment into the revalidation matcher instead of tests forging one.
        expect(matchesTraeIdleRevalidation(internalRow, request)).toBe(false)

        restarted.ingestTerminalStatus({
          paneKey: PANE,
          connectionId: null,
          origin: 'process',
          payload: { agentType: 'trae', state: 'done', prompt: '' },
          traeIdleRevalidation: request
        })

        const accepted = restarted.getStatusSnapshotForPane(PANE)[0]!
        expect(accepted.traeIdleRevalidation).toEqual(request.proof)
        expect(accepted.launchToken).toBeUndefined()
        expect(accepted.launchTokenHash).toBe(launchTokenHash)
      } finally {
        restarted.stop()
      }
    } finally {
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })

  it('does not revive a retired pane', () => {
    const { server, publish } = harness()
    server.retirePaneAuthority(PANE)
    publish()
    expect(server.getStatusSnapshot().some((row) => row.traeIdleRevalidation)).toBe(false)
  })

  it.each([
    'launch',
    'session',
    'path',
    'host',
    'pane',
    'workspace',
    'time',
    'revision',
    'authority',
    'restored',
    'identity-only',
    'sequence',
    'incarnation',
    'hook-time'
  ])('rejects mismatched %s', (kind) => {
    const { row, request } = harness()
    const expected = request.expected
    if (kind === 'launch') {
      expected.launchToken = 'other'
    }
    if (kind === 'session') {
      expected.providerSession = { ...expected.providerSession!, id: 'other' }
    }
    if (kind === 'path') {
      expected.providerSession = { ...expected.providerSession!, transcriptPath: '/other' }
    }
    if (kind === 'host') {
      expected.connectionId = 'remote'
    }
    if (kind === 'pane') {
      expected.paneKey = 'other'
    }
    if (kind === 'workspace') {
      expected.worktreeId = 'other'
    }
    if (kind === 'time') {
      expected.receivedAt++
    }
    if (kind === 'revision') {
      expected.observation = { ...expected.observation!, revision: 999 }
    }
    if (kind === 'authority') {
      expected.observation = { ...expected.observation!, authorityId: 'other' }
    }
    if (kind === 'restored') {
      expected.restoredUnconfirmed = true
    }
    if (kind === 'identity-only') {
      expected.providerSessionOnly = true
    }
    if (kind === 'sequence') {
      request.proof.inputSequence = -1
    }
    if (kind === 'incarnation') {
      request.proof.processIncarnation = ''
    }
    if (kind === 'hook-time') {
      request.proof.hookObservedAt--
    }
    expect(matchesTraeIdleRevalidation(row, request)).toBe(false)
  })

  it.each(['remote', 'replay', 'child', 'working', 'restored', 'identity-only'])(
    'rejects an ineligible %s row',
    (kind) => {
      const { row: original, request } = harness()
      const row = { ...original, payload: { ...original.payload } }
      if (kind === 'remote') {
        row.connectionId = request.expected.connectionId = 'ssh'
      }
      if (kind === 'replay') {
        row.isReplay = true
      }
      if (kind === 'child') {
        row.toolAgentId = 'child'
      }
      if (kind === 'working') {
        row.payload.state = 'working'
      }
      if (kind === 'restored') {
        row.restoredUnconfirmed = true
      }
      if (kind === 'identity-only') {
        row.providerSessionOnly = true
      }
      expect(matchesTraeIdleRevalidation(row, request)).toBe(false)
    }
  )
})

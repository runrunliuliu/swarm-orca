import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHookServer, _internals } from './server'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'
import { selectExactWorkerProviderSession } from '../runtime/orchestration/worker-provider-session'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))

class IsolatedTraeHookServer extends AgentHookServer {
  constructor() {
    super()
    this._setOpenCodeBinderDepsForTests({
      dbPath: () => '/unused-opencode-test.db',
      listSessions: () => [],
      listPanes: () => [],
      sweep: async () => []
    })
  }
}

describe('Trae HTTP accounting authority', () => {
  let userDataPath: string
  let server: AgentHookServer
  const launchToken = 'trae-test-launch-bearer'
  const providerSession = {
    key: 'session_id',
    id: 'thread-1',
    transcriptPath: '/sessions/thread-1.jsonl'
  }

  beforeEach(async () => {
    _internals.resetCachesForTests()
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-trae-accounting-'))
    server = new IsolatedTraeHookServer()
    await server.start({ env: 'production', userDataPath })
  })

  afterEach(() => {
    server.stop()
    rmSync(userDataPath, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  function select(token = launchToken) {
    return selectExactWorkerProviderSession({
      paneKey: PANE,
      processIncarnation: 'runtime:worker:1',
      connectionId: null,
      launchToken: token,
      observedAfter: 0,
      statuses: server.getStatusSnapshot()
    })
  }

  it('persists the same launch commitment and session returned by the exact selector', async () => {
    for (const hook_event_name of ['SessionStart', 'UserPromptSubmit', 'Stop']) {
      const response = await postHookEvent(
        server,
        buildBody(
          {
            hook_event_name,
            source: 'startup',
            session_id: providerSession.id,
            transcript_path: providerSession.transcriptPath,
            prompt: 'synthetic accounting check'
          },
          { launchToken }
        ),
        '/hook/trae'
      )
      expect(response.status).toBe(204)
      const exact = select()
      expect(exact).toMatchObject({ agent: 'trae', providerSession })
      server.flushStatusPersistSync()
      const persisted = readFileSync(join(userDataPath, 'agent-hooks', 'last-status.json'), 'utf8')
      const row = JSON.parse(persisted).entries[PANE]
      expect(row).toMatchObject({
        source: 'trae',
        connectionId: null,
        payload: { agentType: 'trae' },
        launchTokenHash: createHash('sha256').update(launchToken).digest('hex'),
        providerSession,
        evidenceObservedAt: expect.any(Number),
        receivedAt: exact?.observedAt
      })
      expect(exact?.launchTokenHash).toBe(row.launchTokenHash)
      expect(persisted).not.toContain(launchToken)
      expect(exact).not.toHaveProperty('launchToken')
      expect(select('different-launch')).toBeNull()
    }
  })

  it('does not create parent accounting authority from a child hook', async () => {
    const response = await postHookEvent(
      server,
      buildBody(
        {
          hook_event_name: 'SessionStart',
          source: 'startup',
          agent_id: 'child-1',
          session_id: providerSession.id,
          transcript_path: providerSession.transcriptPath
        },
        { launchToken }
      ),
      '/hook/trae'
    )
    expect(response.status).toBe(204)
    expect(select()).toBeNull()
    expect(server.getStatusSnapshot()).toEqual([])
  })
})

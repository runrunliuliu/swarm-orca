import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import type { AgentStatusIpcPayload } from '../../../shared/agent-status-types'
import { selectExactWorkerProviderSession } from './worker-provider-session'

type StatusRow = AgentStatusIpcPayload & { launchTokenHash?: string }

function launchHash(token: string): string {
  return createHash('sha256').update(token.trim()).digest('hex')
}

function status(
  paneKey: string,
  sessionId: string,
  overrides: Partial<StatusRow> = {}
): StatusRow {
  return {
    paneKey,
    connectionId: null,
    receivedAt: 200,
    stateStartedAt: 190,
    state: 'working',
    prompt: '',
    agentType: 'codex',
    providerSession: { key: 'session_id', id: sessionId },
    ...overrides
  }
}

describe('exact worker provider session selection', () => {
  it('preserves the Trae transcript only for the matching launch', () => {
    const selected = selectExactWorkerProviderSession({
      paneKey: 'tab:worker',
      processIncarnation: 'pty:trae',
      connectionId: null,
      launchToken: 'trae-launch',
      observedAfter: 150,
      statuses: [
        status('tab:worker', 'thread-1', {
          agentType: 'trae',
          launchToken: 'trae-launch',
          providerSession: {
            key: 'session_id',
            id: 'thread-1',
            transcriptPath: '/sessions/thread-1.jsonl'
          }
        })
      ]
    })
    expect(selected).toMatchObject({
      agent: 'trae',
      launchTokenHash: launchHash('trae-launch'),
      processIncarnation: 'pty:trae',
      providerSession: { id: 'thread-1', transcriptPath: '/sessions/thread-1.jsonl' }
    })
    expect(selected).not.toHaveProperty('launchToken')
  })

  it('accepts a restart-hydrated Trae row by its persisted launch hash', () => {
    const row = status('tab:worker', 'thread-1', {
      agentType: 'trae',
      launchTokenHash: launchHash('trae-launch'),
      providerSession: {
        key: 'session_id',
        id: 'thread-1',
        transcriptPath: '/sessions/thread-1.jsonl'
      }
    })
    delete row.launchToken
    const selected = selectExactWorkerProviderSession({
      paneKey: 'tab:worker',
      processIncarnation: 'pty:trae',
      connectionId: null,
      launchToken: null,
      launchTokenHash: launchHash('trae-launch'),
      observedAfter: 150,
      statuses: [row]
    })
    expect(selected).toMatchObject({
      agent: 'trae',
      launchTokenHash: launchHash('trae-launch'),
      providerSession: { id: 'thread-1' }
    })
    expect(selected).not.toHaveProperty('launchToken')
  })

  it('rejects a restart-hydrated Trae row when the restored PTY has no matching hash proof', () => {
    const row = status('tab:worker', 'thread-1', {
      agentType: 'trae',
      launchTokenHash: launchHash('trae-launch'),
      providerSession: {
        key: 'session_id',
        id: 'thread-1',
        transcriptPath: '/sessions/thread-1.jsonl'
      }
    })
    delete row.launchToken

    expect(
      selectExactWorkerProviderSession({
        paneKey: 'tab:worker',
        processIncarnation: 'pty:trae',
        connectionId: null,
        launchToken: null,
        observedAfter: 150,
        statuses: [row]
      })
    ).toBeNull()
  })

  it('selects only the current pane, connection, and observation window', () => {
    const selected = selectExactWorkerProviderSession({
      paneKey: 'tab:worker',
      processIncarnation: 'pty:incarnation',
      connectionId: 'ssh-windows',
      launchToken: undefined,
      observedAfter: 150,
      statuses: [
        status('tab:sibling', 'sibling', { connectionId: 'ssh-windows', receivedAt: 300 }),
        status('tab:worker', 'old', { connectionId: 'ssh-windows', receivedAt: 100 }),
        status('tab:worker', 'wrong-host', { connectionId: 'ssh-mac', receivedAt: 400 }),
        status('tab:worker', 'exact', { connectionId: 'ssh-windows', receivedAt: 250 })
      ]
    })

    expect(selected).toEqual({
      paneKey: 'tab:worker',
      processIncarnation: 'pty:incarnation',
      connectionId: 'ssh-windows',
      agent: 'codex',
      providerSession: { key: 'session_id', id: 'exact' },
      observedAt: 250
    })
  })

  it.each([
    { launchToken: undefined, connectionId: null },
    { launchToken: null, connectionId: null },
    { launchToken: '', connectionId: null },
    { launchToken: ' ', connectionId: null },
    { launchToken: 'launch', connectionId: undefined },
    { launchToken: 'other-launch', connectionId: null },
    { launchToken: 'other-launch', connectionId: null, hashOnly: true }
  ])('rejects Trae attribution without matching launch and host metadata: %j', (metadata) => {
    const row = status('tab:worker', 'thread-1', {
      agentType: 'trae',
      launchToken: 'launch',
      ...(metadata.hashOnly ? { launchTokenHash: launchHash('launch') } : {})
    })
    if (metadata.hashOnly) {
      delete row.launchToken
    }
    expect(
      selectExactWorkerProviderSession({
        paneKey: 'tab:worker',
        processIncarnation: 'pty:trae',
        observedAfter: 150,
        ...metadata,
        statuses: [row]
      })
    ).toBeNull()
  })

  it('rejects stale and provider-session-only rows', () => {
    expect(
      selectExactWorkerProviderSession({
        paneKey: 'tab:worker',
        processIncarnation: 'pty:incarnation',
        connectionId: null,
        launchToken: undefined,
        observedAfter: 300,
        statuses: [
          status('tab:worker', 'stale', { receivedAt: 200 }),
          status('tab:worker', 'identity-only', {
            receivedAt: 400,
            providerSessionOnly: true
          })
        ]
      })
    ).toBeNull()
  })

  it('rejects a prior process snapshot when the launch token changed', () => {
    expect(
      selectExactWorkerProviderSession({
        paneKey: 'tab:worker',
        processIncarnation: 'pty:new-incarnation',
        connectionId: null,
        launchToken: 'launch-new',
        observedAfter: 0,
        statuses: [status('tab:worker', 'prior', { launchToken: 'launch-old' })]
      })
    ).toBeNull()
  })

  it('accepts the matching WSL relay provenance for a local PTY', () => {
    const selected = selectExactWorkerProviderSession({
      paneKey: 'tab:worker',
      processIncarnation: 'pty:wsl-incarnation',
      connectionId: null,
      wslDistro: 'Ubuntu',
      launchToken: undefined,
      observedAfter: 150,
      statuses: [
        status('tab:worker', 'wsl-session', {
          connectionId: 'wsl:Ubuntu',
          receivedAt: 250,
          providerSession: {
            key: 'session_id',
            id: 'wsl-session',
            transcriptPath: '/home/ada/.codex/sessions/rollout-wsl.jsonl'
          }
        })
      ]
    })

    expect(selected).toMatchObject({
      paneKey: 'tab:worker',
      processIncarnation: 'pty:wsl-incarnation',
      connectionId: 'wsl:Ubuntu',
      wslDistro: 'Ubuntu',
      providerSession: { id: 'wsl-session' }
    })
    expect(Object.keys(selected ?? {})).toContain('connectionId')
    expect(JSON.stringify(selected)).toContain('wsl:Ubuntu')
  })

  it('rejects WSL relay provenance for a different local distro', () => {
    expect(
      selectExactWorkerProviderSession({
        paneKey: 'tab:worker',
        processIncarnation: 'pty:wsl-incarnation',
        connectionId: null,
        wslDistro: 'Ubuntu',
        launchToken: undefined,
        observedAfter: 150,
        statuses: [status('tab:worker', 'wrong-distro', { connectionId: 'wsl:Debian' })]
      })
    ).toBeNull()
  })
})

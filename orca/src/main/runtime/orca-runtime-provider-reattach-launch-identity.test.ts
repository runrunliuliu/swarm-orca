import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../shared/stable-pane-id'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type { RestoredOrchestrationAuthorityReceipt } from './runtime-terminal-contracts'
import { OrcaRuntimeService } from './orca-runtime'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp'), isPackaged: false },
  BrowserWindow: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn(() => null) }
}))

const TAB_ID = '11111111-1111-4111-8111-111111111111'
const LEAF_ID = '22222222-2222-4222-8222-222222222222'
const PANE_KEY = makePaneKey(TAB_ID, LEAF_ID)
const INCARNATION_ID = 'provider-reattach-incarnation'
const WORKTREE_ID = 'repo-1::/tmp/provider-reattach'
const TERMINAL_HANDLE = 'term_provider_reattach'
const LAUNCH_TOKEN = 'provider-reattach-launch-token'

function launchHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function restoredTraeRow(launchTokenHash: string): AgentStatusIpcPayload {
  return {
    paneKey: PANE_KEY,
    agentType: 'trae',
    state: 'done',
    prompt: '',
    launchTokenHash,
    connectionId: null,
    receivedAt: 1_800_000_000_000,
    stateStartedAt: 1_800_000_000_000
  }
}

function restoredAuthorityRuntime(rows: () => AgentStatusIpcPayload[]): OrcaRuntimeService {
  return new OrcaRuntimeService(null, undefined, {
    getAgentStatusSnapshot: rows,
    attestAgentHookCompatibilityAuthority: ({ paneKey, launchTokenHash }) =>
      paneKey === PANE_KEY && rows().some((row) => row.launchTokenHash === launchTokenHash)
        ? { paneKey, source: 'current_hook' }
        : null
  })
}

function registerTraeReattach(runtime: OrcaRuntimeService, ptyId: string): void {
  runtime.registerPty(ptyId, WORKTREE_ID, null, {
    tabId: TAB_ID,
    leafId: LEAF_ID,
    incarnationId: INCARNATION_ID,
    providerReattachLaunchIdentity: {
      incarnationId: INCARNATION_ID,
      launchAgent: 'trae'
    }
  })
}

type RuntimePtyLaunchIdentity = {
  incarnationId: string | null
  paneKey: string | null
  launchAgent: string | null
  launchToken: string | null
  launchIncarnationId: string | null
}

function getPty(runtime: OrcaRuntimeService, ptyId: string): RuntimePtyLaunchIdentity | undefined {
  return (runtime as unknown as { ptysById: Map<string, RuntimePtyLaunchIdentity> }).ptysById.get(
    ptyId
  )
}

function getRestoredReceipt(
  runtime: OrcaRuntimeService,
  ptyId: string
): RestoredOrchestrationAuthorityReceipt | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This test inspects the runtime's protected receipt map to verify production reattach state, not to seed it.
  return (runtime as unknown as {
    restoredOrchestrationAuthorityByPtyId: Map<string, RestoredOrchestrationAuthorityReceipt>
  }).restoredOrchestrationAuthorityByPtyId.get(ptyId)
}

describe('provider reattach launch identity', () => {
  it('restores daemon-owned agent identity without minting renderer authority', () => {
    const runtime = new OrcaRuntimeService(null)

    runtime.registerPty('pty-reattach', WORKTREE_ID, null, {
      tabId: TAB_ID,
      leafId: LEAF_ID,
      incarnationId: INCARNATION_ID,
      providerReattachLaunchIdentity: {
        incarnationId: INCARNATION_ID,
        launchAgent: 'codex'
      }
    })

    expect(getPty(runtime, 'pty-reattach')).toMatchObject({
      incarnationId: INCARNATION_ID,
      paneKey: PANE_KEY,
      launchAgent: 'codex',
      launchToken: null,
      launchIncarnationId: null
    })
    expect(getRestoredReceipt(runtime, 'pty-reattach')).toBeUndefined()
  })

  it('rejects provider identity from a different process incarnation', () => {
    const runtime = new OrcaRuntimeService(null)

    runtime.registerPty('pty-mismatched-reattach', WORKTREE_ID, null, {
      tabId: TAB_ID,
      leafId: LEAF_ID,
      incarnationId: INCARNATION_ID,
      providerReattachLaunchIdentity: {
        incarnationId: 'stale-provider-incarnation',
        launchAgent: 'codex'
      }
    })

    expect(getPty(runtime, 'pty-mismatched-reattach')).toMatchObject({
      incarnationId: INCARNATION_ID,
      paneKey: PANE_KEY,
      launchAgent: null,
      launchToken: null,
      launchIncarnationId: null
    })
  })

  it('retires daemon launch identity when the agent command finishes', () => {
    const runtime = new OrcaRuntimeService(null)

    runtime.registerPty('pty-finished-reattach', WORKTREE_ID, null, {
      tabId: TAB_ID,
      leafId: LEAF_ID,
      incarnationId: INCARNATION_ID,
      providerReattachLaunchIdentity: {
        incarnationId: INCARNATION_ID,
        launchAgent: 'codex'
      }
    })
    runtime.emitDaemonPtyTransientFact('pty-finished-reattach', {
      kind: 'command-finished',
      exitCode: 0
    })

    expect(getPty(runtime, 'pty-finished-reattach')).toMatchObject({
      launchAgent: null,
      launchToken: null,
      launchIncarnationId: null
    })
  })

  it('records restored authority from the persisted launch hash when the handle binds', () => {
    const launchTokenHash = launchHash(LAUNCH_TOKEN)
    const runtime = restoredAuthorityRuntime(() => [restoredTraeRow(launchTokenHash)])

    registerTraeReattach(runtime, 'pty-restored-reattach')
    expect(getRestoredReceipt(runtime, 'pty-restored-reattach')).toBeUndefined()

    runtime.registerPreAllocatedHandleForPty('pty-restored-reattach', TERMINAL_HANDLE)

    expect(getPty(runtime, 'pty-restored-reattach')).toMatchObject({
      launchAgent: 'trae',
      launchToken: null
    })
    expect(getRestoredReceipt(runtime, 'pty-restored-reattach')).toMatchObject({
      ptyId: 'pty-restored-reattach',
      worktreeId: WORKTREE_ID,
      terminalHandle: TERMINAL_HANDLE,
      paneKey: PANE_KEY,
      processIncarnation: 'pty-restored-reattach:provider-reattach-incarnation',
      launchTokenHash,
      hostScope: { kind: 'local', hostId: 'local' }
    })
  })

  it('records restored authority when the handle binds before the PTY', () => {
    const launchTokenHash = launchHash(LAUNCH_TOKEN)
    const runtime = restoredAuthorityRuntime(() => [restoredTraeRow(launchTokenHash)])

    runtime.registerPreAllocatedHandleForPty('pty-handle-first', TERMINAL_HANDLE)
    expect(getRestoredReceipt(runtime, 'pty-handle-first')).toBeUndefined()

    registerTraeReattach(runtime, 'pty-handle-first')

    expect(getRestoredReceipt(runtime, 'pty-handle-first')).toMatchObject({
      terminalHandle: TERMINAL_HANDLE,
      processIncarnation: 'pty-handle-first:provider-reattach-incarnation',
      launchTokenHash
    })
  })

  it('keeps one restored launch hash stable across repeated identity observations', () => {
    const firstLaunchTokenHash = launchHash(LAUNCH_TOKEN)
    const laterLaunchTokenHash = launchHash('unrelated-later-launch')
    let rows: AgentStatusIpcPayload[] = [restoredTraeRow(firstLaunchTokenHash)]
    const runtime = restoredAuthorityRuntime(() => rows)

    registerTraeReattach(runtime, 'pty-stable-receipt')
    runtime.registerPreAllocatedHandleForPty('pty-stable-receipt', TERMINAL_HANDLE)
    expect(getRestoredReceipt(runtime, 'pty-stable-receipt')?.launchTokenHash).toBe(
      firstLaunchTokenHash
    )

    rows = [
      {
        ...restoredTraeRow(laterLaunchTokenHash),
        launchTokenHash: laterLaunchTokenHash,
        receivedAt: 1_800_000_001_000
      }
    ]
    runtime.registerPreAllocatedHandleForPty('pty-stable-receipt', TERMINAL_HANDLE)

    expect(getRestoredReceipt(runtime, 'pty-stable-receipt')?.launchTokenHash).toBe(
      firstLaunchTokenHash
    )
  })
})

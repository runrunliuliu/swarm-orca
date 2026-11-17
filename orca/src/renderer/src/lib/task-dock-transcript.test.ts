import { describe, expect, it, vi } from 'vitest'

const { callRuntimeRpcMock } = vi.hoisted(() => ({ callRuntimeRpcMock: vi.fn() }))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: callRuntimeRpcMock,
  getActiveRuntimeTarget: () => ({ kind: 'local' })
}))

import { readTaskDockTranscript } from './task-dock-transcript'

function listing(terminals: unknown[]): unknown {
  return { terminals, totalCount: terminals.length, truncated: false }
}

function summary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    handle: 'terminal-1',
    ptyId: 'pty-1',
    worktreeId: 'folder:workspace-1',
    worktreePath: '/tmp/task-drafts/draft-1',
    branch: '',
    tabId: 'tab-agent',
    leafId: 'leaf-1',
    title: 'codex',
    connected: true,
    writable: true,
    lastOutputAt: 1,
    preview: '',
    ...overrides
  }
}

const baseArgs = { folderWorkspaceId: 'workspace-1', primaryTabId: 'tab-agent' }

describe('readTaskDockTranscript', () => {
  it('reads nothing and asks the runtime nothing before a session exists', async () => {
    callRuntimeRpcMock.mockReset()
    await expect(readTaskDockTranscript({ ...baseArgs, primaryTabId: null })).resolves.toBeNull()
    expect(callRuntimeRpcMock).not.toHaveBeenCalled()
  })

  it('follows the draft tab rather than the first terminal in the workspace', async () => {
    callRuntimeRpcMock.mockReset()
    callRuntimeRpcMock
      .mockResolvedValueOnce(
        listing([
          summary({ handle: 'terminal-shell', tabId: 'tab-shell' }),
          summary({ handle: 'terminal-agent' })
        ])
      )
      .mockResolvedValueOnce({
        terminal: { handle: 'terminal-agent', status: 'running', tail: ['a', 'b'], truncated: false }
      })

    await expect(readTaskDockTranscript({ ...baseArgs, limit: 40 })).resolves.toEqual({
      lines: ['a', 'b'],
      ended: false
    })
    expect(callRuntimeRpcMock).toHaveBeenNthCalledWith(
      1,
      { kind: 'local' },
      'terminal.list',
      { worktree: 'id:folder:workspace-1', limit: 200 },
      { timeoutMs: 10_000 }
    )
    expect(callRuntimeRpcMock).toHaveBeenNthCalledWith(
      2,
      { kind: 'local' },
      'terminal.read',
      { terminal: 'terminal-agent', limit: 40 },
      { timeoutMs: 10_000 }
    )
  })

  it('keeps following a detached-but-running terminal', async () => {
    // Why: a transient detach during startup must not end the tail; only a real exit does.
    callRuntimeRpcMock.mockReset()
    callRuntimeRpcMock
      .mockResolvedValueOnce(listing([summary({ connected: false })]))
      .mockResolvedValueOnce({
        terminal: { handle: 'terminal-1', status: 'unknown', tail: ['starting'], truncated: false }
      })
      .mockResolvedValueOnce(listing([summary()]))
      .mockResolvedValueOnce({
        terminal: { handle: 'terminal-1', status: 'running', tail: ['starting', 'ready'], truncated: false }
      })

    await expect(readTaskDockTranscript(baseArgs)).resolves.toEqual({
      lines: ['starting'],
      ended: false
    })
    await expect(readTaskDockTranscript(baseArgs)).resolves.toEqual({
      lines: ['starting', 'ready'],
      ended: false
    })
  })

  it('marks the tail final only when the agent exited', async () => {
    callRuntimeRpcMock.mockReset()
    callRuntimeRpcMock
      .mockResolvedValueOnce(listing([summary({ connected: false })]))
      .mockResolvedValueOnce({
        terminal: { handle: 'terminal-1', status: 'exited', tail: ['done'], truncated: false }
      })
    await expect(readTaskDockTranscript(baseArgs)).resolves.toEqual({
      lines: ['done'],
      ended: true
    })
  })

  it('returns null instead of surfacing a transient host failure into the dock', async () => {
    callRuntimeRpcMock.mockReset()
    callRuntimeRpcMock.mockRejectedValueOnce(new Error('runtime unavailable'))
    await expect(readTaskDockTranscript(baseArgs)).resolves.toBeNull()
  })

  it('returns null when the draft tab has no terminal yet', async () => {
    callRuntimeRpcMock.mockReset()
    callRuntimeRpcMock.mockResolvedValueOnce(listing([summary({ tabId: 'tab-other' })]))
    await expect(readTaskDockTranscript(baseArgs)).resolves.toBeNull()
    expect(callRuntimeRpcMock).toHaveBeenCalledTimes(1)
  })
})

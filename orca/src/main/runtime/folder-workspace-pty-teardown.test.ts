import { beforeEach, describe, expect, it, vi } from 'vitest'

const { killAllProcessesForWorktreeMock } = vi.hoisted(() => ({
  killAllProcessesForWorktreeMock: vi.fn(
    async (): Promise<{
      runtimeStopped: number
      providerStopped: number
      registryStopped: number
    }> => ({ runtimeStopped: 0, providerStopped: 0, registryStopped: 0 })
  )
}))

vi.mock('./worktree-teardown', () => ({
  killAllProcessesForWorktree: killAllProcessesForWorktreeMock
}))

import type { OrcaRuntimeService } from './orca-runtime'
import { teardownFolderWorkspacePtys } from './folder-workspace-pty-teardown'

describe('folder workspace PTY teardown', () => {
  beforeEach(() => {
    killAllProcessesForWorktreeMock.mockClear()
  })

  it('freezes task-record sessions before the sweep clears pane state', async () => {
    const calls: string[] = []
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: teardown only calls captureTaskRecordsRemovalSessions before delegating to the mocked sweep.
    const runtime = {
      captureTaskRecordsRemovalSessions: vi.fn(() => {
        calls.push('capture')
      })
    } as unknown as OrcaRuntimeService
    killAllProcessesForWorktreeMock.mockImplementation(async () => {
      calls.push('sweep')
      return { runtimeStopped: 0, providerStopped: 0, registryStopped: 0 }
    })

    await teardownFolderWorkspacePtys(
      {
        runtime,
        getSshProvider: null,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the provider is only forwarded to the mocked killAllProcessesForWorktree.
        getLocalProvider: () => ({}) as never,
        onPtyStopped: null
      },
      'folder:ws-1',
      null
    )

    expect(calls).toEqual(['capture', 'sweep'])
  })

  it('does not capture when there is no provider to sweep', async () => {
    const capture = vi.fn()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the early return must be reached before any runtime member is read.
    const runtime = {
      captureTaskRecordsRemovalSessions: capture
    } as unknown as OrcaRuntimeService

    await teardownFolderWorkspacePtys(
      { runtime, getSshProvider: null, getLocalProvider: () => null, onPtyStopped: null },
      'folder:ws-1',
      null
    )

    expect(capture).not.toHaveBeenCalled()
    expect(killAllProcessesForWorktreeMock).not.toHaveBeenCalled()
  })
})

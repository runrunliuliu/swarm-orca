// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type {
  TaskWorkbenchView,
  TaskWorkbenchWorkspace
} from '@/components/task-workbench/task-workbench-view'

/**
 * Orca-side archive after delivery (README §7.12 D2, A10).
 *
 * What this file owns: the hook archives **once**, only after the completion
 * fact is observable, only when the operator ticked it, and reports a failure
 * without retrying. The intent store is the real module, so the one-shot
 * semantics are the ones in production, not a mock's.
 */

const mocks = vi.hoisted(() => ({
  updateWorktreeMeta: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({ updateWorktreeMeta: mocks.updateWorktreeMeta })
  }
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))

import {
  consumeTaskWorkbenchArchiveIntent,
  recordTaskWorkbenchArchiveIntent,
  resetTaskWorkbenchArchiveIntents
} from '@/lib/task-workbench/task-workbench-deliver-archive-intent'
import { useTaskWorkbenchDeliverArchive } from './use-task-workbench-deliver-archive'

const WORKSPACE: TaskWorkbenchWorkspace = {
  repoId: 'repo-web-app',
  worktreeId: 'wt-feat-431',
  repoName: 'acme/web-app',
  worktreeName: 'feat/task-431',
  hostKind: 'local' as const,
  executionHostId: LOCAL_EXECUTION_HOST_ID,
  workspaceKind: 'worktree' as const,
  workspaceStatusId: 'completed',
  workspaceStatusLabel: 'Done',
  review: { number: 431, state: 'merged' as const }
}

function view(overrides: Partial<TaskWorkbenchView> = {}): TaskWorkbenchView {
  return {
    identity: { kind: 'workspace', primaryWorktreeId: WORKSPACE.worktreeId },
    title: 'Delivered',
    defaultWorkspace: { workspaceId: WORKSPACE.worktreeId, source: 'explicit' },
    workspaces: [WORKSPACE],
    agents: [],
    spend: { kind: 'unavailable', reason: 'no_matching_session' },
    ...overrides
  }
}

beforeEach(() => {
  resetTaskWorkbenchArchiveIntents()
  mocks.updateWorktreeMeta.mockReset()
  mocks.updateWorktreeMeta.mockResolvedValue({ ok: true })
  mocks.toastError.mockReset()
})

afterEach(cleanup)

describe('useTaskWorkbenchDeliverArchive', () => {
  it('A10: archives exactly once after observing the completion fact', async () => {
    recordTaskWorkbenchArchiveIntent(WORKSPACE.worktreeId)
    const { rerender } = renderHook(() => useTaskWorkbenchDeliverArchive(view()))

    await waitFor(() => expect(mocks.updateWorktreeMeta).toHaveBeenCalledTimes(1))
    expect(mocks.updateWorktreeMeta).toHaveBeenCalledWith(
      WORKSPACE.worktreeId,
      { isArchived: true },
      { executionHostId: LOCAL_EXECUTION_HOST_ID }
    )

    // Re-observing the same fact (a store tick re-renders the panel) must not
    // archive a second time: the intent was consumed by the first run.
    rerender()
    await Promise.resolve()
    expect(mocks.updateWorktreeMeta).toHaveBeenCalledTimes(1)
    expect(consumeTaskWorkbenchArchiveIntent(WORKSPACE.worktreeId)).toBe(false)
  })

  it('A10: does nothing when the operator did not tick archive', async () => {
    renderHook(() => useTaskWorkbenchDeliverArchive(view()))

    await Promise.resolve()
    expect(mocks.updateWorktreeMeta).not.toHaveBeenCalled()
  })

  // §7.12 D2: the intent belongs to the workspace the operator delivered from,
  // which is not necessarily the view's default. A hook that projected only the
  // default would leave this intent pending forever.
  it('archives a non-default workspace whose intent was recorded', async () => {
    const idle: TaskWorkbenchWorkspace = {
      ...WORKSPACE,
      worktreeId: 'wt-feat-430',
      worktreeName: 'feat/task-430',
      workspaceStatusId: undefined,
      review: undefined
    }
    const delivered: TaskWorkbenchWorkspace = {
      ...WORKSPACE,
      worktreeId: 'wt-feat-999',
      worktreeName: 'feat/task-999'
    }
    recordTaskWorkbenchArchiveIntent(delivered.worktreeId)

    renderHook(() =>
      useTaskWorkbenchDeliverArchive(
        view({
          defaultWorkspace: { workspaceId: idle.worktreeId, source: 'explicit' },
          workspaces: [idle, delivered]
        })
      )
    )

    await waitFor(() => expect(mocks.updateWorktreeMeta).toHaveBeenCalledTimes(1))
    expect(mocks.updateWorktreeMeta).toHaveBeenCalledWith(
      delivered.worktreeId,
      { isArchived: true },
      { executionHostId: LOCAL_EXECUTION_HOST_ID }
    )
    // The idle default's lack of intent is not turned into an archive either.
    expect(consumeTaskWorkbenchArchiveIntent(idle.worktreeId)).toBe(false)
  })

  it('does nothing before the workspace reads completed', async () => {
    recordTaskWorkbenchArchiveIntent(WORKSPACE.worktreeId)
    renderHook(() =>
      useTaskWorkbenchDeliverArchive(
        view({ workspaces: [{ ...WORKSPACE, workspaceStatusId: undefined }] })
      )
    )

    await Promise.resolve()
    expect(mocks.updateWorktreeMeta).not.toHaveBeenCalled()
    // The intent survives for the render that can act on it.
    expect(consumeTaskWorkbenchArchiveIntent(WORKSPACE.worktreeId)).toBe(true)
  })

  it('does nothing for a task with no view at all', async () => {
    recordTaskWorkbenchArchiveIntent(WORKSPACE.worktreeId)
    renderHook(() => useTaskWorkbenchDeliverArchive(null))

    await Promise.resolve()
    expect(mocks.updateWorktreeMeta).not.toHaveBeenCalled()
  })

  it('A10: a failed archive is a toast, once, and is never retried', async () => {
    mocks.updateWorktreeMeta.mockResolvedValue({ ok: false, error: 'host unreachable' })
    recordTaskWorkbenchArchiveIntent(WORKSPACE.worktreeId)
    const { rerender } = renderHook(() => useTaskWorkbenchDeliverArchive(view()))

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1))
    expect(mocks.toastError).toHaveBeenCalledWith(
      'Delivery completed, but archiving the workspace failed. Archive it from the workspace row.'
    )

    rerender()
    await act(async () => {
      await Promise.resolve()
    })
    expect(mocks.updateWorktreeMeta).toHaveBeenCalledTimes(1)
    expect(mocks.toastError).toHaveBeenCalledTimes(1)
  })
})

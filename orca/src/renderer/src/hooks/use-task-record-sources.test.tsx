// @vitest-environment happy-dom

import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TaskRecord } from '../../../shared/task-records-types'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../shared/protocol-version'

const runtimeEnvironmentCall = vi.fn()

// Why `window.api` and not a whole `window` stub: this file renders a hook, and
// happy-dom's `window` (with `document`) is what `waitFor` needs. Only the
// transport boundary is replaced.
Object.defineProperty(window, 'api', {
  configurable: true,
  value: { runtimeEnvironments: { call: runtimeEnvironmentCall } }
})

const { clearRuntimeCompatibilityCacheForTests } = await import('@/runtime/runtime-rpc-client')
const { useTaskRecordSources } = await import('./use-task-record-sources')

/**
 * The composed read (issue #31): a workspace's host decides which profile is
 * asked, the runtime RPC answers over the real client stack, and the merge puts
 * the answers back together.
 *
 * Why the real client and only the transport stubbed: the preflight, the envelope
 * unwrapping and the error classification are exactly the parts a hand-rolled
 * double would hide, and they are what makes an old runtime degrade honestly.
 * The transport below is `window.api.runtimeEnvironments.call`, the same boundary
 * the app itself crosses.
 */

const QUERY = { repoId: 'repo-1', itemType: 'issue' as const, number: 7 }

function record(hostId: TaskRecord['hostId'], worktreeId: string): TaskRecord {
  return {
    taskId: 'task:github:repo-1:issue:7',
    hostId,
    origin: { kind: 'external', provider: 'github', itemType: 'issue', number: 7 },
    bindings: [
      {
        worktreeId,
        repoId: 'repo-1',
        hostId,
        path: `/checkouts/${worktreeId}`,
        isArchived: true,
        boundAt: 1,
        boundBy: 'created',
        lastVerifiedAt: 2,
        sessions: []
      }
    ],
    intent: { archived: true },
    createdAt: 1,
    updatedAt: 2,
    schemaVersion: 2
  }
}

function envelope(method: string, result: unknown): unknown {
  return { id: method, ok: true, result, _meta: { runtimeId: 'remote-runtime' } }
}

function serveRecords(answer: unknown): void {
  runtimeEnvironmentCall.mockImplementation(({ method }: { method: string }) => {
    if (method === 'status.get') {
      return Promise.resolve(
        envelope('status.get', {
          runtimeId: 'remote-runtime',
          graphStatus: 'ready',
          runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
          minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
        })
      )
    }
    return Promise.resolve(envelope(method, answer))
  })
}

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  runtimeEnvironmentCall.mockReset()
})

describe('useTaskRecordSources', () => {
  it('asks nothing remote for a task whose workspaces are all local', async () => {
    const local = record('local', 'wt-local')
    const { result } = renderHook(() =>
      useTaskRecordSources({
        query: QUERY,
        worktrees: [{ hostId: 'local' }],
        local
      })
    )

    await waitFor(() => expect(result.current.pending).toBe(false))
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    // Local-only is the path that existed before: the record object is reused and
    // there is no source notice to print.
    expect(result.current.record).toBe(local)
    expect(result.current.recordSource).toBeUndefined()
  })

  it('reads the profile of the environment that owns the workspace', async () => {
    const remote = record('runtime:env-a', 'wt-remote')
    serveRecords({ record: remote, repoKnown: true })

    const { result } = renderHook(() =>
      useTaskRecordSources({
        query: QUERY,
        worktrees: [{ hostId: 'runtime:env-a' }],
        local: null
      })
    )

    await waitFor(() => expect(result.current.pending).toBe(false))
    expect(runtimeEnvironmentCall.mock.calls.map((call) => call[0].method)).toEqual([
      'status.get',
      'taskRecords.get'
    ])
    expect(runtimeEnvironmentCall.mock.calls[1][0].params).toEqual({
      repoId: 'repo-1',
      itemType: 'issue',
      number: 7
    })
    expect(result.current.record).toBe(remote)
    expect(result.current.recordSource).toEqual({
      environmentIds: ['env-a'],
      answered: ['env-a'],
      unavailable: [],
      conflicts: [],
      pending: false
    })
  })

  it('keeps the local record when the environment is too old to answer', async () => {
    runtimeEnvironmentCall.mockImplementation(({ method }: { method: string }) =>
      Promise.resolve(
        method === 'status.get'
          ? envelope('status.get', {
              runtimeId: 'old-runtime',
              graphStatus: 'ready',
              runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
              minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
            })
          : {
              id: method,
              ok: false,
              error: { code: 'method_not_found', message: "unknown method 'taskRecords.get'" },
              _meta: { runtimeId: 'old-runtime' }
            }
      )
    )
    const local = record('local', 'wt-local')

    const { result } = renderHook(() =>
      useTaskRecordSources({
        query: QUERY,
        worktrees: [{ hostId: 'runtime:env-a' }],
        local,
        environments: [{ id: 'env-a', name: 'Build box' }]
      })
    )

    await waitFor(() => expect(result.current.pending).toBe(false))
    expect(result.current.record).toBe(local)
    expect(result.current.recordSource?.unavailable).toEqual([
      { environmentId: 'env-a', failure: 'unsupported', label: 'Build box' }
    ])
  })

  it('reads an environment the local record names even when its workspace row is gone', async () => {
    const remote = record('runtime:env-a', 'wt-remote')
    serveRecords({ record: remote, repoKnown: true })
    const local = record('local', 'wt-local')

    const { result } = renderHook(() =>
      useTaskRecordSources({
        query: QUERY,
        // No workspace rows at all: only the local record's binding says where the
        // rest of this task's history can be.
        worktrees: [],
        local: {
          ...local,
          bindings: [
            ...local.bindings,
            recentBinding('wt-gone', 'runtime:env-a')
          ]
        }
      })
    )

    await waitFor(() => expect(result.current.pending).toBe(false))
    expect(result.current.recordSource?.answered).toEqual(['env-a'])
    expect(result.current.record?.bindings.map((binding) => binding.worktreeId)).toEqual([
      'wt-local',
      'wt-gone',
      'wt-remote'
    ])
  })
})

function recentBinding(worktreeId: string, hostId: TaskRecord['hostId']): TaskRecord['bindings'][number] {
  return {
    worktreeId,
    repoId: 'repo-1',
    hostId,
    path: `/checkouts/${worktreeId}`,
    isArchived: false,
    boundAt: 2,
    boundBy: 'user',
    lastVerifiedAt: 3,
    sessions: []
  }
}

// @vitest-environment happy-dom

import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The remote half of the task-record read (issue #31).
 *
 * What this file owns: which hosts are called, that a host which advertised no
 * `taskRecords.v1` is skipped instead of called, and that every failure becomes an
 * `unavailable` answer — never an empty record the panel would print as "this task
 * never ran". The decision layer is `task-workbench-record-sources.test.ts`; this
 * is the transport wiring around it.
 */

const callRuntimeRpc = vi.fn()

// Why not `importOriginal`: the real client drags the whole transport graph in for a
// test that only needs one function. The failure classifier's token matcher is the
// one real piece it reads, so it is handed over explicitly instead of stubbed.
vi.mock('@/runtime/runtime-rpc-client', async () => {
  const shared = await import('../../../shared/runtime-rpc-error-code')
  return { callRuntimeRpc, hasRuntimeRpcErrorCode: shared.hasRuntimeRpcErrorCode }
})

const { useTaskRecordsRemote } = await import('./use-task-records-remote')

const QUERY = { repoId: 'repo-1', itemType: 'issue' as const, number: 7 }

beforeEach(() => {
  callRuntimeRpc.mockReset()
})

function statusWith(capabilities: string[]) {
  return {
    status: { capabilities },
    checkedAt: 1
  }
}

describe('useTaskRecordsRemote', () => {
  it('does not read anything for a task no environment applies to', () => {
    const { result } = renderHook(() =>
      useTaskRecordsRemote({ query: QUERY, environmentIds: [] })
    )

    expect(result.current).toEqual({ pending: false, answers: [] })
    expect(callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('asks each environment for the one identity and reports an empty answer as an answer', async () => {
    callRuntimeRpc.mockResolvedValue({ record: null, repoKnown: true })
    const { result } = renderHook(() =>
      useTaskRecordsRemote({ query: QUERY, environmentIds: ['env-a'] })
    )

    await waitFor(() => expect(result.current.pending).toBe(false))
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-a' },
      'taskRecords.get',
      { repoId: 'repo-1', itemType: 'issue', number: 7 },
      expect.objectContaining({ timeoutMs: 15_000 })
    )
    expect(result.current.answers).toEqual([
      {
        target: { kind: 'environment', environmentId: 'env-a' },
        kind: 'answered',
        record: null
      }
    ])
  })

  it('skips a host that advertised no task-records capability', async () => {
    const { result } = renderHook(() =>
      useTaskRecordsRemote({
        query: QUERY,
        environmentIds: ['env-old'],
        statusByEnvironment: new Map([['env-old', statusWith(['other.v1'])]])
      })
    )

    await waitFor(() => expect(result.current.pending).toBe(false))
    expect(callRuntimeRpc).not.toHaveBeenCalled()
    expect(result.current.answers).toEqual([
      {
        target: { kind: 'environment', environmentId: 'env-old' },
        kind: 'unavailable',
        failure: 'unsupported'
      }
    ])
  })

  it('turns an older host that is missing the method into unsupported, not empty', async () => {
    const missingMethod = Object.assign(new Error('method_not_found'), {
      code: 'method_not_found'
    })
    callRuntimeRpc.mockRejectedValue(missingMethod)
    const { result } = renderHook(() =>
      useTaskRecordsRemote({ query: QUERY, environmentIds: ['env-a'] })
    )

    await waitFor(() => expect(result.current.pending).toBe(false))
    expect(result.current.answers).toEqual([
      {
        target: { kind: 'environment', environmentId: 'env-a' },
        kind: 'unavailable',
        failure: 'unsupported'
      }
    ])
  })

  it('survives an unmemoized status map: a capability verdict, not an identity, re-arms the read', async () => {
    // Regression guard: an inline `new Map(...)` used to be a fresh effect
    // dependency every render, so the effect re-armed itself and the page spun
    // until the worker ran out of heap. The gate is a rendered verdict instead.
    callRuntimeRpc.mockResolvedValue({ record: null, repoKnown: true })
    const { result, rerender } = renderHook(() =>
      useTaskRecordsRemote({
        query: QUERY,
        environmentIds: ['env-a'],
        statusByEnvironment: new Map([['env-a', statusWith(['taskRecords.v1'])]])
      })
    )

    await waitFor(() => expect(result.current.pending).toBe(false))
    rerender()
    await waitFor(() => expect(result.current.pending).toBe(false))
    expect(callRuntimeRpc).toHaveBeenCalledTimes(1)
  })

  it('treats a host that does not know the repo as a scope answer', async () => {
    callRuntimeRpc.mockResolvedValue({ record: null, repoKnown: false })
    const { result } = renderHook(() =>
      useTaskRecordsRemote({ query: QUERY, environmentIds: ['env-b'] })
    )

    await waitFor(() => expect(result.current.pending).toBe(false))
    expect(result.current.answers).toEqual([
      {
        target: { kind: 'environment', environmentId: 'env-b' },
        kind: 'unavailable',
        failure: 'repo-unknown'
      }
    ])
  })

  it('rejects a malformed answer instead of feeding it to the merge', async () => {
    callRuntimeRpc.mockResolvedValue({ record: { noBindings: true }, repoKnown: true })
    const { result } = renderHook(() =>
      useTaskRecordsRemote({ query: QUERY, environmentIds: ['env-a'] })
    )

    await waitFor(() => expect(result.current.pending).toBe(false))
    expect(result.current.answers[0]).toMatchObject({
      kind: 'unavailable',
      failure: 'unreachable'
    })
  })
})

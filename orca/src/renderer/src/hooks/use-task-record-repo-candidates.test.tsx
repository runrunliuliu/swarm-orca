// @vitest-environment happy-dom

import React from 'react'
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../shared/repo-types'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'

const callRuntimeRpc = vi.fn()

vi.mock('@/runtime/runtime-rpc-client', async () => {
  const shared = await import('../../../shared/runtime-rpc-error-code')
  return { callRuntimeRpc, hasRuntimeRpcErrorCode: shared.hasRuntimeRpcErrorCode }
})

const { clearTaskRecordRepoCatalogCacheForTests, useTaskRecordRepoCandidates } =
  await import('./use-task-record-repo-candidates')
const { taskRecordRepoCatalogCacheSizeForTests } = await import('./task-record-repo-catalog-cache')

const QUERY = { repoId: 'local-repo', itemType: 'issue' as const, number: 7 }

function repo(id: string, path = '/repo', canonicalKey = 'github.com/acme/repo'): Repo {
  return {
    id,
    path,
    displayName: id,
    badgeColor: 'gray',
    addedAt: 1,
    gitRemoteIdentity: {
      canonicalKey,
      remoteName: 'origin',
      remoteUrl: `git@github.com:${canonicalKey.slice('github.com/'.length)}.git`
    }
  }
}

function environment(
  id: string,
  pairingRevision = 1,
  runtimeId = `runtime-${id}`
): PublicKnownRuntimeEnvironment {
  return {
    id,
    name: id,
    createdAt: 1,
    updatedAt: 1,
    pairingRevision,
    lastUsedAt: null,
    runtimeId,
    endpoints: [{ id: `endpoint-${id}`, kind: 'websocket', label: id, endpoint: 'ws://host' }],
    preferredEndpointId: `endpoint-${id}`
  }
}

function status(environmentId: string, capabilities = ['taskRecords.v1']) {
  return {
    status: { runtimeId: `runtime-${environmentId}`, capabilities },
    checkedAt: 1
  }
}

function props(
  environments: readonly PublicKnownRuntimeEnvironment[],
  overrides: Partial<Parameters<typeof useTaskRecordRepoCandidates>[0]> = {}
): Parameters<typeof useTaskRecordRepoCandidates>[0] {
  return {
    query: QUERY,
    pageRepo: repo('local-repo', '/local/repo'),
    evidenceEnvironmentIds: [],
    environments,
    statusByEnvironment: new Map(environments.map((entry) => [entry.id, status(entry.id)])),
    catalogHydrated: true,
    catalogSettled: true,
    ...overrides
  }
}

beforeEach(() => {
  callRuntimeRpc.mockReset()
  clearTaskRecordRepoCatalogCacheForTests()
  vi.restoreAllMocks()
})

describe('useTaskRecordRepoCandidates', () => {
  it('enumerates each capable pairing and returns that environment own repo id', async () => {
    const environments = [environment('env-a'), environment('env-b')]
    callRuntimeRpc.mockImplementation(({ environmentId }: { environmentId: string }) =>
      Promise.resolve({ repos: [repo(`remote-${environmentId}`, `/remote/${environmentId}`)] })
    )

    const { result } = renderHook(() => useTaskRecordRepoCandidates(props(environments)))

    await waitFor(() => expect(result.current.pending).toBe(false))
    expect(callRuntimeRpc).toHaveBeenCalledTimes(2)
    expect(result.current.pairs).toEqual([
      { environmentId: 'env-a', repoId: 'remote-env-a' },
      { environmentId: 'env-b', repoId: 'remote-env-b' }
    ])
    expect(result.current.verdict).toBe('resolved')
  })

  it('does not ask task records when the repo catalog has zero or several matches', async () => {
    const environments = [environment('env-a'), environment('env-b')]
    callRuntimeRpc.mockImplementation(({ environmentId }: { environmentId: string }) =>
      Promise.resolve({
        repos:
          environmentId === 'env-a'
            ? [repo('other', '/other', 'github.com/acme/other')]
            : [repo('duplicate-a', '/a'), repo('duplicate-b', '/b')]
      })
    )

    const { result } = renderHook(() => useTaskRecordRepoCandidates(props(environments)))

    await waitFor(() => expect(result.current.pending).toBe(false))
    expect(result.current.pairs).toEqual([])
    expect(result.current.unavailable).toEqual([
      {
        target: { kind: 'environment', environmentId: 'env-a' },
        kind: 'unavailable',
        failure: 'repo-unmatched'
      },
      {
        target: { kind: 'environment', environmentId: 'env-b' },
        kind: 'unavailable',
        failure: 'repo-ambiguous'
      }
    ])
  })

  it('enumerates but fails closed without a usable cross-host identity', async () => {
    const environments = [environment('env-a')]
    const pageRepo = { ...repo('local-repo'), gitRemoteIdentity: null }
    callRuntimeRpc.mockResolvedValue({ repos: [repo('remote-a')] })
    const { result } = renderHook(() =>
      useTaskRecordRepoCandidates(props(environments, { pageRepo }))
    )

    await waitFor(() => expect(result.current.pending).toBe(false))
    expect(result.current.verdict).toBe('undetermined')
    expect(result.current.pairs).toEqual([])
    expect(callRuntimeRpc).toHaveBeenCalledTimes(1)
  })

  it('resolves the reported remote-only case from an id read from exactly one runtime catalog', async () => {
    const environments = [environment('env-a')]
    callRuntimeRpc.mockResolvedValue({ repos: [repo('local-repo', '/remote/repo')] })
    const { result } = renderHook(() =>
      useTaskRecordRepoCandidates(props(environments, { pageRepo: undefined }))
    )

    await waitFor(() => expect(result.current.pending).toBe(false))
    expect(result.current.pairs).toEqual([{ environmentId: 'env-a', repoId: 'local-repo' }])
    expect(result.current.verdict).toBe('resolved')
  })

  it('uses the page tracker identity when the local repo row is absent', async () => {
    const environments = [environment('env-a')]
    callRuntimeRpc.mockResolvedValue({ repos: [repo('remote-a')] })
    const { result } = renderHook(() =>
      useTaskRecordRepoCandidates(
        props(environments, {
          pageRepo: undefined,
          providerIdentity: { provider: 'github', owner: 'acme', repo: 'repo' }
        })
      )
    )

    await waitFor(() => expect(result.current.pending).toBe(false))
    expect(result.current.pairs).toEqual([{ environmentId: 'env-a', repoId: 'remote-a' }])
  })

  it('refuses an exact id whose tracker identity points at another repository', async () => {
    const environments = [environment('env-a')]
    callRuntimeRpc.mockResolvedValue({
      repos: [repo('local-repo', '/remote/other', 'github.com/acme/other')]
    })
    const { result } = renderHook(() =>
      useTaskRecordRepoCandidates(
        props(environments, {
          pageRepo: undefined,
          providerIdentity: { provider: 'github', owner: 'acme', repo: 'repo' }
        })
      )
    )

    await waitFor(() => expect(result.current.pending).toBe(false))
    expect(result.current.pairs).toEqual([])
    expect(result.current.verdict).toBe('undetermined')
  })

  it('refuses the page id when more than one capable runtime catalog contains it', async () => {
    const environments = [environment('env-a'), environment('env-b')]
    callRuntimeRpc.mockResolvedValue({ repos: [repo('local-repo')] })
    const { result } = renderHook(() =>
      useTaskRecordRepoCandidates(
        props(environments, {
          pageRepo: undefined,
          providerIdentity: { provider: 'github', owner: 'acme', repo: 'repo' }
        })
      )
    )

    await waitFor(() => expect(result.current.pending).toBe(false))
    expect(result.current.pairs).toEqual([])
    expect(result.current.verdict).toBe('undetermined')
  })

  it('keeps catalog and status hydration pending instead of finalizing absence', () => {
    const environments = [environment('env-a')]
    const { result } = renderHook(() =>
      useTaskRecordRepoCandidates(
        props(environments, { catalogHydrated: false, catalogSettled: false })
      )
    )

    expect(result.current.pending).toBe(true)
    expect(callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('does not keep an empty settled catalog pending when hydration failed', async () => {
    const { result } = renderHook(() =>
      useTaskRecordRepoCandidates(
        props([], { catalogHydrated: false, catalogSettled: true })
      )
    )

    await waitFor(() => expect(result.current.pending).toBe(false))
    expect(result.current.verdict).toBe('not-needed')
    expect(callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('reports every paired environment that explicitly lacks task-record capability', async () => {
    const environments = [environment('env-a'), environment('env-b')]
    const unsupported = new Map(
      environments.map((entry) => [entry.id, status(entry.id, [])])
    )
    const { result } = renderHook(() =>
      useTaskRecordRepoCandidates(
        props(environments, { statusByEnvironment: unsupported })
      )
    )

    await waitFor(() => expect(result.current.pending).toBe(false))
    expect(result.current.environmentIds).toEqual(['env-a', 'env-b'])
    expect(result.current.unavailable).toEqual([
      {
        target: { kind: 'environment', environmentId: 'env-a' },
        kind: 'unavailable',
        failure: 'unsupported'
      },
      {
        target: { kind: 'environment', environmentId: 'env-b' },
        kind: 'unavailable',
        failure: 'unsupported'
      }
    ])
    expect(callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('uses the no-guess verdict when page and provider identities contradict', async () => {
    const environments = [environment('env-a')]
    callRuntimeRpc.mockResolvedValue({
      repos: [
        repo('page-repo', '/page'),
        repo('provider-repo', '/provider', 'github.com/acme/provider')
      ]
    })
    const { result } = renderHook(() =>
      useTaskRecordRepoCandidates(
        props(environments, {
          providerIdentity: { provider: 'github', owner: 'acme', repo: 'provider' }
        })
      )
    )

    await waitFor(() => expect(result.current.pending).toBe(false))
    expect(result.current.pairs).toEqual([])
    expect(result.current.unavailable).toEqual([])
    expect(result.current.verdict).toBe('undetermined')
  })

  it('uses retained capability after contact loss and reports the failed read', async () => {
    const environments = [environment('env-a')]
    callRuntimeRpc.mockRejectedValue(new Error('offline'))
    const retained = new Map([
      [
        'env-a',
        {
          status: null,
          snapshot: {
            status: { runtimeId: 'runtime-env-a', capabilities: ['taskRecords.v1'] }
          }
        }
      ]
    ])
    const { result } = renderHook(() =>
      useTaskRecordRepoCandidates(props(environments, { statusByEnvironment: retained }))
    )

    await waitFor(() => expect(result.current.pending).toBe(false))
    expect(callRuntimeRpc).toHaveBeenCalledTimes(1)
    expect(result.current.unavailable[0]).toMatchObject({
      kind: 'unavailable',
      failure: 'unreachable'
    })
  })

  it('lets an unknown capability probe decide instead of silently skipping the environment', async () => {
    const environments = [environment('env-a')]
    callRuntimeRpc.mockResolvedValue({ repos: [repo('remote-a')] })
    const unknown = new Map([['env-a', { status: { runtimeId: 'runtime-env-a' } }]])
    const { result } = renderHook(() =>
      useTaskRecordRepoCandidates(props(environments, { statusByEnvironment: unknown }))
    )

    await waitFor(() => expect(result.current.pending).toBe(false))
    expect(callRuntimeRpc).toHaveBeenCalledTimes(1)
    expect(result.current.pairs).toEqual([{ environmentId: 'env-a', repoId: 'remote-a' }])
  })

  it('coalesces StrictMode reads and reuses a fresh five-second catalog', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const environments = [environment('env-a')]
    callRuntimeRpc.mockResolvedValue({ repos: [repo('remote-a')] })

    const first = renderHook(() => useTaskRecordRepoCandidates(props(environments)), {
      wrapper: React.StrictMode
    })
    await waitFor(() => expect(first.result.current.pending).toBe(false))
    first.unmount()

    now.mockReturnValue(4_000)
    const second = renderHook(() => useTaskRecordRepoCandidates(props(environments)))
    await waitFor(() => expect(second.result.current.pending).toBe(false))
    expect(callRuntimeRpc).toHaveBeenCalledTimes(1)
    second.unmount()

    now.mockReturnValue(7_000)
    const expired = renderHook(() => useTaskRecordRepoCandidates(props(environments)))
    await waitFor(() => expect(expired.result.current.pending).toBe(false))
    expect(callRuntimeRpc).toHaveBeenCalledTimes(2)
  })

  it('invalidates catalogs on re-pair and explicit removal', async () => {
    callRuntimeRpc.mockResolvedValue({ repos: [repo('remote-a')] })
    const initial = environment('env-a', 1)
    const { result, rerender } = renderHook(({ input }) => useTaskRecordRepoCandidates(input), {
      initialProps: { input: props([initial]) }
    })
    await waitFor(() => expect(result.current.pending).toBe(false))

    const repaired = environment('env-a', 2)
    rerender({ input: props([repaired]) })
    await waitFor(() => expect(result.current.pending).toBe(false))
    expect(callRuntimeRpc).toHaveBeenCalledTimes(2)

    rerender({ input: props([]) })
    await waitFor(() => expect(result.current.pending).toBe(false))
    rerender({ input: props([repaired]) })
    await waitFor(() => expect(result.current.pending).toBe(false))
    expect(callRuntimeRpc).toHaveBeenCalledTimes(3)
  })

  it('bounds the shared repo catalog cache', async () => {
    const environments = Array.from({ length: 33 }, (_unused, index) => environment(`env-${index}`))
    callRuntimeRpc.mockImplementation(({ environmentId }: { environmentId: string }) =>
      Promise.resolve({ repos: [repo(`remote-${environmentId}`)] })
    )

    const { result } = renderHook(() => useTaskRecordRepoCandidates(props(environments)))
    await waitFor(() => expect(result.current.pending).toBe(false))

    expect(callRuntimeRpc).toHaveBeenCalledTimes(33)
    expect(taskRecordRepoCatalogCacheSizeForTests()).toBe(32)
  })
})

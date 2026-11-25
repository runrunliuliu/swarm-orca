// @vitest-environment happy-dom

import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TaskRecord } from '../../../shared/task-records-types'
import type { Repo } from '../../../shared/repo-types'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'
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
const { clearTaskRecordRepoCatalogCacheForTests } = await import(
  './use-task-record-repo-candidates'
)
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
    if (method === 'repo.list') {
      return Promise.resolve(envelope(method, { repos: [REMOTE_REPO] }))
    }
    return Promise.resolve(envelope(method, answer))
  })
}

const PAGE_REPO: Repo = {
  id: 'repo-1',
  path: '/local/repo',
  displayName: 'repo',
  badgeColor: 'gray',
  addedAt: 1,
  gitRemoteIdentity: {
    canonicalKey: 'github.com/acme/repo',
    remoteName: 'origin',
    remoteUrl: 'git@github.com:acme/repo.git'
  }
}

const REMOTE_REPO: Repo = { ...PAGE_REPO, id: 'remote-repo-a', path: '/remote/repo' }

const ENV_A: PublicKnownRuntimeEnvironment = {
  id: 'env-a',
  name: 'Build box',
  createdAt: 1,
  updatedAt: 1,
  pairingRevision: 1,
  lastUsedAt: null,
  runtimeId: 'remote-runtime',
  endpoints: [{ id: 'endpoint-a', kind: 'websocket', label: 'Build box', endpoint: 'ws://host' }],
  preferredEndpointId: 'endpoint-a'
}

const ENV_B: PublicKnownRuntimeEnvironment = {
  ...ENV_A,
  id: 'env-b',
  name: 'Offline box',
  runtimeId: 'remote-runtime-b',
  endpoints: [
    { id: 'endpoint-b', kind: 'websocket', label: 'Offline box', endpoint: 'ws://other-host' }
  ],
  preferredEndpointId: 'endpoint-b'
}

function runtimeInputs(capabilities: string[] = ['taskRecords.v1']) {
  return {
    pageRepo: PAGE_REPO,
    environments: [ENV_A],
    statusByEnvironment: new Map([
      [
        'env-a',
        {
          status: { runtimeId: 'remote-runtime', capabilities },
          appVersion: '1.4.219'
        }
      ]
    ]),
    catalogHydrated: true,
    catalogSettled: true
  }
}

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  clearTaskRecordRepoCatalogCacheForTests()
  runtimeEnvironmentCall.mockReset()
})

describe('useTaskRecordSources', () => {
  it('asks nothing remote for a task whose workspaces are all local', async () => {
    const local = record('local', 'wt-local')
    const { result } = renderHook(() =>
      useTaskRecordSources({
        query: QUERY,
        worktrees: [{ hostId: 'local' }],
        local,
        pageRepo: PAGE_REPO,
        environments: [],
        statusByEnvironment: new Map(),
        catalogHydrated: true,
        catalogSettled: true
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
        local: null,
        ...runtimeInputs()
      })
    )

    await waitFor(() => expect(result.current.pending).toBe(false))
    expect(runtimeEnvironmentCall.mock.calls.map((call) => call[0].method)).toEqual([
      'status.get',
      'repo.list',
      'taskRecords.get'
    ])
    expect(runtimeEnvironmentCall.mock.calls[2][0].params).toEqual({
      repoId: 'remote-repo-a',
      itemType: 'issue',
      number: 7
    })
    expect(result.current.record).toBe(remote)
    expect(result.current.recordSource).toEqual({
      environmentIds: ['env-a'],
      blocksFinalAbsence: true,
      answered: ['env-a'],
      unavailable: [],
      conflicts: [],
      pending: false
    })
  })

  it('keeps the local record when the environment is too old to answer', async () => {
    const local = record('local', 'wt-local')

    const { result } = renderHook(() =>
      useTaskRecordSources({
        query: QUERY,
        worktrees: [{ hostId: 'runtime:env-a' }],
        local,
        ...runtimeInputs([])
      })
    )

    await waitFor(() => expect(result.current.pending).toBe(false))
    expect(result.current.record).toBe(local)
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(result.current.recordSource?.unavailable).toEqual([
      {
        environmentId: 'env-a',
        failure: 'unsupported',
        label: 'Build box',
        appVersion: '1.4.219'
      }
    ])
    expect(result.current.recordSource?.blocksFinalAbsence).toBe(true)
  })

  it('reads an exact-id catalog match even when another environment catalog fails', async () => {
    const remote = record('runtime:env-a', 'wt-remote')
    runtimeEnvironmentCall.mockImplementation(
      ({ selector, method }: { selector: string; method: string }) => {
        const runtimeId = selector === 'env-a' ? 'remote-runtime' : 'remote-runtime-b'
        if (method === 'status.get') {
          return Promise.resolve({
            id: method,
            ok: true,
            result: {
              runtimeId,
              graphStatus: 'ready',
              runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
              minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
            },
            _meta: { runtimeId }
          })
        }
        if (selector === 'env-b' && method === 'repo.list') {
          return Promise.reject(new Error('offline'))
        }
        if (method === 'repo.list') {
          return Promise.resolve(envelope(method, { repos: [{ ...REMOTE_REPO, id: QUERY.repoId }] }))
        }
        return Promise.resolve(envelope(method, { record: remote, repoKnown: true }))
      }
    )
    const statusByEnvironment = new Map([
      ['env-a', { status: { runtimeId: 'remote-runtime', capabilities: ['taskRecords.v1'] } }],
      ['env-b', { status: { runtimeId: 'remote-runtime-b', capabilities: ['taskRecords.v1'] } }]
    ])

    const { result } = renderHook(() =>
      useTaskRecordSources({
        query: QUERY,
        worktrees: [],
        local: null,
        pageRepo: undefined,
        environments: [ENV_A, ENV_B],
        statusByEnvironment,
        catalogHydrated: true,
        catalogSettled: true
      })
    )

    await waitFor(() =>
      expect(
        runtimeEnvironmentCall.mock.calls.map(([request]) => [request.selector, request.method])
      ).toContainEqual(['env-a', 'taskRecords.get'])
    )
    await waitFor(() => expect(result.current.pending).toBe(false))
    const recordRead = runtimeEnvironmentCall.mock.calls.find(
      ([request]) => request.selector === 'env-a' && request.method === 'taskRecords.get'
    )
    expect(recordRead?.[0].params).toEqual({ repoId: QUERY.repoId, itemType: 'issue', number: 7 })
    expect(result.current.recordSource?.answered).toEqual(['env-a'])
    expect(result.current.recordSource?.unavailable).toEqual([
      { environmentId: 'env-b', failure: 'unreachable', label: 'Offline box' }
    ])
  })

  it('does not emit a no-guess notice for a local folder repository', async () => {
    serveRecords({ record: null, repoKnown: true })
    const folderRepo: Repo = {
      ...PAGE_REPO,
      kind: 'folder',
      gitRemoteIdentity: null
    }
    const { result } = renderHook(() =>
      useTaskRecordSources({
        query: QUERY,
        worktrees: [{ hostId: 'local' }],
        local: null,
        ...runtimeInputs(),
        pageRepo: folderRepo,
        providerIdentity: null
      })
    )

    await waitFor(() => expect(result.current.pending).toBe(false))
    expect(result.current.recordSource?.candidateFailure).toBeUndefined()
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
          bindings: [...local.bindings, recentBinding('wt-gone', 'runtime:env-a')]
        },
        ...runtimeInputs()
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

function recentBinding(
  worktreeId: string,
  hostId: TaskRecord['hostId']
): TaskRecord['bindings'][number] {
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

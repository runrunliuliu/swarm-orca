// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import {
  useIncidentSnapshot,
  useIncidentDetail
} from '@/components/right-sidebar/incidents/use-incident-panel'
import { useIncidentCounts } from '@/components/right-sidebar/use-incident-counts'
import {
  countsFixture,
  coverageFixture,
  detailFixture,
  listItemFixture
} from '@/components/right-sidebar/incidents/incident-panel-fixtures'
import type { IncidentCountsDto, IncidentSnapshotDto } from '../../../shared/incident-api-types'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: rpc,
  hasRuntimeRpcErrorCode: (error: unknown, code: string) =>
    error instanceof Error && error.message === code
}))

const initialState = useAppStore.getState()
const request = { limit: 200, status: 'untriaged' } as const
const snapshot: IncidentSnapshotDto = {
  incidents: [listItemFixture()],
  total: 1,
  coverage: coverageFixture(),
  source: { kind: 'local' },
  availability: 'supported'
}
const local = { snapshot: vi.fn(), detail: vi.fn(), counts: vi.fn(), onCountsChanged: vi.fn() }

function useReads() {
  return {
    list: useIncidentSnapshot(request, true),
    detail: useIncidentDetail('inc_fixture_1'),
    badge: useIncidentCounts()
  }
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) {
      await Promise.resolve()
    }
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  useAppStore.setState({
    settings: null,
    activeWorktreeId: 'repo::/work',
    activeWorkspaceExecutionHostId: 'runtime:peer',
    runtimeEnvironmentCatalogHydrated: false,
    removedRuntimeEnvironmentIds: new Set()
  })
  Reflect.set(window, 'api', { incidents: local })
  local.snapshot.mockResolvedValue({ ok: true, value: { ...snapshot, incidents: [], total: 0 } })
  local.detail.mockResolvedValue({ ok: true, value: detailFixture() })
  local.counts.mockResolvedValue({
    ok: true,
    value: countsFixture({ readAt: Date.now(), untriaged: 0 })
  })
  local.onCountsChanged.mockReturnValue(() => {})
  rpc.mockImplementation(async (_target, method: string) => {
    if (method === 'incidents.snapshot') {
      return snapshot
    }
    if (method === 'incidents.detail') {
      return detailFixture()
    }
    if (method === 'incidents.counts') {
      return countsFixture({ readAt: Date.now(), untriaged: 5 })
    }
    throw new Error('unexpected method')
  })
})

afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
  Reflect.deleteProperty(window, 'api')
})

describe('incident readers share workspace ownership', () => {
  it('reads list, decision detail and badge from a remote workspace with a null global environment', async () => {
    const { result } = renderHook(useReads)
    await settle()
    expect(result.current.list.snapshot?.incidents).toHaveLength(1)
    expect(result.current.detail.detail?.decisions).toHaveLength(1)
    expect(result.current.badge.counts?.untriaged).toBe(5)
    for (const method of ['incidents.snapshot', 'incidents.detail', 'incidents.counts']) {
      expect(rpc).toHaveBeenCalledWith(
        { kind: 'environment', environmentId: 'peer' },
        method,
        expect.any(Object)
      )
    }
    expect(result.current.list.snapshot?.source).toEqual({
      kind: 'environment',
      environmentId: 'peer'
    })
    expect(local.snapshot).not.toHaveBeenCalled()
    expect(local.detail).not.toHaveBeenCalled()
    expect(local.counts).not.toHaveBeenCalled()
    expect(local.onCountsChanged).not.toHaveBeenCalled()
  })

  it.each(['method_not_found', 'disconnected'])(
    'does not substitute the empty desktop store on %s',
    async (error) => {
      rpc.mockRejectedValue(new Error(error))
      const { result } = renderHook(useReads)
      await settle()
      expect(result.current.list.availability).toBe(
        error === 'method_not_found' ? 'unsupported' : 'unavailable'
      )
      expect(result.current.list.snapshot).toBeNull()
      expect(result.current.detail.detail).toBeNull()
      expect(result.current.badge).toEqual({ counts: null, availability: 'unavailable' })
      expect(local.snapshot).not.toHaveBeenCalled()
      expect(local.counts).not.toHaveBeenCalled()
    }
  )

  it.each(['ssh:connection', null] as const)(
    'never reads a local database for an unsupported or missing owner %s',
    async (host) => {
      useAppStore.setState({ activeWorktreeId: 'missing', activeWorkspaceExecutionHostId: host })
      const { result } = renderHook(useReads)
      await settle()
      expect(result.current.list.availability).toBe(host ? 'unsupported' : 'unavailable')
      expect(result.current.list.snapshot).toBeNull()
      expect(result.current.badge.counts).toBeNull()
      expect(rpc).not.toHaveBeenCalled()
      expect(local.snapshot).not.toHaveBeenCalled()
      expect(local.detail).not.toHaveBeenCalled()
      expect(local.counts).not.toHaveBeenCalled()
    }
  )

  it('clears all old data during a target switch and does not compare clocks across hosts', async () => {
    const { result } = renderHook(useReads)
    await settle()
    let resolveCounts: (value: IncidentCountsDto) => void = () => {
      throw new Error('not reading')
    }
    rpc.mockImplementation((_target, method: string) =>
      method === 'incidents.counts'
        ? new Promise<IncidentCountsDto>((resolve) => {
            resolveCounts = resolve
          })
        : new Promise(() => {})
    )
    await act(async () => {
      useAppStore.setState({ activeWorkspaceExecutionHostId: 'runtime:next' })
    })
    expect(result.current.list.snapshot).toBeNull()
    expect(result.current.detail.detail).toBeNull()
    expect(result.current.badge.counts).toBeNull()
    await act(async () => {
      resolveCounts(countsFixture({ untriaged: 2, readAt: Date.now() - 60_000 }))
    })
    expect(result.current.badge.counts?.untriaged).toBe(2)
  })

  it('ignores delayed responses from a previous runtime after switching to local', async () => {
    const pending: (() => void)[] = []
    rpc.mockImplementation(
      (_target, method: string) =>
        new Promise((resolve) => {
          pending.push(() =>
            resolve(
              method === 'incidents.snapshot'
                ? snapshot
                : method === 'incidents.detail'
                  ? detailFixture({ summary: 'OLD PEER' })
                  : countsFixture({ readAt: Date.now() + 60_000, untriaged: 99 })
            )
          )
        })
    )
    const { result } = renderHook(useReads)
    await act(async () => {
      useAppStore.setState({ activeWorkspaceExecutionHostId: 'local' })
    })
    await settle()
    await act(async () => {
      pending.forEach((resolve) => resolve())
    })
    expect(result.current.list.snapshot?.source).toEqual({ kind: 'local' })
    expect(result.current.list.snapshot?.incidents).toHaveLength(0)
    expect(result.current.detail.detail?.source).toEqual({ kind: 'local' })
    expect(result.current.detail.detail?.summary).not.toBe('OLD PEER')
    expect(result.current.badge.counts?.untriaged).toBe(0)
  })
})

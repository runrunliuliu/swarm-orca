// @vitest-environment happy-dom
/**
 * The renderer's read adapter (A-fix, 2026-11-16).
 *
 * Two properties matter more than the happy path: the answer is labelled with the host it came from, and
 * a host that does not serve the read is `unsupported` — never an empty store.
 */
import { describe, expect, it, vi } from 'vitest'

const callRuntimeRpc = vi.hoisted(() => vi.fn())
const hasRuntimeRpcErrorCode = vi.hoisted(() =>
  vi.fn((error: unknown, code: string) => (error as { code?: string })?.code === code)
)

vi.mock('./runtime-rpc-client', () => ({ callRuntimeRpc, hasRuntimeRpcErrorCode }))

const { readIncidentSnapshot, readIncidentCounts, readIncidentDetail, sourceForTarget } = await import(
  './incident-read-client'
)

// happy-dom so `window.api` exists: the local branch reads the bridge, not the socket.
const snapshot = {
  incidents: [],
  total: 0,
  coverage: { capacity: { rows: 0 } },
  source: { kind: 'local' },
  availability: 'store-not-created'
}

describe('incident read client', () => {
  it('reads the local window through the bridge, not the socket, and labels it local', async () => {
    const snapshotSpy = vi.fn(async () => ({ ok: true as const, value: snapshot }))
    ;(window as unknown as { api: unknown }).api = { incidents: { snapshot: snapshotSpy } }

    const outcome = await readIncidentSnapshot({ kind: 'local' }, { limit: 50 })

    expect(snapshotSpy).toHaveBeenCalledWith({ limit: 50 })
    expect(callRuntimeRpc).not.toHaveBeenCalled()
    if (outcome.availability !== 'supported') {
      throw new Error('expected a supported outcome')
    }
    expect(outcome.value.source).toEqual({ kind: 'local' })
  })

  it('re-stamps a remote answer with the environment it dialled', async () => {
    callRuntimeRpc.mockResolvedValueOnce(snapshot)

    const outcome = await readIncidentSnapshot({ kind: 'environment', environmentId: 'env-7' }, {})

    if (outcome.availability !== 'supported') {
      throw new Error('expected a supported outcome')
    }
    // The host says `local` because for it the store is local; the client is the side that knows where
    // the bytes came from, so its stamp is the one the panel prints.
    expect(outcome.value.source).toEqual({ kind: 'environment', environmentId: 'env-7' })
  })

  it('maps a host without the method to unsupported instead of an empty store', async () => {
    callRuntimeRpc.mockRejectedValueOnce({ code: 'method_not_found' })

    const outcome = await readIncidentCounts({ kind: 'environment', environmentId: 'env-old' })

    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-old' },
      'incidents.counts',
      {}
    )
    expect(outcome).toEqual({ availability: 'unsupported' })
  })

  it('reports a window without the local bridge as unsupported', async () => {
    ;(window as unknown as { api: unknown }).api = {}
    const before = callRuntimeRpc.mock.calls.length

    const outcome = await readIncidentSnapshot({ kind: 'local' }, {})

    expect(outcome).toEqual({ availability: 'unsupported' })
    // Why "no new calls": this case must never fall back to a remote read of the same method.
    expect(callRuntimeRpc.mock.calls.length).toBe(before)
  })

  it('maps every other failure to unavailable with its message', async () => {
    callRuntimeRpc.mockRejectedValueOnce(new Error('websocket closed'))

    const outcome = await readIncidentDetail({ kind: 'environment', environmentId: 'env-7' }, 'inc_1')

    expect(outcome).toEqual({ availability: 'unavailable', error: 'websocket closed' })
  })

  it('names the source it would stamp for each target', () => {
    expect(sourceForTarget({ kind: 'local' })).toEqual({ kind: 'local' })
    expect(sourceForTarget({ kind: 'environment', environmentId: 'env-1' })).toEqual({
      kind: 'environment',
      environmentId: 'env-1'
    })
  })
})

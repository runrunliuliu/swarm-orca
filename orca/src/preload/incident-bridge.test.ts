/**
 * The preload bridge (§12, M2 + M7-A): one `invoke` per channel, the exact channel names the main
 * handler registers, and the push bridge's subscribe/unsubscribe pairing.
 *
 * A rename on either side must fail here rather than in a renderer.
 */
import { describe, expect, it, vi } from 'vitest'

type InvokeFn = (channel: string, request?: unknown) => Promise<unknown>
type ListenerFn = (event: unknown, payload: unknown) => void

const invoke = vi.fn<InvokeFn>(async () => ({ ok: true, value: null }))
const on = vi.fn<(channel: string, listener: ListenerFn) => void>()
const removeListener = vi.fn<(channel: string, listener: ListenerFn) => void>()

vi.mock('electron', () => ({
  ipcRenderer: {
    invoke: (channel: string, request?: unknown) => invoke(channel, request),
    on: (channel: string, listener: ListenerFn) => on(channel, listener),
    removeListener: (channel: string, listener: ListenerFn) => removeListener(channel, listener)
  }
}))

const { incidentApi } = await import('./api/incident-bridge')

describe('incident preload bridge', () => {
  it('maps snapshot/detail/decide/counts/paneClocks/toolFailures onto the registered channels', async () => {
    await incidentApi.snapshot({ limit: 5 })
    await incidentApi.detail({ incidentId: 'inc_1' })
    await incidentApi.decide({ incidentId: 'inc_1', toStatus: 'watch', reason: 'r' })
    await incidentApi.counts({ topWorktrees: 3 })
    // The fact tables are their own read-only channels, so a panel refresh cannot silently reach a
    // write path.
    await incidentApi.paneClocks()
    await incidentApi.toolFailures()
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual([
      'incidents:snapshot',
      'incidents:detail',
      'incidents:decide',
      'incidents:counts',
      'incidents:paneClocks',
      'incidents:toolFailures'
    ])
    expect(invoke.mock.calls[0][1]).toEqual({ limit: 5 })
    expect(invoke.mock.calls[2][1]).toMatchObject({ incidentId: 'inc_1', toStatus: 'watch' })
    expect(invoke.mock.calls[3][1]).toEqual({ topWorktrees: 3 })
  })

  it('passes the main process result through unchanged (no throwing bridge)', async () => {
    invoke.mockResolvedValueOnce({
      ok: false,
      code: 'incident_store_unavailable',
      error: 'nope'
    })
    await expect(incidentApi.snapshot()).resolves.toEqual({
      ok: false,
      code: 'incident_store_unavailable',
      error: 'nope'
    })
  })

  it('subscribes to the coalesced counts push and detaches only its own listener', () => {
    const received: unknown[] = []
    const unsubscribe = incidentApi.onCountsChanged((counts) => received.push(counts))
    expect(on).toHaveBeenCalledTimes(1)
    const [channel, listener] = on.mock.calls[0]
    expect(channel).toBe('incidents:countsChanged')

    // The main handler has already coalesced, so the bridge forwards exactly what arrives.
    listener({}, { untriaged: 2, total: 3 })
    expect(received).toEqual([{ untriaged: 2, total: 3 }])

    unsubscribe()
    expect(removeListener).toHaveBeenCalledWith('incidents:countsChanged', listener)
    // Never `removeAllListeners`: a second component's subscription would be dropped too.
    expect(removeListener).toHaveBeenCalledTimes(1)
  })
})

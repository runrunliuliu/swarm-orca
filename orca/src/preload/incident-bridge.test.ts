/**
 * The preload bridge (§12, M2): one `invoke` per channel, and the exact channel names the main
 * handler registers. A rename on either side must fail here rather than in a renderer that does not
 * exist yet.
 */
import { describe, expect, it, vi } from 'vitest'

type InvokeFn = (channel: string, request?: unknown) => Promise<unknown>

const invoke = vi.fn<InvokeFn>(async () => ({ ok: true, value: null }))

vi.mock('electron', () => ({
  ipcRenderer: { invoke: (channel: string, request?: unknown) => invoke(channel, request) }
}))

const { incidentApi } = await import('./api/incident-bridge')

describe('incident preload bridge', () => {
  it('maps snapshot/detail/decide onto the registered channels', async () => {
    await incidentApi.snapshot({ limit: 5 })
    await incidentApi.detail({ incidentId: 'inc_1' })
    await incidentApi.decide({ incidentId: 'inc_1', toStatus: 'watch', reason: 'r' })
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual([
      'incidents:snapshot',
      'incidents:detail',
      'incidents:decide'
    ])
    expect(invoke.mock.calls[0][1]).toEqual({ limit: 5 })
    expect(invoke.mock.calls[2][1]).toMatchObject({ incidentId: 'inc_1', toStatus: 'watch' })
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
})

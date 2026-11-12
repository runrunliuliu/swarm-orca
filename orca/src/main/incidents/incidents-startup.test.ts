/**
 * The startup mount point's contract (§11.2, §14): one attempt per process, deferred off the
 * startup path, and every outcome visible as a log line instead of an exception.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  __resetIncidentShadowStartupForTests,
  reconcileIncidentShadowAtStartup,
  scheduleIncidentShadowReconcile
} from './incidents-startup'

afterEach(() => {
  vi.restoreAllMocks()
  __resetIncidentShadowStartupForTests()
})

describe('reconcileIncidentShadowAtStartup', () => {
  it('reports a missing user-data path instead of throwing or staying silent', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const result = reconcileIncidentShadowAtStartup({ userDataPath: null })
    expect(result).toEqual({ ran: false, reason: 'no_user_data_path' })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('shadow replay skipped')
  })

  it('attempts once per process, so a double mount cannot replay twice', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(reconcileIncidentShadowAtStartup({ userDataPath: null }).ran).toBe(false)
    expect(reconcileIncidentShadowAtStartup({ userDataPath: null })).toEqual({
      ran: false,
      reason: 'already_reconciled'
    })
  })
})

describe('scheduleIncidentShadowReconcile', () => {
  it('returns immediately and runs one deferred turn, never throwing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const started = Date.now()
    expect(() => scheduleIncidentShadowReconcile(null)).not.toThrow()
    // The call itself is a scheduling hop, not the work: no readable evidence it ran yet…
    expect(Date.now() - started).toBeLessThan(1000)
    // …until the event loop turns.
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(warn).toHaveBeenCalled()
  })
})

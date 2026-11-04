import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertRunitDown,
  assertServerMaintenanceStopped,
  serverPidFromMaintenanceEvidence
} from './administrative-maintenance-guard'

vi.mock('node:fs', () => ({ readFileSync: vi.fn() }))

describe('offline maintenance runit guard', () => {
  const down = () => {
    const status = Buffer.alloc(20)
    status[17] = 100
    return status
  }
  afterEach(() => vi.restoreAllMocks())
  it('accepts only a fully stopped service that wants down', () => {
    expect(() => assertRunitDown(down())).not.toThrow()
    for (const [index, value] of [
      [12, 1],
      [17, 117],
      [19, 1],
      [19, 2]
    ] as const) {
      const status = down()
      status[index] = value
      expect(() => assertRunitDown(status)).toThrow('service_not_down')
    }
  })
  it('refuses missing and incompatible status layouts', () => {
    for (const size of [0, 18, 19, 21]) {
      expect(() => assertRunitDown(Buffer.alloc(size))).toThrow('service_not_down')
    }
  })
  it('checks only the target service and native Orca PID, never the process table', () => {
    vi.mocked(readFileSync).mockReturnValue(down())
    const probe = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('absent'), { code: 'ESRCH' })
    })
    expect(() => assertServerMaintenanceStopped('/exact/orca-server', 12345)).not.toThrow()
    expect(probe.mock.calls).toEqual([[12345, 0]])
    expect(vi.mocked(readFileSync).mock.calls).toEqual([
      ['/exact/orca-server/supervise/status'],
      ['/exact/orca-server/supervise/status']
    ])
  })
  it('rejects a live or reused PID without sending a termination signal', () => {
    vi.mocked(readFileSync).mockReturnValue(down())
    const probe = vi.spyOn(process, 'kill').mockReturnValue(true)
    expect(() => assertServerMaintenanceStopped('/exact/orca-server', 12345)).toThrow(
      'server_process_present:12345'
    )
    expect(probe.mock.calls).toEqual([[12345, 0]])
  })
  it.each(['EPERM', 'EACCES', 'EIO', 'ENOENT'])('does not treat %s as PID absence', (code) => {
    vi.mocked(readFileSync).mockReturnValue(down())
    const error = Object.assign(new Error(code), { code })
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw error
    })
    expect(() => assertServerMaintenanceStopped('/exact/orca-server', 12345)).toThrow(error)
  })
  it('rejects an unreadable service status without probing processes', () => {
    const error = Object.assign(new Error('status denied'), { code: 'EACCES' })
    vi.mocked(readFileSync).mockImplementation(() => {
      throw error
    })
    const probe = vi.spyOn(process, 'kill')
    expect(() => assertServerMaintenanceStopped('/exact/orca-server', 12345)).toThrow(error)
    expect(probe).not.toHaveBeenCalled()
  })
  it('detects the service restarting during the PID check', () => {
    const running = down()
    running[19] = 1
    vi.mocked(readFileSync).mockReturnValueOnce(down()).mockReturnValueOnce(running)
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('absent'), { code: 'ESRCH' })
    })
    expect(() => assertServerMaintenanceStopped('/exact/orca-server', 12345)).toThrow(
      'service_not_down'
    )
  })
  it.each([0, 1, -1, 1.5, Number.NaN, Infinity, 2147483648])('rejects unsafe PID %s', (pid) => {
    const probe = vi.spyOn(process, 'kill')
    expect(() => assertServerMaintenanceStopped('/exact/orca-server', pid)).toThrow()
    expect(probe).not.toHaveBeenCalled()
  })
})

describe('native maintenance status evidence', () => {
  const evidence = () => ({
    runtime: {
      ok: true,
      result: {
        target: { kind: 'local' },
        app: { running: true, pid: 12345 },
        runtime: { state: 'ready', runtimeId: '11111111-1111-4111-8111-111111111111' }
      },
      _meta: { runtimeId: '11111111-1111-4111-8111-111111111111' }
    }
  })
  it('uses the application PID, not the runit wrapper or a supplied process list', () => {
    expect(serverPidFromMaintenanceEvidence(evidence())).toBe(12345)
  })
  it('rejects missing, remote, stopped, failed and inconsistent native status', () => {
    const remote = evidence()
    remote.runtime.result.target.kind = 'remote'
    const stopped = evidence()
    stopped.runtime.result.app.running = false
    const failed = evidence()
    failed.runtime.ok = false
    const mismatch = evidence()
    mismatch.runtime._meta.runtimeId = '22222222-2222-4222-8222-222222222222'
    for (const input of [{}, remote, stopped, failed, mismatch]) {
      expect(() => serverPidFromMaintenanceEvidence(input)).toThrow()
    }
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fenceStrictContinuityPtyController } from './strict-continuity-pty-controller'
import { strictCoordinatorHarness } from './rpc/strict-coordinator-test-fixture'
import { sealStrictContinuityDatabase } from './orchestration/strict-continuity-store'
import { sendWorktreeStartupFollowupWhenReady } from './runtime-worktree-startup-readiness'
import { WRITE_ACCEPTED } from '../../shared/pty-write-settlement'
import type { RuntimePtyController } from './runtime-pty-controller-contract'

describe('shared controller continuity fence', () => {
  let h: ReturnType<typeof strictCoordinatorHarness>
  let runId: string
  beforeEach(async () => {
    h = strictCoordinatorHarness()
    runId = await h.create()
  })
  afterEach(() => {
    h.close()
    vi.restoreAllMocks()
  })
  const seal = () =>
    sealStrictContinuityDatabase(h.db, {
      runId,
      sourceRuntimeId: h.runtime.getRuntimeId(),
      expiresAtMs: Date.now() + 60_000
    })
  function controller() {
    const raw = {
      write: vi.fn(() => true),
      kill: vi.fn(() => true),
      getForegroundProcess: vi.fn(async () => 'claude'),
      spawn: vi.fn(async () => ({ id: 'pty' })),
      resize: vi.fn(() => true),
      clearBuffer: vi.fn(async () => {}),
      resetInputModes: vi.fn(async () => {}),
      stopAndWait: vi.fn(async () => true),
      adoptStablePane: vi.fn(async () => null),
      claimStablePaneCreate: vi.fn(() => () => {}),
      retireRejectedPty: vi.fn(() => {}),
      recordUnconfirmedStop: vi.fn(() => true),
      writeWithSettlement: vi.fn(() => WRITE_ACCEPTED)
    } satisfies RuntimePtyController
    return { raw, fenced: fenceStrictContinuityPtyController(raw, () => h.db) }
  }

  it('fences direct write, settled write, spawn, resize, reset, clear and stop without provider effects', () => {
    const { raw, fenced } = controller()
    expect(fenced.write('pty', 'before', 'launch')).toBe(true)
    raw.write.mockClear()
    seal()
    for (const invoke of [
      () => fenced.write('pty', 'command', 'launch'),
      () => fenced.writeWithSettlement?.('pty', 'command', 'launch'),
      () => fenced.spawn?.({ cols: 80, rows: 24 }),
      () => fenced.resize?.('pty', 80, 24),
      () => fenced.clearBuffer?.('pty'),
      () => fenced.resetInputModes?.('pty'),
      () => fenced.kill('pty'),
      () => fenced.stopAndWait?.('pty'),
      () => fenced.retireRejectedPty?.('pty', false),
      () => fenced.recordUnconfirmedStop?.('pty'),
      () =>
        fenced.claimStablePaneCreate?.({
          worktreeId: 'folder',
          connectionId: null,
          tabId: 'tab',
          leafId: 'leaf'
        }),
      () =>
        fenced.adoptStablePane?.({
          cols: 80,
          rows: 24,
          worktreeId: 'folder',
          connectionId: null,
          preAllocatedHandle: 'handle',
          tabId: 'tab',
          leafId: 'leaf'
        })
    ]) {
      expect(invoke).toThrow('fenced')
    }
    for (const fn of Object.values(raw)) {
      expect(fn).not.toHaveBeenCalled()
    }
  })

  it('refuses seal until an in-flight spawn settles, without orphaning or repeating it', async () => {
    const { raw } = controller()
    let finish: (result: { id: string }) => void = () => {
      throw new Error('not started')
    }
    raw.spawn.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const fenced = fenceStrictContinuityPtyController(raw, () => h.db)
    const pending = fenced.spawn?.({ cols: 80, rows: 24 })
    expect(seal).toThrow('in flight')
    expect(h.db.db.prepare('SELECT * FROM strict_continuity_database').all()).toEqual([])
    finish({ id: 'pty' })
    await expect(pending).resolves.toEqual({ id: 'pty' })
    seal()
    expect(() => fenced.spawn?.({ cols: 80, rows: 24 })).toThrow('fenced')
    expect(raw.spawn).toHaveBeenCalledOnce()
  })

  it('rejects a startup follow-up that became ready after sealing', async () => {
    const { raw, fenced } = controller()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    sendWorktreeStartupFollowupWhenReady(
      {
        getPtyId: () => 'pty',
        getForegroundProcess: raw.getForegroundProcess,
        subscribeToData: () => () => {},
        readRecentOutput: () => undefined,
        write: fenced.write
      },
      'handle',
      { expectedProcess: 'claude', prompt: 'must not send' }
    )
    seal()
    await vi.waitFor(() => expect(warning).toHaveBeenCalled())
    expect(raw.write).not.toHaveBeenCalled()
  })

  it('releases rejected asynchronous effects and synchronous exceptions without clearing the fence', async () => {
    const { raw } = controller()
    raw.spawn.mockRejectedValue(new Error('spawn failed'))
    raw.write.mockImplementation(() => {
      throw new Error('write failed')
    })
    const fenced = fenceStrictContinuityPtyController(raw, () => h.db)
    await expect(fenced.spawn?.({ cols: 80, rows: 24 })).rejects.toThrow('spawn failed')
    expect(() => fenced.write('pty', 'text', 'launch')).toThrow('write failed')
    seal()
    expect(() => fenced.write('pty', 'text', 'launch')).toThrow('fenced')
  })
})

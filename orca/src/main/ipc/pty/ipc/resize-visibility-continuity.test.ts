import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { strictCoordinatorHarness } from '../../../runtime/rpc/strict-coordinator-test-fixture'
import { sealStrictContinuityDatabase } from '../../../runtime/orchestration/strict-continuity-store'
import { createPtyIpcSession } from '../session'
import { installPtyResizeVisibilityIpc } from './resize-visibility'
import { ptySizes } from '../delivery/visibility-state'
import type { PtyIpcSurface } from '../../pty-host-bindings'

const { ipc, provider } = vi.hoisted(() => ({
  ipc: {
    on: vi.fn(),
    handle: vi.fn(),
    removeHandler: vi.fn(),
    removeAllListeners: vi.fn()
  } satisfies PtyIpcSurface,
  provider: {
    resize: vi.fn(),
    sendSignal: vi.fn(async () => {}),
    clearBuffer: vi.fn(async () => {}),
    resetInputModes: vi.fn(async () => {})
  }
}))
vi.mock('../../pty-host-bindings', () => ({ getPtyIpc: () => ipc }))
vi.mock('../provider/registry', () => ({ tryGetProviderForPty: () => provider }))
vi.mock('./terminal-view-attributes-ipc', () => ({ installTerminalViewAttributesIpc: vi.fn() }))

describe('renderer terminal control continuity admission', () => {
  let h: ReturnType<typeof strictCoordinatorHarness>
  let runId: string
  beforeEach(async () => {
    vi.clearAllMocks()
    h = strictCoordinatorHarness()
    runId = await h.create()
    vi.spyOn(h.runtime, 'resetHeadlessTerminalInputModes').mockResolvedValue(undefined)
    installPtyResizeVisibilityIpc(createPtyIpcSession({ runtime: h.runtime }))
  })
  afterEach(() => {
    ptySizes.delete('control-pty')
    h.close()
    vi.restoreAllMocks()
  })

  it.each(['resize', 'signal', 'clearBuffer', 'resetInputModes'])(
    'allows ordinary %s, then refuses sealed requests before any provider effect',
    (operation) => {
      const listener = ipc.on.mock.calls.find(([channel]) => channel === `pty:${operation}`)?.[1]
      if (typeof listener !== 'function') {
        throw new Error(`missing ${operation} listener`)
      }
      const args = { id: 'control-pty', cols: 80, rows: 24, signal: 'SIGINT' }
      listener(null, args)
      expect(Object.values(provider).some((fn) => fn.mock.calls.length > 0)).toBe(true)
      vi.clearAllMocks()
      sealStrictContinuityDatabase(h.db, {
        runId,
        sourceRuntimeId: h.runtime.getRuntimeId(),
        expiresAtMs: Date.now() + 60_000
      })
      listener(null, args)
      for (const fn of Object.values(provider)) {
        expect(fn).not.toHaveBeenCalled()
      }
      expect(h.runtime.resetHeadlessTerminalInputModes).not.toHaveBeenCalled()
    }
  )
})

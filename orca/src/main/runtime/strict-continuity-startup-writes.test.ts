import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { strictCoordinatorHarness } from './rpc/strict-coordinator-test-fixture'
import { sealStrictContinuityDatabase } from './orchestration/strict-continuity-store'
import { sendWorktreeStartupFollowupWhenReady } from './runtime-worktree-startup-readiness'

const worktree = 'folder'
const tab = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const leaf = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

class StartupRuntime extends OrcaRuntimeService {
  prepareMobile() {
    this.pendingMobileTerminalCreatesByKey.set(`${worktree}::${tab}`, {
      activate: false,
      paired: true,
      selectIfNoActiveTab: false,
      startupCommand: 'claude'
    })
    this.registerPty('startup-pty', worktree, null, { tabId: tab, leafId: leaf })
  }
  recoverMobile() {
    this.deliverPendingStartupCommandToBareRendererPty(worktree, tab)
  }
  launchRecorded() {
    return this.terminalSpawnCommandsByPtyId.has('startup-pty')
  }
  provisioningHost() {
    return this.getWorktreeStartupReadinessHost()
  }
  startupMailRepoints = vi.fn()
  protected override scheduleRestoredMessageRepoints() {
    this.startupMailRepoints()
  }
}

describe('runtime startup write entry points', () => {
  let h: ReturnType<typeof strictCoordinatorHarness>
  let runtime: StartupRuntime
  let runId: string
  beforeEach(async () => {
    h = strictCoordinatorHarness()
    runId = await h.create()
    runtime = new StartupRuntime()
    runtime.setOrchestrationDb(h.db)
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

  it('keeps boot mail redrive deferred while reviewed recovery owns the pending action', () => {
    const relay = vi.spyOn(runtime, 'ensureOrchestrationFederationRelay')
    runtime.startupMailRepoints.mockClear()
    runtime.setOrchestrationDb(h.db, { deferStartupEffects: true })
    expect(runtime.getOrchestrationDb()).toBe(h.db)
    expect(runtime.startupMailRepoints).not.toHaveBeenCalled()
    expect(relay).not.toHaveBeenCalled()
    runtime.setOrchestrationDb(h.db)
    expect(runtime.startupMailRepoints).toHaveBeenCalledOnce()
    expect(relay).toHaveBeenCalledOnce()
  })

  it('blocks actual mobile recovery before command/Enter and does not mark the launch delivered', () => {
    const write = vi.fn(() => true)
    runtime.setPtyController({ write, kill: () => true, getForegroundProcess: async () => null })
    runtime.prepareMobile()
    seal()
    expect(() => runtime.recoverMobile()).toThrow('fenced')
    expect(write).not.toHaveBeenCalled()
    expect(runtime.launchRecorded()).toBe(false)
  })

  it('keeps ordinary mobile startup command and Enter delivery working', () => {
    const write = vi.fn(() => true)
    runtime.setPtyController({ write, kill: () => true, getForegroundProcess: async () => null })
    runtime.prepareMobile()
    runtime.recoverMobile()
    expect(write.mock.calls).toHaveLength(2)
    expect(runtime.launchRecorded()).toBe(true)
  })

  it('checks the current database when the controller was installed before database binding', () => {
    runtime = new StartupRuntime()
    const write = vi.fn(() => true)
    runtime.setPtyController({ write, kill: () => true, getForegroundProcess: async () => null })
    runtime.prepareMobile()
    runtime.setOrchestrationDb(h.db)
    seal()
    expect(() => runtime.recoverMobile()).toThrow('fenced')
    expect(write).not.toHaveBeenCalled()
    expect(runtime.launchRecorded()).toBe(false)
  })

  it('blocks the provisioning host callback after its asynchronous readiness check', async () => {
    const write = vi.fn(() => true)
    runtime.setPtyController({
      write,
      kill: () => true,
      getForegroundProcess: async () => 'claude'
    })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const host = runtime.provisioningHost()
    sendWorktreeStartupFollowupWhenReady({ ...host, getPtyId: () => 'startup-pty' }, 'handle', {
      expectedProcess: 'claude',
      prompt: 'must stay unsent'
    })
    seal()
    await vi.waitFor(() => expect(warning).toHaveBeenCalled())
    expect(write).not.toHaveBeenCalled()
  })
})

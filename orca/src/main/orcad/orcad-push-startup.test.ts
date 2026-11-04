import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeviceRegistry } from '../runtime/device-registry'
import { RuntimeMobileNotificationController } from '../runtime/runtime-mobile-notification-controller'
import { PushUnregisterOutbox } from '../runtime/push/push-unregister-outbox'
import { createPushHostKeypair } from '../runtime/push/push-host-challenge-fixtures'
import { acquireProfileStateMaintenance } from '../persistence/profile-state/profile-state-access'
import { profileStateAccessPaths } from '../persistence/profile-state/profile-state-access-owner'
import { agentHookServer } from '../agent-hooks/server'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import * as admission from './orcad-planned-successor'
import { plannedStartupFixture } from './orcad-startup-test-fixture'
import { withPlannedRestartRequest } from '../runtime/rpc/planned-restart-admission'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-types'

type RuntimeDeps = ConstructorParameters<typeof OrcaRuntimeService>[2]

const state = vi.hoisted(() => ({
  root: '',
  controller: null as RuntimeMobileNotificationController | null,
  registry: null as DeviceRegistry | null,
  rpcStarted: false,
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The optional deps start unset and are captured by the mocked constructor.
  runtimeDeps: undefined as RuntimeDeps,
  browserProvider: vi.fn(async () => null),
  profile: vi.fn(async () => {}),
  flush: vi.fn(async () => {}),
  freeze: vi.fn(async () => {}),
  pty: vi.fn(async () => {}),
  graph: vi.fn(() => {}),
  rpc: vi.fn(async () => {}),
  pairing: vi.fn(() => ({ available: false as const, reason: 'fixture', guidance: 'fixture' })),
  health: vi.fn(async () => ({})),
  publish: vi.fn(async () => {}),
  register: vi.fn(async () => ({ ok: true, registrationId: 'headless-registration' })),
  send: vi.fn(async () => ({ ok: true, results: [] }))
}))
vi.mock('./orcad-app-paths', () => ({
  resolveOrcadInstallRoot: () => state.root,
  resolveOrcadPath: () => state.root,
  resolveUserDataPath: () => state.root
}))
vi.mock('./orcad-browser-provider', () => ({ resolveOrcadBrowserProvider: state.browserProvider }))
vi.mock('./orcad-daemon-supervision', () => ({
  startOrcadDaemon: async () => {},
  stopOrcadDaemon: async () => {}
}))
vi.mock('./orcad-health', () => ({ collectOrcadHealth: state.health }))
vi.mock('../daemon/daemon-init', () => ({ daemonOwnsFreshPersistentPtys: () => false }))
vi.mock('../ipc/pty', () => ({
  registerHeadlessPtyRuntime: state.pty,
  getLocalPtyProvider: () => null,
  getSshPtyProvider: () => null
}))
vi.mock('./orcad-profile-state-startup', () => ({
  createOrcadProfileStateStartup: async () => {
    await state.profile()
    return {
      store: {
        getSettings: () => ({}),
        flushFinalOrThrowAsync: state.flush,
        freezeWritesAsync: state.freeze
      },
      authority: {
        backend: 'sqlite',
        classification: 'neither',
        authority_mode: 'sqlite-candidate',
        runtime: 'orcad',
        migrated: false
      }
    }
  }
}))
vi.mock('../orca-profiles/profile-index-store', () => ({
  initOrcaProfilePaths() {},
  ensureActiveOrcaProfile: () => ({
    dataFile: join(state.root, 'profile.json'),
    stateDatabaseFile: join(state.root, 'profile-state.db'),
    profile: { id: 'headless-profile' }
  })
}))
vi.mock('../ssh/ssh-host-key-store', () => ({ initSshHostKeyStoreFile() {} }))
vi.mock('../server/serve-readiness', () => ({
  ServeReadinessPublisher: class {
    publish = state.publish
  }
}))
vi.mock('../runtime/orca-runtime', () => ({
  OrcaRuntimeService: class {
    constructor(_store: unknown, _stats: unknown, deps: RuntimeDeps) {
      state.runtimeDeps = deps
    }
    getRuntimeId() {
      return state.runtimeDeps?.runtimeId ?? 'headless-runtime'
    }
    setOrchestrationDb() {}
    rehydrateClientHostedBrowserPages() {}
    async refreshRestoredOrchestrationAuthority() {}
    async reconcileLegacyWorkerTerminals() {}
    syncWindowGraph = state.graph
    setMobilePushRegistrar(
      registrar: Parameters<RuntimeMobileNotificationController['setPushRegistrar']>[0]
    ) {
      state.controller!.setPushRegistrar(registrar)
    }
    onNotificationDispatched(
      listener: Parameters<RuntimeMobileNotificationController['onDispatched']>[0]
    ) {
      return state.controller!.onDispatched(listener)
    }
  }
}))
vi.mock('../runtime/runtime-rpc', () => ({
  OrcaRuntimeRpcServer: class {
    async start() {
      await state.rpc()
      state.rpcStarted = true
    }
    async stop() {
      state.rpcStarted = false
    }
    getWebSocketEndpoint() {
      return null
    }
    createPairingOffer = state.pairing
    getE2EEKeypair() {
      expect(state.rpcStarted).toBe(true)
      return createPushHostKeypair()
    }
    getDeviceRegistry() {
      return state.registry
    }
    getPushUnregisterOutbox() {
      return new PushUnregisterOutbox(state.root)
    }
    setOnPushUnregisterQueued() {}
  }
}))
vi.mock('../runtime/push/push-gateway-client', () => ({
  PushGatewayClient: class {
    registerDevice = state.register
    send = state.send
    async deleteDevice() {
      return { deleted: true, retryable: false }
    }
  }
}))

afterEach(() => {
  rmSync(state.root, { recursive: true, force: true })
  state.runtimeDeps = undefined
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

it('refuses recovery overlap before initializing the browser provider or runtime', async () => {
  state.root = mkdtempSync(join(tmpdir(), 'orca-headless-recovery-'))
  const maintenance = acquireProfileStateMaintenance(state.root)
  const { startOrcad } = await import('./orcad-entry')
  try {
    await expect(startOrcad({ noPairing: true, json: true })).rejects.toThrow()
    expect(state.browserProvider).not.toHaveBeenCalled()
    expect(state.rpcStarted).toBe(false)
  } finally {
    maintenance.release()
  }
})

it('starts push after RPC identity is available and stops dispatch on shutdown', async () => {
  state.root = mkdtempSync(join(tmpdir(), 'orca-headless-push-'))
  state.controller = new RuntimeMobileNotificationController()
  state.registry = new DeviceRegistry(state.root)
  const phone = state.registry.addDevice('headless-phone', 'mobile')
  const { startOrcad } = await import('./orcad-entry')
  const host = await startOrcad({ noPairing: true, json: true })
  try {
    expect(state.graph).toHaveBeenCalledExactlyOnceWith(HEADLESS_RUNTIME_WINDOW_ID, {
      tabs: [],
      leaves: []
    })
    expect(state.pty.mock.invocationCallOrder[0]).toBeLessThan(
      state.graph.mock.invocationCallOrder[0]
    )
    expect(state.graph.mock.invocationCallOrder[0]).toBeLessThan(
      state.rpc.mock.invocationCallOrder[0]
    )
    const result = await state.controller.registerPushDevice({
      deviceId: phone.deviceId,
      platform: 'android',
      token: 'test-token',
      filter: {
        onlyWhenDesktopAway: true
      }
    })
    expect(result).toMatchObject({ registered: true })
    expect(state.registry.getDevice(phone.deviceId)?.pushRegistration?.expiresAt).toBeGreaterThan(
      Date.now()
    )
    state.controller.dispatch({
      type: 'notification',
      source: 'agent-task-complete',
      title: 'QA',
      body: 'QA'
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(state.send).toHaveBeenCalledTimes(1)
  } finally {
    await host.stop()
  }
  expect(readdirSync(profileStateAccessPaths(state.root).participants)).toEqual([])
  acquireProfileStateMaintenance(state.root).release()
  expect(state.controller.getListenerCount()).toBe(0)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Invalid input tests the unregistered short circuit after shutdown.
  expect(await state.controller.registerPushDevice({} as never)).toMatchObject({
    registered: false
  })
})

it('releases admission when host setup fails before a runtime exists', async () => {
  state.root = mkdtempSync(join(tmpdir(), 'orca-headless-setup-failure-'))
  state.browserProvider.mockRejectedValueOnce(new Error('browser setup failed'))
  const { startOrcad } = await import('./orcad-entry')
  await expect(startOrcad()).rejects.toThrow('browser setup failed')
  expect(readdirSync(profileStateAccessPaths(state.root).participants)).toEqual([])
  acquireProfileStateMaintenance(state.root).release()
})

it('wires restored hook attestation and retirement through the actual headless entry', async () => {
  state.root = mkdtempSync(join(tmpdir(), 'orca-headless-authority-'))
  state.controller = new RuntimeMobileNotificationController()
  state.registry = new DeviceRegistry(state.root)
  const candidate = {
    paneKey: 'tab:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    launchTokenHash: 'committed-hash',
    connectionId: null,
    terminalProvenance: 'restored'
  } as const
  const proof = { paneKey: candidate.paneKey, source: 'hydrated_commitment' } as const
  const attest = vi.spyOn(agentHookServer, 'attestCompatibilityAuthority').mockReturnValue(proof)
  const retire = vi.spyOn(agentHookServer, 'retirePaneAuthority').mockImplementation(() => {})
  const { startOrcad } = await import('./orcad-entry')
  const host = await startOrcad({ noPairing: true, json: true })
  try {
    expect(state.runtimeDeps?.attestAgentHookCompatibilityAuthority?.(candidate)).toBe(proof)
    expect(attest).toHaveBeenCalledExactlyOnceWith(candidate)
    attest.mockReturnValue(null)
    expect(state.runtimeDeps?.attestAgentHookCompatibilityAuthority?.(candidate)).toBeNull()
    state.runtimeDeps?.retireAgentHookCompatibilityAuthority?.(candidate.paneKey)
    expect(retire).toHaveBeenCalledExactlyOnceWith(candidate.paneKey)
  } finally {
    await host.stop()
  }
})

describe.runIf(process.platform === 'linux')('planned startup entry failure injection', () => {
  function fixture() {
    state.root = mkdtempSync(join(tmpdir(), 'orca-planned-entry-'))
    state.controller = new RuntimeMobileNotificationController()
    state.registry = new DeviceRegistry(state.root)
    return plannedStartupFixture(state.root, admission, async (runtime) => {
      expect(state.graph).toHaveBeenLastCalledWith(HEADLESS_RUNTIME_WINDOW_ID, {
        tabs: [],
        leaves: []
      })
      expect(state.rpcStarted).toBe(false)
      await expect(
        withPlannedRestartRequest(runtime, 'terminal.send', async () => {})
      ).rejects.toThrow('server_frozen')
    })
  }
  it.each(['browserProvider', 'profile', 'pty', 'graph', 'rpc', 'pairing'] as const)(
    'retries %s failure without flushing failed startup state',
    async (stage) => {
      const f = fixture()
      state[stage].mockImplementationOnce(() => {
        throw new Error(`fault:${stage}`)
      })
      const { startOrcad } = await import('./orcad-entry')
      await expect(startOrcad(f.options)).rejects.toThrow(`fault:${stage}`)
      expect(f.attempts[0].commit).not.toHaveBeenCalled()
      expect(f.attempts[0].close).toHaveBeenCalledOnce()
      expect(state.flush).not.toHaveBeenCalled()
      expect(state.freeze).toHaveBeenCalledTimes(
        ['browserProvider', 'profile'].includes(stage) ? 0 : 1
      )
      expect(state.rpcStarted).toBe(false)
      expect(readdirSync(profileStateAccessPaths(state.root).participants)).toEqual([])
      const host = await startOrcad(f.options)
      try {
        expect(f.admit).toHaveBeenCalledTimes(2)
        expect(host.readiness.runtimeId).toBe(f.attempts[1].runtimeId)
        expect(host.readiness.runtimeId).not.toBe(f.attempts[0].runtimeId)
        expect(f.attempts[1].commit).toHaveBeenCalledOnce()
      } finally {
        await host.stop()
      }
    }
  )
  it.each(['health', 'publish'] as const)(
    'keeps admission committed on %s reporting failure',
    async (stage) => {
      const f = fixture()
      state[stage].mockRejectedValueOnce(new Error(`fault:${stage}`))
      const log = vi.spyOn(console, 'error').mockImplementation(() => {})
      const { startOrcad } = await import('./orcad-entry')
      const host = await startOrcad(f.options)
      try {
        expect(f.admit).toHaveBeenCalledOnce()
        expect(f.attempts[0].commit).toHaveBeenCalledOnce()
        expect(f.attempts[0].close).not.toHaveBeenCalled()
        expect(state.rpcStarted).toBe(true)
        expect(log).toHaveBeenCalledWith(
          '[orcad] committed startup reporting failed:',
          expect.any(Error)
        )
      } finally {
        await host.stop()
      }
    }
  )
})

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, type ElectronApplication } from '@stablyai/playwright-test'
import { RuntimeClient } from '../../../../src/cli/runtime/client'
import { decodePairingOffer } from '../../../../src/shared/pairing'
import { getE2ECompletedOnboardingProfile } from '../e2e-completed-onboarding-profile'
import { getOrcaElectronLaunchArgs } from '../electron-launch-args'
import { cleanupE2EDaemons, closeElectronAppForE2E } from '../electron-process-shutdown'
import { createElectronHomeIsolation } from '../electron-home-isolation'
import { readPairingOffer, readServeReadiness } from '../headless-paired-runtime-serve-readiness'

export type SimRuntimeSpec = {
  name: string
  servePort?: number
  capabilities?: 'default' | 'none' | string[]
}

export type SimRuntime = {
  readonly name: string
  readonly baseUrl: string
  readonly userDataDir: string
  readonly pairingCode: string
  readonly client: RuntimeClient
  kill(): Promise<void>
  start(): Promise<void>
  dispose(): Promise<void>
}

type RuntimeController = {
  app: ElectronApplication | undefined
  disposed: boolean
  servePort: number
  startProcess(requirePairingOffer: boolean): Promise<string | undefined>
}

const claimedPorts = new Set<number>()

function validateName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(name) || name === '.' || name === '..') {
    throw new Error(`Invalid simulation runtime name: ${JSON.stringify(name)}`)
  }
}

async function claimServePort(requested = 0): Promise<number> {
  if (!Number.isInteger(requested) || requested < 0 || requested > 65_535) {
    throw new Error(`Invalid simulation runtime port: ${requested}`)
  }
  if (requested > 0 && claimedPorts.has(requested)) {
    throw new Error(`Simulation runtime port is unavailable: ${requested}`)
  }
  const probe = createServer()
  const port = await new Promise<number>((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(requested, '127.0.0.1', () => {
      const address = probe.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Loopback port probe returned no TCP address'))
      } else {
        resolve(address.port)
      }
    })
  }).finally(() => new Promise<void>((resolve) => probe.close(() => resolve())))
  if (claimedPorts.has(port)) {
    throw new Error(`Simulation runtime port is unavailable: ${port}`)
  }
  claimedPorts.add(port)
  return port
}

async function cleanupFailures(cleanups: (() => void | Promise<void>)[]): Promise<unknown[]> {
  const failures: unknown[] = []
  for (const cleanup of cleanups) {
    try {
      await cleanup()
    } catch (error) {
      failures.push(error)
    }
  }
  return failures
}

async function endpointIsClosed(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const finish = (closed: boolean): void => {
      socket.destroy()
      resolve(closed)
    }
    socket.setTimeout(250, () => finish(false))
    socket.once('connect', () => finish(false))
    socket.once('error', () => finish(true))
  })
}

async function waitForClosedEndpoint(port: number): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!(await endpointIsClosed(port))) {
    if (Date.now() >= deadline) {
      throw new Error(`Simulation runtime endpoint still accepts connections on 127.0.0.1:${port}`)
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
  }
}

function assertAdvertisedCapabilities(
  spec: SimRuntimeSpec,
  advertised: readonly string[] | undefined
): void {
  if (spec.capabilities === undefined || spec.capabilities === 'default') {
    return
  }
  const actual = [...(advertised ?? [])].sort()
  const expected = spec.capabilities === 'none' ? [] : [...spec.capabilities].sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Runtime capability replacement is unavailable without a product seam; requested ${JSON.stringify(expected)}, actual ${JSON.stringify(actual)}`
    )
  }
}

function definedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined)
  )
}

export async function startSimRuntime(spec: SimRuntimeSpec): Promise<SimRuntime> {
  validateName(spec.name)
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-sim-runtime-'))
  const userDataDir = path.join(rootDir, spec.name)
  mkdirSync(userDataDir)
  writeFileSync(
    path.join(userDataDir, 'orca-data.json'),
    `${JSON.stringify(getE2ECompletedOnboardingProfile(), null, 2)}\n`
  )
  let servePort: number | undefined
  let controller: RuntimeController | undefined
  try {
    servePort = await claimServePort(spec.servePort)
    const { ELECTRON_RUN_AS_NODE: _unused, ...cleanEnv } = process.env
    void _unused
    const isolation = createElectronHomeIsolation({
      inheritedEnv: cleanEnv,
      launchEnv: {
        NODE_ENV: 'development',
        ORCA_BACKGROUND_LAUNCH: '1',
        ORCA_E2E_ENFORCE_SINGLE_INSTANCE_LOCK: '1',
        ORCA_E2E_HEADLESS: '1'
      },
      extraEnv: {},
      userDataDir
    })
    const mainPath = path.join(process.cwd(), 'out', 'main', 'index.js')
    const createdController: RuntimeController = {
      app: undefined,
      disposed: false,
      servePort,
      startProcess: async (requirePairingOffer) => {
        let app: ElectronApplication | undefined
        try {
          app = await electron.launch({
            args: [
              ...getOrcaElectronLaunchArgs(mainPath, false),
              '--serve',
              '--serve-json',
              '--serve-port',
              String(servePort),
              '--serve-pairing-address',
              '127.0.0.1'
            ],
            env: definedEnvironment(isolation.env)
          })
          createdController.app = app
          const launchedApp = app
          if (requirePairingOffer) {
            const offer = await readPairingOffer(launchedApp)
            return offer.pairingUrl
          }
          await readServeReadiness(launchedApp, { requirePairingOffer: false })
          return undefined
        } catch (error) {
          createdController.app = undefined
          if (app) {
            try {
              await closeElectronAppForE2E(app)
            } catch (cleanupError) {
              throw new AggregateError(
                [error, cleanupError],
                `Simulation runtime ${spec.name} launch and cleanup failed`
              )
            }
          }
          throw error
        }
      }
    }
    controller = createdController
    const pairingCode = await createdController.startProcess(true)
    if (!pairingCode) {
      throw new Error('Simulation runtime returned no pairing code')
    }
    const offer = decodePairingOffer(pairingCode)
    const endpoint = new URL(offer.endpoint)
    if (endpoint.hostname !== '127.0.0.1' || Number(endpoint.port) !== servePort) {
      throw new Error(`Simulation runtime advertised an unexpected endpoint: ${offer.endpoint}`)
    }
    const client = new RuntimeClient(userDataDir, 5_000)
    const status = await client.call<{ capabilities?: string[] }>('status.get')
    assertAdvertisedCapabilities(spec, status.result.capabilities)

    let runtime: SimRuntime
    runtime = {
      name: spec.name,
      baseUrl: offer.endpoint,
      userDataDir,
      pairingCode,
      client,
      kill: async () => {
        if (!createdController.app) {
          await waitForClosedEndpoint(createdController.servePort)
          return
        }
        const app = createdController.app
        createdController.app = undefined
        await closeElectronAppForE2E(app)
        await waitForClosedEndpoint(createdController.servePort)
      },
      start: async () => {
        if (createdController.disposed) {
          throw new Error(`Simulation runtime ${spec.name} is disposed`)
        }
        if (createdController.app) {
          throw new Error(`Simulation runtime ${spec.name} is already running`)
        }
        await createdController.startProcess(false)
        const restarted = await client.call<{ capabilities?: string[] }>('status.get')
        assertAdvertisedCapabilities(spec, restarted.result.capabilities)
      },
      dispose: async () => {
        if (createdController.disposed) {
          return
        }
        createdController.disposed = true
        await runtime.kill()
        const failures = await cleanupFailures([
          () => cleanupE2EDaemons(userDataDir),
          () => rmSync(rootDir, { recursive: true, force: true })
        ])
        claimedPorts.delete(createdController.servePort)
        if (failures.length > 0) {
          throw new AggregateError(failures, `Failed to dispose simulation runtime ${spec.name}`)
        }
      }
    }
    return runtime
  } catch (error) {
    const app = controller?.app
    const failures = [
      error,
      ...(await cleanupFailures([
        ...(app ? [() => closeElectronAppForE2E(app)] : []),
        () => cleanupE2EDaemons(userDataDir),
        () => rmSync(rootDir, { recursive: true, force: true })
      ]))
    ]
    if (servePort !== undefined) {
      claimedPorts.delete(servePort)
    }
    throw failures.length === 1
      ? error
      : new AggregateError(failures, `Simulation runtime ${spec.name} startup failed`)
  }
}

export async function startSimRuntimes(specs: SimRuntimeSpec[]): Promise<SimRuntime[]> {
  if (specs.length === 0) {
    throw new Error('startSimRuntimes requires at least one runtime')
  }
  const names = new Set<string>()
  for (const spec of specs) {
    if (names.has(spec.name)) {
      throw new Error(`Duplicate simulation runtime name: ${spec.name}`)
    }
    names.add(spec.name)
  }
  const runtimes: SimRuntime[] = []
  try {
    for (const spec of specs) {
      runtimes.push(await startSimRuntime(spec))
    }
    return runtimes
  } catch (error) {
    const cleanup = await Promise.allSettled(runtimes.map((runtime) => runtime.dispose()))
    const failures = cleanup.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    )
    if (failures.length > 0) {
      throw new AggregateError(
        [error, ...failures],
        'Simulation runtime startup and cleanup failed'
      )
    }
    throw error
  }
}

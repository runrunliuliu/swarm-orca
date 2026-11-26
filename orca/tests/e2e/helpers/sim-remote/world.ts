import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RuntimeClient } from '../../../../src/cli/runtime/client'
import { decodePairingOffer, encodePairingOffer } from '../../../../src/shared/pairing'
import { startNetworkProxy, type NetworkFaults, type NetworkProxy } from './network-proxy'
import { seedTaskRecord } from './record-seeder'
import { startSimRuntimes, type SimRuntime, type SimRuntimeSpec } from './runtime-host'

type SeedTaskRecordArgs = Parameters<typeof seedTaskRecord>[1]
type RecordArgs =
  | SeedTaskRecordArgs
  | ((runtime: SimRuntime) => SeedTaskRecordArgs | Promise<SeedTaskRecordArgs>)

export type SimIdentity = {
  owner: string
  repo: string
  originUrl: string
  canonicalKey: string
  bareRepoPath: string
  worktreePath: string
  tracker: {
    state: 'open' | 'closed'
    url: string
    number: number
    title: string
  }
}

type IdentityMetadata = SimIdentity['tracker']
type IdentityModule = {
  prepareSimIdentity(args: {
    owner: string
    repo: string
    metadata?: IdentityMetadata
    root?: string
  }): Promise<SimIdentity>
}

export type SimulationSpec = {
  runtimes: SimRuntimeSpec[]
  network?: { target: string; faults?: NetworkFaults }
  identity?: { owner: string; repo: string; metadataFile?: string }
  records?: { runtime: string; args: RecordArgs }[]
}

export type Simulation = {
  runtimes: SimRuntime[]
  runtime(name: string): SimRuntime
  proxy?: NetworkProxy
  identity?: SimIdentity
  dispose(): Promise<void>
}

type Cleanup = () => void | Promise<void>

async function runCleanups(cleanups: readonly Cleanup[], message: string): Promise<void> {
  const failures: unknown[] = []
  for (const cleanup of cleanups) {
    try {
      await cleanup()
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, message)
  }
}

function requireNamedRuntime(
  runtimes: ReadonlyMap<string, SimRuntime>,
  name: string,
  purpose: string
): SimRuntime {
  const runtime = runtimes.get(name)
  if (!runtime) {
    throw new Error(`Unknown simulation runtime ${JSON.stringify(name)} for ${purpose}`)
  }
  return runtime
}

function readIdentityMetadata(metadataFile: string | undefined): IdentityMetadata | undefined {
  if (!metadataFile) {
    return undefined
  }
  const value: unknown = JSON.parse(readFileSync(metadataFile, 'utf8'))
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Simulation identity metadata is not an object: ${metadataFile}`)
  }
  const state = Reflect.get(value, 'state')
  const url = Reflect.get(value, 'url')
  const number = Reflect.get(value, 'number')
  const title = Reflect.get(value, 'title')
  if (
    (state !== 'open' && state !== 'closed') ||
    typeof url !== 'string' ||
    typeof number !== 'number' ||
    !Number.isInteger(number) ||
    typeof title !== 'string'
  ) {
    throw new Error(`Simulation identity metadata has an invalid tracker shape: ${metadataFile}`)
  }
  return { state, url, number, title }
}

function isIdentityModule(value: unknown): value is IdentityModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'prepareSimIdentity') === 'function'
  )
}

async function prepareIdentity(
  spec: NonNullable<SimulationSpec['identity']>,
  root: string
): Promise<SimIdentity> {
  const identityModulePath: string = './identity'
  const identityModule: unknown = await import(/* @vite-ignore */ identityModulePath)
  if (!isIdentityModule(identityModule)) {
    throw new Error('Simulation identity module does not export prepareSimIdentity')
  }
  const metadata = readIdentityMetadata(spec.metadataFile)
  return await identityModule.prepareSimIdentity({
    owner: spec.owner,
    repo: spec.repo,
    ...(metadata ? { metadata } : {}),
    root
  })
}

function proxiedRuntime(runtime: SimRuntime, proxy: NetworkProxy): SimRuntime {
  const endpoint = new URL(runtime.baseUrl)
  endpoint.hostname = '127.0.0.1'
  endpoint.port = String(proxy.listenPort)
  const offer = decodePairingOffer(runtime.pairingCode)
  const pairingCode = encodePairingOffer({ ...offer, endpoint: endpoint.toString() })
  return {
    name: runtime.name,
    baseUrl: endpoint.toString(),
    userDataDir: runtime.userDataDir,
    pairingCode,
    client: new RuntimeClient(runtime.userDataDir, 5_000, pairingCode, null),
    kill: () => runtime.kill(),
    start: () => runtime.start(),
    dispose: () => runtime.dispose()
  }
}

export async function startSimulation(spec: SimulationSpec): Promise<Simulation> {
  const cleanupStack: Cleanup[] = []
  let identity: SimIdentity | undefined
  let rawRuntimes: SimRuntime[] = []
  let proxy: NetworkProxy | undefined
  try {
    if (spec.identity) {
      const identityRoot = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-sim-identity-'))
      cleanupStack.push(() => rmSync(identityRoot, { recursive: true, force: true }))
      identity = await prepareIdentity(spec.identity, identityRoot)
    }

    rawRuntimes = await startSimRuntimes(spec.runtimes)
    cleanupStack.push(...rawRuntimes.map((runtime) => () => runtime.dispose()))
    const rawByName = new Map(rawRuntimes.map((runtime) => [runtime.name, runtime]))

    for (const record of spec.records ?? []) {
      const runtime = requireNamedRuntime(rawByName, record.runtime, 'record seeding')
      const args = typeof record.args === 'function' ? await record.args(runtime) : record.args
      await seedTaskRecord(runtime, args)
    }

    let publicRuntimes = rawRuntimes
    if (spec.network) {
      const target = requireNamedRuntime(rawByName, spec.network.target, 'network proxy')
      const targetPort = Number(new URL(target.baseUrl).port)
      proxy = await startNetworkProxy({ targetPort, faults: spec.network.faults })
      cleanupStack.push(() => proxy?.dispose())
      publicRuntimes = rawRuntimes.map((runtime) =>
        runtime.name === target.name && proxy ? proxiedRuntime(runtime, proxy) : runtime
      )
    }

    const publicByName = new Map(publicRuntimes.map((runtime) => [runtime.name, runtime]))
    let disposePromise: Promise<void> | undefined
    return {
      runtimes: publicRuntimes,
      runtime: (name) => requireNamedRuntime(publicByName, name, 'runtime lookup'),
      ...(proxy ? { proxy } : {}),
      ...(identity ? { identity } : {}),
      dispose: () => {
        disposePromise ??= runCleanups([...cleanupStack].toReversed(), 'Simulation teardown failed')
        return disposePromise
      }
    }
  } catch (error) {
    try {
      await runCleanups([...cleanupStack].toReversed(), 'Simulation startup cleanup failed')
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Simulation startup and cleanup failed')
    }
    throw error
  }
}

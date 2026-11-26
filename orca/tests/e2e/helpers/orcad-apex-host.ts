import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RuntimeClient } from '../../../src/cli/runtime/client'
import {
  isAgentHookEndpointFileName,
  parseAgentHookEndpointFile,
  type AgentHookEndpoint
} from '../../../src/shared/agent-hook-endpoint-file'
import { parseHeadlessPairedRuntimePairingOffer } from './headless-paired-runtime-serve-readiness'

/**
 * A **real headless `orcad` apex** (`out/orcad/orcad.js` under the bundled bun runtime), started on
 * an isolated profile for one e2e case.
 *
 * Why this exists beside `headless-paired-runtime-host.ts`: that helper starts the *Electron* app in
 * `--serve` mode, i.e. `out/main/index.js`, which assembles the desktop observers. Issue #68 is about
 * the headless composition root having no live-run writer at all, so a test built on the Electron
 * host is structurally green whatever the fix does. Only the `orcad` entry can answer it.
 *
 * Isolation (the machine running these tests also serves a production orcad on `127.0.0.1:6768` with
 * `ORCA_USER_DATA=/home/tiger/.local/state/orca-server/config/orca`):
 * - `ORCA_USER_DATA` → a fresh temp dir, so no profile is read or written;
 * - `HOME` → a fresh temp dir, so agent-hook installers and `~/.local/bin` dispatchers stay local;
 * - `ORCA_BUILD_POINTER_PATH` → a temp file, because `orcad-entry.ts` publishes the machine-wide
 *   `/opt/orca/current` pointer on Linux unless `shared/build-pointer.ts:110` is redirected;
 * - `--port 0`, so the kernel picks a free port instead of colliding with the production listener.
 */
export type OrcadApexHost = {
  readonly apexDir: string
  readonly bunRuntimePath: string
  readonly orcadEntryPath: string
  /** `/orca_server_ready` line decoded: the pairing offer a desktop client would consume. */
  readonly offer: { pairingUrl: string; webClientUrl?: string }
  readonly readiness: Record<string, unknown>
  readonly userDataDir: string
  readonly homeDir: string
  readonly buildPointerPath: string
  readonly client: RuntimeClient
  /** Everything the host wrote to stdout/stderr so far, for attaching as failure evidence. */
  output(): string
  /** SIGTERM the host, wait for exit, and start a replacement on the same profile. */
  restart(): Promise<void>
  dispose(): Promise<void>
}

/** Where the apex under test lives. The red/green switch of issue #68 is exactly this variable. */
export function resolveOrcadApexDir(explicit?: string): string {
  const apexDir =
    explicit ?? process.env.ORCA_E2E_ORCAD_APEX ?? path.join(process.cwd(), 'out', 'orcad')
  const orcadEntryPath = path.join(apexDir, 'orcad.js')
  if (!existsSync(orcadEntryPath)) {
    throw new Error(
      `No orcad apex at ${orcadEntryPath}: build with \`pnpm build:orcad\` or point ORCA_E2E_ORCAD_APEX at a built artifact`
    )
  }
  return apexDir
}

function findEndpointEnvFile(root: string): string | null {
  if (!existsSync(root)) {
    return null
  }
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isFile() && isAgentHookEndpointFileName(entry.name)) {
      return fullPath
    }
    if (entry.isDirectory()) {
      const nested = findEndpointEnvFile(fullPath)
      if (nested) {
        return nested
      }
    }
  }
  return null
}

/**
 * The orcad hook endpoint, read off the profile instead of off an Electron app: the server writes
 * `<userData>/agent-hooks[/<namespace>]/endpoint.env` (`server-runtime-env.ts:55-59`), and a POST to
 * `http://127.0.0.1:<port>/hook/<agent>` with `X-Orca-Agent-Hook-Token` is the same wire shape a real
 * agent produces.
 */
export function readOrcadHookEndpoint(userDataDir: string): AgentHookEndpoint | null {
  const endpointPath = findEndpointEnvFile(path.join(userDataDir, 'agent-hooks'))
  return endpointPath ? parseAgentHookEndpointFile(readFileSync(endpointPath, 'utf8')) : null
}

export async function waitForOrcadHookEndpoint(
  userDataDir: string,
  timeoutMs = 30_000
): Promise<AgentHookEndpoint> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const endpoint = readOrcadHookEndpoint(userDataDir)
    if (endpoint) {
      return endpoint
    }
    if (Date.now() > deadline) {
      throw new Error(`Agent hook endpoint file not found under ${userDataDir}/agent-hooks`)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

type StartOptions = {
  apexDir?: string
  /** Root for the profile/home/pointer temp dirs; removed by `dispose()`. */
  userDataParent?: string
}

type HostInternals = {
  child: ChildProcess
  stdout: string
  stderr: string
}

function spawnApex(args: {
  apexDir: string
  bunRuntimePath: string
  orcadEntryPath: string
  userDataDir: string
  homeDir: string
  buildPointerPath: string
  onLine: (line: string) => void
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void
}): ChildProcess {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: args.homeDir,
    XDG_DATA_HOME: path.join(args.homeDir, '.local', 'share'),
    XDG_CONFIG_HOME: path.join(args.homeDir, '.config'),
    XDG_CACHE_HOME: path.join(args.homeDir, '.cache'),
    ORCA_USER_DATA: args.userDataDir,
    ORCA_BUILD_POINTER_PATH: args.buildPointerPath,
    ORCA_E2E_ORCAD_APEX_CHILD: '1'
  }
  // The apex needs no display; clearing it keeps a Chromium-less host from inheriting a stale one.
  delete env.DISPLAY
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(
    args.bunRuntimePath,
    [
      args.orcadEntryPath,
      '--bind',
      '127.0.0.1',
      '--port',
      '0',
      '--pairing-address',
      '127.0.0.1',
      '--json'
    ],
    { env, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  let buffered = ''
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    buffered += chunk
    for (let index = buffered.indexOf('\n'); index >= 0; index = buffered.indexOf('\n')) {
      const line = buffered.slice(0, index)
      buffered = buffered.slice(index + 1)
      args.onLine(line)
    }
  })
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', () => undefined)
  child.once('exit', args.onExit)
  return child
}

export async function startOrcadApex(options: StartOptions = {}): Promise<OrcadApexHost> {
  const apexDir = resolveOrcadApexDir(options.apexDir)
  const bunRuntimePath = path.join(apexDir, 'bun-runtime')
  const orcadEntryPath = path.join(apexDir, 'orcad.js')
  if (!existsSync(bunRuntimePath)) {
    throw new Error(
      `No bun runtime at ${bunRuntimePath}: the orcad apex must run under bun (Bun.Terminal), not node`
    )
  }
  const root = mkdtempSync(path.join(options.userDataParent ?? os.tmpdir(), 'orca-e2e-orcad-apex-'))
  const userDataDir = path.join(root, 'userdata')
  const homeDir = path.join(root, 'home')
  const buildPointerPath = path.join(root, 'build-pointer.json')
  // The profile dir must exist but be empty: `orcad` establishes its own sqlite authority, and
  // `restart()` relaunches on the same directory without wiping what the first host flushed.
  mkdirSync(userDataDir, { recursive: true })
  mkdirSync(homeDir, { recursive: true })

  const outputs: HostInternals[] = []
  let ready: {
    readiness: Record<string, unknown>
    offer: { pairingUrl: string; webClientUrl?: string }
  } | null = null
  let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null

  const launch = async (): Promise<{
    readiness: Record<string, unknown>
    offer: { pairingUrl: string; webClientUrl?: string }
  }> => {
    ready = null
    exitInfo = null
    const internals: HostInternals = {
      child: null as unknown as ChildProcess,
      stdout: '',
      stderr: ''
    }
    outputs.push(internals)
    internals.child = spawnApex({
      apexDir,
      bunRuntimePath,
      orcadEntryPath,
      userDataDir,
      homeDir,
      buildPointerPath,
      onLine: (line) => {
        internals.stdout += `${line}\n`
        const offer = parseHeadlessPairedRuntimePairingOffer(line)
        if (offer && !ready) {
          let parsed: unknown = null
          try {
            parsed = JSON.parse(line) as unknown
          } catch {
            parsed = null
          }
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the readiness line is parsed, not trusted.
          ready = { readiness: (parsed ?? {}) as Record<string, unknown>, offer }
        }
      },
      onExit: (code, signal) => {
        exitInfo = { code, signal }
      }
    })
    internals.child.stderr?.setEncoding('utf8')
    internals.child.stderr?.on('data', (chunk: string) => {
      internals.stderr += chunk
    })
    const deadline = Date.now() + 60_000
    while (!ready) {
      if (exitInfo) {
        throw new Error(
          `orcad apex exited before readiness (${JSON.stringify(exitInfo)}):\n${outputs
            .map((entry) => `${entry.stdout}${entry.stderr}`)
            .join('\n')}`
        )
      }
      if (Date.now() > deadline) {
        throw new Error(
          `orcad apex never published readiness from ${apexDir}:\n${outputs
            .map((entry) => `${entry.stdout}${entry.stderr}`)
            .join('\n')}`
        )
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return ready
  }

  const startedReady = await launch()

  const stopCurrent = async (): Promise<void> => {
    const current = outputs.at(-1)
    if (!current || exitInfo) {
      return
    }
    const child = current.child
    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => resolve())
    })
    child.kill('SIGTERM')
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
    }, 20_000)
    await exited
    clearTimeout(timer)
  }

  return {
    apexDir,
    bunRuntimePath,
    orcadEntryPath,
    offer: startedReady.offer,
    readiness: startedReady.readiness,
    userDataDir,
    homeDir,
    buildPointerPath,
    client: new RuntimeClient(userDataDir, 30_000),
    output: () =>
      outputs.map((entry) => `[stdout]\n${entry.stdout}[stderr]\n${entry.stderr}`).join('\n'),
    restart: async () => {
      await stopCurrent()
      await launch()
    },
    dispose: async () => {
      await stopCurrent()
      rmSync(root, { recursive: true, force: true })
    }
  }
}

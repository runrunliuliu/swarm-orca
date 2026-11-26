import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { parseHeadlessPairedRuntimePairingOffer } from './headless-paired-runtime-serve-readiness'

/**
 * Process ownership for one `orcad` apex: spawn it, wait for its readiness line, and stop it in a
 * way that can prove the process is gone.
 *
 * Why the termination lives here rather than at the call site: a launch that never becomes ready must
 * still be reclaimed before its temp root is deleted, so "kill and confirm the exit" is a step every
 * failure path needs, not something only `dispose()` may use.
 */

export type ApexExit = { code: number | null; signal: NodeJS.Signals | null }

export type ApexReadiness = {
  readiness: Record<string, unknown>
  offer: { pairingUrl: string; webClientUrl?: string }
}

/** Test seam: the unit test replaces the child process so startup failures stay deterministic. */
export type ApexChildSpawn = (request: {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
}) => ChildProcess

export type LaunchedApex = {
  child: ChildProcess
  stdout: string
  stderr: string
  exit: ApexExit | null
  /**
   * A **spawn failure**: the OS never created a process (`ENOENT`/`EACCES`), so no `exit` will ever
   * arrive. This — and only this — may be read as "the child is gone".
   */
  spawnError: Error | null
  /**
   * An `error` that arrived **after** the process existed: a failed `kill` or a failed IPC message.
   * Node documents that only the process's `exit` proves it is gone, so this is evidence, not an exit.
   */
  controlError: Error | null
  /** True once the process exists (the `spawn` event, or a `pid` assigned by a successful spawn). */
  started: boolean
  ready: ApexReadiness | null
  /** Settles on `exit`, or on a spawn failure (where there is no process to wait for). */
  exited: Promise<void>
  settleExited: () => void
}

const SIGKILL_GRACE_MS = 5_000

function createLaunched(child: ChildProcess): LaunchedApex {
  let settle: () => void = () => undefined
  const exited = new Promise<void>((resolve) => {
    settle = resolve
  })
  return {
    child,
    stdout: '',
    stderr: '',
    exit: null,
    spawnError: null,
    controlError: null,
    started: typeof child.pid === 'number',
    ready: null,
    exited,
    settleExited: settle
  }
}

function wireApexChild(state: LaunchedApex, onLine: (line: string) => void): void {
  const child = state.child
  let buffered = ''
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    buffered += chunk
    for (let index = buffered.indexOf('\n'); index >= 0; index = buffered.indexOf('\n')) {
      const line = buffered.slice(0, index)
      buffered = buffered.slice(index + 1)
      state.stdout += `${line}\n`
      onLine(line)
    }
  })
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => {
    state.stderr += chunk
  })
  child.once('spawn', () => {
    state.started = true
  })
  child.once('exit', (code, signal) => {
    state.exit = { code, signal }
    state.settleExited()
  })
  // Why: EACCES/ENOEXEC never emit `exit`, so without this the readiness wait would spin for the
  // whole timeout and then report a missing readiness line instead of the spawn failure. But an
  // `error` also reports a failed `kill` on a live child (`node:child_process` documents both), and
  // treating *that* as an exit would let a stop "succeed" on a process that is still running. The
  // discriminating fact is whether a process ever existed: a successful spawn assigns `pid` (and
  // emits `spawn`), a spawn failure has neither.
  child.on('error', (error: Error) => {
    if (state.started || typeof child.pid === 'number') {
      state.controlError = error
      return
    }
    state.spawnError = error
    state.settleExited()
  })
}

function apexEnv(request: {
  userDataDir: string
  homeDir: string
  buildPointerPath: string
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: request.homeDir,
    XDG_DATA_HOME: path.join(request.homeDir, '.local', 'share'),
    XDG_CONFIG_HOME: path.join(request.homeDir, '.config'),
    XDG_CACHE_HOME: path.join(request.homeDir, '.cache'),
    ORCA_USER_DATA: request.userDataDir,
    ORCA_BUILD_POINTER_PATH: request.buildPointerPath,
    ORCA_E2E_ORCAD_APEX_CHILD: '1'
  }
  // The apex needs no display; clearing it keeps a Chromium-less host from inheriting a stale one.
  delete env.DISPLAY
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

const defaultSpawnApexChild: ApexChildSpawn = (request) =>
  spawn(request.command, request.args, { env: request.env, stdio: ['ignore', 'pipe', 'pipe'] })

export function spawnApexChild(request: {
  apexDir: string
  userDataDir: string
  homeDir: string
  buildPointerPath: string
  spawn?: ApexChildSpawn
}): LaunchedApex {
  const child = (request.spawn ?? defaultSpawnApexChild)({
    command: path.join(request.apexDir, 'bun-runtime'),
    args: [
      path.join(request.apexDir, 'orcad.js'),
      '--bind',
      '127.0.0.1',
      '--port',
      '0',
      '--pairing-address',
      '127.0.0.1',
      '--json'
    ],
    env: apexEnv(request)
  })
  const state = createLaunched(child)
  wireApexChild(state, (line) => {
    const offer = parseHeadlessPairedRuntimePairingOffer(line)
    if (!offer || state.ready) {
      return
    }
    let parsed: unknown = null
    try {
      parsed = JSON.parse(line) as unknown
    } catch {
      parsed = null
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the readiness line is parsed, not trusted.
    state.ready = { readiness: (parsed ?? {}) as Record<string, unknown>, offer }
  })
  return state
}

/** Wait for the `orca_server_ready` line; a spawn error or an exit is reported as itself. */
export async function awaitApexReadiness(
  state: LaunchedApex,
  options: { apexDir: string; timeoutMs: number; output: () => string }
): Promise<ApexReadiness> {
  const deadline = Date.now() + options.timeoutMs
  for (;;) {
    if (state.ready) {
      return state.ready
    }
    if (state.spawnError) {
      throw new Error(
        `orcad apex failed to spawn from ${options.apexDir}: ${state.spawnError.message}`,
        { cause: state.spawnError }
      )
    }
    if (state.exit) {
      throw new Error(
        `orcad apex exited before readiness (${JSON.stringify(state.exit)}):\n${options.output()}`
      )
    }
    if (Date.now() > deadline) {
      // A live child that keeps failing to accept signals is worth naming: otherwise the timeout
      // reads like a slow start while the real story is "this pid is unresponsive".
      const control = state.controlError
        ? `\nsignalling reported: ${state.controlError.message}`
        : ''
      throw new Error(
        `orcad apex never published readiness from ${options.apexDir} within ${options.timeoutMs}ms${control}:\n${options.output()}`
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/**
 * True once the child is gone (or never started) — proven by `exit` or by a spawn failure, never by
 * an `error` that only means a signal could not be delivered. At most `timeoutMs` of waiting.
 */
async function waitForExit(state: LaunchedApex, timeoutMs: number): Promise<boolean> {
  if (state.exit || state.spawnError) {
    return true
  }
  let timer: NodeJS.Timeout | null = null
  const timedOut = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs)
    timer.unref()
  })
  const result = await Promise.race([state.exited.then(() => true), timedOut])
  if (timer) {
    clearTimeout(timer)
  }
  return result
}

/**
 * Stop one child and **prove it is gone**: SIGTERM, then SIGKILL after the grace window. A stop that
 * cannot confirm the exit throws, so the caller keeps the temp root for inspection instead of
 * deleting a directory an orphan process may still be writing into. `killGraceMs` is injectable so
 * the unit test can exercise the escalation without waiting the production five seconds.
 */
export async function terminateApexChild(
  state: LaunchedApex,
  graceMs: number,
  killGraceMs: number = SIGKILL_GRACE_MS
): Promise<void> {
  if (state.exit || state.spawnError) {
    return
  }
  try {
    state.child.kill('SIGTERM')
  } catch {
    // Already gone; the exit event below settles the wait.
  }
  if (await waitForExit(state, graceMs)) {
    return
  }
  try {
    state.child.kill('SIGKILL')
  } catch {
    // Same: the exit event (if any) settles the wait.
  }
  if (await waitForExit(state, killGraceMs)) {
    return
  }
  const control = state.controlError
    ? `; signalling reported: ${state.controlError.message}`
    : ''
  throw new Error(
    `orcad apex did not exit after SIGTERM+${graceMs}ms and SIGKILL+${killGraceMs}ms (pid ${String(state.child.pid)})${control}`
  )
}

import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMetadata, RuntimeTransportMetadata } from '../../shared/runtime-bootstrap'
import { formatCliError, reportCliError } from '../cli-error'
import { callOrchestrationMutation } from '../handlers/orchestration/mutation-request'
import { RuntimeClient } from './client'
import { launchOrcaApp } from './launch'
import { getCliStatus } from './status'
import { sendRequest } from './transport'

const { connect, tryReadMetadata } = vi.hoisted(() => ({
  connect: vi.fn(),
  tryReadMetadata: vi.fn()
}))
// Why: keep the real createServer — the endpoint-presence cases need a real unix socket — while
// faking the connect, because no test can make a real socket answer EPERM.
vi.mock('node:net', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createConnection: connect
}))
vi.mock('./metadata', () => ({ tryReadMetadata, readMetadata: tryReadMetadata }))
vi.mock('./launch', () => ({ launchOrcaApp: vi.fn() }))
vi.mock('./runtime-remote-pairing', () => ({ resolveRemotePairing: () => null }))

const metadata: RuntimeMetadata = {
  runtimeId: 'runtime-test',
  pid: 12345,
  transports: [{ kind: 'unix', endpoint: '/private-runtime.sock' }],
  authToken: 'private-runtime-token',
  startedAt: 1
}

const WORKER_DONE_RETRY_MS = 120_000

class TestSocket extends EventEmitter {
  setEncoding = vi.fn()
  end = vi.fn()
  destroy = vi.fn()
  write = vi.fn()
}

const RESTART_OR_ABSENT_ADVICE =
  /Restart Orca and try again|Orca is not running|Run 'orca open' first/

const servers = new Set<Server>()
const tempDirs = new Set<string>()

let socket: TestSocket

beforeEach(() => {
  // Why: this suite must hold in the environment the fix targets, where the parent shell already
  // carries a Codex marker. Both names are cleared, and each case sets only the one it needs.
  vi.stubEnv('CODEX_SANDBOX', '')
  vi.stubEnv('CODEX_SANDBOX_NETWORK_DISABLED', '')
  socket = new TestSocket()
  connect.mockReturnValue(socket)
  tryReadMetadata.mockReturnValue(metadata)
  mockKill()
})
afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.clearAllMocks()
  await Promise.all(
    [...servers].map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  )
  servers.clear()
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  tempDirs.clear()
})

// Node emits 'error' then 'close' for a refused or denied connect.
function failConnect(code: string): void {
  socket.emit('error', Object.assign(new Error(`connect ${code} /private-runtime.sock`), { code }))
  socket.emit('close')
}

function mockKill(code?: string): void {
  vi.spyOn(process, 'kill').mockImplementation(() => {
    if (code) {
      throw Object.assign(new Error(`kill ${code}`), { code })
    }
    return true
  })
}

async function deniedRequest(code: string): Promise<unknown> {
  return await deniedRequestAt(code, metadata.transports[0])
}

async function deniedRequestAt(
  code: string,
  transport: RuntimeTransportMetadata
): Promise<unknown> {
  const pending = sendRequest(
    { ...metadata, transports: [transport] },
    'status.get',
    undefined,
    1000
  )
  failConnect(code)
  return pending.catch((failure: unknown) => failure)
}

// A real unix socket is the shape EPERM actually arrives on. A codex sandbox refuses listen()
// with EPERM and may make the temp dir read-only, so a fixture that cannot be built reports why
// and the case skips instead of hanging on an 'error' event nobody handles.
type UnixSocketFixture =
  | { kind: 'listening'; endpoint: string }
  | { kind: 'unavailable'; reason: string }

async function listenUnixSocket(prefix: string): Promise<UnixSocketFixture> {
  let dir: string
  try {
    dir = mkdtempSync(join(tmpdir(), prefix))
  } catch (error) {
    return {
      kind: 'unavailable',
      reason: `temp dir: ${String((error as NodeJS.ErrnoException).code)}`
    }
  }
  tempDirs.add(dir)
  const endpoint = join(dir, 'runtime.sock')
  const server = createServer((client) => client.end())
  servers.add(server)
  const failure = await new Promise<string | null>((resolve) => {
    server.once('error', (error: NodeJS.ErrnoException) => resolve(String(error.code)))
    server.listen(endpoint, () => resolve(null))
  })
  return failure === null
    ? { kind: 'listening', endpoint }
    : { kind: 'unavailable', reason: `listen: ${failure}` }
}

// Why: the classifier's only endpoint test is existsSync, so any existing path exercises the same
// branch; this one needs no temp dir and no write access, which keeps the case runnable inside a
// read-only sandbox. The realistic socket shape is covered by the separately skipped live case.
const existingPath = process.execPath

async function flushMicrotasks(until: () => boolean): Promise<void> {
  // Why: advance 0 ms at a time — this drains the promise chain without ever letting a retry
  // delay elapse, which is what makes the assertion below deterministic.
  for (let turn = 0; turn < 50 && !until(); turn++) {
    await vi.advanceTimersByTimeAsync(0)
  }
}

describe('runtime access denied', () => {
  it.each(['EPERM', 'EACCES'])('classifies a %s connect without restart advice', async (code) => {
    const error = await deniedRequest(code)

    expect(error).toMatchObject({ code: 'runtime_access_denied', data: { systemCode: code } })
    expect(socket.write).not.toHaveBeenCalled()
    const human = formatCliError(error)
    expect(human).toContain(
      `Permission denied connecting to Orca (${code}). Orca may be running normally`
    )
    expect(human).toContain("Next step: Do not restart Orca or run 'orca open'")
    expect(human).not.toMatch(RESTART_OR_ABSENT_ADVICE)
    expect(human).not.toContain('private-runtime')
  })

  it('names the Codex sandbox only when a marker is set', async () => {
    vi.stubEnv('CODEX_SANDBOX', 'seatbelt')
    const human = formatCliError(await deniedRequest('EPERM'))

    expect(human).toContain('The Codex sandbox blocked this command from connecting to Orca')
    expect(human).toContain('escalated permissions, outside the Codex sandbox')
    expect(human).not.toMatch(RESTART_OR_ABSENT_ADVICE)
  })

  // Why: '' and '0' are how a caller says "not sandboxed". Reading either as set would hide the
  // real state, and a parent shell may carry one of them.
  it.each([
    ['CODEX_SANDBOX', ''],
    ['CODEX_SANDBOX', '0'],
    ['CODEX_SANDBOX_NETWORK_DISABLED', ''],
    ['CODEX_SANDBOX_NETWORK_DISABLED', '0']
  ])('treats %s=%j as no sandbox', async (marker, value) => {
    mockKill('ESRCH')
    vi.stubEnv(marker, value)

    expect(formatCliError(await deniedRequest('EPERM'))).toContain(
      "Orca is not running. Run 'orca open' first."
    )
  })

  it('keeps ordinary connect failures as runtime_unavailable', async () => {
    expect(await deniedRequest('ECONNREFUSED')).toMatchObject({ code: 'runtime_unavailable' })
  })

  it.each([undefined, 'EPERM'])(
    'fails status instead of guessing a state (kill %s)',
    async (killCode) => {
      mockKill(killCode)
      const pending = getCliStatus('/test')
      failConnect('EPERM')

      await expect(pending).rejects.toMatchObject({ code: 'runtime_access_denied' })
    }
  )

  // Why: a sandboxed shell hides Orca's pid namespace, so the ESRCH probe there proves nothing.
  it.each(['CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED'])(
    'keeps a denial when %s says a sandbox fences the pid probe',
    async (marker) => {
      mockKill('ESRCH')
      vi.stubEnv(marker, '1')
      const error = await deniedRequest('EPERM')

      expect(error).toMatchObject({ code: 'runtime_access_denied', data: { systemCode: 'EPERM' } })
      const human = formatCliError(error)
      expect(human).toContain('The Codex sandbox blocked this command from connecting to Orca')
      expect(human).toContain('escalated permissions, outside the Codex sandbox')
      expect(human).toContain('not evidence that Orca stopped')
      expect(human).not.toMatch(RESTART_OR_ABSENT_ADVICE)

      // Why: status is what a worker runs first; it must not report a healthy sandboxed runtime as dead.
      const pending = getCliStatus('/test')
      failConnect('EPERM')
      await expect(pending).rejects.toMatchObject({ code: 'runtime_access_denied' })
    }
  )

  // Why: a denial that reached a real listening socket was denied, not aimed at a missing path.
  // With no marker and a pid the probe cannot see, the classifier must claim no state at all.
  it.skipIf(process.platform === 'win32')(
    'keeps a denial for a live socket even when the pid probe says gone',
    async (ctx) => {
      const fixture = await listenUnixSocket('orca-denied-live-')
      if (fixture.kind === 'unavailable') {
        ctx.skip(
          `sandbox cannot provide a unix socket fixture (${fixture.reason}); the existing-path case covers the same branch`
        )
        return
      }
      mockKill('ESRCH')

      const error = await deniedRequestAt('EPERM', { kind: 'unix', endpoint: fixture.endpoint })

      expect(error).toMatchObject({ code: 'runtime_access_denied', data: { systemCode: 'EPERM' } })
      const human = formatCliError(error)
      expect(human).toContain(
        "Permission denied connecting to Orca (EPERM) on a path that exists where Orca's Unix socket should be"
      )
      expect(human).toContain('cannot tell which')
      expect(human).not.toContain('Do not restart')
      expect(human).not.toMatch(RESTART_OR_ABSENT_ADVICE)
    }
  )

  // Accepted tradeoff, pinned here: any path that exists at the endpoint is enough to suppress
  // not-running advice, so a socket left behind by another user's gone Orca reads as a denial.
  // existsSync is the whole test, so a non-socket path is the equivalent fixture (and the only one
  // a read-only sandbox can offer); the alternative — not-running advice for a live but fenced
  // Orca — is what told sandboxed workers to restart a healthy app.
  it('keeps a denial for any path that exists where the socket should be', async () => {
    mockKill('ESRCH')
    expect(existsSync(existingPath)).toBe(true)

    expect(await deniedRequestAt('EACCES', { kind: 'unix', endpoint: existingPath })).toMatchObject(
      {
        code: 'runtime_access_denied',
        data: { systemCode: 'EACCES' }
      }
    )
  })

  // Why: a named pipe has no filesystem existence check, so the endpoint must only vote for a
  // unix transport; `existsSync("\\\\.\\pipe\\...")` measures nothing about a live runtime.
  it('ignores an existing path on a non-unix transport', async () => {
    mockKill('ESRCH')

    expect(
      await deniedRequestAt('EPERM', { kind: 'named-pipe', endpoint: existingPath })
    ).toMatchObject({ code: 'runtime_unavailable' })
  })

  // Why: the reported defect. Inside the Codex sandbox connect() answers EPERM while
  // process.kill(pid, 0) answers ESRCH, so worker_done spent its whole 120 s retry window on the
  // generic runtime_unavailable branch, printing nothing; the agent Ctrl-C'd and the Dispatch
  // never settled. Asserted without advancing a single millisecond of the retry clock: one
  // connect attempt, the denial surfaced, and no retry sleep left pending.
  it('surfaces a sandboxed worker_done once instead of using its retry window', async () => {
    vi.useFakeTimers()
    mockKill('ESRCH')
    vi.stubEnv('CODEX_SANDBOX_NETWORK_DISABLED', '1')
    const client = new RuntimeClient('/test', 1000, null, null)
    let settled = false
    let outcome: unknown
    const call = callOrchestrationMutation(
      client,
      new Map(),
      'orchestration.send',
      { from: 'term_worker', subject: 'done', type: 'worker_done' },
      undefined,
      WORKER_DONE_RETRY_MS
    ).then(
      (value) => {
        settled = true
        return value
      },
      (error: unknown) => {
        settled = true
        outcome = error
      }
    )

    await flushMicrotasks(() => connect.mock.calls.length > 0)
    expect(connect).toHaveBeenCalledTimes(1)
    failConnect('EPERM')
    await flushMicrotasks(() => settled)

    // Assertions run before awaiting the call: before the fix this promise only settles after the
    // retry window, so awaiting it first would turn the proof into a timeout instead of a
    // statement about the refusal.
    expect(settled, 'the denial did not surface before any retry delay elapsed').toBe(true)
    expect(outcome).toMatchObject({ code: 'runtime_access_denied' })
    expect((outcome as Error).message).toContain('Codex sandbox')
    expect(connect).toHaveBeenCalledTimes(1)
    // Why: a pending timer here is the retry sleep that used to hide the refusal for 120 s.
    expect(vi.getTimerCount()).toBe(0)
    await call
  })

  // Why: a dead pid with no sandbox marker and no socket at the endpoint is the one shape that
  // still earns not-running advice.
  it('gives not-running advice when the endpoint does not exist', async () => {
    mockKill('ESRCH')
    const human = formatCliError(await deniedRequest('EPERM'))

    expect(human).toContain("Orca is not running. Run 'orca open' first.")
    expect(human).not.toContain('Do not restart')
    const pending = getCliStatus('/test')
    failConnect('EPERM')
    await expect(pending).resolves.toMatchObject({
      result: { app: { running: false }, runtime: { state: 'stale_bootstrap' } }
    })
  })

  it('does not launch or poll Orca when the initial status is denied', async () => {
    const pending = new RuntimeClient('/test', 1000, null, null).openOrca()
    failConnect('EPERM')

    await expect(pending).rejects.toMatchObject({ code: 'runtime_access_denied' })
    expect(launchOrcaApp).not.toHaveBeenCalled()
    expect(connect).toHaveBeenCalledTimes(1)
  })

  it('reports status --json as an ok:false envelope with the recovery data', async () => {
    const pending = getCliStatus('/test')
    failConnect('EPERM')
    const error = await pending.catch((failure: unknown) => failure)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    reportCliError(error, true, { commandPath: ['status'] })

    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      ok: false,
      error: {
        code: 'runtime_access_denied',
        data: { systemCode: 'EPERM', nextSteps: expect.any(Array) }
      }
    })
  })
})

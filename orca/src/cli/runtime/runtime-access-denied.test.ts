import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMetadata } from '../../shared/runtime-bootstrap'
import { formatCliError, reportCliError } from '../cli-error'
import { RuntimeClient } from './client'
import { launchOrcaApp } from './launch'
import { getCliStatus } from './status'
import { sendRequest } from './transport'

const { connect, tryReadMetadata } = vi.hoisted(() => ({
  connect: vi.fn(),
  tryReadMetadata: vi.fn()
}))
vi.mock('node:net', () => ({ createConnection: connect }))
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

class TestSocket extends EventEmitter {
  setEncoding = vi.fn()
  end = vi.fn()
  destroy = vi.fn()
  write = vi.fn()
}

const RESTART_OR_ABSENT_ADVICE =
  /Restart Orca and try again|Orca is not running|Run 'orca open' first/

let socket: TestSocket

beforeEach(() => {
  vi.stubEnv('CODEX_SANDBOX', '')
  socket = new TestSocket()
  connect.mockReturnValue(socket)
  tryReadMetadata.mockReturnValue(metadata)
  mockKill()
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.clearAllMocks()
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
  const pending = sendRequest(metadata, 'status.get', undefined, 1000)
  failConnect(code)
  return pending.catch((failure: unknown) => failure)
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

  it('names the Codex sandbox only when CODEX_SANDBOX is set', async () => {
    vi.stubEnv('CODEX_SANDBOX', 'seatbelt')
    const human = formatCliError(await deniedRequest('EPERM'))

    expect(human).toContain('The Codex sandbox blocked this command from connecting to Orca')
    expect(human).toContain('escalated permissions, outside the Codex sandbox')
    expect(human).not.toMatch(RESTART_OR_ABSENT_ADVICE)
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

  // Why: an endpoint that exists and still answered EPERM was denied, not absent.
  it('keeps a denial for a present socket even when the pid probe says gone', async () => {
    mockKill('ESRCH')
    const dir = mkdtempSync(join(tmpdir(), 'orca-denied-endpoint-'))
    const endpoint = join(dir, 'runtime.sock')
    try {
      writeFileSync(endpoint, '')
      const pending = sendRequest(
        { ...metadata, transports: [{ kind: 'unix', endpoint }] },
        'status.get',
        undefined,
        1000
      )
      failConnect('EPERM')
      const error = await pending.catch((failure: unknown) => failure)

      expect(error).toMatchObject({ code: 'runtime_access_denied', data: { systemCode: 'EPERM' } })
      expect(formatCliError(error)).toContain('sandbox or OS permissions block the connection')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Why: a dead Orca leaves its socket behind, and the sandbox denies it before ECONNREFUSED.
  it('gives not-running advice when the denied endpoint belongs to a dead pid', async () => {
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

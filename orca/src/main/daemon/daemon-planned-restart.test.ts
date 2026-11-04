import './mock-descendant-sweep'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DaemonClient } from './client'
import { DaemonServer } from './daemon-server'
import { createMockSubprocess } from './daemon-pty-adapter-test-harness'
import { DaemonPlannedRestartFence } from './daemon-planned-restart-fence'
import { plannedRestartDaemonRequest, type DaemonRestartPin } from './daemon-planned-restart-client'

describe('planned restart control fence', () => {
  let directory: string
  let server: DaemonServer
  let source: DaemonClient
  let clients: DaemonClient[]
  let pin: DaemonRestartPin
  let subprocess: ReturnType<typeof createMockSubprocess>
  const input = { sessionId: 'original-tui', data: 'fact' }

  async function connectClient() {
    const client = new DaemonClient({
      socketPath: join(directory, 'daemon.sock'),
      tokenPath: join(directory, 'daemon.token')
    })
    clients.push(client)
    await client.ensureConnected()
    return client
  }

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'orca-planned-restart-'))
    clients = []
    subprocess = createMockSubprocess()
    server = new DaemonServer({
      socketPath: join(directory, 'daemon.sock'),
      tokenPath: join(directory, 'daemon.token'),
      spawnSubprocess: () => subprocess
    })
    await server.start()
    source = await connectClient()
    await source.request('createOrAttach', { sessionId: input.sessionId, cols: 80, rows: 24 })
    const daemon = source.getDaemonIdentity()
    if (!daemon) {
      throw new Error('Test requires authenticated daemon identity')
    }
    pin = { daemon, transitionId: randomUUID(), token: randomUUID() }
  })

  afterEach(async () => {
    for (const client of clients) {
      client.disconnect()
    }
    await server.shutdown()
    rmSync(directory, { recursive: true, force: true })
  })

  it('freezes, survives a client restart and releases only to its single successor', async () => {
    const before = await source.request('listSessions', undefined)
    await plannedRestartDaemonRequest(source, 'Freeze', pin)
    await expect(source.request('write', input)).rejects.toThrow('fenced')
    await expect(plannedRestartDaemonRequest(source, 'Release', pin)).rejects.toThrow(
      'successor_required'
    )
    source.disconnect()
    const successor = await connectClient()
    await expect(plannedRestartDaemonRequest(successor, 'Inspect', pin)).resolves.toMatchObject({
      state: 'frozen'
    })
    await expect(successor.request('listSessions', undefined)).resolves.toEqual(before)
    await vi.waitFor(async () => {
      await expect(plannedRestartDaemonRequest(successor, 'Release', pin)).resolves.toMatchObject({
        state: 'released'
      })
    })
    await plannedRestartDaemonRequest(successor, 'Release', pin)
    await successor.request('write', input)
    expect(subprocess.write).toHaveBeenCalledWith('fact')
    const stale = await connectClient()
    await expect(stale.request('write', input)).rejects.toThrow('fenced')
    await expect(
      stale.request('createOrAttach', { sessionId: 'duplicate', cols: 80, rows: 24 })
    ).rejects.toThrow('fenced')
    await expect(successor.request('listSessions', undefined)).resolves.toEqual(before)
  })

  it.each([
    'write',
    'resize',
    'signal',
    'kill',
    'createOrAttach',
    'resetInputModes',
    'clearScrollback',
    'takePendingOutput',
    'ptySpawnHealth',
    'shutdown',
    'shutdownIfIdle'
  ])('rejects %s before dispatch while frozen', async (type) => {
    await plannedRestartDaemonRequest(source, 'Freeze', pin)
    await expect(source.request(type, input)).rejects.toThrow('daemon_planned_restart_fenced')
  })

  it('refuses competitors and wrong pins without freezing ordinary work', async () => {
    await connectClient()
    await expect(plannedRestartDaemonRequest(source, 'Freeze', pin)).rejects.toThrow(
      'exclusive_client_required'
    )
    await source.request('write', input)
    await expect(
      plannedRestartDaemonRequest(source, 'Inspect', { ...pin, token: randomUUID() })
    ).rejects.toThrow('pin_mismatch')
  })

  it('releases two cycles while refusing old pins and keeping the same PTY', async () => {
    const before = await source.request('listSessions', undefined)
    let current = source
    for (let cycle = 0; cycle < 2; cycle++) {
      const next = { ...pin, transitionId: randomUUID(), token: randomUUID() }
      await plannedRestartDaemonRequest(current, 'Freeze', next)
      current.disconnect()
      current = await connectClient()
      await vi.waitFor(() => plannedRestartDaemonRequest(current, 'Release', next))
      await current.request('write', { ...input, data: `cycle-${cycle}` })
      await expect(plannedRestartDaemonRequest(current, 'Inspect', pin)).rejects.toThrow(
        'pin_mismatch'
      )
      pin = next
    }
    expect(await current.request('listSessions', undefined)).toEqual(before)
    expect(subprocess.write).toHaveBeenCalledTimes(2)
  })

  it('recovers a lost release reply before any effect, but not after writing', async () => {
    await plannedRestartDaemonRequest(source, 'Freeze', pin)
    source.disconnect()
    const failed = await connectClient()
    await vi.waitFor(() => plannedRestartDaemonRequest(failed, 'Release', pin))
    await expect(failed.request('shutdownIfIdle', undefined)).rejects.toThrow('fenced')
    failed.disconnect()
    const retry = await connectClient()
    await vi.waitFor(async () =>
      expect(await plannedRestartDaemonRequest(retry, 'Inspect', pin)).toMatchObject({
        state: 'frozen'
      })
    )
    await plannedRestartDaemonRequest(retry, 'Release', pin)
    expect(subprocess.write).not.toHaveBeenCalled()
    await retry.request('write', input)
    retry.disconnect()
    const later = await connectClient()
    await expect(plannedRestartDaemonRequest(later, 'Release', pin)).rejects.toThrow(
      'successor_required'
    )
  })

  it('does not accept identity changes or a legacy unknown-method reply', async () => {
    const request = vi.spyOn(source, 'request')
    await expect(
      plannedRestartDaemonRequest(source, 'Freeze', {
        ...pin,
        daemon: { ...pin.daemon, launchNonce: randomUUID() }
      })
    ).rejects.toThrow('identity_changed')
    expect(request).not.toHaveBeenCalled()
    request.mockRejectedValueOnce(new Error('Unknown request type: plannedRestartFreeze'))
    await expect(plannedRestartDaemonRequest(source, 'Freeze', pin)).rejects.toThrow(
      'Unknown request type'
    )
    expect(request).toHaveBeenCalledOnce()
  })
})

it('fences first, drains failed in-flight effects, and never replays them', async () => {
  const fence = new DaemonPlannedRestartFence()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const operation = vi.fn(async () => {
    await gate
    throw new Error('original failure')
  })
  const running = fence.execute('createOrAttach', 'source', operation)
  const failed = expect(running).rejects.toThrow('original failure')
  const pin = { transitionId: randomUUID(), token: randomUUID() }
  const frozen = fence.freeze(pin, 'source')
  expect(fence.inspect(pin)).toMatchObject({ state: 'draining' })
  await expect(fence.execute('write', 'source', async () => {})).rejects.toThrow('fenced')
  expect(() => fence.release(pin, 'successor')).toThrow('successor_required')
  release()
  await failed
  await expect(frozen).resolves.toMatchObject({ state: 'frozen' })
  await expect(fence.freeze(pin, 'source')).resolves.toMatchObject({ state: 'frozen' })
  expect(operation).toHaveBeenCalledOnce()
  fence.release(pin, 'successor')
  await expect(fence.freeze(pin, 'source')).rejects.toThrow('already_owned')
})

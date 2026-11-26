import { once } from 'node:events'
import {
  createConnection,
  createServer,
  type AddressInfo,
  type Server,
  type Socket
} from 'node:net'
import { performance } from 'node:perf_hooks'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startNetworkProxy, type NetworkProxy } from './network-proxy'

type EchoServer = { port: number; server: Server; sockets: Set<Socket> }

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  const results = await Promise.allSettled(
    cleanups
      .splice(0)
      .toReversed()
      .map((cleanup) => cleanup())
  )
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []
  )
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Network proxy test cleanup failed')
  }
})

async function startEchoServer(echo = true): Promise<EchoServer> {
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => undefined)
    socket.once('close', () => sockets.delete(socket))
    if (echo) {
      socket.pipe(socket)
    }
  })
  const cleanup = async (): Promise<void> => {
    for (const socket of sockets) {
      socket.destroy()
    }
    if (!server.listening) {
      return
    }
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  cleanups.push(cleanup)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  return { port: (server.address() as AddressInfo).port, server, sockets }
}

async function startTrackedProxy(
  targetPort: number,
  faults: Parameters<typeof startNetworkProxy>[0]['faults'] = {}
): Promise<NetworkProxy> {
  const proxy = await startNetworkProxy({ targetPort, faults })
  cleanups.push(() => proxy.dispose())
  return proxy
}

function connectOnce(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const onError = (error: Error): void => {
      socket.destroy()
      reject(error)
    }
    socket.once('error', onError)
    socket.once('connect', () => {
      socket.off('error', onError)
      socket.on('error', () => undefined)
      resolve(socket)
    })
  })
}

async function connectEventually(port: number): Promise<Socket> {
  for (;;) {
    try {
      return await connectOnce(port)
    } catch {
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  while (!predicate()) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

function waitForClose(socket: Socket): Promise<void> {
  if (socket.destroyed) {
    return Promise.resolve()
  }
  return new Promise((resolve) => socket.once('close', () => resolve()))
}

async function roundTrip(socket: Socket, payload: Buffer): Promise<Buffer> {
  const response = once(socket, 'data')
  socket.write(payload)
  const [data] = await response
  return Buffer.from(data)
}

const PROXY_TIMER_GRANULARITY_MS = 1

async function captureJitterSchedule(payload: Buffer, fragmentSizes: number[]): Promise<number[]> {
  const target = await startEchoServer(false)
  const proxy = await startTrackedProxy(target.port, { jitterMs: 80 })
  const client = await connectOnce(proxy.listenPort)
  client.setNoDelay(true)
  await waitFor(() => target.sockets.size === 1)
  const [targetSocket] = target.sockets
  if (!targetSocket) {
    throw new Error('Proxy target socket was not accepted')
  }

  let receivedBytes = 0
  targetSocket.on('data', (chunk: Buffer) => {
    receivedBytes += chunk.length
  })
  const originalSetTimeout = globalThis.setTimeout
  const scheduledDelays: number[] = []
  const timerSpy = vi
    .spyOn(globalThis, 'setTimeout')
    .mockImplementation((callback, delay, ...args) => {
      scheduledDelays.push(Number(delay ?? 0))
      return originalSetTimeout(callback, delay, ...args)
    })

  try {
    let sentBytes = 0
    for (const size of fragmentSizes) {
      client.write(payload.subarray(sentBytes, sentBytes + size))
      sentBytes += size
      await waitFor(() => proxy.stats().bytesUp === sentBytes)
    }
    await waitFor(() => receivedBytes === payload.length)
  } finally {
    timerSpy.mockRestore()
    client.destroy()
  }

  if (scheduledDelays.length !== fragmentSizes.length) {
    throw new Error(`Expected ${fragmentSizes.length} deliveries, got ${scheduledDelays.length}`)
  }
  return fragmentSizes.flatMap((size, index) => {
    const delay = scheduledDelays[index]
    if (delay === undefined) {
      throw new Error(`Missing delivery delay ${index}`)
    }
    return Array<number>(size).fill(delay)
  })
}

describe('network proxy', () => {
  it('adds latency to both one-way deliveries', async () => {
    const echo = await startEchoServer()
    const proxy = await startTrackedProxy(echo.port, { latencyMs: 50 })
    const client = await connectOnce(proxy.listenPort)
    const startedAt = performance.now()

    expect(await roundTrip(client, Buffer.from('latency'))).toEqual(Buffer.from('latency'))

    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(85)
    expect(proxy.stats()).toEqual({
      connections: 1,
      bytesUp: 7,
      bytesDown: 7,
      resets: 0,
      dropped: 0
    })
    client.destroy()
  })

  it('keeps seeded jitter independent of write fragmentation', async () => {
    const payload = Buffer.from('fragmentation')
    const wholeWrite = await captureJitterSchedule(payload, [payload.length])
    const byteWrites = await captureJitterSchedule(payload, Array<number>(payload.length).fill(1))
    const perByteDifferences = byteWrites.map((delay, index) => {
      const wholeWriteDelay = wholeWrite[index]
      return wholeWriteDelay === undefined
        ? Number.POSITIVE_INFINITY
        : Math.abs(delay - wholeWriteDelay)
    })

    // The proxy rounds each setTimeout delay to one integer millisecond.
    expect(Math.max(...perByteDifferences)).toBeLessThanOrEqual(PROXY_TIMER_GRANULARITY_MS)
    expect(Math.abs(Math.max(...byteWrites) - Math.max(...wholeWrite))).toBeLessThanOrEqual(
      PROXY_TIMER_GRANULARITY_MS
    )
  })

  it('blackholes bytes without closing the connection', async () => {
    const echo = await startEchoServer()
    const proxy = await startTrackedProxy(echo.port, { blackhole: true })
    const client = await connectOnce(proxy.listenPort)
    const received: Buffer[] = []
    client.on('data', (chunk: Buffer) => received.push(chunk))

    client.write('silent')
    await waitFor(() => proxy.stats().dropped === 6)

    expect(received).toEqual([])
    expect(client.destroyed).toBe(false)
    expect(proxy.stats()).toEqual({
      connections: 1,
      bytesUp: 6,
      bytesDown: 0,
      resets: 0,
      dropped: 6
    })
    client.destroy()
  })

  it('resets a connection after the byte threshold is reached', async () => {
    const echo = await startEchoServer()
    const proxy = await startTrackedProxy(echo.port, { resetAfterBytes: 4 })
    const client = await connectOnce(proxy.listenPort)
    const closed = waitForClose(client)

    client.write('abcdefgh')
    await closed

    expect(client.destroyed).toBe(true)
    expect(proxy.stats()).toMatchObject({ connections: 1, bytesUp: 8, resets: 1 })
  })

  it('refuses new connections while cut and requires reconnection after restore', async () => {
    const echo = await startEchoServer()
    const proxy = await startTrackedProxy(echo.port)
    const original = await connectOnce(proxy.listenPort)
    const originalClosed = waitForClose(original)

    proxy.cut()
    await originalClosed
    await expect(connectOnce(proxy.listenPort)).rejects.toMatchObject({ code: 'ECONNREFUSED' })

    proxy.restore()
    const replacement = await connectEventually(proxy.listenPort)
    expect(await roundTrip(replacement, Buffer.from('restored'))).toEqual(Buffer.from('restored'))
    expect(proxy.stats()).toMatchObject({ connections: 2, resets: 1 })
    replacement.destroy()
  })

  it('counts observed traffic and only labels blackholed bytes as dropped', async () => {
    const echo = await startEchoServer()
    const proxy = await startTrackedProxy(echo.port)
    const client = await connectOnce(proxy.listenPort)

    expect(await roundTrip(client, Buffer.from('echo'))).toEqual(Buffer.from('echo'))
    proxy.setFaults({ blackhole: true })
    client.write('lost')
    await waitFor(() => proxy.stats().dropped === 4)

    expect(proxy.stats()).toEqual({
      connections: 1,
      bytesUp: 8,
      bytesDown: 4,
      resets: 0,
      dropped: 4
    })
    client.destroy()
  })

  it('dispose closes live sockets and releases the listen port', async () => {
    const echo = await startEchoServer()
    const proxy = await startTrackedProxy(echo.port)
    const client = await connectOnce(proxy.listenPort)
    const clientClosed = waitForClose(client)

    await proxy.dispose()
    await clientClosed

    const replacementListener = createServer()
    cleanups.push(async () => {
      if (replacementListener.listening) {
        await new Promise<void>((resolve) => replacementListener.close(() => resolve()))
      }
    })
    await new Promise<void>((resolve, reject) => {
      replacementListener.once('error', reject)
      replacementListener.listen(proxy.listenPort, '127.0.0.1', () => {
        replacementListener.off('error', reject)
        resolve()
      })
    })
    expect((replacementListener.address() as AddressInfo).port).toBe(proxy.listenPort)
  })
})

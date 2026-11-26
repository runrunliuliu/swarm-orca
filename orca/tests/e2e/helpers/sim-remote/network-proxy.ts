/** Seeded jitter is one fixed delay per connection and direction, independent of TCP chunking. */

import {
  createConnection,
  createServer,
  type AddressInfo,
  type Server,
  type Socket
} from 'node:net'

export type NetworkFaults = {
  /** Added to every one-way delivery. */
  latencyMs?: number
  /** Seeded, deterministic extra one-way delay in the range [0, jitterMs]. */
  jitterMs?: number
  bandwidthBytesPerSec?: number
  /** Reset the connection once either direction has forwarded this many bytes. */
  resetAfterBytes?: number
  /** Keep connections open while discarding newly received bytes. */
  blackhole?: boolean
}

export type NetworkProxyStats = {
  /** Total client connections accepted over this proxy's lifetime. */
  connections: number
  /** Bytes received from clients, including bytes later dropped or reset. */
  bytesUp: number
  /** Bytes received from the target, including bytes later dropped or reset. */
  bytesDown: number
  /** Connections reset by resetAfterBytes or cut(). */
  resets: number
  /** Bytes intentionally discarded by blackhole mode. */
  dropped: number
}

export type NetworkProxy = {
  readonly listenPort: number
  readonly targetPort: number
  setFaults(faults: NetworkFaults): void
  /** Destroy every live connection and close the listener. New connections are refused. */
  cut(): void
  /**
   * Rebind the listener after cut(). Previously open sockets stay reset and callers must reconnect;
   * unlike blackhole mode, a cut does not keep a connected-but-silent socket alive.
   */
  restore(): void
  stats(): NetworkProxyStats
  dispose(): Promise<void>
}

type Direction = 'up' | 'down'

type LiveConnection = {
  dispose: () => Promise<void>
  reset: () => Promise<void>
}

const LOOPBACK = '127.0.0.1'
const JITTER_SEED = 0x6d2b_79f5

function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b_79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    try {
      server.close(() => resolve())
    } catch (error) {
      reject(error)
    }
  })
}

function listenOnLoopback(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, LOOPBACK)
  })
}

function resetSocket(socket: Socket): void {
  try {
    socket.resetAndDestroy()
  } catch {
    socket.destroy()
  }
}

function waitForSocketClose(socket: Socket): Promise<void> {
  if (socket.destroyed) {
    return Promise.resolve()
  }
  return new Promise((resolve) => socket.once('close', () => resolve()))
}

export async function startNetworkProxy(args: {
  targetPort: number
  listenPort?: number
  faults?: NetworkFaults
}): Promise<NetworkProxy> {
  let faults: NetworkFaults = { ...args.faults }
  const counters: NetworkProxyStats = {
    connections: 0,
    bytesUp: 0,
    bytesDown: 0,
    resets: 0,
    dropped: 0
  }
  const connections = new Set<LiveConnection>()
  let connectionSequence = 0
  const listener = createServer({ allowHalfOpen: true })
  let listenPort = args.listenPort ?? 0
  let desiredListening = true
  let disposed = false
  let transitionError: unknown = null
  let listenerTransition = Promise.resolve()
  let listenerClosed = Promise.resolve()

  const createProxyConnection = (client: Socket): void => {
    if (!desiredListening || disposed) {
      resetSocket(client)
      return
    }

    counters.connections += 1
    connectionSequence += 1
    const sequence = connectionSequence
    const upstream = createConnection({
      allowHalfOpen: true,
      host: LOOPBACK,
      port: args.targetPort
    })
    const timers = new Set<ReturnType<typeof setTimeout>>()
    let closed = false
    let resetScheduled = false

    client.on('error', () => undefined)
    upstream.on('error', () => undefined)

    const closedPromise = Promise.all([
      waitForSocketClose(client),
      waitForSocketClose(upstream)
    ]).then(() => undefined)

    const destroyConnection = async (countReset: boolean): Promise<void> => {
      if (!closed) {
        closed = true
        timers.forEach((timer) => clearTimeout(timer))
        timers.clear()
        if (countReset) {
          counters.resets += 1
        }
        resetSocket(client)
        resetSocket(upstream)
      }
      await closedPromise
    }

    const connection: LiveConnection = {
      dispose: () => destroyConnection(false),
      reset: () => destroyConnection(true)
    }
    connections.add(connection)
    void closedPromise.finally(() => connections.delete(connection))

    const createDirection = (
      source: Socket,
      destination: Socket,
      direction: Direction,
      seed: number
    ): void => {
      const jitterRatio = createSeededRandom(seed)()
      let forwardedBytes = 0
      let nextDeliveryAt = 0
      let sourceEnded = false
      let pendingDeliveries = 0

      const finishDestinationWhenReady = (): void => {
        if (sourceEnded && pendingDeliveries === 0 && !closed && !destination.destroyed) {
          destination.end()
        }
      }

      source.on('data', (chunk: Buffer) => {
        counters[direction === 'up' ? 'bytesUp' : 'bytesDown'] += chunk.length
        if (closed || resetScheduled) {
          return
        }

        const activeFaults = faults
        if (activeFaults.blackhole === true) {
          counters.dropped += chunk.length
          return
        }

        let forwardedChunk = chunk
        let resetAfterDelivery = false
        if (activeFaults.resetAfterBytes !== undefined) {
          const remaining = Math.max(0, activeFaults.resetAfterBytes - forwardedBytes)
          if (remaining === 0) {
            resetScheduled = true
            void connection.reset()
            return
          }
          if (forwardedChunk.length >= remaining) {
            forwardedChunk = forwardedChunk.subarray(0, remaining)
            resetAfterDelivery = true
            resetScheduled = true
          }
        }
        forwardedBytes += forwardedChunk.length

        const latencyMs = activeFaults.latencyMs ?? 0
        const jitterMs = (activeFaults.jitterMs ?? 0) * jitterRatio
        const transmitMs = activeFaults.bandwidthBytesPerSec
          ? (forwardedChunk.length / activeFaults.bandwidthBytesPerSec) * 1_000
          : 0
        const now = Date.now()
        const earliestDeliveryAt = now + latencyMs + jitterMs
        nextDeliveryAt = Math.max(nextDeliveryAt, earliestDeliveryAt) + transmitMs
        const delayMs = Math.max(0, Math.ceil(nextDeliveryAt - now))
        pendingDeliveries += 1
        const timer = setTimeout(() => {
          timers.delete(timer)
          pendingDeliveries -= 1
          if (!closed && !destination.destroyed) {
            destination.write(forwardedChunk)
          }
          if (resetAfterDelivery) {
            void connection.reset()
          } else {
            finishDestinationWhenReady()
          }
        }, delayMs)
        timer.unref()
        timers.add(timer)
      })
      source.once('end', () => {
        sourceEnded = true
        finishDestinationWhenReady()
      })
    }

    createDirection(client, upstream, 'up', JITTER_SEED ^ sequence ^ 0xa5a5_a5a5)
    createDirection(upstream, client, 'down', JITTER_SEED ^ sequence ^ 0x5a5a_5a5a)
    client.once('close', () => void destroyConnection(false))
    upstream.once('close', () => void destroyConnection(false))
  }

  listener.on('connection', createProxyConnection)
  await listenOnLoopback(listener, listenPort)
  listenPort = (listener.address() as AddressInfo).port

  return {
    listenPort,
    targetPort: args.targetPort,
    setFaults(nextFaults) {
      if (disposed) {
        throw new Error('Cannot change faults on a disposed network proxy')
      }
      faults = { ...nextFaults }
    },
    cut() {
      if (disposed || !desiredListening) {
        return
      }
      desiredListening = false
      listenerClosed = closeServer(listener).catch((error: unknown) => {
        transitionError = error
      })
      connections.forEach((connection) => void connection.reset())
    },
    restore() {
      if (disposed) {
        throw new Error('Cannot restore a disposed network proxy')
      }
      if (desiredListening && listener.listening) {
        return
      }
      desiredListening = true
      listenerTransition = Promise.all([listenerTransition, listenerClosed])
        .then(async () => {
          if (!desiredListening || disposed) {
            return
          }
          transitionError = null
          await listenOnLoopback(listener, listenPort)
          if (!desiredListening || disposed) {
            await closeServer(listener)
          }
        })
        .catch((error: unknown) => {
          transitionError = error
        })
    },
    stats() {
      return { ...counters }
    },
    async dispose() {
      if (disposed) {
        return
      }
      disposed = true
      desiredListening = false
      const immediateListenerClose = closeServer(listener)
      const connectionCloses = [...connections].map((connection) => connection.dispose())
      await Promise.all([
        listenerTransition,
        listenerClosed,
        immediateListenerClose,
        ...connectionCloses
      ])
      await closeServer(listener)
      if (transitionError) {
        throw transitionError
      }
    }
  }
}

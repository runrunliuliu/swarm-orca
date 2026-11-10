// Why: this is the original Unix socket / named pipe transport extracted from
// runtime-rpc.ts. It preserves the same behavior: newline-delimited JSON, a 30s idle
// timeout for connections with no dispatch running, 1MB max message, 32 max
// connections, chmod 0o600 on Unix.
// It also owns the keepalive timer and per-connection abort signal so the
// server-side handler can cancel long-poll dispatches when the client goes
// away. See design doc §3.1.
import { createServer, type Server, type Socket } from 'node:net'
import { chmodSync, existsSync, rmSync } from 'node:fs'
import type { RpcMessageContext, RpcTransport } from './transport'

const MAX_RUNTIME_RPC_MESSAGE_BYTES = 1024 * 1024
const KEEPALIVE_FRAME = '{"_keepalive":true}\n'
const RUNTIME_RPC_SOCKET_IDLE_TIMEOUT_MS = 30_000
const MAX_RUNTIME_RPC_CONNECTIONS = 32
const DEFAULT_KEEPALIVE_INTERVAL_MS = 10_000
// Why: a handler that never settles must not hold one of the 32 connection slots
// forever. Long-poll handlers own their own deadlines; this ceiling bounds only the
// dispatches whose keepalive was armed implicitly because they ran long.
const MAX_IMPLICIT_KEEPALIVE_MS = 10 * 60_000

export type UnixSocketTransportOptions = {
  endpoint: string
  kind: 'unix' | 'named-pipe'
  // Why: how often to write `{"_keepalive":true}\n` frames while a dispatch
  // is pending. Each write resets both the server-side idle timer and, once
  // the client honours them, the client-side idle timer. Tests override this
  // to avoid waiting 10 s for a frame.
  keepaliveIntervalMs?: number
  // Why: how long a dispatch may run before keepalive is armed for it implicitly.
  // Tests override this to exercise the arming without faking 15 s.
  keepaliveArmDelayMs?: number
  // Why: the idle timeout is a production constant, but a FakeSocket cannot model it.
  // Tests inject a short one so a real socket can prove a keepalive write refreshes it.
  idleTimeoutMs?: number
}

type MessageHandler = (
  msg: string,
  reply: (response: string) => void,
  context?: RpcMessageContext
) => void

export class UnixSocketTransport implements RpcTransport {
  private readonly endpoint: string
  private readonly kind: 'unix' | 'named-pipe'
  private readonly keepaliveIntervalMs: number
  private readonly keepaliveArmDelayMs: number
  private readonly idleTimeoutMs: number
  private server: Server | null = null
  private messageHandler: MessageHandler | null = null
  private readonly activeSockets = new Set<Socket>()

  constructor({
    endpoint,
    kind,
    keepaliveIntervalMs,
    keepaliveArmDelayMs,
    idleTimeoutMs
  }: UnixSocketTransportOptions) {
    this.endpoint = endpoint
    this.kind = kind
    this.idleTimeoutMs = idleTimeoutMs ?? RUNTIME_RPC_SOCKET_IDLE_TIMEOUT_MS
    // Why clamp the interval too: the first frame lands on time regardless, but a steady
    // state slower than the idle timeout would starve the connection between frames, so
    // the interval must stay strictly inside one idle window.
    this.keepaliveIntervalMs = Math.min(
      keepaliveIntervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS,
      Math.max(1, this.idleTimeoutMs - 1)
    )
    // Why half the idle timeout (the default): a dispatch still running half an idle
    // period later has already provably outlived every fast RPC, so it gets a keepalive
    // before the socket's idle timer can fire. Node refreshes that timer on write as well
    // as on read, so the frame is what keeps the connection - and the CLI's own request
    // timer - alive; without it a 210 s `git worktree add` reported `runtime_unavailable`
    // at 30 s. Why clamp: an arming delay at or past the idle timeout would let the timer
    // fire first, so the guarantee must not depend on the caller passing a sane pair.
    this.keepaliveArmDelayMs = Math.min(
      keepaliveArmDelayMs ?? Math.floor(this.idleTimeoutMs / 2),
      Math.max(0, this.idleTimeoutMs - 1)
    )
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler
  }

  async start(): Promise<void> {
    if (this.server) {
      return
    }

    if (this.kind === 'unix' && existsSync(this.endpoint)) {
      rmSync(this.endpoint, { force: true })
    }

    const server = createServer((socket) => {
      this.handleConnection(socket)
    })
    server.maxConnections = MAX_RUNTIME_RPC_CONNECTIONS

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.endpoint, () => {
        server.off('error', reject)
        resolve()
      })
    })

    if (this.kind === 'unix') {
      chmodSync(this.endpoint, 0o600)
    }

    this.server = server
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    if (!server) {
      return
    }
    const closePromise = new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve()
      })
    })
    // Why: server.close() stops accepting new connections but waits for
    // existing sockets; long-poll keepalives can otherwise hold shutdown open.
    for (const socket of Array.from(this.activeSockets)) {
      socket.destroy()
    }
    await closePromise
    if (this.kind === 'unix' && existsSync(this.endpoint)) {
      rmSync(this.endpoint, { force: true })
    }
  }

  private handleConnection(socket: Socket): void {
    this.activeSockets.add(socket)
    let buffer = ''
    let retainedBytes = 0
    let oversized = false
    // Why: each in-flight dispatch registers its own AbortController here so
    // `socket.on('close')` can abort them all at once. Keeping the set scoped
    // to the connection (rather than a single shared controller) means
    // completing one dispatch does not abort any other dispatch still running
    // on the same socket — future-proofing for a persistent CLI socket that
    // multiplexes sequential requests.
    const inflight = new Set<() => void>()

    socket.setEncoding('utf8')
    socket.setNoDelay(true)
    socket.setTimeout(this.idleTimeoutMs, () => {
      socket.destroy()
    })
    socket.on('error', () => {
      socket.destroy()
    })
    socket.once('close', () => {
      for (const cleanup of inflight) {
        cleanup()
      }
      inflight.clear()
      this.activeSockets.delete(socket)
    })
    socket.on('data', (chunk: string) => {
      if (oversized) {
        return
      }
      buffer += chunk
      // setEncoding('utf8') keeps split codepoints intact, so chunk byte lengths add exactly.
      retainedBytes += Buffer.byteLength(chunk, 'utf8')
      // Why: the Orca runtime lives in Electron main, so it must reject
      // oversized local RPC frames instead of letting a local client grow an
      // unbounded buffer and stall the app.
      if (retainedBytes > MAX_RUNTIME_RPC_MESSAGE_BYTES) {
        oversized = true
        this.messageHandler?.('', (response) => {
          socket.write(`${response}\n`)
          socket.end()
        })
        return
      }
      if (!chunk.includes('\n')) {
        return
      }
      let newlineIndex = buffer.indexOf('\n')
      while (newlineIndex !== -1) {
        const rawMessage = buffer.slice(0, newlineIndex).trim()
        buffer = buffer.slice(newlineIndex + 1)
        if (rawMessage) {
          this.dispatchMessage(socket, rawMessage, inflight)
        }
        newlineIndex = buffer.indexOf('\n')
      }
      retainedBytes = Buffer.byteLength(buffer, 'utf8')
    })
  }

  // Why two arming paths: a long-poll handler (e.g. orchestration.check --wait) calls
  // `startKeepalive()` before it blocks, and any other dispatch gets the same frames
  // implicitly once it outlives `keepaliveArmDelayMs`. A fast RPC still writes no frame
  // - it only carries one unref'd one-shot timer, cleared by its reply - so a handler is
  // never mistaken for an idle connection. See §3.1.
  private dispatchMessage(socket: Socket, rawMessage: string, inflight: Set<() => void>): void {
    let replied = false
    let keepaliveTimer: NodeJS.Timeout | null = null
    let keepaliveArmTimer: NodeJS.Timeout | null = null
    // Why: only the implicit (ran-long) path arms a ceiling; a long-poll handler
    // passes its own deadline through `startKeepalive()` and must keep it.
    let implicitKeepaliveDeadline: number | null = null
    // Why: each dispatch needs its own abort signal and keepalive timer
    // cleanup. Socket close runs every cleanup without touching sibling
    // dispatches that already replied on the same connection.
    const abortController = new AbortController()
    let cleanedUp = false
    const cleanupDispatch = (abort: boolean): void => {
      if (cleanedUp) {
        return
      }
      cleanedUp = true
      if (keepaliveTimer) {
        clearInterval(keepaliveTimer)
        keepaliveTimer = null
      }
      if (keepaliveArmTimer) {
        clearTimeout(keepaliveArmTimer)
        keepaliveArmTimer = null
      }
      if (abort) {
        abortController.abort()
      }
      inflight.delete(abortDispatch)
    }
    const abortDispatch = (): void => cleanupDispatch(true)
    inflight.add(abortDispatch)

    const reply = (response: string): void => {
      if (replied) {
        return
      }
      replied = true
      cleanupDispatch(false)
      if (!socket.destroyed && socket.writable) {
        socket.write(`${response}\n`)
      }
    }

    const startKeepalive = (): void => {
      if (keepaliveTimer || replied) {
        return
      }
      keepaliveTimer = setInterval(() => {
        if (replied || socket.destroyed || !socket.writable) {
          cleanupDispatch(socket.destroyed || !socket.writable)
          return
        }
        if (implicitKeepaliveDeadline !== null && Date.now() >= implicitKeepaliveDeadline) {
          // Why: a dispatch that outlived its ceiling is aborted here, not left to the
          // idle timer: the socket then goes silent, its idle timer closes it, and the
          // client observes a closed connection rather than a response it cannot use.
          cleanupDispatch(true)
          return
        }
        socket.write(KEEPALIVE_FRAME)
      }, this.keepaliveIntervalMs)
      // Why: don't hold the process open solely on the keepalive interval.
      if (typeof keepaliveTimer.unref === 'function') {
        keepaliveTimer.unref()
      }
    }

    // Why: a dispatch that is still running has not gone idle, so the connection must
    // not be torn down as if it had. Arming only after `keepaliveArmDelayMs` keeps the
    // fast path timer-free (the one-shot is cleared by the reply) while any slower
    // handler — `worktree.create` over a slow filesystem, a large ledger write — writes
    // a frame before the idle timer can fire. The CLI's own request timer is refreshed
    // by these frames too, so this fixes not just the framing but the client deadline.
    keepaliveArmTimer = setTimeout(() => {
      keepaliveArmTimer = null
      // Why the extra keepaliveTimer test: a long-poll handler arms keepalive through
      // the admission layer and owns its own deadline (`terminal.waitForStartup`
      // accepts up to an hour), so the implicit ceiling must not be layered on top.
      if (replied || cleanedUp || keepaliveTimer) {
        return
      }
      implicitKeepaliveDeadline = Date.now() + MAX_IMPLICIT_KEEPALIVE_MS
      // Why write before starting the interval: the first frame must land before the idle
      // timer, and `keepaliveIntervalMs` is caller-configurable, so waiting a whole
      // interval could land it after the timeout that this path exists to prevent.
      if (!socket.destroyed && socket.writable) {
        socket.write(KEEPALIVE_FRAME)
      }
      startKeepalive()
    }, this.keepaliveArmDelayMs)
    if (typeof keepaliveArmTimer.unref === 'function') {
      keepaliveArmTimer.unref()
    }

    this.messageHandler?.(rawMessage, reply, {
      signal: abortController.signal,
      startKeepalive
    })
  }
}

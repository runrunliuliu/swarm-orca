import { EventEmitter } from 'node:events'
import { createConnection } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Socket } from 'node:net'
import { UnixSocketTransport } from './unix-socket-transport'

class FakeSocket extends EventEmitter {
  destroyed = false
  writable = true
  readonly writes: string[] = []

  setEncoding(): void {}
  setNoDelay(): void {}
  setTimeout(): void {}
  end(): void {}

  write(data: string): boolean {
    this.writes.push(data)
    return true
  }

  destroy(): this {
    if (!this.destroyed) {
      this.destroyed = true
      this.writable = false
      this.emit('close')
    }
    return this
  }
}

type UnixSocketTransportInternals = {
  handleConnection(socket: Socket): void
}

describe('UnixSocketTransport', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function createReceiver() {
    const transport = new UnixSocketTransport({ endpoint: 'test-pipe', kind: 'named-pipe' })
    const socket = new FakeSocket()
    const received: string[] = []
    transport.onMessage((message, reply) => {
      received.push(message)
      reply('ok')
    })
    ;(transport as unknown as UnixSocketTransportInternals).handleConnection(
      socket as unknown as Socket
    )
    return { socket, received }
  }

  it.each([false, true])('preserves the UTF-8 byte boundary with oversized=%s', (oversized) => {
    const { socket, received } = createReceiver()
    const message = `${'é'.repeat(524287)}a${oversized ? 'x' : ''}`
    const wire = Buffer.from(`${message}\n`)
    const decoder = new StringDecoder('utf8')
    for (let offset = 0; offset < wire.length; offset += 4095) {
      socket.emit('data', decoder.write(wire.subarray(offset, offset + 4095)))
    }
    expect(received).toEqual([oversized ? '' : message])
  })

  it('retains only the byte count of the partial tail between messages', () => {
    const { socket, received } = createReceiver()
    const large = 'a'.repeat(700000)
    socket.emit('data', `${large}\npart`)
    socket.emit('data', `ial\r\n\n${large}\n`)
    expect(received).toEqual([large, 'partial', large])
  })

  it('checks the combined incoming buffer before dispatching any complete messages', () => {
    const { socket, received } = createReceiver()
    socket.emit('data', `${'a'.repeat(700000)}\n${'b'.repeat(700000)}\n`)
    expect(received).toEqual([''])
    socket.emit('data', 'later\n')
    expect(received).toEqual([''])
  })

  it('clears request keepalive timers when the socket closes before a reply', () => {
    const transport = new UnixSocketTransport({
      endpoint: '/tmp/orca-runtime-rpc-test.sock',
      kind: 'unix',
      keepaliveIntervalMs: 100
    })
    const socket = new FakeSocket()
    let aborted = false

    transport.onMessage((_msg, _reply, context) => {
      context?.signal?.addEventListener(
        'abort',
        () => {
          aborted = true
        },
        { once: true }
      )
      context?.startKeepalive()
    })

    ;(transport as unknown as UnixSocketTransportInternals).handleConnection(
      socket as unknown as Socket
    )
    socket.emit('data', '{"id":"pending","method":"wait"}\n')

    vi.advanceTimersByTime(100)
    expect(socket.writes).toHaveLength(1)

    socket.destroy()
    expect(aborted).toBe(true)

    vi.advanceTimersByTime(500)
    expect(socket.writes).toHaveLength(1)
  })

  it('keeps a slow dispatch alive instead of letting the socket go idle', () => {
    // Why this is the regression: `worktree.create` runs `git worktree add` inside the
    // handler. A checkout slower than the 30 s socket idle timeout used to abort the
    // dispatch and answer `runtime_unavailable` (closed the connection before
    // responding) while the git work kept running and then rolled back.
    const transport = new UnixSocketTransport({
      endpoint: 'test-pipe',
      kind: 'named-pipe',
      keepaliveIntervalMs: 100,
      keepaliveArmDelayMs: 50
    })
    const socket = new FakeSocket()
    // Why a holder and not `let reply`: the assignment happens inside the handler
    // callback, so a plain binding narrows to its initial value at the call site.
    const captured: { reply: ((response: string) => void) | null } = { reply: null }
    transport.onMessage((_msg, respond) => {
      captured.reply = respond
    })
    ;(transport as unknown as UnixSocketTransportInternals).handleConnection(
      socket as unknown as Socket
    )
    socket.emit('data', '{"id":"slow","method":"worktree.create"}\n')

    // Nothing before the arming delay: a fast RPC must never emit frames.
    vi.advanceTimersByTime(49)
    expect(socket.writes).toEqual([])

    // The first frame is written when the delay expires, not one interval later, so the
    // guarantee does not depend on how `keepaliveIntervalMs` is configured.
    vi.advanceTimersByTime(1)
    expect(socket.writes).toEqual(['{"_keepalive":true}\n'])

    vi.advanceTimersByTime(400)
    expect(socket.writes.length).toBeGreaterThan(1)
    expect(socket.writes.every((frame) => frame === '{"_keepalive":true}\n')).toBe(true)
    expect(socket.destroyed).toBe(false)

    captured.reply?.('slow-but-done')
    expect(socket.writes.at(-1)).toBe('slow-but-done\n')
    const afterReply = socket.writes.length
    vi.advanceTimersByTime(2_000)
    // Why: interval and arming timer are cleared on reply, so a finished dispatch
    // cannot leave a keepalive stream running on the connection.
    expect(socket.writes).toHaveLength(afterReply)
  })

  it('does not arm keepalive for a dispatch that replies before the delay', () => {
    const transport = new UnixSocketTransport({
      endpoint: 'test-pipe',
      kind: 'named-pipe',
      keepaliveIntervalMs: 100,
      keepaliveArmDelayMs: 50
    })
    const socket = new FakeSocket()
    transport.onMessage((_msg, respond) => respond('ok'))
    ;(transport as unknown as UnixSocketTransportInternals).handleConnection(
      socket as unknown as Socket
    )
    socket.emit('data', '{"id":"fast","method":"worktree.list"}\n')

    vi.advanceTimersByTime(5_000)
    expect(socket.writes).toEqual(['ok\n'])
  })

  it('stops feeding an implicitly kept-alive dispatch that outlives the ceiling', () => {
    const transport = new UnixSocketTransport({
      endpoint: 'test-pipe',
      kind: 'named-pipe',
      keepaliveIntervalMs: 100,
      keepaliveArmDelayMs: 50
    })
    const socket = new FakeSocket()
    let aborted = false
    transport.onMessage((_msg, _respond, context) => {
      context?.signal.addEventListener(
        'abort',
        () => {
          aborted = true
        },
        { once: true }
      )
    })
    ;(transport as unknown as UnixSocketTransportInternals).handleConnection(
      socket as unknown as Socket
    )
    socket.emit('data', '{"id":"stuck","method":"worktree.create"}\n')

    // Paused just past the ceiling (which starts at the arming delay) so the next
    // interval tick is the one that has to give up.
    vi.advanceTimersByTime(10 * 60_000 + 500)
    expect(aborted).toBe(true)
    const atCeiling = socket.writes.length
    vi.advanceTimersByTime(5_000)
    // Why: the ceiling keeps a handler that never settles from holding one of the 32
    // connection slots forever; after it the idle timer is allowed to win.
    expect(socket.writes).toHaveLength(atCeiling)
  })

  it('never caps a keepalive the handler armed itself', () => {
    // Why: long-poll handlers (terminal.waitForStartup accepts an hour) arm keepalive
    // through the admission layer. The implicit ceiling exists for handlers that never
    // settle, so it must not shorten a deadline the handler is honouring.
    const transport = new UnixSocketTransport({
      endpoint: 'test-pipe',
      kind: 'named-pipe',
      keepaliveIntervalMs: 100,
      keepaliveArmDelayMs: 50
    })
    const socket = new FakeSocket()
    let aborted = false
    transport.onMessage((_msg, _respond, context) => {
      context?.signal.addEventListener(
        'abort',
        () => {
          aborted = true
        },
        { once: true }
      )
      context?.startKeepalive()
    })
    ;(transport as unknown as UnixSocketTransportInternals).handleConnection(
      socket as unknown as Socket
    )
    socket.emit('data', '{"id":"wait","method":"terminal.waitForStartup"}\n')

    vi.advanceTimersByTime(10 * 60_000)
    expect(aborted).toBe(false)
    const atCeiling = socket.writes.length
    vi.advanceTimersByTime(5_000)
    expect(aborted).toBe(false)
    expect(socket.writes.length).toBeGreaterThan(atCeiling)
  })

  it('clamps the keepalive interval inside the idle window', () => {
    // Why: a steady-state interval slower than the idle timeout would starve the socket
    // between frames even though the first frame now lands on time.
    const transport = new UnixSocketTransport({
      endpoint: 'test-pipe',
      kind: 'named-pipe',
      idleTimeoutMs: 60,
      keepaliveIntervalMs: 1_000,
      keepaliveArmDelayMs: 10
    })
    const socket = new FakeSocket()
    transport.onMessage(() => {})
    ;(transport as unknown as UnixSocketTransportInternals).handleConnection(
      socket as unknown as Socket
    )
    socket.emit('data', '{"id":"slow","method":"worktree.create"}\n')

    vi.advanceTimersByTime(10)
    expect(socket.writes).toEqual(['{"_keepalive":true}\n'])
    // Clamped to 59 ms, so another frame is due well before the caller's 1000 ms.
    vi.advanceTimersByTime(59)
    expect(socket.writes.length).toBe(2)
  })

  it('writes the first implicit frame on time even with a long keepalive interval', () => {
    // Why: with a caller interval of 60 s and a 30 s idle timeout, waiting one interval
    // before the first frame would land after the timeout this path exists to prevent.
    const transport = new UnixSocketTransport({
      endpoint: 'test-pipe',
      kind: 'named-pipe',
      keepaliveIntervalMs: 60_000,
      keepaliveArmDelayMs: 50
    })
    const socket = new FakeSocket()
    transport.onMessage(() => {})
    ;(transport as unknown as UnixSocketTransportInternals).handleConnection(
      socket as unknown as Socket
    )
    socket.emit('data', '{"id":"slow","method":"worktree.create"}\n')

    vi.advanceTimersByTime(50)
    expect(socket.writes).toEqual(['{"_keepalive":true}\n'])
  })

  it('keeps a real socket alive past its own idle timeout', async () => {
    // Why a real socket: FakeSocket.setTimeout is a no-op, so the fake-timer cases prove
    // the frames and the cleanup but not the property the fix depends on - that a write
    // refreshes Node's idle timer. Here the handler answers after 400 ms while the
    // transport's idle timeout is 60 ms and the first frame is due at 20 ms.
    vi.useRealTimers()
    const directory = await mkdtemp(join(tmpdir(), 'orca-transport-idle-'))
    const endpoint = join(directory, 'idle.sock')
    const transport = new UnixSocketTransport({
      endpoint,
      kind: 'unix',
      idleTimeoutMs: 60,
      keepaliveArmDelayMs: 20,
      keepaliveIntervalMs: 20
    })
    transport.onMessage((_msg, reply) => {
      setTimeout(() => reply('{"id":"slow","ok":true}'), 400)
    })
    await transport.start()
    try {
      const frames: string[] = []
      const response = await new Promise<string>((resolve, reject) => {
        const client = createConnection(endpoint)
        client.setEncoding('utf8')
        let buffer = ''
        client.on('error', reject)
        client.on('close', () => reject(new Error('socket closed before the response')))
        client.on('data', (chunk: string) => {
          buffer += chunk
          let index = buffer.indexOf('\n')
          while (index !== -1) {
            const line = buffer.slice(0, index)
            buffer = buffer.slice(index + 1)
            index = buffer.indexOf('\n')
            if (!line.trim()) {
              continue
            }
            frames.push(line)
            if (!line.includes('_keepalive')) {
              client.end()
              resolve(line)
              return
            }
          }
        })
        client.write('{"id":"slow","method":"worktree.create"}\n')
      })
      expect(response).toBe('{"id":"slow","ok":true}')
      // Why: more than one frame means the connection survived several idle windows.
      expect(frames.filter((frame) => frame.includes('_keepalive')).length).toBeGreaterThan(1)
    } finally {
      await transport.stop()
      await rm(directory, { recursive: true, force: true })
    }
  })
})

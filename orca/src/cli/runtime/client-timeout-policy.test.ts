import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DISPATCH_ACCEPTANCE_AGGREGATE_BUDGET_MS
} from '../../main/incidents/dispatch-acceptance-run'
import { RuntimeClient } from './client'

const servers = new Set<Server>()
const sockets = new Set<Socket>()

afterEach(async () => {
  for (const socket of sockets) {
    socket.destroy()
  }
  sockets.clear()
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
        })
    )
  )
  servers.clear()
})

describe('RuntimeClient timeout policy: derived orchestration.send budget', () => {
  it('covers the dispatch acceptance budget on orchestration.send', () => {
    // `orchestration.send` of a worker_report evaluates the dispatch's acceptance rules inside the
    // request, so its socket timeout is the caller's only chance to see a verdict or a typed
    // `aggregate_deadline:` reason. `resolveMethodTimeoutMs` is private on purpose (no new public
    // API), so this reaches it the way `client-recovery.test.ts` does.
    const resolveFor = (requestTimeoutMs: number) => {
      const client = new RuntimeClient(undefined, requestTimeoutMs, null, null, 'orca')
      return (
        client as unknown as {
          resolveMethodTimeoutMs: (method: string, params?: unknown) => number
        }
      ).resolveMethodTimeoutMs.bind(client)
    }

    const send = resolveFor(60_000)('orchestration.send')
    // Covered: the whole evaluation budget fits inside the socket timeout.
    expect(send).toBeGreaterThan(DISPATCH_ACCEPTANCE_AGGREGATE_BUDGET_MS)
    // Not by 1 ms: the settlement write, the receipt and the socket need a real grace.
    expect(send - DISPATCH_ACCEPTANCE_AGGREGATE_BUDGET_MS).toBeGreaterThanOrEqual(5_000)
    // A params-level wait budget (as `orchestration.check` has) cannot narrow this path either: the
    // request awaits the whole evaluation, so the floor is the budget plus grace regardless.
    const askedForBudget = resolveFor(60_000)('orchestration.send', {
      timeoutMs: DISPATCH_ACCEPTANCE_AGGREGATE_BUDGET_MS
    })
    expect(askedForBudget).toBe(send)

    // An explicit larger client default still wins; the derived floor never narrows it.
    expect(resolveFor(300_000)('orchestration.send')).toBe(300_000)
  })
})

describe.skipIf(process.platform === 'win32')('RuntimeClient timeout policy', () => {
  it('does not crash while resolving terminal.wait defaults without params', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-client-'))
    const endpoint = join(userDataPath, 'runtime.sock')
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      socket.once('data', (data) => {
        const request = JSON.parse(String(data).trim()) as { id: string }
        socket.write(
          `${JSON.stringify({
            id: request.id,
            ok: true,
            result: { satisfied: true },
            _meta: { runtimeId: 'runtime-1' }
          })}\n`
        )
      })
    })
    servers.add(server)
    await new Promise<void>((resolve) => server.listen(endpoint, resolve))
    writeFileSync(
      join(userDataPath, 'orca-runtime.json'),
      JSON.stringify({
        runtimeId: 'runtime-1',
        pid: process.pid,
        transports: [{ kind: 'unix', endpoint }],
        authToken: 'token',
        startedAt: Date.now()
      }),
      'utf8'
    )

    const client = new RuntimeClient(userDataPath, 100)
    const response = await client.call<{ satisfied: boolean }>('terminal.wait')

    expect(response.result).toEqual({ satisfied: true })
  })
})

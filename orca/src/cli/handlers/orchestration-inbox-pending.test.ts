import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseArgs } from '../args'
import { RuntimeClient } from '../runtime-client'
import { ORCHESTRATION_INBOX_HANDLERS } from './orchestration/message-inbox-handlers'

vi.mock('../format', () => ({ printResult: vi.fn() }))

describe('pending inbox CLI', () => {
  const call = vi.fn()
  const client = new RuntimeClient('/tmp/orca-inbox-cli-unit', 60_000, null, null)
  client.call = call
  const invoke = (args: string[]) =>
    ORCHESTRATION_INBOX_HANDLERS['orchestration inbox']({
      flags: parseArgs(['orchestration', 'inbox', ...args]).flags,
      client,
      cwd: '/tmp/repo',
      json: true
    })
  beforeEach(() => call.mockReset())

  it('passes explicit pending scope and accepts the confirmed filter', async () => {
    call.mockResolvedValue({
      result: {
        messages: [],
        count: 0,
        filter: { mode: 'pending', terminal: 'run:test', deliveryContract: 'current_delivery' }
      }
    })
    await invoke(['--pending', '--terminal', 'run:test', '--limit', '10'])
    expect(call).toHaveBeenCalledExactlyOnceWith('orchestration.inbox', {
      terminal: 'run:test',
      pending: true,
      limit: 10
    })
  })

  it('does not alter default historical reads against older servers', async () => {
    call.mockResolvedValue({ result: { messages: [], count: 0 } })
    await invoke([])
    expect(call).toHaveBeenCalledExactlyOnceWith('orchestration.inbox', {
      terminal: undefined,
      limit: undefined
    })
  })

  it('rejects old servers silently ignoring the new field', async () => {
    call.mockResolvedValue({ result: { messages: [], count: 0 } })
    await expect(invoke(['--pending', '--terminal', 'run:test'])).rejects.toMatchObject({
      code: 'unsupported_operation'
    })
  })

  it('requires explicit target before calling the server', async () => {
    await expect(invoke(['--pending'])).rejects.toThrow('terminal')
    expect(call).not.toHaveBeenCalled()
  })
})

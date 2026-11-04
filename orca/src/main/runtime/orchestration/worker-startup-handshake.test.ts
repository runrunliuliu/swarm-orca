import { describe, expect, it } from 'vitest'
import { buildDispatchPreamble } from './preamble'
import type { MessageRow } from './types'
import { matchesWorkerStartupHandshake } from './worker-startup-handshake'

const target = {
  threadId: '5333d9f0-44a0-4dd8-8d78-cd708b159293',
  taskId: 'task_startup',
  dispatchId: 'ctx_startup',
  workerHandle: 'term_worker',
  runId: 'run_startup',
  paneKey: 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
}
const payload = { taskId: target.taskId, dispatchId: target.dispatchId, phase: 'startup' }

function callback(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id: 'msg_startup',
    run_id: target.runId,
    from_handle: target.workerHandle,
    to_handle: `run:${target.runId}`,
    subject: 'worker_started',
    body: '',
    type: 'heartbeat',
    priority: 'normal',
    thread_id: target.threadId,
    payload: JSON.stringify(payload),
    read: 0,
    sequence: 1,
    created_at: '2026-10-12T00:00:00.000Z',
    delivered_at: null,
    sender_pane_key: target.paneKey,
    ...overrides
  }
}

describe('one executable startup check in the task preamble', () => {
  it.each([
    { cliCommand: 'orca', expected: 'orca' },
    { cliCommand: 'orca-ide', expected: 'orca-ide' },
    { cliCommand: 'orca-ide', devMode: true, expected: 'orca-ide' },
    { devMode: true, expected: 'orca-dev' },
    { cliCommand: "'/data/Orca instance/cli'", expected: "'/data/Orca instance/cli'" }
  ] as const)('uses the execution host CLI $expected', (host) => {
    const text = buildDispatchPreamble({
      ...target,
      ...host,
      startupHandshakeThreadId: target.threadId,
      coordinatorHandle: 'term_coord',
      taskSpec: 'Implement the requested fix'
    })
    const firstCommand = text.split('\n').find((line) => line.trimStart().startsWith(host.expected))
    expect(firstCommand).toBe(
      `${host.expected} orchestration send --from term_worker --type heartbeat --subject "worker_started" --task-id task_startup --dispatch-id ctx_startup --phase "startup" --thread-id ${target.threadId}`
    )
    expect(text.match(/--subject "worker_started"/g)).toHaveLength(1)
    expect(text).toContain('execute this command exactly once in your shell')
    expect(text).toContain('in this same turn. Do not wait for another prompt')
    expect(text).toContain('=== TASK ===\nImplement the requested fix')
    expect(text.indexOf('=== STARTUP CHECK')).toBeLessThan(text.indexOf('=== CLI COMMANDS'))
    expect(text).toContain('--subject "alive"')
    expect(text).toContain('--type worker_done')
    expect(text).toContain(
      'required permission cannot be requested or is denied, stop before task work'
    )
    expect(text).toContain('Do not switch tools, omit required approval')
    expect(text).toContain('unknown, do not resend or begin task work')
  })

  it('does not add a startup command unless requested', () => {
    const text = buildDispatchPreamble({
      ...target,
      coordinatorHandle: 'term_coord',
      taskSpec: 'Existing dispatch'
    })
    expect(text).not.toContain('STARTUP CHECK')
    expect(text).not.toContain('--thread-id')
  })
})

describe('startup callback identity', () => {
  it('accepts only the scoped durable heartbeat, regardless of inbox consumption', () => {
    expect(matchesWorkerStartupHandshake(callback(), target)).toBe(true)
    expect(
      matchesWorkerStartupHandshake(
        callback({ read: 1, delivered_at: '2026-10-12T00:00:01.000Z' }),
        target
      )
    ).toBe(true)
  })

  it('keeps a pane identity valid across tab remounts', () => {
    expect(
      matchesWorkerStartupHandshake(
        callback({ sender_pane_key: 'tab_remounted:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }),
        target
      )
    ).toBe(true)
  })

  const mismatches: [string, Partial<MessageRow>][] = [
    ['message type', { type: 'status' }],
    ['subject', { subject: 'alive' }],
    ['old startup thread', { thread_id: 'old-startup' }],
    ['missing startup thread', { thread_id: null }],
    ['run', { run_id: 'another-run' }],
    ['recipient', { to_handle: 'term_coord' }],
    ['worker', { from_handle: 'term_other' }],
    ['pane', { sender_pane_key: 'tab_other:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }],
    ['missing pane', { sender_pane_key: null }],
    ['task', { payload: JSON.stringify({ ...payload, taskId: 'another-task' }) }],
    ['dispatch', { payload: JSON.stringify({ ...payload, dispatchId: 'another-dispatch' }) }],
    ['phase', { payload: JSON.stringify({ ...payload, phase: 'working' }) }],
    [
      'rejected lifecycle message',
      {
        payload: JSON.stringify({
          ...payload,
          _orcaLifecycleRejection: { code: 'stale_dispatch', reason: 'Not current' }
        })
      }
    ]
  ]
  it.each(mismatches)('ignores a mismatched %s', (_label, overrides) => {
    expect(matchesWorkerStartupHandshake(callback(overrides), target)).toBe(false)
  })

  it.each([null, '{', '[]', 'null', '"worker_started"', '{}'])(
    'ignores missing or malformed payload %s',
    (value) => {
      expect(matchesWorkerStartupHandshake(callback({ payload: value }), target)).toBe(false)
    }
  )
})

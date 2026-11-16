/**
 * B-F10, CLI half: both settlement verbs print the settlement helper's exact `skipped` ids.
 *
 * `task-update` already printed `skippedAcceptance`; `gate-create` was silent about the same fact even
 * though opening a gate settles the Task's active Dispatches too. These tests drive the real handlers
 * through the real `printResult` (stdout captured), so the operator-visible line is what is pinned —
 * not just the RPC shape.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_HANDLERS } from './orchestration'

const originalTerminalHandle = process.env.ORCA_TERMINAL_HANDLE

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  if (originalTerminalHandle === undefined) {
    delete process.env.ORCA_TERMINAL_HANDLE
  } else {
    process.env.ORCA_TERMINAL_HANDLE = originalTerminalHandle
  }
})

function printed(log: { mock: { calls: unknown[][] } }): string {
  return log.mock.calls.map((call) => String(call[0])).join('\n')
}

async function runTaskUpdate(result: unknown): Promise<string> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  const client = { call: vi.fn().mockResolvedValue({ result }) }
  await ORCHESTRATION_HANDLERS['orchestration task-update']({
    flags: new Map([
      ['id', 'task_1'],
      ['status', 'completed'],
      ['from', 'term_coord']
    ]),
    client,
    cwd: '/tmp/repo',
    json: false
  } as never)
  return printed(log)
}

async function runGateCreate(result: unknown): Promise<string> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  const client = { call: vi.fn().mockResolvedValue({ result }) }
  await ORCHESTRATION_HANDLERS['orchestration gate-create']({
    flags: new Map([
      ['task', 'task_1'],
      ['question', 'Proceed?'],
      ['from', 'term_coord']
    ]),
    client,
    cwd: '/tmp/repo',
    json: false
  } as never)
  return printed(log)
}

const TASK = { id: 'task_1', status: 'completed' }
const GATE = { id: 'gate_1', task_id: 'task_1', status: 'pending' }

describe('orchestration task-update output', () => {
  it('prints the unsettled dispatch id and how to bypass acceptance', async () => {
    const output = await runTaskUpdate({ task: TASK, skippedAcceptance: ['ctx_blocked'] })

    expect(output).toContain('Updated task_1 -> completed')
    expect(output).toContain('Not settled')
    expect(output).toContain('ctx_blocked')
    expect(output).toContain('--override-acceptance')
  })

  it('prints only the status line when nothing was left unsettled', async () => {
    const output = await runTaskUpdate({ task: TASK })

    expect(output).toBe('Updated task_1 -> completed')
  })
})

describe('orchestration gate-create output', () => {
  it('prints the unsettled dispatch id, same wording as task-update', async () => {
    const output = await runGateCreate({ gate: GATE, skippedAcceptance: ['ctx_blocked'] })

    expect(output).toContain('Gate gate_1 created for task task_1 [pending]')
    expect(output).toContain('Not settled')
    expect(output).toContain('ctx_blocked')
    expect(output).toContain('--override-acceptance')
  })

  it('prints only the gate line when nothing was left unsettled', async () => {
    const output = await runGateCreate({ gate: GATE })

    expect(output).toBe('Gate gate_1 created for task task_1 [pending]')
  })
})

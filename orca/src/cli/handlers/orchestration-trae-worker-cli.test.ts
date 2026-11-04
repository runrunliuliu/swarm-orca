import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseArgs } from '../args'
import { formatCommandHelp } from '../help'
import { RuntimeClient } from '../runtime-client'
import { ORCHESTRATION_WORKER_COMMAND_SPECS } from '../specs/orchestration-worker-specs'
import {
  ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY,
  TRAE_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY
} from '../../shared/protocol-version'

vi.mock('../format', () => ({ printResult: vi.fn() }))
vi.mock('../selectors', () => ({ getTerminalHandle: vi.fn() }))

import { ORCHESTRATION_HANDLERS } from './orchestration'

describe('Trae worker CLI launch options', () => {
  const call = vi.fn()
  const client = new RuntimeClient('/tmp/orca-trae-cli-unit', 60_000, null, null)
  client.call = call
  const originalExitCode = process.exitCode
  const invoke = (extra: string[] = []) => {
    const { flags } = parseArgs([
      'orchestration',
      'worker-start',
      '--task',
      'task_test',
      '--from',
      'term_coord',
      '--agent',
      'trae',
      '--model',
      'gpt-5.6-sol',
      ...extra
    ])
    return ORCHESTRATION_HANDLERS['orchestration worker-start']({
      flags,
      client,
      cwd: '/tmp/repo',
      json: true
    })
  }

  beforeEach(() => call.mockReset())
  afterEach(() => {
    process.exitCode = originalExitCode
  })

  it.each([[], ['--effort', 'high', '--backend-variant', 'max']])(
    'refuses old servers before dispatch: %j',
    async (...extra) => {
      call.mockResolvedValueOnce({
        result: {
          capabilities: [ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY]
        }
      })
      await expect(invoke(extra)).rejects.toMatchObject({ code: 'incompatible_runtime' })
      expect(call).toHaveBeenCalledExactlyOnceWith('status.get')
    }
  )

  it.each([
    { model: 'gpt-5.6-sol', effort: 'high', backendVariant: 'max' },
    { model: 'gpt-5.4', effort: 'xhigh', backendVariant: 'standard' }
  ])('forwards fixed model settings without changing the agent: %j', async (selection) => {
    call
      .mockResolvedValueOnce({
        result: {
          capabilities: [
            ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY,
            TRAE_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY
          ]
        }
      })
      .mockResolvedValueOnce({ result: { state: 'ready' } })
    await invoke([
      '--model',
      selection.model,
      '--effort',
      selection.effort,
      '--backend-variant',
      selection.backendVariant
    ])
    expect(call).toHaveBeenNthCalledWith(
      2,
      'orchestration.workerStart',
      expect.objectContaining({
        agent: 'trae',
        ...selection
      })
    )
  })

  it('accepts and documents the separate backend variant flag', () => {
    const spec = ORCHESTRATION_WORKER_COMMAND_SPECS.find(
      (item) => item.path.join(' ') === 'orchestration worker-start'
    )
    if (!spec) {
      throw new Error('worker-start spec missing')
    }
    expect(spec.allowedFlags).toContain('backend-variant')
    expect(formatCommandHelp(spec)).toContain('--backend-variant <max|standard>')
    expect(formatCommandHelp(spec)).toContain('separate from --effort')
    expect(formatCommandHelp(spec)).toContain('require explicit --backend-variant standard')
  })
})

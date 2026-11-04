import { afterEach, expect, it, vi } from 'vitest'
import { ORCHESTRATION_RUN_HANDLERS } from './run-handlers'
import { ORCHESTRATION_RUN_COMMAND_SPECS } from '../../specs/orchestration-run-specs'
import { resolveCoordinatorTerminalHandle } from './terminal-identity'
import type { CommandHandler } from '../../dispatch'

vi.mock('node:fs/promises', () => ({ readFile: vi.fn(async () => '{"phase":"review"}') }))
vi.mock('../../format', () => ({ printResult: vi.fn() }))
vi.mock('./terminal-identity', () => ({ resolveCoordinatorTerminalHandle: vi.fn() }))
afterEach(() => vi.clearAllMocks())

function context(call: ReturnType<typeof vi.fn>) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This handler uses only flags, call and json; the stub supplies all three.
  return {
    flags: new Map([['request-file', '/fixture/request.json']]),
    client: { call },
    cwd: '/fixture',
    json: true
  } as unknown as Parameters<CommandHandler>[0]
}

it('sends maintenance directly with native envelope identity, without a frozen-host lookup', async () => {
  const call = vi.fn().mockResolvedValue({ result: {} })
  await ORCHESTRATION_RUN_HANDLERS['orchestration planned-restart']!(context(call))
  expect(call).toHaveBeenCalledExactlyOnceWith('orchestration.plannedRestart', {
    from: undefined,
    request: { phase: 'review' }
  })
  expect(resolveCoordinatorTerminalHandle).not.toHaveBeenCalled()
  expect(
    ORCHESTRATION_RUN_COMMAND_SPECS.find((item) => item.path[1] === 'planned-restart')
      ?.identityFlagRoles
  ).toEqual({ from: 'caller' })
})

it('stops on an unsupported host and never retries another entry', async () => {
  const call = vi.fn().mockRejectedValue(new Error('method_not_found'))
  await expect(
    ORCHESTRATION_RUN_HANDLERS['orchestration planned-restart']!(context(call))
  ).rejects.toThrow('method_not_found')
  expect(call).toHaveBeenCalledOnce()
  expect(resolveCoordinatorTerminalHandle).not.toHaveBeenCalled()
})

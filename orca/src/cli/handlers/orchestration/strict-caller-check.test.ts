import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_RUN_HANDLERS } from './run-handlers'
import { ORCHESTRATION_RUN_COMMAND_SPECS } from '../../specs/orchestration-run-specs'
import { createOrchestrationCompatibilityEnvelope } from '../../runtime/orchestration-compatibility-envelope'

vi.mock('../../format', () => ({ printResult: vi.fn() }))
vi.mock('./terminal-identity', () => ({
  resolveCoordinatorTerminalHandle: vi.fn().mockResolvedValue('term_coord')
}))
afterEach(() => vi.clearAllMocks())

describe('strict caller CLI', () => {
  it('uses a read-only distinct method with no mutation replay id', async () => {
    const call = vi.fn().mockResolvedValue({ result: { caller: { terminalHandle: 'term_coord' } } })
    const handler = ORCHESTRATION_RUN_HANDLERS['orchestration strict-caller-check']!
    await handler({ flags: new Map(), client: { call }, cwd: '/tmp/task', json: true } as never)
    expect(call).toHaveBeenCalledExactlyOnceWith('orchestration.strictCallerCheck', {
      from: 'term_coord'
    })
    const spec = ORCHESTRATION_RUN_COMMAND_SPECS.find((s) => s.path[1] === 'strict-caller-check')
    expect(spec?.identityFlagRoles).toEqual({ from: 'caller' })
    expect(spec?.allowedFlags).not.toContain('retry-request')
  })

  it('does not fall back on old servers', async () => {
    const call = vi.fn().mockRejectedValue(new Error('method_not_found'))
    const handler = ORCHESTRATION_RUN_HANDLERS['orchestration strict-caller-check']!
    await expect(
      handler({ flags: new Map(), client: { call }, cwd: '/tmp/task', json: true } as never)
    ).rejects.toThrow('method_not_found')
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('carries caller evidence only through the existing environment envelope', () => {
    const envelope = createOrchestrationCompatibilityEnvelope({
      ORCA_TERMINAL_HANDLE: 'term_coord',
      ORCA_PANE_KEY: 'tab:leaf',
      ORCA_AGENT_LAUNCH_TOKEN: 'test-only-token'
    })
    expect(envelope.orchestrationCompatibilityEvidence).toMatchObject({
      terminalHandle: 'term_coord',
      paneKey: 'tab:leaf',
      launchToken: 'test-only-token'
    })
  })
})

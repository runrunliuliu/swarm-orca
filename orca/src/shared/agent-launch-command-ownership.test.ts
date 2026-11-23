import { describe, expect, it } from 'vitest'
import {
  agentLaunchNeedsPreparedCommand,
  resolveAgentLaunchCommandOwnership
} from './agent-launch-command-ownership'
import { buildAgentStartupPlan } from './tui-agent-startup'

const SHELL_WRAPPER_ARGS = `-c 'exec traecli "$@"' wrapper-dispatch --yolo`

describe('resolveAgentLaunchCommandOwnership', () => {
  it('leaves the command to the host when this client configured no override', () => {
    expect(
      resolveAgentLaunchCommandOwnership({ agent: 'trae', cmdOverrides: {} })
    ).toBe('host-owned')
    expect(
      resolveAgentLaunchCommandOwnership({ agent: 'trae', cmdOverrides: undefined })
    ).toBe('host-owned')
    expect(
      resolveAgentLaunchCommandOwnership({ agent: 'trae', cmdOverrides: null })
    ).toBe('host-owned')
  })

  it('classifies the launch as client-prepared when the plan wrapped this agent', () => {
    expect(
      resolveAgentLaunchCommandOwnership({ agent: 'trae', cmdOverrides: { trae: 'sh' } })
    ).toBe('client-prepared')
    expect(agentLaunchNeedsPreparedCommand('client-prepared')).toBe(true)
    expect(agentLaunchNeedsPreparedCommand('host-owned')).toBe(false)
  })

  it('ignores an override configured for another agent', () => {
    expect(
      resolveAgentLaunchCommandOwnership({ agent: 'trae', cmdOverrides: { claude: 'sh' } })
    ).toBe('host-owned')
  })

  // The planner picks `override || configured default`, so a whitespace-only override still
  // becomes the command it built. The classification has to describe that plan.
  it('counts a whitespace-only override, because the planner used it as the command', () => {
    const settings = { agentCmdOverrides: { trae: ' ' }, agentDefaultArgs: { trae: '--yolo' } }
    const plan = buildAgentStartupPlan({
      agent: 'trae',
      prompt: '',
      allowEmptyPromptLaunch: true,
      cmdOverrides: settings.agentCmdOverrides,
      agentArgs: '--yolo',
      platform: 'linux',
      shell: 'posix'
    })

    expect(plan?.launchCommand.startsWith(' ')).toBe(true)
    expect(
      resolveAgentLaunchCommandOwnership({
        agent: 'trae',
        cmdOverrides: settings.agentCmdOverrides
      })
    ).toBe('client-prepared')
  })
})

// The regression the issue asks for: the same inputs that produced the field command must be
// classified as one indivisible launch, in both directions (wrapper kept, or nothing sent at all).
describe('issue #60 synthetic wrapper', () => {
  const clientOverrides = { trae: 'sh' }
  const hostOverrides: Record<string, string> = {}

  it('keeps the wrapper and its marker in one client-owned command', () => {
    const client = buildAgentStartupPlan({
      agent: 'trae',
      prompt: '',
      allowEmptyPromptLaunch: true,
      cmdOverrides: clientOverrides,
      agentArgs: SHELL_WRAPPER_ARGS,
      platform: 'linux',
      shell: 'posix'
    })

    expect(client?.launchCommand).toBe(`sh '-c' 'exec traecli "$@"' 'wrapper-dispatch' '--yolo'`)
    expect(
      resolveAgentLaunchCommandOwnership({ agent: 'trae', cmdOverrides: clientOverrides })
    ).toBe('client-prepared')
    // The host would have built a different command from its own settings; that is why the
    // arguments cannot travel alone.
    const host = buildAgentStartupPlan({
      agent: 'trae',
      prompt: '',
      allowEmptyPromptLaunch: true,
      cmdOverrides: hostOverrides,
      agentArgs: null,
      platform: 'linux',
      shell: 'posix'
    })
    expect(host?.launchCommand).not.toBe(client?.launchCommand)
    expect(
      resolveAgentLaunchCommandOwnership({ agent: 'trae', cmdOverrides: hostOverrides })
    ).toBe('host-owned')
  })
})

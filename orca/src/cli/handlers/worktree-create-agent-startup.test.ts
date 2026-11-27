import { describe, expect, it } from 'vitest'
import {
  annotateCreateAgentStartup,
  type AgentStartupReceipt
} from './worktree-create-agent-startup'

function receipt(overrides: Partial<AgentStartupReceipt> = {}): AgentStartupReceipt {
  return { agentTerminalHandle: 'term-1', ...overrides }
}

describe('worktree create agent startup receipt', () => {
  it('reports a started agent from either handle and adds no warning', () => {
    const fromAgentHandle = annotateCreateAgentStartup(receipt(), {
      requestedAgent: 'codex',
      issueLinked: true
    })
    expect(fromAgentHandle.agentStarted).toBe(true)
    expect(fromAgentHandle.warning).toBeUndefined()

    const fromStartupTerminal = annotateCreateAgentStartup(
      receipt({
        agentTerminalHandle: undefined,
        startupTerminal: { spawned: true, handle: 'term-2' }
      }),
      { requestedAgent: 'codex', issueLinked: true }
    )
    expect(fromStartupTerminal.agentStarted).toBe(true)
    expect(fromStartupTerminal.warning).toBeUndefined()
  })

  it('reports the issue-linked create that started no agent', () => {
    const value = annotateCreateAgentStartup(receipt({ agentTerminalHandle: undefined }), {
      issueLinked: true
    })
    expect(value.agentStarted).toBe(false)
    expect(value.warning).toContain('--agent')
  })

  it('keeps the runtime warning instead of replacing it', () => {
    const value = annotateCreateAgentStartup(
      receipt({ agentTerminalHandle: undefined, warning: 'hook failed' }),
      { issueLinked: true }
    )
    expect(value.warning).toContain('hook failed')
    expect(value.warning).toContain('--agent')
  })

  it('does not warn for a shell workspace nobody asked an agent for', () => {
    const value = annotateCreateAgentStartup(receipt({ agentTerminalHandle: undefined }), {
      issueLinked: false
    })
    expect(value.agentStarted).toBe(false)
    expect(value.warning).toBeUndefined()
  })

  it('does not claim a started agent just because --agent was requested', () => {
    const value = annotateCreateAgentStartup(
      receipt({ agentTerminalHandle: undefined, warning: 'startup failed' }),
      { requestedAgent: 'codex', issueLinked: true }
    )
    expect(value.agentStarted).toBe(false)
    expect(value.warning).toBe('startup failed')
  })
})

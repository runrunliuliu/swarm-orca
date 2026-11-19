import { describe, expect, it } from 'vitest'
import { TUI_AGENT_AUTO_PICK_ORDER } from '../../../shared/tui-agent-selection'
import { AGENT_CATALOG } from './agent-catalog'
import {
  isTaskSourceWorkItemSelectionKind,
  pickQuickWorkspaceAgent,
  resolveQuickWorkspaceAgentSelection
} from './quick-workspace-agent-selection'

describe('pickQuickWorkspaceAgent', () => {
  it('keeps the fallback order in sync with the desktop agent catalog', () => {
    expect(TUI_AGENT_AUTO_PICK_ORDER).toEqual(AGENT_CATALOG.map((agent) => agent.id))
    expect(new Set(TUI_AGENT_AUTO_PICK_ORDER).size).toBe(TUI_AGENT_AUTO_PICK_ORDER.length)
  })

  it('uses the first enabled catalog agent while detection is pending', () => {
    expect(pickQuickWorkspaceAgent(null, null, [])).toBe('claude')
    expect(pickQuickWorkspaceAgent(null, null, ['claude'])).toBe('claude-agent-teams')
    expect(pickQuickWorkspaceAgent(null, null, ['claude', 'claude-agent-teams'])).toBe('openclaude')
    expect(
      pickQuickWorkspaceAgent(null, null, ['claude', 'claude-agent-teams', 'openclaude'])
    ).toBe('codex')
  })

  it('respects blank and disabled preferred agents', () => {
    expect(pickQuickWorkspaceAgent('blank', null, [])).toBeNull()
    expect(pickQuickWorkspaceAgent('codex', null, ['codex'])).toBe('claude')
  })

  it('uses detected enabled agents after detection resolves', () => {
    expect(pickQuickWorkspaceAgent(null, ['codex'], ['claude'])).toBe('codex')
    expect(pickQuickWorkspaceAgent('codex', ['claude', 'codex'], ['codex'])).toBe('claude')
  })

  it('keeps the global default and auto order for workspaces without a work item', () => {
    expect(pickQuickWorkspaceAgent('codex', ['claude', 'pi', 'codex'], [])).toBe('codex')
    expect(pickQuickWorkspaceAgent(null, ['claude', 'pi'], [])).toBe('claude')
    expect(
      pickQuickWorkspaceAgent('codex', ['claude', 'pi', 'codex'], [], {
        taskSourceWorkItem: false
      })
    ).toBe('codex')
  })
})

describe('pickQuickWorkspaceAgent for a task source work item', () => {
  it('preselects the task source default over the global default', () => {
    expect(
      pickQuickWorkspaceAgent('claude', ['claude', 'pi'], [], { taskSourceWorkItem: true })
    ).toBe('pi')
    expect(
      pickQuickWorkspaceAgent('codex', ['claude', 'pi', 'codex'], [], { taskSourceWorkItem: true })
    ).toBe('pi')
  })

  it('preselects the task source default while detection is still pending', () => {
    expect(pickQuickWorkspaceAgent(null, null, [], { taskSourceWorkItem: true })).toBe('pi')
    expect(pickQuickWorkspaceAgent('claude', null, [], { taskSourceWorkItem: true })).toBe('pi')
  })

  it('falls back to the global default when the task source default is disabled', () => {
    expect(
      pickQuickWorkspaceAgent('codex', ['claude', 'pi', 'codex'], ['pi'], {
        taskSourceWorkItem: true
      })
    ).toBe('codex')
  })

  it('falls back to the auto pick order when the task source default is not detected', () => {
    expect(
      pickQuickWorkspaceAgent(null, ['claude', 'codex'], [], { taskSourceWorkItem: true })
    ).toBe('claude')
    expect(
      pickQuickWorkspaceAgent('codex', ['claude', 'codex'], [], { taskSourceWorkItem: true })
    ).toBe('codex')
  })

  it('keeps an explicit no-agent preference over the task source default', () => {
    expect(
      pickQuickWorkspaceAgent('blank', ['claude', 'pi'], [], { taskSourceWorkItem: true })
    ).toBeNull()
  })

  it('never leaves the agent field empty when no agent is usable', () => {
    expect(pickQuickWorkspaceAgent(null, [], [], { taskSourceWorkItem: true })).toBeNull()
    expect(
      pickQuickWorkspaceAgent(null, ['claude'], ['claude'], { taskSourceWorkItem: true })
    ).toBeNull()
  })
})

describe('isTaskSourceWorkItemSelectionKind', () => {
  it('recognises issue and pull request sources only', () => {
    for (const kind of [
      'github-issue',
      'github-pr',
      'gitlab-issue',
      'gitlab-mr',
      'linear',
      'jira'
    ] as const) {
      expect(isTaskSourceWorkItemSelectionKind(kind)).toBe(true)
    }
    expect(isTaskSourceWorkItemSelectionKind('branch')).toBe(false)
    expect(isTaskSourceWorkItemSelectionKind(null)).toBe(false)
    expect(isTaskSourceWorkItemSelectionKind(undefined)).toBe(false)
  })
})

describe('resolveQuickWorkspaceAgentSelection', () => {
  it('uses the preferred quick agent until the user picks an override', () => {
    expect(
      resolveQuickWorkspaceAgentSelection({
        quickAgentOverride: undefined,
        preferredQuickAgent: 'claude',
        detectedAgentIds: ['claude', 'codex'],
        disabledTuiAgents: []
      })
    ).toEqual({ quickAgent: 'claude', quickAgentOverride: undefined })
  })

  it('keeps explicit blank overrides stable', () => {
    expect(
      resolveQuickWorkspaceAgentSelection({
        quickAgentOverride: null,
        preferredQuickAgent: 'claude',
        detectedAgentIds: ['claude'],
        disabledTuiAgents: []
      })
    ).toEqual({ quickAgent: null, quickAgentOverride: null })
  })

  it('keeps an available user override', () => {
    expect(
      resolveQuickWorkspaceAgentSelection({
        quickAgentOverride: 'codex',
        preferredQuickAgent: 'claude',
        detectedAgentIds: new Set(['claude', 'codex']),
        disabledTuiAgents: []
      })
    ).toEqual({ quickAgent: 'codex', quickAgentOverride: 'codex' })
  })

  it('replaces an unavailable override with the preferred quick agent', () => {
    expect(
      resolveQuickWorkspaceAgentSelection({
        quickAgentOverride: 'codex',
        preferredQuickAgent: 'claude',
        detectedAgentIds: ['claude'],
        disabledTuiAgents: []
      })
    ).toEqual({ quickAgent: 'claude', quickAgentOverride: 'claude' })
  })
})

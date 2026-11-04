import { describe, expect, it } from 'vitest'
import { normalizeHookPayload } from './agent-hook-listener'
import { createHookListenerState } from './agent-hook-listener/listener-state'
import { normalizeAndAccept, PANE_KEY } from './agent-hook-listener-test-harness'
import { extractAgentProviderSession, isResumableTuiAgent } from './agent-session-resume'
import { isAgentHookSource } from './agent-hook-relay'
import { resolveHookSource } from './agent-hook-listener/source-routing'

const base = {
  session_id: 'thread-1',
  transcript_path: '/sessions/thread-1.jsonl',
  cwd: '/workspace',
  model: 'model-1',
  permission_mode: 'default'
}

describe('Trae 0.209.1 runtime session accounting hooks', () => {
  it('preserves launch/pane and provider-reported transcript identity', () => {
    const source = resolveHookSource('/hook/trae')
    expect(source).toBe('trae')
    if (!source) {
      throw new Error('Trae hook route is missing')
    }
    const event = normalizeHookPayload(
      createHookListenerState(),
      source,
      {
        paneKey: PANE_KEY,
        tabId: 'tab-1',
        worktreeId: 'folder-1',
        launchToken: 'launch-1',
        payload: { ...base, hook_event_name: 'SessionStart', source: 'startup' }
      },
      'production'
    )
    expect(isAgentHookSource('trae')).toBe(true)
    expect(event).toMatchObject({
      source: 'trae',
      paneKey: PANE_KEY,
      launchToken: 'launch-1',
      worktreeId: 'folder-1',
      payload: { agentType: 'trae', state: 'done' },
      providerSession: { key: 'session_id', id: 'thread-1', transcriptPath: base.transcript_path }
    })
    expect(event?.providerSessionOnly).not.toBe(true)
    expect(isResumableTuiAgent('trae')).toBe(false)
  })

  it('tracks submit/stop without allowing child hooks to settle or remap the parent', () => {
    const state = createHookListenerState()
    const submit = normalizeAndAccept(state, 'trae', {
      ...base,
      hook_event_name: 'UserPromptSubmit',
      prompt: 'work'
    })
    expect(submit?.payload.state).toBe('working')
    expect(submit?.hasExplicitPrompt).toBe(true)
    for (const agent_id of ['child', '', 42]) {
      expect(
        normalizeAndAccept(state, 'trae', {
          ...base,
          hook_event_name: 'Stop',
          session_id: 'child-session',
          agent_id
        })
      ).toBeNull()
    }
    expect(state.lastStatusByPaneKey.get(PANE_KEY)?.payload.state).toBe('working')
    const stopped = normalizeAndAccept(state, 'trae', {
      ...base,
      hook_event_name: 'Stop',
      stop_hook_active: false,
      last_assistant_message: 'done'
    })
    expect(stopped?.payload).toMatchObject({
      state: 'done',
      agentType: 'trae',
      lastAssistantMessage: 'done'
    })
    expect(stopped?.providerSession?.id).toBe('thread-1')
  })

  it.each(['compact', 'fork', 'unknown'])('does not settle an active turn on %s', (source) => {
    expect(
      normalizeAndAccept(createHookListenerState(), 'trae', {
        ...base,
        hook_event_name: 'SessionStart',
        source
      })
    ).toBeNull()
  })

  it('fails closed for missing session identity and unverified events', () => {
    const state = createHookListenerState()
    expect(normalizeAndAccept(state, 'trae', { hook_event_name: 'Stop' })).toBeNull()
    expect(normalizeAndAccept(state, 'trae', { ...base, hook_event_name: 'made-up' })).toBeNull()
    expect(extractAgentProviderSession('trae', { ...base, transcript_path: null })).toEqual({
      key: 'session_id',
      id: 'thread-1'
    })
    expect(extractAgentProviderSession('trae', { ...base, session_id: 'bad\nidentity' })).toBeNull()
  })
})

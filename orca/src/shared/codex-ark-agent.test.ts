import { describe, expect, it } from 'vitest'
import { TUI_AGENT_CONFIG, isTuiAgent } from './tui-agent-config'
import { TUI_AGENT_DISPLAY_NAMES } from './tui-agent-display-names'
import { pickTuiAgent, TUI_AGENT_AUTO_PICK_ORDER } from './tui-agent-selection'
import {
  getTuiAgentDefaultArgs,
  normalizeTuiAgentArgsRecord,
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv,
  tuiAgentArgsBypassPermissions
} from './tui-agent-launch-defaults'
import {
  buildAgentDraftLaunchPlan,
  buildAgentResumeStartupPlan,
  buildAgentStartupPlan
} from './tui-agent-startup'
import { getAgentResumeArgv } from './agent-session-resume'
import {
  recognizeAgentProcess,
  recognizeAgentProcessFromCommandLine
} from './agent-process-recognition'
import {
  normalizeCompatibleAgentTitleForOwner,
  resolveCompatibleAgentTypeForOwner,
  shareCompatibleTitleIdentityGroup
} from './agent-title-owner'
import { getAgentSessionOptionCatalog } from './agent-session-option-catalog'
import {
  isNativeChatSupportedAgent,
  resolveNativeChatTranscriptAgent
} from './native-chat-agent-support'
import { shouldUseShellReadyStartupDelivery } from './codex-startup-delivery'

describe('Codex Ark TUI integration', () => {
  it('registers a separately detected entry immediately after Codex', () => {
    expect(isTuiAgent('codex-ark')).toBe(true)
    expect(TUI_AGENT_DISPLAY_NAMES['codex-ark']).toBe('Codex Ark')
    expect(TUI_AGENT_AUTO_PICK_ORDER[TUI_AGENT_AUTO_PICK_ORDER.indexOf('codex') + 1]).toBe(
      'codex-ark'
    )
    expect(pickTuiAgent('codex-ark', ['codex', 'codex-ark'])).toBe('codex-ark')
    expect(pickTuiAgent(undefined, ['codex'])).toBe('codex')
    expect(pickTuiAgent(undefined, ['codex-ark'])).toBe('codex-ark')
    expect(pickTuiAgent('codex-ark', ['codex', 'codex-ark'], ['codex-ark'])).toBe('codex')
    expect(TUI_AGENT_CONFIG['codex-ark']).toEqual({
      ...TUI_AGENT_CONFIG.codex,
      detectCmd: 'codex-ark',
      launchCmd: 'codex-ark',
      preflightTrust: 'codex-ark'
    })
  })

  it('shares permission defaults but keeps explicit args, environment and commands independent', () => {
    const yolo = getTuiAgentDefaultArgs('codex')
    expect(getTuiAgentDefaultArgs('codex-ark')).toBe(yolo)
    expect(tuiAgentArgsBypassPermissions('codex-ark', yolo, 'posix')).toBe(true)
    expect(resolveTuiAgentLaunchArgs('codex-ark', { 'codex-ark': '', codex: yolo })).toBe('')
    expect(resolveTuiAgentLaunchArgs('codex-ark', { codex: '--no-daemon --model other' })).toBe(
      yolo
    )
    expect(resolveTuiAgentLaunchEnv('codex-ark', { codex: { CODEX_HOME: '/other' } })).toEqual({})
    expect(normalizeTuiAgentArgsRecord({ 'codex-ark': ' --custom ', codex: '' })).toEqual({
      'codex-ark': '--custom',
      codex: ''
    })
  })

  it.each([false, true])(
    'launches through the wrapper (remote=%s) without Codex connection flags',
    (isRemote) => {
      const plan = buildAgentStartupPlan({
        agent: 'codex-ark',
        prompt: 'hello',
        platform: 'linux',
        isRemote,
        cmdOverrides: { codex: 'other-codex --no-daemon' },
        agentArgs: ''
      })
      expect(plan).toMatchObject({
        agent: 'codex-ark',
        expectedProcess: 'codex',
        launchCommand: "codex-ark 'hello'",
        startupCommandDelivery: 'shell-ready',
        followupPrompt: null
      })
      expect(plan?.env).toBeUndefined()
      expect(
        shouldUseShellReadyStartupDelivery({ command: 'codex-ark', shellPath: '/bin/zsh' })
      ).toBe(true)
    }
  )

  it('reuses draft delivery and resumes with the Ark executable', () => {
    const draft = buildAgentDraftLaunchPlan({
      agent: 'codex-ark',
      draft: 'hello',
      cmdOverrides: {},
      platform: 'linux'
    })
    // Both launchers use the existing post-start composer-paste fallback.
    expect(draft).toBeNull()
    expect(TUI_AGENT_CONFIG['codex-ark'].draftPasteReadySignal).toBe(
      TUI_AGENT_CONFIG.codex.draftPasteReadySignal
    )
    const providerSession = { key: 'session_id', id: 'session-1' } as const
    expect(getAgentResumeArgv('codex-ark', providerSession)).toEqual([
      'codex-ark',
      'resume',
      'session-1'
    ])
    expect(
      buildAgentResumeStartupPlan({
        agent: 'codex-ark',
        providerSession,
        cmdOverrides: { codex: 'other-codex' },
        platform: 'linux'
      })
    ).toMatchObject({
      agent: 'codex-ark',
      launchCommand: "codex-ark 'resume' 'session-1'",
      expectedProcess: 'codex'
    })
  })

  it('retains explicit Ark ownership after the wrapper execs Codex without stealing ordinary Codex', () => {
    expect(recognizeAgentProcess('codex')?.agent).toBe('codex')
    expect(recognizeAgentProcess('codex-ark')?.agent).toBe('codex-ark')
    expect(recognizeAgentProcessFromCommandLine('codex-ark hello')?.agent).toBe('codex-ark')
    expect(resolveCompatibleAgentTypeForOwner('codex', 'codex-ark')).toBe('codex-ark')
    expect(resolveCompatibleAgentTypeForOwner('codex', undefined)).toBe('codex')
    expect(resolveCompatibleAgentTypeForOwner('codex-ark', 'codex')).toBe('codex-ark')
    expect(resolveCompatibleAgentTypeForOwner('claude', 'codex-ark')).toBe('claude')
    expect(shareCompatibleTitleIdentityGroup('codex', 'codex-ark')).toBe(true)
    expect(normalizeCompatibleAgentTitleForOwner('Codex ready', 'codex-ark')).toBe('Codex ready')
  })

  it('does not borrow the standard Codex model catalog or native-chat backend', () => {
    expect(getAgentSessionOptionCatalog('codex-ark')).toBeNull()
    expect(isNativeChatSupportedAgent('codex-ark')).toBe(false)
    expect(resolveNativeChatTranscriptAgent('codex-ark')).toBeNull()
    expect(isNativeChatSupportedAgent('codex')).toBe(true)
  })
})

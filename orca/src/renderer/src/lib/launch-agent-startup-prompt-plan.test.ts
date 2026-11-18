import { describe, expect, it } from 'vitest'
import { planLaunchAgentStartupPrompt } from './launch-agent-startup-prompt-plan'

// Why 'claude': it is one of the agents whose draft normally rides in argv (`--prefill`), which is
// exactly the case the injected linked-issue block must avoid.
const BASE = { agent: 'claude' as const, cmdOverrides: {}, platform: 'linux' as const }

describe('planLaunchAgentStartupPrompt pasteOnlyPrompt', () => {
  it('keeps the argv prefill for ordinary drafts', () => {
    const plan = planLaunchAgentStartupPrompt({
      base: BASE,
      prompt: 'a short draft',
      promptDelivery: 'draft',
      isFollowupPath: false
    })

    expect(plan.startupPlan?.launchCommand).toContain('--prefill')
    expect(plan.pasteDraftAfterLaunch).toBeNull()
    expect(plan.submitPastedPrompt).toBe(false)
  })

  it('launches clean and pastes when the caller refuses argv prefill', () => {
    const plan = planLaunchAgentStartupPrompt({
      base: BASE,
      prompt: 'x'.repeat(12000),
      promptDelivery: 'draft',
      isFollowupPath: false,
      pasteOnlyPrompt: true
    })

    expect(plan.startupPlan?.launchCommand).not.toContain('--prefill')
    expect(plan.startupPlan?.launchCommand).not.toContain('xxxxxxxxxx')
    expect(plan.pasteDraftAfterLaunch).toBe('x'.repeat(12000))
    expect(plan.submitPastedPrompt).toBe(false)
  })

  it('does not change a launch that has no prompt to deliver', () => {
    const plan = planLaunchAgentStartupPrompt({
      base: BASE,
      prompt: '',
      promptDelivery: 'draft',
      isFollowupPath: false,
      pasteOnlyPrompt: true
    })

    expect(plan.pasteDraftAfterLaunch).toBeNull()
    expect(plan.submitPastedPrompt).toBe(false)
  })
})

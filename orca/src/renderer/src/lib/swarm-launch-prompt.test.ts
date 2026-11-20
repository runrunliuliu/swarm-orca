import { describe, expect, it } from 'vitest'
import {
  SWARM_COORDINATOR_SKILL_PATH,
  buildSwarmLaunchPrompt,
  launchModeBlocksCreate,
  parseSwarmMaxWorkers,
  planQuickCreateLaunchPrompt
} from './swarm-launch-prompt'

describe('parseSwarmMaxWorkers', () => {
  it('accepts a positive whole number', () => {
    expect(parseSwarmMaxWorkers('4')).toBe(4)
    expect(parseSwarmMaxWorkers(' 12 ')).toBe(12)
  })

  it('rejects blank, zero, negative, fractional and non-numeric input', () => {
    for (const value of ['', '   ', '0', '-1', '4.5', 'four', '1e3', '0x10']) {
      expect(parseSwarmMaxWorkers(value), value).toBeNull()
    }
  })
})

describe('launchModeBlocksCreate', () => {
  it('blocks a swarm start with a blank, zero or fractional cap', () => {
    expect(launchModeBlocksCreate('swarm', '')).toBe(true)
    expect(launchModeBlocksCreate('swarm', '0')).toBe(true)
    expect(launchModeBlocksCreate('swarm', '2.5')).toBe(true)
  })

  it('allows a swarm start once the cap is a positive integer', () => {
    expect(launchModeBlocksCreate('swarm', '4')).toBe(false)
  })

  it('never blocks the single-agent start, whatever the field holds', () => {
    expect(launchModeBlocksCreate('single', '')).toBe(false)
    expect(launchModeBlocksCreate('single', '0')).toBe(false)
  })
})

describe('buildSwarmLaunchPrompt', () => {
  it('names the skill, the work item, the repository, the base ref and the worker cap', () => {
    const prompt = buildSwarmLaunchPrompt({
      issueUrl: 'https://github.com/acme/web-app/issues/123',
      repoPath: '/work/acme/web-app',
      baseRef: 'main',
      maxWorkers: 4
    })

    expect(prompt).toContain(SWARM_COORDINATOR_SKILL_PATH)
    expect(prompt).toContain('https://github.com/acme/web-app/issues/123')
    expect(prompt).toContain('/work/acme/web-app')
    expect(prompt).toContain('main')
    expect(prompt).toContain('max_workers=4')
  })

  it('says the cap covers review, integration, nested and discussion agents', () => {
    const prompt = buildSwarmLaunchPrompt({ maxWorkers: 4 })

    expect(prompt).toContain('含审查、集成、嵌套与讨论用 agent')
  })

  it('requires the task source to be written to a file with a SHA before work starts', () => {
    const prompt = buildSwarmLaunchPrompt({ issueUrl: 'https://example.test/1', maxWorkers: 2 })

    expect(prompt).toContain('落盘为一个文件')
    expect(prompt).toContain('SHA')
  })

  it('asks for the goal instead of guessing when nothing is linked', () => {
    const prompt = buildSwarmLaunchPrompt({ maxWorkers: 4 })

    expect(prompt).toContain('开工前先问我目标')
    expect(prompt).not.toContain('目标：https')
  })

  it('appends a note after the template instead of replacing it', () => {
    const prompt = buildSwarmLaunchPrompt({
      issueUrl: 'https://example.test/1',
      maxWorkers: 4,
      note: 'focus on the cache layer'
    })

    expect(prompt).toContain(SWARM_COORDINATOR_SKILL_PATH)
    expect(prompt.trimEnd().endsWith('focus on the cache layer')).toBe(true)
  })

  it('carries no absolute host path beyond the selected repository', () => {
    const prompt = buildSwarmLaunchPrompt({ repoPath: '/work/acme/web-app', maxWorkers: 4 })

    expect(prompt).toContain('/work/acme/web-app')
    expect(prompt).not.toContain('/Users/')
    expect(prompt).not.toContain('/home/')
  })
})

describe('planQuickCreateLaunchPrompt', () => {
  const singleAgent = {
    selection: { mode: 'single' as const, maxWorkers: 4 },
    agentSelected: true,
    singleAgentPrompt: 'https://github.com/acme/web-app/issues/123',
    singleAgentDraftPrompt: 'https://github.com/acme/web-app/issues/123' as string | null,
    linkedWorkItemUrl: 'https://github.com/acme/web-app/issues/123',
    repoPath: '/work/acme/web-app',
    baseRef: 'main',
    note: ''
  }

  it('keeps the single-agent delivery decision untouched', () => {
    expect(planQuickCreateLaunchPrompt(singleAgent)).toEqual({
      commandPrompt: 'https://github.com/acme/web-app/issues/123',
      draftPrompt: 'https://github.com/acme/web-app/issues/123',
      pasteAfterReadyPrompt: null,
      deliveredPrompt: 'https://github.com/acme/web-app/issues/123',
      promptDelivery: 'draft'
    })
  })

  it('keeps the single-agent auto-submit decision when there is no draft prompt', () => {
    const plan = planQuickCreateLaunchPrompt({ ...singleAgent, singleAgentDraftPrompt: null })

    expect(plan.promptDelivery).toBe('auto-submit')
    expect(plan.commandPrompt).toBe('https://github.com/acme/web-app/issues/123')
  })

  it('submits the generated template for a swarm launch', () => {
    const plan = planQuickCreateLaunchPrompt({
      ...singleAgent,
      selection: { mode: 'swarm', maxWorkers: 4 }
    })

    expect(plan.promptDelivery).toBe('submit-after-ready')
    expect(plan.commandPrompt).toBe('')
    expect(plan.draftPrompt).toBeNull()
    expect(plan.pasteAfterReadyPrompt).toContain(SWARM_COORDINATOR_SKILL_PATH)
    expect(plan.pasteAfterReadyPrompt).toContain('max_workers=4')
    expect(plan.deliveredPrompt).toBe(plan.pasteAfterReadyPrompt)
  })

  it('falls back to the single-agent path when no agent is selected', () => {
    const plan = planQuickCreateLaunchPrompt({
      ...singleAgent,
      selection: { mode: 'swarm', maxWorkers: 4 },
      agentSelected: false
    })

    expect(plan.promptDelivery).toBe('draft')
    expect(plan.pasteAfterReadyPrompt).toBeNull()
  })

  it('falls back to the single-agent path when the worker cap did not parse', () => {
    const plan = planQuickCreateLaunchPrompt({
      ...singleAgent,
      selection: { mode: 'swarm', maxWorkers: null }
    })

    expect(plan.promptDelivery).toBe('draft')
    expect(plan.pasteAfterReadyPrompt).toBeNull()
  })
})

import { describe, expect, it } from 'vitest'
import { buildTaskDraftPrompt } from './task-draft-prompt'

describe('buildTaskDraftPrompt', () => {
  const prompt = buildTaskDraftPrompt({
    instruction: 'Add a retry button to the login page',
    targetLabel: 'github · acme/widgets'
  })

  it('carries the instruction verbatim', () => {
    expect(prompt).toContain('Add a retry button to the login page')
  })

  it('names the list page target as the default', () => {
    expect(prompt).toContain('github · acme/widgets')
  })

  it('tells the agent to create the ticket itself with its skills', () => {
    expect(prompt).toContain('tracker skills')
    expect(prompt).toContain('create the ticket')
  })

  it('keeps the session out of code work', () => {
    expect(prompt).toContain('scratch workspace, not a checkout')
    expect(prompt).not.toContain('task-draft-proposal.json')
  })

  it('says so when no target is selected', () => {
    expect(buildTaskDraftPrompt({ instruction: 'x', targetLabel: null })).toContain(
      'whichever tracker the instruction names'
    )
  })
})

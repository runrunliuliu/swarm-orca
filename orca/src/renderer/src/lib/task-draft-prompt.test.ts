import { describe, expect, it } from 'vitest'
import { buildTaskDraftPrompt } from './task-draft-prompt'

const TARGET = 'github · acme/web-app'

describe('buildTaskDraftPrompt', () => {
  it('includes the instruction verbatim and the target label', () => {
    const prompt = buildTaskDraftPrompt({
      instruction: 'Add a retry button to the login page',
      targetLabel: TARGET
    })
    expect(prompt).toContain('Add a retry button to the login page')
    expect(prompt).toContain(TARGET)
  })

  it('only drafts and forbids every tracker write path by name', () => {
    const prompt = buildTaskDraftPrompt({
      instruction: 'Add a retry button to the login page',
      targetLabel: TARGET
    })
    expect(prompt).toContain('only drafts')
    expect(prompt).toContain('orca linear create')
    expect(prompt).toContain('orca github create-issue')
    expect(prompt).toContain('gh issue create')
    expect(prompt).toContain('gh pr create')
    expect(prompt).toContain('Jira form')
    expect(prompt).toContain('Creating the issue now is out of scope for this session')
  })

  it('states the scratch-directory rule', () => {
    const prompt = buildTaskDraftPrompt({
      instruction: 'Add a retry button to the login page',
      targetLabel: TARGET
    })
    expect(prompt).toContain('scratch directory, not a checkout')
    expect(prompt).toContain('Do not edit code')
    expect(prompt).toContain('do not create a branch or worktree')
    expect(prompt).toContain('write nothing outside the scratch directory')
  })

  it('produces different strings for different instructions', () => {
    const first = buildTaskDraftPrompt({
      instruction: 'Add a retry button to the login page',
      targetLabel: TARGET
    })
    const second = buildTaskDraftPrompt({
      instruction: 'Remove the legacy importer',
      targetLabel: TARGET
    })
    expect(first).not.toBe(second)
  })

  it('is pure', () => {
    const args = { instruction: 'Add a retry button to the login page', targetLabel: TARGET }
    expect(buildTaskDraftPrompt(args)).toBe(buildTaskDraftPrompt(args))
  })

  it('leaves a blank instruction line empty instead of substituting text', () => {
    expect(buildTaskDraftPrompt({ instruction: '   ', targetLabel: TARGET })).toContain(
      'Instruction:\n   \n'
    )
  })
})

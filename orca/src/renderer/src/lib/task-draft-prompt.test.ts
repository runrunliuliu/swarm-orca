import { describe, expect, it } from 'vitest'
import { buildTaskDraftPrompt } from './task-draft-prompt'

const TARGET = 'github · acme/web-app'
const ARGS = {
  instruction: 'Add a retry button to the login page',
  targetLabel: TARGET,
  draftKey: 'draft-key-1',
  provider: 'github' as const,
  repoId: 'repo-1',
  proposalPath: '/scratch/draft-key-1/task-draft-proposal.json'
}

describe('buildTaskDraftPrompt', () => {
  it('includes the instruction verbatim and the target label', () => {
    const prompt = buildTaskDraftPrompt(ARGS)
    expect(prompt).toContain('Add a retry button to the login page')
    expect(prompt).toContain(TARGET)
  })

  it('only drafts and forbids every tracker write path by name', () => {
    const prompt = buildTaskDraftPrompt(ARGS)
    expect(prompt).toContain('only drafts')
    expect(prompt).toContain('orca linear create')
    expect(prompt).toContain('orca github create-issue')
    expect(prompt).toContain('gh issue create')
    expect(prompt).toContain('gh pr create')
    expect(prompt).toContain('Jira form')
    expect(prompt).toContain('Creating the issue now is out of scope for this session')
  })

  it('names the proposal envelope and its exact path, revision and attempt', () => {
    const prompt = buildTaskDraftPrompt(ARGS)
    expect(prompt).toContain(ARGS.proposalPath)
    expect(prompt).toContain('"version":1')
    expect(prompt).toContain('"draftKey":"draft-key-1"')
    expect(prompt).toContain('"attempt":1')
    expect(prompt).toContain('"provider":"github"')
    expect(prompt).toContain('"repoId":"repo-1"')
    expect(prompt).toContain('"revision":1')
    expect(prompt).toContain('write exactly this JSON envelope')
    expect(prompt).toContain('The app reads that file and creates the issue only after the user confirms')
  })

  it('describes the gh fallback receipt only for the app-sent command', () => {
    const prompt = buildTaskDraftPrompt(ARGS)
    expect(prompt).toContain('Only if the app later sends')
    expect(prompt).toContain('task-draft-receipt.json')
    expect(prompt).toContain('"channel": "gh-fallback"')
  })

  it('states the scratch-directory rule', () => {
    const prompt = buildTaskDraftPrompt(ARGS)
    expect(prompt).toContain('scratch directory, not a checkout')
    expect(prompt).toContain('Do not edit code')
    expect(prompt).toContain('do not create a branch or worktree')
    expect(prompt).toContain('write nothing outside the scratch directory')
  })

  it('produces different strings for different instructions', () => {
    const first = buildTaskDraftPrompt(ARGS)
    const second = buildTaskDraftPrompt({ ...ARGS, instruction: 'Remove the legacy importer' })
    expect(first).not.toBe(second)
  })

  it('is pure', () => {
    expect(buildTaskDraftPrompt(ARGS)).toBe(buildTaskDraftPrompt(ARGS))
  })

  it('leaves a blank instruction line empty instead of substituting text', () => {
    expect(buildTaskDraftPrompt({ ...ARGS, instruction: '   ' })).toContain('Instruction:\n   \n')
  })
})

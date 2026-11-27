import { describe, expect, it } from 'vitest'
import { buildAutoEvolveCreateParams } from './auto-evolve-fixture'

describe('auto-evolve create params', () => {
  const base = {
    repoId: 'repo-1',
    baseSha: 'a'.repeat(40),
    name: 'issue-77-autoevolve-test',
    clientMutationId: 'intent-1',
    startupAgent: 'codex',
    startupPrompt: 'Issue 77 E2E'
  }

  it('keeps the issue identity in both fields the runtime and the skill check', () => {
    const params = buildAutoEvolveCreateParams(base)
    expect(params.repo).toBe('id:repo-1')
    expect(params.baseBranch).toBe('a'.repeat(40))
    expect(params.linkedIssue).toBe(77)
    expect(params.linkedWorkItem).toMatchObject({
      provider: 'github',
      type: 'issue',
      number: 77,
      repoId: 'repo-1',
      url: 'https://github.com/example/project/issues/77'
    })
    expect(params.linkedTaskSourceContext).toMatchObject({
      kind: 'task-source',
      provider: 'github',
      hostId: 'local',
      repoId: 'repo-1',
      providerIdentity: {
        provider: 'github',
        host: 'github.com',
        owner: 'example',
        repo: 'project'
      }
    })
  })

  it('sends the agent and prompt as the only delivery, with an independent background create', () => {
    const params = buildAutoEvolveCreateParams(base)
    expect(params).toMatchObject({
      startupAgent: 'codex',
      startupPrompt: 'Issue 77 E2E',
      clientMutationId: 'intent-1',
      noParent: true,
      setupDecision: 'skip',
      activate: false
    })
  })

  it('moves every issue-dependent field together', () => {
    const params = buildAutoEvolveCreateParams({ ...base, issue: 42 })
    expect(params.linkedIssue).toBe(42)
    expect(params.linkedWorkItem.number).toBe(42)
    expect(params.linkedWorkItem.url).toContain('/issues/42')
  })
})

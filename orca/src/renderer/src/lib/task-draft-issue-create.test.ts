import { describe, expect, it } from 'vitest'
import {
  buildTaskDraftCreateRequest,
  getTaskDraftRetryAction,
  findDuplicateCandidates,
  parseTaskDraftProposal,
  type TaskDraftCandidate,
  type TaskDraftState,
  type TaskDraftTarget
} from './task-draft-issue-create'

const githubTarget: TaskDraftTarget = {
  provider: 'github',
  label: 'github · stablyai/orca',
  repoId: 'repo-1',
  owner: 'stablyai',
  repo: 'orca'
}

describe('parseTaskDraftProposal', () => {
  it('accepts the agent-written file and trims the title and labels', () => {
    expect(
      parseTaskDraftProposal({
        title: '  Add login retry  ',
        body: 'Retry the login call.\n\n- once\n',
        labels: [' bug ', 'ui', 'bug']
      })
    ).toEqual({
      ok: true,
      proposal: {
        title: 'Add login retry',
        body: 'Retry the login call.\n\n- once\n',
        labels: ['bug', 'ui']
      }
    })
  })

  it('defaults an absent body to an empty string and absent labels to none', () => {
    expect(parseTaskDraftProposal({ title: 'Add login retry' })).toEqual({
      ok: true,
      proposal: { title: 'Add login retry', body: '', labels: [] }
    })
  })

  it.each([[null], ['a string'], [42], [[]], [['title']], [undefined]])(
    'rejects a non-object payload: %j',
    (raw) => {
      expect(parseTaskDraftProposal(raw)).toEqual({ ok: false, reason: 'not-object' })
    }
  )

  it.each([[{}], [{ title: '' }], [{ title: '   ' }], [{ title: 42 }], [{ title: null }]])(
    'rejects a missing or empty title: %j',
    (raw) => {
      expect(parseTaskDraftProposal(raw)).toEqual({ ok: false, reason: 'empty-title' })
    }
  )

  it('rejects a body that is present but not a string', () => {
    expect(parseTaskDraftProposal({ title: 'Add login retry', body: 42 })).toEqual({
      ok: false,
      reason: 'invalid-body'
    })
    expect(parseTaskDraftProposal({ title: 'Add login retry', body: null })).toEqual({
      ok: false,
      reason: 'invalid-body'
    })
  })

  it('rejects a labels field that is not a list of non-empty strings', () => {
    for (const labels of ['bug', { 0: 'bug' }, ['bug', 42], ['bug', ''], ['bug', '  '], [null]]) {
      expect(parseTaskDraftProposal({ title: 'Add login retry', labels })).toEqual({
        ok: false,
        reason: 'invalid-labels'
      })
    }
  })
})

describe('findDuplicateCandidates', () => {
  const candidates: TaskDraftCandidate[] = [
    { number: 412, title: 'Add login retry', url: 'https://example.test/412' },
    { number: 413, title: 'Add   LOGIN   retry ', url: 'https://example.test/413' },
    { number: 414, title: 'Add login retry for SSO', url: 'https://example.test/414' },
    { number: 412, title: ' add login RETRY', url: 'https://example.test/412-dup' },
    { number: 415, title: '   ', url: 'https://example.test/415' }
  ]

  it('matches on case, surrounding space and collapsed internal whitespace', () => {
    const matches = findDuplicateCandidates({ title: 'ADD   login retry ' }, candidates)
    expect(matches.map((candidate) => candidate.number)).toEqual([412, 413])
  })

  it('keeps the first candidate per number and preserves input order', () => {
    const matches = findDuplicateCandidates({ title: 'Add login retry' }, candidates)
    expect(matches.map((candidate) => candidate.url)).toEqual([
      'https://example.test/412',
      'https://example.test/413'
    ])
  })

  it('returns nothing when no title matches, the proposal title is blank or the list is empty', () => {
    expect(findDuplicateCandidates({ title: 'Add login retry' }, [])).toEqual([])
    expect(findDuplicateCandidates({ title: '   ' }, candidates)).toEqual([])
    expect(
      findDuplicateCandidates({ title: 'Add login retry' }, [
        { number: 1, title: 'Unrelated', url: 'https://example.test/1' }
      ])
    ).toEqual([])
  })
})

describe('getTaskDraftRetryAction', () => {
  // The runtime policy is the switch, not a parallel table: these are the rows the
  // dock acts on, asserted where the action is decided.
  it('retries only the link write after the provider created the issue', () => {
    expect(getTaskDraftRetryAction('issue-created-link-failed')).toBe('link-only')
  })

  it('re-confirms a provider rejection and reopens a crashed or cancelled draft', () => {
    expect(getTaskDraftRetryAction('provider-rejected')).toBe('create')
    expect(getTaskDraftRetryAction('agent-crashed')).toBe('reopen')
    expect(getTaskDraftRetryAction('cancelled')).toBe('reopen')
    expect(getTaskDraftRetryAction('agent-launch-failed')).toBe('relaunch-agent')
    expect(getTaskDraftRetryAction('draft-failed')).toBe('resubmit')
  })

  it('offers no action while a step is in flight or already settled', () => {
    for (const state of [
      'idle',
      'creating-draft',
      'drafting',
      'preview-ready',
      'creating-issue'
    ] as const) {
      expect(getTaskDraftRetryAction(state)).toBe('none')
    }
  })
})

describe('buildTaskDraftCreateRequest', () => {
  const proposal = { title: 'Add login retry', body: 'Retry the login call.', labels: ['bug'] }

  it('builds a Linear create with a team key, labels and workspace', () => {
    const request = buildTaskDraftCreateRequest({
      target: {
        provider: 'linear',
        label: 'linear · FIN',
        teamKey: 'FIN',
        teamId: 'team-1',
        workspaceId: 'workspace-1'
      },
      proposal
    })
    expect(request).toEqual({
      kind: 'rpc',
      provider: 'linear',
      method: 'linear.issueCreate',
      params: {
        title: 'Add login retry',
        body: 'Retry the login call.',
        labels: ['bug'],
        teamKey: 'FIN',
        workspaceId: 'workspace-1'
      }
    })
  })

  it('falls back to a team input and omits empty labels and workspace', () => {
    const request = buildTaskDraftCreateRequest({
      target: { provider: 'linear', label: 'linear · FIN', teamId: 'FIN', workspaceId: '' },
      proposal: { title: 'Add login retry', body: '', labels: [] }
    })
    expect(request).toEqual({
      kind: 'rpc',
      provider: 'linear',
      method: 'linear.issueCreate',
      params: { title: 'Add login retry', body: '', teamInput: 'FIN' }
    })
    if (request.kind !== 'rpc') {
      throw new Error('expected an rpc request')
    }
    expect(Object.keys(request.params).sort()).toEqual(['body', 'teamInput', 'title'])
  })

  it('builds a GitHub create from the repo selector', () => {
    expect(buildTaskDraftCreateRequest({ target: githubTarget, proposal })).toEqual({
      kind: 'rpc',
      provider: 'github',
      method: 'github.createIssue',
      params: {
        repo: 'repo-1',
        title: 'Add login retry',
        body: 'Retry the login call.',
        labels: ['bug']
      }
    })
  })

  it('omits an empty GitHub label list', () => {
    const request = buildTaskDraftCreateRequest({
      target: githubTarget,
      proposal: { title: 'Add login retry', body: '', labels: [] }
    })
    expect(request).toEqual({
      kind: 'rpc',
      provider: 'github',
      method: 'github.createIssue',
      params: { repo: 'repo-1', title: 'Add login retry', body: '' }
    })
    if (request.kind !== 'rpc') {
      throw new Error('expected an rpc request')
    }
    expect(Object.keys(request.params).sort()).toEqual(['body', 'repo', 'title'])
  })

  it('throws when a GitHub create has no repo selector', () => {
    for (const target of [
      { provider: 'github' as const, label: 'github · ?' },
      { provider: 'github' as const, label: 'github · ?', repoId: null }
    ]) {
      expect(() => buildTaskDraftCreateRequest({ target, proposal })).toThrow(/repo selector/)
    }
  })

  it('hands Jira to the pre-filled form instead of an rpc write', () => {
    expect(
      buildTaskDraftCreateRequest({
        target: { provider: 'jira', label: 'jira · ORCA' },
        proposal
      })
    ).toEqual({
      kind: 'jira-form',
      provider: 'jira',
      title: 'Add login retry',
      body: 'Retry the login call.'
    })
  })
})

describe('getTaskDraftRetryAction', () => {
  it('names one retry action per README 7.9.7 state and nothing for the rest', () => {
    const cases: [TaskDraftState, string][] = [
      ['idle', 'none'],
      ['no-context', 'none'],
      ['creating-draft', 'none'],
      ['draft-failed', 'resubmit'],
      ['agent-launch-failed', 'relaunch-agent'],
      ['drafting', 'none'],
      ['preview-ready', 'none'],
      ['creating-issue', 'none'],
      ['issue-created-link-failed', 'link-only'],
      ['provider-rejected', 'create'],
      ['duplicate-suspected', 'none'],
      ['remote-unsupported', 'none'],
      ['cancelled', 'reopen'],
      ['agent-crashed', 'reopen'],
      ['archived', 'none']
    ]
    for (const [state, action] of cases) {
      expect(getTaskDraftRetryAction(state)).toBe(action)
    }
  })
})

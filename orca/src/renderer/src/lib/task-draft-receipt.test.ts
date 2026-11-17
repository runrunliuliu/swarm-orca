import { describe, expect, it } from 'vitest'
import {
  buildGhFallbackInvocation,
  parseTaskDraftProposalEnvelope,
  parseTaskDraftReceipt
} from './task-draft-receipt'

const EXPECTED = { draftKey: 'draft-1', provider: 'github' as const, repoId: 'repo-1' }

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    draftKey: 'draft-1',
    provider: 'github',
    repoId: 'repo-1',
    revision: 1,
    proposal: { title: 'Add a retry button', body: 'Body', labels: ['bug'] },
    ...overrides
  }
}

describe('parseTaskDraftProposalEnvelope', () => {
  it('accepts a complete envelope for this draft', () => {
    expect(parseTaskDraftProposalEnvelope(envelope(), EXPECTED)).toEqual({
      ok: true,
      proposal: { title: 'Add a retry button', body: 'Body', labels: ['bug'] },
      revision: 1
    })
  })

  it('treats an absent field as a half-written file, not a failure', () => {
    expect(parseTaskDraftProposalEnvelope({}, EXPECTED)).toEqual({ ok: false, reason: 'partial' })
    expect(parseTaskDraftProposalEnvelope(envelope({ proposal: undefined }), EXPECTED)).toEqual({
      ok: false,
      reason: 'partial'
    })
    expect(parseTaskDraftProposalEnvelope(envelope({ revision: undefined }), EXPECTED)).toEqual({
      ok: false,
      reason: 'partial'
    })
  })

  it('rejects a wrong draft, target or version without ever accepting the proposal', () => {
    expect(parseTaskDraftProposalEnvelope(envelope({ draftKey: 'other' }), EXPECTED)).toEqual({
      ok: false,
      reason: 'wrong-draft'
    })
    expect(parseTaskDraftProposalEnvelope(envelope({ provider: 'linear' }), EXPECTED)).toEqual({
      ok: false,
      reason: 'wrong-target'
    })
    expect(parseTaskDraftProposalEnvelope(envelope({ repoId: 'repo-2' }), EXPECTED)).toEqual({
      ok: false,
      reason: 'wrong-target'
    })
    expect(parseTaskDraftProposalEnvelope(envelope({ version: 2 }), EXPECTED)).toEqual({
      ok: false,
      reason: 'unsupported-version'
    })
  })

  it('rejects a malformed proposal or a present-but-wrong number field', () => {
    expect(
      parseTaskDraftProposalEnvelope(envelope({ proposal: { title: '   ' } }), EXPECTED)
    ).toEqual({ ok: false, reason: 'invalid' })
    expect(parseTaskDraftProposalEnvelope(envelope({ revision: 0 }), EXPECTED)).toEqual({
      ok: false,
      reason: 'invalid'
    })
    expect(parseTaskDraftProposalEnvelope('not json', EXPECTED)).toEqual({
      ok: false,
      reason: 'invalid'
    })
  })

  it('rejects an over-long title, body or label', () => {
    expect(
      parseTaskDraftProposalEnvelope(
        envelope({ proposal: { title: 'x'.repeat(257), body: '' } }),
        EXPECTED
      )
    ).toEqual({ ok: false, reason: 'invalid' })
    expect(
      parseTaskDraftProposalEnvelope(
        envelope({ proposal: { title: 'ok', body: 'x'.repeat(65_537) } }),
        EXPECTED
      )
    ).toEqual({ ok: false, reason: 'invalid' })
    expect(
      parseTaskDraftProposalEnvelope(
        envelope({ proposal: { title: 'ok', body: '', labels: ['x'.repeat(129)] } }),
        EXPECTED
      )
    ).toEqual({ ok: false, reason: 'invalid' })
  })

  it('treats a missing repoId as null for a repo-less target', () => {
    const expected = { draftKey: 'draft-1', provider: 'linear' as const, repoId: null }
    expect(
      parseTaskDraftProposalEnvelope(
        envelope({ provider: 'linear', repoId: null, proposal: { title: 'ok', body: '' } }),
        expected
      )
    ).toMatchObject({ ok: true })
    expect(
      parseTaskDraftProposalEnvelope(
        envelope({ provider: 'linear', repoId: undefined, proposal: { title: 'ok', body: '' } }),
        expected
      )
    ).toMatchObject({ ok: true })
  })
})

describe('parseTaskDraftReceipt', () => {
  const expected = { draftKey: 'draft-1', provider: 'github' as const }

  function receipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      version: 1,
      channel: 'primary-rpc',
      provider: 'github',
      number: 412,
      url: 'https://github.com/acme/widgets/issues/412',
      title: 'Add a retry button',
      draftKey: 'draft-1',
      ...overrides
    }
  }

  it('accepts a durable primary-rpc receipt and keeps a linear identifier', () => {
    expect(parseTaskDraftReceipt(receipt(), expected)).toEqual({
      version: 1,
      channel: 'primary-rpc',
      provider: 'github',
      number: 412,
      url: 'https://github.com/acme/widgets/issues/412',
      title: 'Add a retry button',
      draftKey: 'draft-1'
    })
    expect(
      parseTaskDraftReceipt(
        receipt({ provider: 'linear', channel: 'gh-fallback', identifier: 'ENG-123' }),
        { draftKey: 'draft-1', provider: 'linear' }
      )
    ).toMatchObject({ identifier: 'ENG-123', channel: 'gh-fallback', number: 412 })
  })

  it('rejects a wrong version, channel, provider, draft key or number', () => {
    expect(parseTaskDraftReceipt(receipt({ version: 2 }), expected)).toBeNull()
    expect(parseTaskDraftReceipt(receipt({ channel: 'agent' }), expected)).toBeNull()
    expect(parseTaskDraftReceipt(receipt({ provider: 'linear' }), expected)).toBeNull()
    expect(parseTaskDraftReceipt(receipt({ draftKey: 'other' }), expected)).toBeNull()
    expect(parseTaskDraftReceipt(receipt({ number: 0 }), expected)).toBeNull()
    expect(parseTaskDraftReceipt(receipt({ number: 4.5 }), expected)).toBeNull()
    expect(parseTaskDraftReceipt(null, expected)).toBeNull()
  })

  it('rejects an empty or over-long url and title', () => {
    expect(parseTaskDraftReceipt(receipt({ url: '  ' }), expected)).toBeNull()
    expect(
      parseTaskDraftReceipt(receipt({ url: `https://x/${'a'.repeat(2_048)}` }), expected)
    ).toBeNull()
    expect(parseTaskDraftReceipt(receipt({ title: '' }), expected)).toBeNull()
  })
})

describe('buildGhFallbackInvocation', () => {
  it('always passes an explicit --repo and keeps every value its own argv entry', () => {
    const invocation = buildGhFallbackInvocation({
      owner: 'acme',
      repo: 'widgets',
      title: 'Add a retry button',
      body: 'Line one\nLine two',
      labels: ['bug', 'ui']
    })
    expect(invocation.command).toBe('gh')
    expect(invocation.args).toEqual([
      'issue',
      'create',
      '--repo',
      'acme/widgets',
      '--title',
      'Add a retry button',
      '--body',
      'Line one\nLine two',
      '--label',
      'bug',
      '--label',
      'ui'
    ])
  })

  it('throws for a missing owner or repo', () => {
    expect(() =>
      buildGhFallbackInvocation({ owner: ' ', repo: 'widgets', title: 't', body: '', labels: [] })
    ).toThrow('owner/repo')
    expect(() =>
      buildGhFallbackInvocation({ owner: 'acme', repo: '', title: 't', body: '', labels: [] })
    ).toThrow('owner/repo')
  })

  it('throws for an empty or over-long title, body or label', () => {
    expect(() =>
      buildGhFallbackInvocation({ owner: 'acme', repo: 'w', title: ' ', body: '', labels: [] })
    ).toThrow('title')
    expect(() =>
      buildGhFallbackInvocation({
        owner: 'acme',
        repo: 'w',
        title: 't',
        body: 'x'.repeat(65_537),
        labels: []
      })
    ).toThrow('body')
    expect(() =>
      buildGhFallbackInvocation({ owner: 'acme', repo: 'w', title: 't', body: '', labels: [' '] })
    ).toThrow('label')
  })
})

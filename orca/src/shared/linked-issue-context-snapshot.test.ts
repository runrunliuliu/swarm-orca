import { describe, expect, it } from 'vitest'
import {
  buildLinkedIssueContextSnapshot,
  LINKED_ISSUE_CONTEXT_BODY_MAX_CHARS,
  LINKED_ISSUE_CONTEXT_SNAPSHOT_VERSION,
  normalizeLinkedIssueContextSnapshot,
  renderLinkedIssueContextSnapshot
} from './linked-issue-context-snapshot'

const ISSUE = {
  number: 24,
  title: 'feat: inject linked issue',
  url: 'https://github.com/runrunliuliu/swarm-orca/issues/24',
  body: '## Background\n\nOrca prefills only the URL.',
  updatedAt: '2026-11-18T10:00:00Z',
  capturedAt: 1_700_000_000_000
}

describe('buildLinkedIssueContextSnapshot', () => {
  it('captures the issue fields the draft block quotes', () => {
    expect(buildLinkedIssueContextSnapshot(ISSUE)).toEqual({
      version: LINKED_ISSUE_CONTEXT_SNAPSHOT_VERSION,
      number: 24,
      title: 'feat: inject linked issue',
      url: 'https://github.com/runrunliuliu/swarm-orca/issues/24',
      updatedAt: '2026-11-18T10:00:00Z',
      capturedAt: 1_700_000_000_000,
      body: '## Background\n\nOrca prefills only the URL.'
    })
  })

  it('refuses a response that cannot name the issue', () => {
    expect(buildLinkedIssueContextSnapshot(null)).toBeNull()
    expect(buildLinkedIssueContextSnapshot({ ...ISSUE, number: 0 })).toBeNull()
    expect(buildLinkedIssueContextSnapshot({ ...ISSUE, number: 1.5 })).toBeNull()
    expect(buildLinkedIssueContextSnapshot({ ...ISSUE, url: '  ' })).toBeNull()
  })

  it('keeps a non-positive capturedAt from becoming an unreadable timestamp', () => {
    expect(buildLinkedIssueContextSnapshot({ ...ISSUE, capturedAt: Number.NaN })?.capturedAt).toBe(
      0
    )
  })

  it('caps the persisted body at the block budget so orca-data.json stays bounded', () => {
    const snapshot = buildLinkedIssueContextSnapshot({
      ...ISSUE,
      body: 'x'.repeat(LINKED_ISSUE_CONTEXT_BODY_MAX_CHARS + 500)
    })
    expect(snapshot?.body.length).toBe(LINKED_ISSUE_CONTEXT_BODY_MAX_CHARS)
  })

  it('strips terminal control characters from provider text', () => {
    const snapshot = buildLinkedIssueContextSnapshot({
      ...ISSUE,
      title: 'safe\u001b[31m title',
      body: 'line one\u0007\nline two'
    })
    expect(snapshot?.title).toBe('safe[31m title')
    expect(snapshot?.body).toBe('line one\nline two')
  })

  it('normalizes CRLF bodies so the rendered block has one line ending', () => {
    expect(buildLinkedIssueContextSnapshot({ ...ISSUE, body: 'a\r\nb\rc' })?.body).toBe(
      'a\nb\nc'
    )
  })
})

describe('normalizeLinkedIssueContextSnapshot', () => {
  const stored = buildLinkedIssueContextSnapshot(ISSUE)!

  it('round-trips a snapshot read back from disk', () => {
    expect(normalizeLinkedIssueContextSnapshot(stored)).toEqual(stored)
  })

  it('rejects anything a reader must not trust blindly', () => {
    expect(normalizeLinkedIssueContextSnapshot(undefined)).toBeNull()
    expect(normalizeLinkedIssueContextSnapshot(null)).toBeNull()
    expect(normalizeLinkedIssueContextSnapshot('issue')).toBeNull()
    expect(normalizeLinkedIssueContextSnapshot({ ...stored, version: 2 })).toBeNull()
    expect(normalizeLinkedIssueContextSnapshot({ ...stored, number: -1 })).toBeNull()
    expect(normalizeLinkedIssueContextSnapshot({ ...stored, url: '' })).toBeNull()
  })

  it('repairs an internally inconsistent stored record instead of trusting it', () => {
    expect(
      normalizeLinkedIssueContextSnapshot({ ...stored, capturedAt: 'yesterday', body: 42 })
    ).toMatchObject({ capturedAt: 0, body: '' })
  })
})

describe('renderLinkedIssueContextSnapshot', () => {
  const snapshot = buildLinkedIssueContextSnapshot(ISSUE)!

  it('quotes number, title, url and body', () => {
    const text = renderLinkedIssueContextSnapshot(snapshot)
    expect(text).toContain('Issue: #24')
    expect(text).toContain('Title: feat: inject linked issue')
    expect(text).toContain(`URL: ${ISSUE.url}`)
    expect(text).toContain('Updated: 2026-11-18T10:00:00Z')
    expect(text).toContain('Body:\n## Background\n\nOrca prefills only the URL.')
  })

  it('omits the Updated line when the provider reported none', () => {
    const text = renderLinkedIssueContextSnapshot({ ...snapshot, updatedAt: '' })
    expect(text).not.toContain('Updated:')
  })

  it('marks an empty body instead of leaving a trailing blank section', () => {
    expect(renderLinkedIssueContextSnapshot({ ...snapshot, body: '' })).toContain('Body:\n(empty)')
  })
})

import { describe, expect, it } from 'vitest'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../shared/agent-status-types'
import {
  classifyTitleActivity,
  isExplicitAgentStatusFresh,
  paneHasNoStatusEvidence,
  resolveCommittedTitleAgentType,
  titleClaimsStatus,
  resolvePaneAgentActivity,
  resolveTitleActivityLabel
} from './pane-agent-evidence'

const NOW = 1_700_000_000_000

function entry(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    paneKey: 'tab-1:leaf-1',
    agentType: 'claude',
    state: 'working',
    prompt: '',
    updatedAt: NOW,
    stateStartedAt: NOW,
    stateHistory: [],
    ...overrides
  } as AgentStatusEntry
}

describe('isExplicitAgentStatusFresh', () => {
  it('accepts an entry exactly at the staleness boundary', () => {
    expect(
      isExplicitAgentStatusFresh(
        { updatedAt: NOW - AGENT_STATUS_STALE_AFTER_MS },
        NOW,
        AGENT_STATUS_STALE_AFTER_MS
      )
    ).toBe(true)
  })

  it('rejects an entry past the staleness boundary', () => {
    expect(
      isExplicitAgentStatusFresh(
        { updatedAt: NOW - AGENT_STATUS_STALE_AFTER_MS - 1 },
        NOW,
        AGENT_STATUS_STALE_AFTER_MS
      )
    ).toBe(false)
  })
})

describe('classifyTitleActivity', () => {
  it('classifies working, permission, idle, and unclassifiable titles', () => {
    expect(classifyTitleActivity('mimo working')).toBe('working')
    expect(classifyTitleActivity('Claude - action required')).toBe('permission')
    expect(classifyTitleActivity('✳ Claude Code ready')).toBe('idle')
    expect(classifyTitleActivity('vim')).toBe(null)
  })
})

describe('title agent identity facets', () => {
  it('splits the bare Claude spinner into activity label without committed identity', () => {
    expect(resolveTitleActivityLabel('⠋ compiling everything')).toBe('Claude Code')
    expect(resolveCommittedTitleAgentType('⠋ compiling everything')).toBe(null)
  })

  it('commits identity when the title names the agent explicitly', () => {
    expect(resolveTitleActivityLabel('✳ Claude Code working')).toBe('Claude Code')
    expect(resolveCommittedTitleAgentType('✳ Claude Code working')).toBe('claude')
  })

  it('returns neither facet for a plain shell title', () => {
    expect(resolveTitleActivityLabel('zsh')).toBe(null)
    expect(resolveCommittedTitleAgentType('zsh')).toBe(null)
  })
})

describe('resolvePaneAgentActivity', () => {
  it('reports a fresh hook row as the authoritative source and keeps the title layer visible', () => {
    const decision = resolvePaneAgentActivity({
      explicitEntry: entry({ state: 'waiting' }),
      liveTitle: '⠋ running the tests',
      hasLivePty: true,
      now: NOW
    })
    expect(decision).toEqual({
      hookState: 'waiting',
      hookAgentType: 'claude',
      titleStatus: 'working',
      source: 'hook',
      confidence: 'authoritative',
      livePtyRequired: false,
      noStatusEvidence: false
    })
  })

  it('treats a stale hook row as absent and falls back to the title', () => {
    const decision = resolvePaneAgentActivity({
      explicitEntry: entry({ updatedAt: NOW - AGENT_STATUS_STALE_AFTER_MS - 1 }),
      liveTitle: '⠋ running the tests',
      hasLivePty: true,
      now: NOW
    })
    expect(decision.hookState).toBe(null)
    expect(decision.source).toBe('title')
    expect(decision.confidence).toBe('fallback')
    expect(decision.titleStatus).toBe('working')
    expect(decision.livePtyRequired).toBe(false)
  })

  it('flags title-only evidence without a live PTY so liveness-gated consumers drop it', () => {
    const decision = resolvePaneAgentActivity({
      explicitEntry: undefined,
      liveTitle: '⠋ running the tests',
      hasLivePty: false,
      now: NOW
    })
    expect(decision.source).toBe('title')
    expect(decision.livePtyRequired).toBe(true)
  })

  it('reports none for a plain shell pane that merely carries no status', () => {
    const decision = resolvePaneAgentActivity({
      explicitEntry: undefined,
      liveTitle: 'bash',
      hasLivePty: true,
      now: NOW
    })
    // Why: without identity evidence this is just a shell — the unchanged `source: 'none'`
    // answer. The new field is what separates it from the case below.
    expect(decision).toEqual({
      hookState: null,
      hookAgentType: undefined,
      titleStatus: null,
      source: 'none',
      confidence: 'authoritative',
      livePtyRequired: false,
      noStatusEvidence: false
    })
  })

  it('names a live, identified agent pane whose title says nothing about its state', () => {
    const decision = resolvePaneAgentActivity({
      explicitEntry: undefined,
      // A project name the agent retitled the pane to: identity comes from launch/process
      // evidence, and the title itself claims no state.
      liveTitle: 'demo-repo',
      hasLivePty: true,
      now: NOW,
      hasAgentIdentity: true
    })
    expect(decision.source).toBe('none')
    expect(decision.noStatusEvidence).toBe(true)
  })

  it('keeps a title the detector can read as a claim, whatever layer it arrives on', () => {
    // Why: `idle` is not silence — several agents report rest through their title protocol,
    // so overwriting it with "no status reported" would lose a real report.
    const bareName = resolvePaneAgentActivity({
      explicitEntry: undefined,
      liveTitle: 'codex',
      hasLivePty: true,
      now: NOW,
      hasAgentIdentity: true
    })
    expect(bareName.source).toBe('title')
    expect(bareName.noStatusEvidence).toBe(false)
    expect(titleClaimsStatus('OMP > Run a long task')).toBe(true)
    expect(titleClaimsStatus('demo-repo')).toBe(false)
    expect(titleClaimsStatus('bash')).toBe(false)
  })

  it('treats any explicit row, even a stale one, as evidence that was once reported', () => {
    const decision = resolvePaneAgentActivity({
      explicitEntry: entry({ updatedAt: NOW - AGENT_STATUS_STALE_AFTER_MS - 1 }),
      liveTitle: 'demo-repo',
      hasLivePty: true,
      now: NOW,
      hasAgentIdentity: true
    })
    // The stale row is not fresh, so no claim is current — but the pane has reported before,
    // which is `unverifiable`, not "never reported".
    expect(decision.source).toBe('none')
    expect(decision.noStatusEvidence).toBe(false)
  })

  it('does not claim absent evidence without a live PTY or without identity', () => {
    const base = { explicitEntry: undefined, liveTitle: 'codex', now: NOW }
    const withoutPty = resolvePaneAgentActivity({
      ...base,
      hasLivePty: false,
      hasAgentIdentity: true
    })
    expect(withoutPty.noStatusEvidence).toBe(false)
    const withoutIdentity = resolvePaneAgentActivity({
      ...base,
      hasLivePty: true,
      hasAgentIdentity: false
    })
    expect(withoutIdentity.noStatusEvidence).toBe(false)
  })

  it('never reports absent evidence on the hook or title branches', () => {
    const withHook = resolvePaneAgentActivity({
      explicitEntry: entry({ state: 'done' }),
      liveTitle: null,
      hasLivePty: true,
      now: NOW,
      hasAgentIdentity: true
    })
    expect(withHook.source).toBe('hook')
    expect(withHook.noStatusEvidence).toBe(false)
    const withTitle = resolvePaneAgentActivity({
      explicitEntry: undefined,
      liveTitle: '⠋ running the tests',
      hasLivePty: true,
      now: NOW,
      hasAgentIdentity: true
    })
    expect(withTitle.source).toBe('title')
    expect(withTitle.noStatusEvidence).toBe(false)
  })

  it('passes hook state through raw, including done', () => {
    const decision = resolvePaneAgentActivity({
      explicitEntry: entry({ state: 'done' }),
      liveTitle: null,
      hasLivePty: true,
      now: NOW
    })
    expect(decision.hookState).toBe('done')
    expect(decision.source).toBe('hook')
    expect(decision.noStatusEvidence).toBe(false)
  })
})

describe('paneHasNoStatusEvidence', () => {
  it('requires identity, liveness and the absence of both claims', () => {
    const facts = {
      hasAgentIdentity: true,
      hasLivePty: true,
      hasHookClaim: false,
      hasTitleClaim: false
    }
    expect(paneHasNoStatusEvidence(facts)).toBe(true)
    expect(paneHasNoStatusEvidence({ ...facts, hasAgentIdentity: false })).toBe(false)
    expect(paneHasNoStatusEvidence({ ...facts, hasLivePty: false })).toBe(false)
    expect(paneHasNoStatusEvidence({ ...facts, hasHookClaim: true })).toBe(false)
    expect(paneHasNoStatusEvidence({ ...facts, hasTitleClaim: true })).toBe(false)
  })
})

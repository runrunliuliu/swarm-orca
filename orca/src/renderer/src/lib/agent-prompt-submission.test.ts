import { describe, expect, it, vi } from 'vitest'
import {
  beginAgentSubmitObservation,
  decidePromptSubmission,
  finishAgentSubmitObservation,
  observeAgentTurnState,
  readAgentTurnSnapshot,
  waitForAgentTurnStart,
  type AgentTurnSnapshot
} from './agent-prompt-submission'

const WRITE_AT = 1_000_000

describe('observeAgentTurnState', () => {
  it('reads a running turn, and a pending prompt, as working', () => {
    expect(observeAgentTurnState('working')).toBe('working')
    // Why: an agent holding a permission question or a prompt is not between turns; a new user
    // message there is consumed by that prompt, so it cannot start a turn either.
    expect(observeAgentTurnState('blocked')).toBe('working')
    expect(observeAgentTurnState('waiting')).toBe('working')
  })

  it('reads done as idle and anything else as unknown', () => {
    expect(observeAgentTurnState('done')).toBe('idle')
    expect(observeAgentTurnState(undefined)).toBe('unknown')
    expect(observeAgentTurnState(null)).toBe('unknown')
    expect(observeAgentTurnState('something-new')).toBe('unknown')
  })
})

describe('readAgentTurnSnapshot', () => {
  it('answers unknown for a tab the agent has reported nothing about', () => {
    expect(readAgentTurnSnapshot(undefined, 'tab-1')).toEqual({
      state: 'unknown',
      stateStartedAt: null
    })
    expect(readAgentTurnSnapshot({ 'tab-2:leaf': { state: 'working' } }, 'tab-1').state).toBe(
      'unknown'
    )
  })

  it('prefers a working pane over an idle sibling of the same tab', () => {
    expect(
      readAgentTurnSnapshot(
        {
          'tab-1:a': { state: 'done', stateStartedAt: 10 },
          'tab-1:b': { state: 'working', stateStartedAt: 5 }
        },
        'tab-1'
      )
    ).toEqual({ state: 'working', stateStartedAt: 5 })
  })

  it('matches whole tab ids, not prefixes of them', () => {
    expect(
      readAgentTurnSnapshot({ 'tab-10:a': { state: 'working', stateStartedAt: 1 } }, 'tab-1')
    ).toEqual({ state: 'unknown', stateStartedAt: null })
  })

  it('takes the newest turn when two panes are in the same class', () => {
    expect(
      readAgentTurnSnapshot(
        {
          'tab-1:a': { state: 'done', stateStartedAt: 10 },
          'tab-1:b': { state: 'done', stateStartedAt: 20 }
        },
        'tab-1'
      ).stateStartedAt
    ).toBe(20)
  })
})

describe('decidePromptSubmission', () => {
  const after = (state: AgentTurnSnapshot['state'], startedAt: number | null): AgentTurnSnapshot => ({
    state,
    stateStartedAt: startedAt
  })

  it('confirms a turn that began after the write', () => {
    expect(
      decidePromptSubmission({
        before: 'idle',
        after: after('working', WRITE_AT + 120),
        writeStartedAt: WRITE_AT,
        composerObserved: true
      })
    ).toBe('submitted')
  })

  it('confirms a turn with no reported start time as the best available evidence', () => {
    expect(
      decidePromptSubmission({
        before: 'idle',
        after: after('working', null),
        writeStartedAt: WRITE_AT,
        composerObserved: true
      })
    ).toBe('submitted')
  })

  it('does not confirm a turn that was already running before the write', () => {
    expect(
      decidePromptSubmission({
        before: 'idle',
        after: after('working', WRITE_AT - 5_000),
        writeStartedAt: WRITE_AT,
        composerObserved: true
      })
    ).toBe('unconfirmed')
  })

  // The field shape of issue #60: a wrong first turn was already executing, so the same working
  // state would be reported whether or not the delivery instruction was ever submitted.
  it('reports unconfirmed when the agent was already working before the write', () => {
    expect(
      decidePromptSubmission({
        before: 'working',
        after: after('working', WRITE_AT + 30),
        writeStartedAt: WRITE_AT,
        composerObserved: true
      })
    ).toBe('unconfirmed')
  })

  it('reports unconfirmed when a between-turns agent stayed between turns', () => {
    expect(
      decidePromptSubmission({
        before: 'idle',
        after: after('idle', WRITE_AT - 60_000),
        writeStartedAt: WRITE_AT,
        composerObserved: true
      })
    ).toBe('unconfirmed')
  })

  it('keeps the write as the claim when status says nothing either way', () => {
    expect(
      decidePromptSubmission({
        before: 'unknown',
        after: after('unknown', null),
        writeStartedAt: WRITE_AT,
        composerObserved: true
      })
    ).toBe('written')
  })

  it('reports unconfirmed for a blind write with no status evidence', () => {
    expect(
      decidePromptSubmission({
        before: 'unknown',
        after: after('unknown', null),
        writeStartedAt: WRITE_AT,
        composerObserved: false
      })
    ).toBe('unconfirmed')
  })
})

describe('waitForAgentTurnStart', () => {
  const snapshot = (state: AgentTurnSnapshot['state'], at: number | null = null) => ({
    state,
    stateStartedAt: at
  })

  it('returns immediately when there was no between-turns state to watch', async () => {
    const read = vi.fn(() => snapshot('unknown'))
    const sleep = vi.fn(async (_ms: number) => {})

    await expect(
      waitForAgentTurnStart({ tabId: 'tab-1', before: 'unknown', read, sleep })
    ).resolves.toEqual(snapshot('unknown'))
    expect(sleep).not.toHaveBeenCalled()
  })

  it('returns as soon as the agent starts the turn', async () => {
    const states = [snapshot('idle'), snapshot('idle'), snapshot('working', WRITE_AT)]
    const read = vi.fn(() => states.shift() ?? snapshot('working', WRITE_AT))
    const sleep = vi.fn(async (_ms: number) => {})

    await expect(
      waitForAgentTurnStart({ tabId: 'tab-1', before: 'idle', read, sleep, timeoutMs: 600 })
    ).resolves.toEqual(snapshot('working', WRITE_AT))
    expect(sleep).toHaveBeenCalledTimes(2)
  })

  it('gives up at the budget instead of waiting for a turn that never starts', async () => {
    const read = vi.fn(() => snapshot('idle'))
    const sleep = vi.fn(async (_ms: number) => {})

    await expect(
      waitForAgentTurnStart({
        tabId: 'tab-1',
        before: 'idle',
        read,
        sleep,
        timeoutMs: 500,
        pollMs: 250
      })
    ).resolves.toEqual(snapshot('idle'))
    // Two polls of 250ms fill the 500ms budget; the wait is bounded, not open-ended.
    expect(sleep).toHaveBeenCalledTimes(2)
    expect(sleep.mock.calls.every(([ms]) => ms <= 250)).toBe(true)
  })
})

describe('agent submit observation', () => {
  const unknown: AgentTurnSnapshot = { state: 'unknown', stateStartedAt: null }

  it('starts unarmed, and remembers a blind write while forwarding the caller notice', () => {
    const onUnconfirmedDelivery = vi.fn()
    const observation = beginAgentSubmitObservation({ onUnconfirmedDelivery })

    // Why unarmed: nothing about the pane is known until the write actually happens.
    expect(observation).toMatchObject({ before: 'unknown', startedAt: 0, composerObserved: true })

    observation.markWriteStart(() => 'idle', WRITE_AT)

    expect(observation).toMatchObject({ before: 'idle', startedAt: WRITE_AT, composerObserved: true })

    observation.markComposerUnobserved()

    expect(observation.composerObserved).toBe(false)
    expect(onUnconfirmedDelivery).toHaveBeenCalledTimes(1)
  })

  it('needs nothing from the agent when the write never happened', async () => {
    const read = vi.fn(() => unknown)
    const observation = beginAgentSubmitObservation({})
    observation.markWriteStart(() => 'idle', WRITE_AT)

    await expect(
      finishAgentSubmitObservation({
        observation,
        tabId: 'tab-1',
        written: false,
        read
      })
    ).resolves.toBe('not-written')
    expect(read).not.toHaveBeenCalled()
  })

  it('confirms the turn that began after the write', async () => {
    const observation = beginAgentSubmitObservation({})
    observation.markWriteStart(() => 'idle', WRITE_AT)

    await expect(
      finishAgentSubmitObservation({
        observation,
        tabId: 'tab-1',
        written: true,
        read: () => ({ state: 'working', stateStartedAt: WRITE_AT + 40 })
      })
    ).resolves.toBe('submitted')
  })

  it('does not confirm a blind write the agent never acknowledged', async () => {
    const observation = beginAgentSubmitObservation({})
    observation.markWriteStart(() => 'unknown', WRITE_AT)
    observation.markComposerUnobserved()

    await expect(
      finishAgentSubmitObservation({
        observation,
        tabId: 'tab-1',
        written: true,
        read: () => unknown
      })
    ).resolves.toBe('unconfirmed')
  })
})

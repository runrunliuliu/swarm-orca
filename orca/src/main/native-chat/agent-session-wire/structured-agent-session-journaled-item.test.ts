/**
 * The one notification contract every sink write path shares (M4-C3): it fires after the write, and it
 * can never fail the append it rides on.
 *
 * This is what makes the resolved-append variants (a revised tool-call row, i.e. exactly where a
 * failed tool result arrives) covered rather than silently excluded.
 */
import { describe, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import {
  appendJournalItemAndNotify,
  notifyJournaledItem
} from './structured-agent-session-journaled-item'

const identity = { provider: 'orca', clientMessageId: 'claude-tool:s-1:toolu-1' } as const
const body = { kind: 'tool-call', name: 'Bash', input: {}, state: 'failed' } as const
const turnScope = { kind: 'turn', turnItemId: 'turn-1' } as const

describe('notifyJournaledItem', () => {
  it('reports the item key, body and turn', () => {
    const seen: unknown[] = []
    notifyJournaledItem((item) => seen.push(item), identity, body, turnScope)
    expect(seen).toEqual([
      { itemKey: agentJournalItemKey(identity), body, turnScope }
    ])
  })

  it('swallows an observer throw so the journal append survives', () => {
    expect(() =>
      notifyJournaledItem(
        () => {
          throw new Error('observer exploded')
        },
        identity,
        body,
        turnScope
      )
    ).not.toThrow()
  })

  it('does nothing when no observer is wired', () => {
    expect(() => notifyJournaledItem(undefined, identity, body, turnScope)).not.toThrow()
  })
})

describe('appendJournalItemAndNotify', () => {
  function target(appendItem: (...args: unknown[]) => Promise<unknown>) {
    return { fence: 1, journal: { appendItem } }
  }

  it('notifies only after the append resolves', async () => {
    const order: string[] = []
    const onJournaled = vi.fn(() => order.push('notified'))
    const result = await appendJournalItemAndNotify({
      bound: target(async () => {
        order.push('appended')
        return { ok: true }
      }) as never,
      identity,
      body,
      options: { turnScope },
      onJournaled
    })
    expect(result).toEqual({ ok: true })
    expect(order).toEqual(['appended', 'notified'])
  })

  it('does not notify when the append rejects', async () => {
    const onJournaled = vi.fn()
    await expect(
      appendJournalItemAndNotify({
        bound: target(async () => {
          throw new Error('write failed')
        }) as never,
        identity,
        body,
        options: { turnScope },
        onJournaled
      })
    ).rejects.toThrow('write failed')
    expect(onJournaled).not.toHaveBeenCalled()
  })
})

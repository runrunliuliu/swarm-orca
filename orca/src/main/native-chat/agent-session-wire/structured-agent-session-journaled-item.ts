// One live-sink item append, plus the "it landed" notification the incident collector rides on.
//
// Split out of structured-agent-session-event-sink.ts so that file stays inside the max-lines budget
// and so the ordering rule lives in one place: the notification fires AFTER the journal write
// resolves, which is what keeps a rejected append from being counted as a tool error.

import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentJournalTurnScope
} from '../../../shared/agent-session-journal-types'
import { structuredAgentSessionJournalAppendOptions } from './structured-agent-session-journal-append-options'

/** One item that reached the journal through a live sink. */
export type StructuredAgentSessionJournaledItem = {
  itemKey: string
  body: AgentJournalItemBody
  turnScope: AgentJournalTurnScope
}

/** What the append needs from the bound sink target; structural so it cannot import the sink back. */
export type JournalAppendTarget = {
  fence: number
  journal: {
    appendItem(
      identity: AgentJournalItemIdentity,
      body: AgentJournalItemBody,
      options: ReturnType<typeof structuredAgentSessionJournalAppendOptions>
    ): Promise<unknown>
  }
}

export function appendJournalItemAndNotify(input: {
  bound: JournalAppendTarget
  identity: AgentJournalItemIdentity
  body: AgentJournalItemBody
  options: {
    turnScope: AgentJournalTurnScope
    coalescingKey?: string
    lifecycle?: boolean
    observedAt?: number
    producer?: unknown
  }
  onJournaled?: (item: StructuredAgentSessionJournaledItem) => void
}): Promise<unknown> {
  return input.bound.journal
    .appendItem(
      input.identity,
      input.body,
      structuredAgentSessionJournalAppendOptions(input.bound.fence, input.options as never)
    )
    .then((result) => {
      try {
        input.onJournaled?.({
          itemKey: agentJournalItemKey(input.identity),
          body: input.body,
          turnScope: input.options.turnScope
        })
      } catch {
        // A diagnostics observer must never fail a journal append.
      }
      return result
    })
}

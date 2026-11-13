import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentJournalTurnScope
} from '../../../shared/agent-session-journal-types'
import { notifyJournaledItem } from './structured-agent-session-journaled-item'
import { estimateStructuredAgentSessionItemBytes } from './structured-agent-session-event-sink-estimate'
import type {
  StructuredAgentSessionItemAppendOptions,
  StructuredAgentSessionEventSink,
  StructuredAgentSessionRevisionJournal
} from './structured-agent-session-event-sink'
import { structuredAgentSessionJournalAppendOptions } from './structured-agent-session-journal-append-options'
import type { StructuredAgentSessionSinkQueue } from './structured-agent-session-event-sink-queue'

type ResolvedItem = { identity: AgentJournalItemIdentity; body: AgentJournalItemBody }

export function createStructuredAgentSessionResolvedAppend(
  queue: StructuredAgentSessionSinkQueue,
  onJournaled?: (item: { itemKey: string; body: AgentJournalItemBody; turnScope: AgentJournalTurnScope }) => void
): Required<
  Pick<
    StructuredAgentSessionEventSink,
    | 'tryAppendResolvedItem'
    | 'tryAppendResolvedItemAndPublish'
    | 'tryReviseResolvedItem'
    | 'tryReviseResolvedItemAndPublish'
    | 'tryAppendLifecycleTransition'
  >
> {
  const submit = (
    reservedBytes: number,
    resolve: (journal: StructuredAgentSessionRevisionJournal) => ResolvedItem | null,
    options: Omit<StructuredAgentSessionItemAppendOptions, 'coalescingKey'>,
    publish: boolean
  ) =>
    queue.submit(
      {
        bytes: reservedBytes,
        run: async (bound) => {
          const resolved = resolve(bound.journal)
          if (resolved === null) {
            return
          }
          const bytes = estimateStructuredAgentSessionItemBytes(resolved.identity, resolved.body)
          if (bytes + (publish ? 1 : 0) > reservedBytes) {
            throw new Error('structured agent-session resolved item exceeded its reserved size')
          }
          await bound.journal.appendItem(
            resolved.identity,
            resolved.body,
            structuredAgentSessionJournalAppendOptions(bound.fence, options)
          )
          notifyJournaledItem(onJournaled, resolved.identity, resolved.body, options.turnScope)
          if (publish) {
            bound.publish()
          }
        }
      },
      options
    )
  const identityOnly = (publish: boolean) =>
    ((identitySizeBound, body, resolveIdentity, options) =>
      submit(
        estimateStructuredAgentSessionItemBytes(identitySizeBound, body) + (publish ? 1 : 0),
        (journal) => {
          const identity = resolveIdentity(journal)
          return identity === null ? null : { identity, body }
        },
        options,
        publish
      )) satisfies NonNullable<StructuredAgentSessionEventSink['tryAppendResolvedItem']>
  return {
    tryAppendResolvedItem: identityOnly(false),
    tryAppendResolvedItemAndPublish: identityOnly(true),
    tryReviseResolvedItem: (reservedBytes, resolve, options) =>
      submit(reservedBytes, resolve, options, false),
    tryReviseResolvedItemAndPublish: (reservedBytes, resolve, options) =>
      submit(reservedBytes + 1, resolve, options, true),
    tryAppendLifecycleTransition: (identitySizeBound, body, resolveIdentity, options) => {
      const bytes = estimateStructuredAgentSessionItemBytes(identitySizeBound, body)
      return queue.submit(
        {
          bytes,
          lifecycle: true,
          run: async (bound) => {
            const identity = resolveIdentity(bound.journal)
            if (identity === null) {
              return
            }
            if (estimateStructuredAgentSessionItemBytes(identity, body) > bytes) {
              throw new Error('structured agent-session item identity exceeded its reserved size')
            }
            await bound.journal.appendItem(
              identity,
              body,
              structuredAgentSessionJournalAppendOptions(bound.fence, options)
            )
            notifyJournaledItem(onJournaled, identity, body, options.turnScope)
            bound.publish()
          }
        },
        { lifecycle: true }
      )
    }
  }
}

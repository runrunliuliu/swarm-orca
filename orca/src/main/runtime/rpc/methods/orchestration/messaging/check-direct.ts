import type { MessageType, OrchestrationDb } from '../../../../orchestration/db'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { formatMessageBanner } from '../../../../orchestration/formatter'
import { exposeMessages } from './mailbox-message-receipt'
import { reconcileLifecycleMessage } from '../../../../orchestration/lifecycle-reconciliation'
import { ORCHESTRATION_LEGACY_RUN_ID } from '../../../../../../shared/orchestration-rpc-contract'
import type { CheckParams } from '../schemas'
import type { z } from 'zod'

type CheckParamsInput = z.infer<typeof CheckParams>

export async function checkDirectMailbox(args: {
  params: CheckParamsInput
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  handle: string
  typeFilter: MessageType[] | undefined
  signal: AbortSignal | undefined
}): Promise<unknown> {
  const { params, runtime, db, handle, typeFilter, signal } = args
  // Why: unread:false is honored for one release as a compat shim so in-flight callers don't break (design doc §5).
  const showAll = params.all === true || (params.unread === false && params.peek !== true)
  const consumeUnread = !showAll && params.peek !== true
  const readAndReturn = () => {
    const messages = showAll
      ? db.getAllMessagesForHandle(handle, undefined, typeFilter)
      : db.getUnreadMessages(handle, typeFilter)
    if (
      consumeUnread &&
      messages.some((message) => message.run_id === ORCHESTRATION_LEGACY_RUN_ID)
    ) {
      throw new OrchestrationError(
        'legacy_read_only',
        'Legacy orchestration messages are inspect-only; use --peek or --all. No acknowledgment was applied.',
        { effectsApplied: false }
      )
    }
    let visibleMessages = messages
    if (consumeUnread && messages.length > 0) {
      // Why: unread check is an authoritative read path for worker_done/heartbeat, so reconcile lifecycle messages here too.
      // M5 review C2: a worker_done the acceptance gate blocks must stay unread here as well as in the
      // coordinator. This path used to mark everything read, so `acceptance resolve --accept` found no
      // message left to resume and the dispatch stayed unsettled forever.
      const keepUnread = new Set<string>()
      visibleMessages = messages.map((message) => {
        const reconciled = reconcileLifecycleMessage(db, message)
        if (reconciled.action === 'acceptance_pending') {
          keepUnread.add(message.id)
          return message
        }
        return reconciled.action === 'rejected'
          ? (db.getMessageById(message.id) ?? message)
          : message
      })
      const read = messages.map((message) => message.id).filter((id) => !keepUnread.has(id))
      if (read.length > 0) {
        db.markAsRead(read)
      }
    }
    if (params.format || params.inject) {
      const formatted = visibleMessages.map(formatMessageBanner).join('\n\n')
      return { messages: exposeMessages(visibleMessages), formatted, count: visibleMessages.length }
    }
    return { messages: exposeMessages(visibleMessages), count: visibleMessages.length }
  }

  if (signal?.aborted) {
    return { messages: [], count: 0 }
  }
  const result = readAndReturn()
  if (result.count > 0 || !params.wait) {
    return result
  }
  // Why: signal aborts this waiter when the client socket closes, freeing the long-poll slot immediately rather than after timeoutMs (design doc §3.1).
  const waitResult = await runtime.waitForMessage(handle, {
    typeFilter: typeFilter as string[] | undefined,
    timeoutMs: params.timeoutMs ?? undefined,
    signal
  })
  if (signal?.aborted) {
    return { messages: [], count: 0 }
  }
  if (waitResult === 'cancelled') {
    throw new OrchestrationError(
      'consumer_fenced',
      'This direct mailbox became owned by a Run while the check was waiting.'
    )
  }
  return readAndReturn()
}

// Extracting failed tool calls from one journal item (issue-sedimentation.md v2.5 §7.3, M4-1).
//
// The item body is the *structured* evidence: a failed `tool-call` item carries the tool name, the
// state and a bounded output head; a message carries render blocks where a `tool-result` may be marked
// `isError`. Nothing here reads transcripts, files or provider stderr — the journal already reduced
// them to this shape, and the output head is only ever handed to the classifier.

import type {
  AgentJournalItemBody,
  AgentJournalTurnScope
} from '../../shared/agent-session-journal-types'
import type { NativeChatBlock } from '../../shared/native-chat-types'

export type ToolErrorObservation = {
  /** The tool that failed, as the provider named it. */
  toolName: string
  /** Bounded output head for classification; dropped after the code is chosen. */
  output: string
  exitCode: number | null
  /** Position within the item, so two failures in one message are two observations. */
  ordinal: number
}

/** Blocks that carry tool calls/results, in the order the renderer would show them. */
function blockObservations(blocks: readonly NativeChatBlock[]): ToolErrorObservation[] {
  const observations: ToolErrorObservation[] = []
  let pendingCall: string | null = null
  let ordinal = 0
  for (const block of blocks) {
    if (block.type === 'tool-call') {
      pendingCall = block.name
      if (block.state === 'failed') {
        // A failed call with no separate result block is still one error.
        observations.push({ toolName: block.name, output: '', exitCode: null, ordinal: ordinal++ })
      }
      continue
    }
    if (block.type === 'tool-result') {
      if (block.isError === true) {
        observations.push({
          toolName: pendingCall ?? 'unknown_tool',
          output: block.output,
          exitCode: null,
          ordinal: ordinal++
        })
      }
      pendingCall = null
    }
  }
  return observations
}

function exitCodeFromOutput(head: string): number | null {
  const match = /\b(?:exit(?:ed)? (?:with )?(?:code|status)|command failed with code) (\d{1,3})\b/i.exec(
    head
  )
  return match ? Number(match[1]) : null
}

/**
 * Every failed tool call in one item, with the turn it belongs to.
 *
 * `turnScope` is the journal's own attribution: `turn` → the turn item id (the key's epoch component),
 * `thread` → the literal `thread`, because a thread-scoped write has no turn to name and inventing one
 * would make two different turns collide.
 */
export function toolErrorObservations(
  body: AgentJournalItemBody,
  turnScope: AgentJournalTurnScope
): { turn: string; observations: ToolErrorObservation[] } {
  const turn = turnScope.kind === 'turn' ? turnScope.turnItemId : 'thread'
  if (body.kind === 'tool-call') {
    if (body.state !== 'failed') {
      return { turn, observations: [] }
    }
    const head = body.output?.head ?? ''
    return {
      turn,
      observations: [
        { toolName: body.name, output: head, exitCode: exitCodeFromOutput(head), ordinal: 0 }
      ]
    }
  }
  if (body.kind === 'message') {
    return { turn, observations: blockObservations(body.blocks) }
  }
  return { turn, observations: [] }
}

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
  /** Bounded output head for the low-confidence hint; dropped after the code is chosen. */
  output: string
  /** Structured exit status from the journal item, when the provider supplied one. */
  exitCode: number | null
  /** Structured refusal kind stamped by the provider translation (M4-C1). */
  errorKind: string | null
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
        observations.push({
          toolName: block.name,
          output: '',
          exitCode: null,
          errorKind: null,
          ordinal: ordinal++
        })
      }
      continue
    }
    if (block.type === 'tool-result') {
      if (block.isError === true) {
        observations.push({
          toolName: pendingCall ?? 'unknown_tool',
          output: block.output,
          exitCode: null,
          errorKind: null,
          ordinal: ordinal++
        })
      }
      pendingCall = null
    }
  }
  return observations
}

/**
 * A numeric exit status, if the provider put one on the item.
 *
 * Deliberately NOT parsed from the output head any more (M4-C1): the journal item carries
 * `exitCode` as a structured field (`NativeChatToolMetadata`), the codex translation populates it from
 * the provider's own item, and every other provider leaves it absent. Absent means the status is
 * unknown — a regex over "exited with code 2" would be a low-confidence guess promoted to a code.
 */
function structuredExitCode(body: { exitCode?: unknown }): number | null {
  const value = body.exitCode
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null
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
        {
          toolName: body.name,
          output: head,
          exitCode: structuredExitCode(body),
          errorKind: typeof body.errorKind === 'string' ? body.errorKind : null,
          ordinal: 0
        }
      ]
    }
  }
  if (body.kind === 'message') {
    return { turn, observations: blockObservations(body.blocks) }
  }
  return { turn, observations: [] }
}

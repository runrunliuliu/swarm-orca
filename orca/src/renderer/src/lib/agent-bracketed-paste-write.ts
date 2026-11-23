import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { TerminalInputKind } from '../../../shared/terminal-input-kind'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import { useAppStore } from '@/store'
import { sendRuntimePtyInputVerified } from '@/runtime/runtime-terminal-inspection'
import { runTerminalPtyInputTransaction } from '@/components/terminal-pane/terminal-pty-input-transaction'
import { sendAgentDraftPasteContentNow } from './agent-draft-paste-content'

/**
 * The one write path for "paste this text into an agent, then optionally submit it".
 *
 * Why its own module: paste, the 50ms split before Enter, and the per-agent Enter retry have to be
 * a single PTY input transaction, and the launch and mid-session senders both need exactly that.
 * Keeping it beside the readiness logic made `agent-paste-draft` grow past its line budget, and a
 * write primitive is the part of that file with the least to do with readiness.
 */
export const POST_PASTE_SUBMIT_DELAY_MS = 50

export async function sendBracketedPasteToAgent(args: {
  settings?: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null
  ptyId: string
  content: string
  submit: boolean
  agent?: TuiAgent
  inputKind: TerminalInputKind
  /**
   * Called inside the input transaction, immediately before the first write.
   *
   * Why there and not before the transaction: another operation on the same PTY can hold the queue,
   * and a timestamp from before that wait would let a turn that began in between count as this
   * write's turn (issue #60's `submitted` vs `unconfirmed`).
   */
  onWriteStart?: () => void
}): Promise<boolean> {
  const { settings = useAppStore.getState().settings, ptyId, content, submit, agent } = args
  const { inputKind, onWriteStart } = args
  const submitRetryDelayMs = agent ? TUI_AGENT_CONFIG[agent]?.submitRetryDelayMs : undefined
  try {
    // Why: paste + Enter (+ retry Enter) must be one transaction, or a concurrent
    // paste on this PTY can slip between them and submit a half-written prompt.
    return await runTerminalPtyInputTransaction(ptyId, async () => {
      onWriteStart?.()
      const pasted = await sendAgentDraftPasteContentNow(settings, ptyId, content, inputKind)
      if (!pasted || !submit) {
        return pasted
      }

      // Why: Claude Code can leave a prompt as editable text when paste-end and
      // Enter arrive in the same PTY write. Split the submit into the next turn so
      // the TUI processes bracketed-paste termination before handling Enter.
      await new Promise<void>((resolve) => window.setTimeout(resolve, POST_PASTE_SUBMIT_DELAY_MS))
      const submitted = await sendRuntimePtyInputVerified(settings, ptyId, '\r', inputKind)

      if (submitRetryDelayMs !== undefined) {
        // Why: agents that render their composer before Enter is live silently eat
        // the first Enter; the retry is best-effort and never downgrades `submitted`.
        await new Promise<void>((resolve) => window.setTimeout(resolve, submitRetryDelayMs))
        try {
          await sendRuntimePtyInputVerified(settings, ptyId, '\r', inputKind)
        } catch {
          // Why: a rejected retry leaves the first Enter's verdict untouched.
        }
      }

      return submitted
    })
  } catch {
    return false
  }
}

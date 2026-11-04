import type { RuntimeTerminalRead } from '../../shared/runtime-terminal-contracts'
import { describeTerminalWaitBlockedReason } from '../../shared/terminal-wait-blocked-reason-legacy-alias'
import { settleBeforeDeadline } from './settle-before-deadline'
import { detectTerminalWaitBlockedReason } from './terminal-wait-detection'
import { hasTraeStartupComposer } from './trae-terminal-readiness'

/** A pre-submit gate for a fresh Trae only, not evidence that an existing agent is idle. */
export async function waitForTraeStartupComposer(
  readScreen: () => Promise<RuntimeTerminalRead>,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const read = await settleBeforeDeadline<RuntimeTerminalRead | null>(
      readScreen,
      null,
      deadline,
      new Error('timeout'),
      (error) => error instanceof Error && error.message === 'terminal_handle_stale'
    )
    // Only the current screen can prove that a startup dialog still owns input.
    const blockedReason =
      read?.source === 'screen' ? detectTerminalWaitBlockedReason(read.tail.join('\n')) : null
    if (blockedReason) {
      throw new Error(`Agent startup blocked: ${describeTerminalWaitBlockedReason(blockedReason)}`)
    }
    if (read?.source === 'screen' && hasTraeStartupComposer(read.tail)) {
      return
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw new Error('timeout')
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, remaining)))
  }
}

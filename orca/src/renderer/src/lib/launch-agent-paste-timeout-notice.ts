import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { track, tuiAgentToAgentKind } from '@/lib/telemetry'
import { copyPromptToastAction } from '@/lib/copy-prompt-toast-action'
import { translate } from '@/i18n/i18n'
import type { TuiAgent } from '../../../shared/tui-agent'

/**
 * Notice for a post-launch paste that never landed — a stalled readiness wait
 * would otherwise drop the user's text silently.
 *
 * `wasNotified()` reports whether a toast was actually shown, so a deferred
 * caller can suppress a duplicate. It stays false when this surface chose to
 * stay quiet — a closed tab, or a workspace the reader has switched away from —
 * because "nobody here was told" is not the same as "the reader was told", and a
 * delivery that reached no one must not be reported as already communicated
 * (issue #60).
 */
export function createPasteReadinessTimeoutNotice(args: {
  worktreeId: string
  tabId: string
  agent: TuiAgent
  submitted: boolean
  /**
   * The text that did not make it. When present the notice carries the same copy action the
   * deferred delivery notice uses, so the reader can repair it from whichever notice they see
   * first — the alternative was a first notice with no action that then suppressed the one with it.
   */
  prompt?: string
}): { onTimeout: () => void; wasNotified: () => boolean } {
  let notified = false
  return {
    wasNotified: () => notified,
    onTimeout: () => {
      const state = useAppStore.getState()
      const currentTab = (state.tabsByWorktree[args.worktreeId] ?? []).find(
        (tab) => tab.id === args.tabId
      )
      if (currentTab?.ptyId === null) {
        // Why: PTY never spawned = genuine launch failure; stay silent so the caller emits the sole notice.
        return
      }
      if (!currentTab || state.activeWorktreeId !== args.worktreeId) {
        // Why: the reader cancelled (closed the tab) or is looking at another workspace, so toasting
        // here would land in a surface they are not watching. `notified` stays false on purpose: a
        // deferred caller still owes the reader a durable statement that the text did not arrive.
        return
      }
      toast.message(
        translate(
          'auto.lib.launch.agent.in.new.tab.a5a1f7033f',
          "Your {{value0}} wasn't sent — paste it once the agent is ready.",
          { value0: args.submitted ? 'prompt' : 'notes' }
        ),
        args.prompt?.trim() ? copyPromptToastAction(args.prompt) : undefined
      )
      notified = true
      track('agent_error', {
        error_class: 'paste_readiness_timeout',
        agent_kind: tuiAgentToAgentKind(args.agent)
      })
    }
  }
}

import { agentDeliversDraftViaNativePrefill } from '@/lib/agent-native-draft-prefill'
import { pasteDraftWhenAgentReady } from '@/lib/agent-paste-draft'
import {
  beginAgentSubmitObservation,
  finishAgentSubmitObservation,
  readAgentTurnSnapshot,
  type AgentPromptSubmissionVerdict,
  type AgentTurnSnapshot
} from '@/lib/agent-prompt-submission'
import { canMirrorLaunchDraftToNativeChat } from '@/lib/native-chat-launch-draft-mirrorability'
import { isNativeChatSupportedAgent } from '@/lib/native-chat-supported-agent'
import { useAppStore } from '@/store'
import { LAUNCH_PTY_SPAWN_TIMEOUT_MS } from '../../../shared/draft-paste-ready-timeout'
import type { TuiAgent } from '../../../shared/tui-agent'

/** Seed the chat-composer copy of launch context that reaches only the TUI
 *  input (argv prefill or startup paste). No-op for agents without a
 *  native-chat renderer, or for text `canMirrorLaunchDraftToNativeChat`
 *  rejects — the same predicate that decides whether the tab opens in chat. */
export function seedNativeChatLaunchDraftForAgentTab(args: {
  tabId: string
  agent: TuiAgent
  text: string
}): void {
  if (!canMirrorLaunchDraftToNativeChat(args.text) || !isNativeChatSupportedAgent(args.agent)) {
    return
  }
  useAppStore.getState().seedNativeChatLaunchDraft({
    tabId: args.tabId,
    agent: args.agent,
    text: args.text,
    createdAt: Date.now()
  })
}

export function deliverLaunchPromptToAgentTab(args: {
  tabId: string
  agent: TuiAgent
  content: string
  submit: boolean
  forcePaste: boolean
  timeoutMs?: number
  onTimeout?: () => void
  /** Overrides the admitted-spawn budget for this delivery (see `LAUNCH_PTY_SPAWN_TIMEOUT_MS`). */
  spawnTimeoutMs?: number
  /** The paste was written without ever observing the agent's composer. */
  onUnconfirmedDelivery?: () => void
  /** What this delivery may claim about the prompt becoming a turn (issue #60). */
  onSubmitVerdict?: (verdict: AgentPromptSubmissionVerdict) => void
}): Promise<boolean> {
  const {
    tabId,
    agent,
    content,
    submit,
    forcePaste,
    timeoutMs,
    onTimeout,
    spawnTimeoutMs,
    onUnconfirmedDelivery,
    onSubmitVerdict
  } = args
  const shouldSeed =
    submit === true && content.trim().length > 0 && isNativeChatSupportedAgent(agent)

  if (shouldSeed) {
    useAppStore.getState().seedNativeChatLaunchPrompt({
      tabId,
      agent,
      text: content,
      createdAt: Date.now()
    })
  } else if (submit !== true) {
    // Why: an unsubmitted draft lives only in the TUI input buffer; seed the
    // chat-composer copy so the context isn't invisible in the GUI view.
    seedNativeChatLaunchDraftForAgentTab({ tabId, agent, text: content })
  }

  // Why: native-prefill agents (claude/openclaude etc.) get the prompt at launch,
  // so pasteDraftWhenAgentReady returns false without pasting. That is a successful
  // native delivery, not a failure — don't flag the seeded bubble in that case.
  const deliversViaNativePrefill = agentDeliversDraftViaNativePrefill(agent, forcePaste)
  // Why an observation and not two readings: the verdict is the difference between "what the pane
  // was doing" and "what it published after the write" (#60). It is opened unarmed and takes both
  // facts at the write itself, because the paste waits for the PTY and then the composer — a
  // timestamp from before those waits would misattribute a turn that began in between. A launch
  // that never writes (native prefill, a draft) opens no observation and publishes no verdict.
  const observation =
    submit === true && !deliversViaNativePrefill
      ? beginAgentSubmitObservation({ onUnconfirmedDelivery })
      : null

  return pasteDraftWhenAgentReady({
    tabId,
    content,
    agent,
    submit,
    forcePaste,
    timeoutMs,
    onTimeout,
    // Why the launch budget here: this paste belongs to a tab whose startup command was already
    // queued, so its spawn is expected and may legitimately outlast the generic 8s verdict (#60).
    spawnTimeoutMs: spawnTimeoutMs ?? LAUNCH_PTY_SPAWN_TIMEOUT_MS,
    ...(observation
      ? {
          onUnconfirmedDelivery: observation.markComposerUnobserved,
          onWriteStart: () =>
            observation.markWriteStart(() => readAgentTurnSnapshotForTab(tabId).state)
        }
      : onUnconfirmedDelivery
        ? { onUnconfirmedDelivery }
        : {})
  }).then(
    async (delivered) => {
      if (shouldSeed && !delivered && !deliversViaNativePrefill) {
        useAppStore.getState().markNativeChatLaunchPromptFailed(tabId)
      }
      if (observation && onSubmitVerdict) {
        onSubmitVerdict(
          await finishAgentSubmitObservation({
            observation,
            tabId,
            written: delivered,
            read: readAgentTurnSnapshotForTab
          })
        )
      }
      return delivered || deliversViaNativePrefill
    },
    (error) => {
      if (shouldSeed && !deliversViaNativePrefill) {
        useAppStore.getState().markNativeChatLaunchPromptFailed(tabId)
      }
      throw error
    }
  )
}

/**
 * The live hook status rows that describe one tab's turns.
 *
 * Why the store and not the PTY: whether a written message became a turn is reported by the agent
 * through its hooks, per pane, and that is the only evidence a client has (issue #60).
 */
function readAgentTurnSnapshotForTab(tabId: string): AgentTurnSnapshot {
  return readAgentTurnSnapshot(useAppStore.getState().agentStatusByPaneKey, tabId)
}

import type { GlobalSettings } from '../../../shared/global-settings-types'

/** Only the flag this feature reads, so a caller can pass the store's settings without a cast. */
type PrefillSetting = Pick<GlobalSettings, 'prefillLinkedIssueContextOnAgentLaunch'>
import type { Worktree } from '../../../shared/worktree/types'
import {
  normalizeLinkedIssueContextSnapshot,
  renderLinkedIssueContextSnapshot,
  type LinkedIssueContextSnapshot
} from '../../../shared/linked-issue-context-snapshot'
import { buildContainedLinkedContextBlock } from './linked-work-item-context'

/**
 * Settings gate. Absent means enabled: the feature is "inject the linked issue automatically", so
 * a profile written before the setting existed must behave like the documented default, and only an
 * explicit opt-out (`false`) turns it off.
 */
export function isLinkedIssueContextPrefillEnabled(
  settings: PrefillSetting | null | undefined
): boolean {
  return settings?.prefillLinkedIssueContextOnAgentLaunch !== false
}

/**
 * Render the cached snapshot as the contained, untrusted-source block the agent sees.
 *
 * Returns null for anything that is not a valid snapshot for a GitHub issue, which keeps the
 * caller honest: "no block" is always expressed as null rather than an empty string that could end
 * up as a blank draft.
 */
export function buildLinkedIssueContextBlock(
  snapshot: LinkedIssueContextSnapshot | null | undefined
): string | null {
  const normalized = normalizeLinkedIssueContextSnapshot(snapshot)
  if (!normalized) {
    return null
  }
  return buildContainedLinkedContextBlock({
    provider: 'github',
    version: 1,
    renderedText: renderLinkedIssueContextSnapshot(normalized)
  })
}

/**
 * The draft a new agent should start with in this worktree, or null when it should start clean.
 *
 * Why the number is checked again here: the snapshot and the link are two persisted fields, so a
 * mismatched pair (older build, hand-edited state) must drop the block instead of quoting a
 * different issue than the one the worktree is linked to.
 */
export function resolveLinkedIssueContextDraft(args: {
  worktree: Pick<Worktree, 'linkedIssue' | 'linkedIssueContext'> | null | undefined
  settings: PrefillSetting | null | undefined
}): string | null {
  if (!isLinkedIssueContextPrefillEnabled(args.settings)) {
    return null
  }
  const snapshot = normalizeLinkedIssueContextSnapshot(args.worktree?.linkedIssueContext)
  if (!snapshot) {
    return null
  }
  if (args.worktree?.linkedIssue !== snapshot.number) {
    return null
  }
  return buildLinkedIssueContextBlock(snapshot)
}

export type LinkedIssueDraftLaunchDecision = {
  /** Prompt to launch with; unchanged when the user already typed one. */
  prompt: string
  promptDelivery: 'auto-submit' | 'draft' | 'submit-after-ready'
  /** True when `prompt` came from the cached issue snapshot rather than from the user. */
  injectedIssueContext: boolean
}

/**
 * Decide whether the cached issue context fills an otherwise empty agent launch.
 *
 * A user prompt always wins untouched — the linked issue is prefilled only into a launch that
 * would have started with no prompt at all, and it is delivered as a draft so nothing is submitted
 * on the user's behalf.
 */
export function planLinkedIssueContextLaunch(args: {
  prompt: string | undefined
  promptDelivery: 'auto-submit' | 'draft' | 'submit-after-ready'
  draft: string | null
}): LinkedIssueDraftLaunchDecision {
  const userPrompt = args.prompt?.trim() ?? ''
  if (userPrompt.length > 0 || !args.draft) {
    return {
      prompt: userPrompt,
      promptDelivery: args.promptDelivery,
      injectedIssueContext: false
    }
  }
  return { prompt: args.draft, promptDelivery: 'draft', injectedIssueContext: true }
}

import type { AgentStatus } from '../../../shared/agent-detection'
import { detectAgentStatusFromTitle, getAgentLabel } from '../../../shared/agent-detection'
import { isCursorAgentTitle } from '../../../shared/agent-title-core'
import { isClaudeManagementTitle } from '../../../shared/terminal-title-agent-type'
import { resolveExplicitTerminalTitleAgentType } from '../../../shared/terminal-title-agent-type'
import type { TuiAgent } from '../../../shared/tui-agent'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  agentStatusEvidenceObservedAt,
  type AgentStatusEntry,
  type AgentStatusState,
  type AgentType
} from '../../../shared/agent-status-types'

// Why: explicit agent status entries (from hook-based reports) can go stale if
// the agent process exits without sending a final update. This helper lets
// callers decide whether to trust the entry based on a configurable TTL.
// (Moved here from agent-status.ts so the evidence resolvers below and the
// aggregate consumers share one gate without an import cycle.)
export function isExplicitAgentStatusFresh(
  entry: Pick<
    AgentStatusEntry,
    | 'updatedAt'
    | 'evidenceObservedAt'
    | 'mirroredEvidenceReceivedAt'
    | 'restoredUnconfirmed'
    | 'structuredHostOwned'
  >,
  now: number,
  staleAfterMs: number
): boolean {
  // Why: an unconfirmed hydrated row may describe a turn that ended while no receiver was up; never fresh.
  return (
    entry.restoredUnconfirmed !== true &&
    (entry.structuredHostOwned === true ||
      now - agentStatusEvidenceObservedAt(entry) <= staleAfterMs)
  )
}

/**
 * Title-only activity classification for consumers whose product rule really
 * is "what does this title say" (timer seeding, ready-wait polling, sort-epoch
 * comparison, synthetic-title writing) — they combine no hook/liveness
 * evidence, so routing them through the pane resolver would misstate intent.
 */
export function classifyTitleActivity(title: string): AgentStatus | null {
  return detectAgentStatusFromTitle(title)
}

/**
 * The two facets of title-derived agent identity. The ACTIVITY LABEL treats
 * Claude's bare status prefixes (spinner/`✳`/`. `/`* `) as Claude activity;
 * COMMITTED identity rejects them — evidence that something runs is not proof
 * of who. Consumers historically split on this by accident; pick the facet
 * that matches the product rule, never both out of habit.
 */
export function resolveTitleActivityLabel(title: string): string | null {
  return getAgentLabel(title)
}

/** See resolveTitleActivityLabel — the strict facet for identity decisions. */
export function resolveCommittedTitleAgentType(title: string): TuiAgent | null {
  return resolveExplicitTerminalTitleAgentType(title)
}

/**
 * Whether a live title says anything about the agent's state, as opposed to only
 * letting Orca name the agent.
 *
 * `detectAgentStatusFromTitle` is the authority here, including its `idle` answer:
 * several agents report rest through their title protocol (Pi/OMP's `>` marker,
 * Gemini's idle glyph, an OpenCode session title with no spinner), so a blanket
 * "idle is not a claim" rule would overwrite an agent's own report with "no status
 * reported". What counts as silence is a title the detector cannot read at all — a
 * plain project name the agent retitled the pane to, or a bare shell prompt.
 *
 * The two status-neutral surfaces whose rows Orca deliberately pins to `idle` stay
 * claims: the `claude agents` management list and the bare `cursor agent` literal
 * (#10258). The shared detector leaves both neutral on purpose.
 */
export function titleClaimsStatus(title: string): boolean {
  return (
    detectAgentStatusFromTitle(title) !== null ||
    isClaudeManagementTitle(title) ||
    isCursorAgentTitle(title)
  )
}

/**
 * The one rule behind "this pane names an agent and holds a live PTY, yet has
 * reported no status at all". The pane resolver below and the worktree-dot
 * heuristic both call it, so a row and its card cannot disagree about what
 * counts as evidence.
 *
 * `hasHookClaim` is any hook row Orca still attributes to the pane — fresh, or a
 * stale one that reported before. Only a pane that never reported has *no*
 * evidence; a pane whose stream went quiet is `unverifiable`, which says how long
 * the silence has run. Identity and liveness are supplied by the caller from
 * evidence Orca already holds (title identity, a live process read, the live-PTY
 * map) — never from the absence of a report — and the answer is never a completion
 * claim: silence is not evidence (docs/reference/ssh-execution-boundary.md).
 *
 * Deliberately a caller-supplied flag rather than a second identity resolver: each
 * surface knows which evidence it may trust (the worktree dot rejects a reattach's
 * launch record, the row builder accepts a process read).
 */
export function paneHasNoStatusEvidence(input: {
  hasAgentIdentity: boolean
  hasLivePty: boolean
  hasHookClaim: boolean
  hasTitleClaim: boolean
}): boolean {
  return input.hasAgentIdentity && input.hasLivePty && !input.hasHookClaim && !input.hasTitleClaim
}

/**
 * Combined pane activity evidence for aggregate consumers. The hook and title
 * layers are exposed separately on purpose: consumers legitimately combine
 * them differently (send targets let a live permission title override a fresh
 * working hook; the worktree dot suppresses titles on hook-covered panes), so
 * a single merged status would silently change behavior.
 */
export type AgentActivityDecision = {
  /** Fresh (within AGENT_STATUS_STALE_AFTER_MS), pane-scoped hook state; null when absent or stale. */
  hookState: AgentStatusState | null
  /** Agent identity from the fresh hook row, when one exists. */
  hookAgentType: AgentType | undefined
  /** Title-derived status of the pane's live title, independent of hook state. */
  titleStatus: AgentStatus | null
  /** Which evidence layer holds the strongest current claim. */
  source: 'hook' | 'title' | 'none'
  confidence: 'authoritative' | 'fallback'
  /** True when the only claim is a title without live-PTY proof — liveness-gated consumers must treat it as absent. */
  livePtyRequired: boolean
  /**
   * True only on the `source: 'none'` branch, when the caller proved agent
   * identity and a live PTY anyway (see `paneHasNoStatusEvidence`). Consumers use
   * it to say "this agent has not reported a status" instead of showing the pane
   * as a quiet shell. False on every hook and title branch, by construction.
   */
  noStatusEvidence: boolean
}

export type ResolvePaneAgentActivityInput = {
  explicitEntry: AgentStatusEntry | undefined
  liveTitle: string | null
  hasLivePty: boolean
  now: number
  /**
   * Independent evidence that this pane runs an identified agent (title identity
   * token, launch record, or a foreground process read). Absent means "unknown",
   * which keeps the shell-pane answer of `source: 'none'` unchanged.
   */
  hasAgentIdentity?: boolean
}

export function resolvePaneAgentActivity(
  input: ResolvePaneAgentActivityInput
): AgentActivityDecision {
  const freshEntry =
    input.explicitEntry &&
    isExplicitAgentStatusFresh(input.explicitEntry, input.now, AGENT_STATUS_STALE_AFTER_MS)
      ? input.explicitEntry
      : null
  const titleStatus = input.liveTitle !== null ? detectAgentStatusFromTitle(input.liveTitle) : null
  // Why one computation for all three branches: a fresh row, a stale one and a title claim
  // are three ways a pane can have spoken, and every one of them is a hook/claim answer.
  // Only a pane with none of them can be reported as "never said anything", which keeps the
  // hook and title branches false without a special case each.
  const noStatusEvidence = paneHasNoStatusEvidence({
    hasAgentIdentity: input.hasAgentIdentity === true,
    hasLivePty: input.hasLivePty,
    hasHookClaim: input.explicitEntry !== undefined,
    hasTitleClaim: input.liveTitle !== null && titleClaimsStatus(input.liveTitle)
  })
  if (freshEntry) {
    return {
      hookState: freshEntry.state,
      hookAgentType: freshEntry.agentType,
      titleStatus,
      source: 'hook',
      confidence: 'authoritative',
      livePtyRequired: false,
      noStatusEvidence
    }
  }
  if (titleStatus !== null) {
    return {
      hookState: null,
      hookAgentType: undefined,
      titleStatus,
      source: 'title',
      confidence: 'fallback',
      livePtyRequired: !input.hasLivePty,
      noStatusEvidence
    }
  }
  return {
    hookState: null,
    hookAgentType: undefined,
    titleStatus: null,
    source: 'none',
    confidence: 'authoritative',
    livePtyRequired: false,
    noStatusEvidence
  }
}

import {
  agentStatusEvidenceObservedAt,
  type AgentStatusEntry,
  type AgentStatusState
} from '../../../shared/agent-status-types'

/**
 * Row states: the hook-reported statuses plus the ones Orca derives from its own
 * evidence — `idle` (a named pane nothing claims is working), `unverifiable` (a
 * report that went quiet while the PTY is still held), and `no-evidence` (a named
 * agent pane that never reported anything, e.g. hooks are not installed).
 */
export type AgentRowState = AgentStatusState | 'idle' | 'unverifiable' | 'no-evidence'

type DecayInput = Pick<AgentStatusEntry, 'state' | 'restoredUnconfirmed'>

/**
 * Where a stale non-`done` entry decays to.
 *
 * Silence is not evidence (docs/reference/ssh-execution-boundary.md), so the destination
 * splits on the liveness Orca actually holds: a pane whose PTY is still in the live-PTY map
 * only lost its reporting stream (`unverifiable`), while a pane with no PTY has nothing
 * running behind it (`idle`). Neither ever claims the agent finished.
 *
 * `restoredUnconfirmed` rows are excluded: they are stale by construction rather than by
 * elapsed silence, and their last evidence predates a process boundary — so there is no
 * "how long since we last heard" for `unverifiable` to report.
 */
export function resolveDecayedAgentRowState(
  entry: DecayInput,
  hasLivePty: boolean
): 'idle' | 'unverifiable' {
  return hasLivePty && entry.state !== 'done' && entry.restoredUnconfirmed !== true
    ? 'unverifiable'
    : 'idle'
}

/** Coarse `34m` / `2h` / `3d` duration, floored so it never overstates the gap. */
export function formatCompactDuration(deltaMs: number): string {
  const minutes = Math.max(0, Math.floor(deltaMs / 60_000))
  if (minutes < 60) {
    return `${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `${hours}h`
  }
  return `${Math.floor(hours / 24)}d`
}

/**
 * The label for a `no-evidence` row. It names the gap in Orca's knowledge, not the
 * agent's activity: no status was ever reported for this pane, which for a launched
 * agent usually means its hooks are not installed (an externally started app-server,
 * a wrapper launcher, a plain `CODEX_HOME` without Orca's hook config). Deliberately
 * does not read as `idle` ("nothing is happening") or `done` ("it finished").
 */
export function agentNoStatusEvidenceLabel(): string {
  return 'No status reported'
}

/**
 * The observer's report for an `unverifiable` row. Deliberately says what Orca last heard
 * rather than what the agent is doing: the elapsed time is what lets a user apply knowledge
 * Orca does not have (a 40-minute build, a long download).
 */
export function agentNoUpdateLabel(
  entry: Pick<AgentStatusEntry, 'updatedAt' | 'evidenceObservedAt'>,
  now: number
): string {
  return `No update in ${formatCompactDuration(now - agentStatusEvidenceObservedAt(entry))}`
}

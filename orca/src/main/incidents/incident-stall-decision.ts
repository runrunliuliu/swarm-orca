// The stall decision, as a pure function (issue-sedimentation.md v2.4 §7.2, M3-2).
//
// There was no "is this pane stuck?" judgement anywhere in the main process: only per-pane
// timestamps and a narrow reaping sweep. This is the missing predicate, kept free of timers, SQLite
// and the hook server so the thresholds can be tested at the exact minute boundary instead of by
// waiting 45 of them.
//
// AGE BASIS (M3-C1). The age is `now - lastSemanticEventAt`, and `lastSemanticEventAt` is the status
// row's `evidenceObservedAt`: "when the reported evidence was first observed, as distinct from
// receivedAt (delivery order)". That is the only clock on the row that measures staleness — the
// payload's own comment says so, because a relay reconnect replays cached rows and restamps
// `receivedAt` to stay monotonic, which would make a dead pane look fresh forever.
//
// Deliberately NOT the basis:
//   * PTY byte/output timestamps — a TUI spinner repaints forever and would suppress every stall;
//   * `receivedAt` — delivery, restamped on relay replay (see above);
//   * `stateStartedAt` — that is the epoch (idempotency), and a long healthy turn keeps it old.
//
// When a row has no `evidenceObservedAt` (old hosts), the age falls back to `stateStartedAt` and the
// decision says so with `ageBasis: 'state_fallback'` — in the row, the JSON, the text and coverage.
// A fallback age is a weaker signal and must never be presented as the semantic one.
//
// The order of the checks is the policy:
//   1. an unreadable state is never a stall (`unknown_state`), because nothing can be concluded;
//   2. only `working` can stall — `blocked`/`waiting`/`done` are the agent's own reported states and
//      a "no progress" incident for them would be noise (§7.2 "不写");
//   3. a live operator declaration wins over the age (`waiting_declared`): a long training run with
//      a declared wait is expected, not stuck;
//   4. age below the threshold is `below_threshold`;
//   5. fewer than the required observation cycles is `insufficient_cycles` — one long gap between
//      two samples must not be enough;
//   6. only then `stalled`.

import type { AgentStatusState } from '../../shared/agent-status-types'

/** §7.2 / §19.1: 45 minutes without progress. */
export const STALL_THRESHOLD_MS = 45 * 60 * 1000
/** §7.2: ≥2 independent observation cycles. The cycle IS the sampler interval. */
export const STALL_REQUIRED_CYCLES = 2
/** One sample per minute is the granularity the threshold is expressed in (§13 M3). */
export const STALL_SAMPLE_INTERVAL_MS = 60 * 1000

export const STALL_THRESHOLDS = {
  stallMs: STALL_THRESHOLD_MS,
  requiredCycles: STALL_REQUIRED_CYCLES,
  sampleIntervalMs: STALL_SAMPLE_INTERVAL_MS
} as const

export type StallThresholds = {
  stallMs: number
  requiredCycles: number
  sampleIntervalMs: number
}

export type StallDecisionReason =
  | 'waiting_declared'
  | 'not_working'
  | 'below_threshold'
  | 'insufficient_cycles'
  /** No semantic event for the threshold. Not "the agent is stuck" — see the module note. */
  | 'no_event_for_threshold'
  | 'unknown_state'

/**
 * Which clock the age came from. `state_fallback` is a degraded signal (the row never reported a
 * semantic event clock) and every surface must show it as such.
 */
export type StallAgeBasis = 'event' | 'state_fallback'

export type StallPaneFacts = {
  paneKey: string
  /** The status row's state, as reported. Unknown/foreign values are treated as unknown. */
  state: string
  /** Epoch of the current state; the stall key's epoch (§6.2.1). */
  stateStartedAt: number
  /** When the current main-agent turn began, if the host reported it. Context for a reader; NOT the age basis. */
  turnStartedAt?: number | null
  /**
   * `evidenceObservedAt` from the status row, or null when the host never reported one.
   * This is the semantic-event clock: the age is measured from it, and its absence switches the
   * decision to the stated `state_fallback` basis.
   */
  lastSemanticEventAt: number | null
}

export type StallWaitDeclarationFacts = {
  reason: string
  /** Wall-clock deadline; a declaration with no deadline lives until it is cleared. */
  expiresAt: number | null
  /** The epoch the declaration was made against; must equal the pane's, or it does not apply. */
  epoch: string
}

export type StallDecisionInput = {
  facts: StallPaneFacts
  now: number
  thresholds?: Partial<StallThresholds>
  declaration?: StallWaitDeclarationFacts | null
  /**
   * Number of independent samples in which this epoch was observed. Defaults to what the age can
   * prove (`age / sampleIntervalMs`); a sampler that has actually counted samples passes the count.
   */
  cyclesObserved?: number
}

export type StallDecision = {
  /** True when a *write-enabled* sampler may record this. Never means "confirmed stuck". */
  wouldWriteIfEnabled: boolean
  ageMs: number
  ageBasis: StallAgeBasis
  reason: StallDecisionReason
  /** Epoch this decision is about, so a caller cannot mix two epochs up. */
  epoch: number
  thresholds: StallThresholds
}

const WORKING_STATE: AgentStatusState = 'working'

function isWorkingState(state: string): boolean {
  return state === WORKING_STATE
}

/** Everything that is not one of the four reported states is treated as unknown. */
function isKnownState(state: string): boolean {
  return state === 'working' || state === 'blocked' || state === 'waiting' || state === 'done'
}

export function normalizeThresholds(overrides?: Partial<StallThresholds>): StallThresholds {
  return {
    stallMs: overrides?.stallMs ?? STALL_THRESHOLDS.stallMs,
    requiredCycles: overrides?.requiredCycles ?? STALL_THRESHOLDS.requiredCycles,
    sampleIntervalMs: overrides?.sampleIntervalMs ?? STALL_THRESHOLDS.sampleIntervalMs
  }
}

/** The later of the two clocks a pane might have, and which one it was (see the module note). */
export function stallAgeClock(
  facts: StallPaneFacts,
  now: number
): { since: number; ageMs: number; ageBasis: StallAgeBasis } {
  const hasEvent = typeof facts.lastSemanticEventAt === 'number' && Number.isFinite(facts.lastSemanticEventAt)
  const since = hasEvent ? (facts.lastSemanticEventAt as number) : facts.stateStartedAt
  return {
    since,
    ageMs: Math.max(0, now - since),
    ageBasis: hasEvent ? 'event' : 'state_fallback'
  }
}

export function stallAgeMs(facts: StallPaneFacts, now: number): number {
  return stallAgeClock(facts, now).ageMs
}

export function decideStall(input: StallDecisionInput): StallDecision {
  const thresholds = normalizeThresholds(input.thresholds)
  const clock = stallAgeClock(input.facts, input.now)
  const ageMs = clock.ageMs
  const epoch = input.facts.stateStartedAt
  const base = { ageMs, ageBasis: clock.ageBasis, epoch, thresholds }

  if (!isKnownState(input.facts.state)) {
    return { ...base, wouldWriteIfEnabled: false, reason: 'unknown_state' }
  }
  if (!isWorkingState(input.facts.state)) {
    return { ...base, wouldWriteIfEnabled: false, reason: 'not_working' }
  }
  const liveDeclaration =
    input.declaration !== null &&
    input.declaration !== undefined &&
    input.declaration.epoch === String(epoch) &&
    (input.declaration.expiresAt === null || input.declaration.expiresAt > input.now)
  if (liveDeclaration) {
    return { ...base, wouldWriteIfEnabled: false, reason: 'waiting_declared' }
  }
  if (ageMs < thresholds.stallMs) {
    return { ...base, wouldWriteIfEnabled: false, reason: 'below_threshold' }
  }
  const cycles =
    input.cyclesObserved ?? Math.floor(ageMs / Math.max(1, thresholds.sampleIntervalMs))
  if (cycles < thresholds.requiredCycles) {
    return { ...base, wouldWriteIfEnabled: false, reason: 'insufficient_cycles' }
  }
  return { ...base, wouldWriteIfEnabled: true, reason: 'no_event_for_threshold' }
}

/** True when a decision is allowed to become an incident (M3-4). */
export function stallDecisionWrites(decision: StallDecision): boolean {
  return decision.wouldWriteIfEnabled && decision.reason === 'no_event_for_threshold'
}

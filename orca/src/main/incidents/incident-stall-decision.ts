// The stall decision, as a pure function (issue-sedimentation.md v2.4 §7.2, M3-2).
//
// There was no "is this pane stuck?" judgement anywhere in the main process: only per-pane
// timestamps and a narrow reaping sweep. This is the missing predicate, kept free of timers, SQLite
// and the hook server so the thresholds can be tested at the exact minute boundary instead of by
// waiting 45 of them.
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
  | 'stalled'
  | 'unknown_state'

export type StallPaneFacts = {
  paneKey: string
  /** The status row's state, as reported. Unknown/foreign values are treated as unknown. */
  state: string
  /** Epoch of the current state; the stall key's epoch (§6.2.1). */
  stateStartedAt: number
  /** When the current main-agent turn began, if the host reported it. */
  turnStartedAt?: number | null
  /** When the row was actually observed (evidence time where available, else received time). */
  observedAt: number
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
  wouldStall: boolean
  ageMs: number
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

/**
 * Age is measured from the latest progress signal the agent gave: a turn that started after the
 * state did means the state timestamp is already stale (e.g. `working` re-emitted by a title update).
 */
export function stallAgeMs(facts: StallPaneFacts, now: number): number {
  const since = Math.max(facts.stateStartedAt, facts.turnStartedAt ?? Number.NEGATIVE_INFINITY)
  return Math.max(0, now - since)
}

export function decideStall(input: StallDecisionInput): StallDecision {
  const thresholds = normalizeThresholds(input.thresholds)
  const ageMs = stallAgeMs(input.facts, input.now)
  const epoch = input.facts.stateStartedAt
  const base = { ageMs, epoch, thresholds }

  if (!isKnownState(input.facts.state)) {
    return { ...base, wouldStall: false, reason: 'unknown_state' }
  }
  if (!isWorkingState(input.facts.state)) {
    return { ...base, wouldStall: false, reason: 'not_working' }
  }
  const liveDeclaration =
    input.declaration !== null &&
    input.declaration !== undefined &&
    input.declaration.epoch === String(epoch) &&
    (input.declaration.expiresAt === null || input.declaration.expiresAt > input.now)
  if (liveDeclaration) {
    return { ...base, wouldStall: false, reason: 'waiting_declared' }
  }
  if (ageMs < thresholds.stallMs) {
    return { ...base, wouldStall: false, reason: 'below_threshold' }
  }
  const cycles =
    input.cyclesObserved ?? Math.floor(ageMs / Math.max(1, thresholds.sampleIntervalMs))
  if (cycles < thresholds.requiredCycles) {
    return { ...base, wouldStall: false, reason: 'insufficient_cycles' }
  }
  return { ...base, wouldStall: true, reason: 'stalled' }
}

/** True when a decision is allowed to become an incident (M3-4). */
export function stallDecisionWrites(decision: StallDecision): boolean {
  return decision.wouldStall && decision.reason === 'stalled'
}

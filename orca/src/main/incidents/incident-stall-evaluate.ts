// Per-row stall evaluation (M3-2/M3-3), extracted from the sampler so both stay inside the budget.
//
// Pure apart from the two callbacks: `cyclesObserved` is the sampler's in-memory "how many times have
// I seen this epoch" count (a decision input), `rememberSeen` lets the caller prune epochs that are
// gone. Nothing here reads the clock, the database or an environment variable.

import type { StallSampleRow } from './incident-stall-samples'
import {
  decideStall,
  type StallDecision,
  type StallPaneFacts,
  type StallThresholds
} from './incident-stall-decision'
import type { WaitDeclaration } from './incident-wait'

export type StallCandidate = {
  facts: StallPaneFacts
  decision: StallDecision
}

export type StallEvaluation = {
  rows: StallSampleRow[]
  /** Panes the predicate would write for, if the switch were on. */
  wouldWrite: number
  /** Panes whose age crossed the threshold with no semantic event. */
  noEvent: number
  /** Exactly the panes a write-enabled run should record. */
  candidates: StallCandidate[]
}

export function evaluateStallRows(input: {
  rows: readonly StallPaneFacts[]
  waits: readonly WaitDeclaration[]
  thresholds: StallThresholds
  now: number
  cyclesObserved: (paneKey: string, epoch: number) => number
  rememberSeen: (paneKey: string, epoch: number) => void
}): StallEvaluation {
  const waits = new Map<string, WaitDeclaration>()
  for (const declaration of input.waits) {
    waits.set(`${declaration.paneKey}\u0000${declaration.epoch}`, declaration)
  }

  const rows: StallSampleRow[] = []
  const candidates: StallCandidate[] = []
  let wouldWrite = 0
  let noEvent = 0

  for (const row of input.rows) {
    input.rememberSeen(row.paneKey, row.stateStartedAt)
    const declaration = waits.get(`${row.paneKey}\u0000${row.stateStartedAt}`) ?? null
    const decision = decideStall({
      facts: row,
      now: input.now,
      thresholds: input.thresholds,
      declaration: declaration
        ? { reason: declaration.reason, expiresAt: declaration.expiresAt, epoch: declaration.epoch }
        : null,
      cyclesObserved: input.cyclesObserved(row.paneKey, row.stateStartedAt)
    })
    if (decision.wouldWriteIfEnabled) {
      wouldWrite += 1
    }
    if (decision.reason === 'no_event_for_threshold') {
      noEvent += 1
      candidates.push({ facts: row, decision })
    }
    rows.push({
      paneKey: row.paneKey,
      terminalHandle: (row as StallPaneFacts & { terminalHandle?: string | null }).terminalHandle ?? null,
      state: row.state,
      stateStartedAt: row.stateStartedAt,
      turnStartedAt: row.turnStartedAt ?? null,
      lastSemanticEventAt: row.lastSemanticEventAt,
      ageMs: decision.ageMs,
      ageBasis: decision.ageBasis,
      thresholdMs: input.thresholds.stallMs,
      wouldWriteIfEnabled: decision.wouldWriteIfEnabled,
      reason: decision.reason,
      declaredWait: declaration?.reason ?? null
    })
  }
  return { rows, wouldWrite, noEvent, candidates }
}

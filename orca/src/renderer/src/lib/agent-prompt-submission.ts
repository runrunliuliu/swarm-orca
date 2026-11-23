/**
 * Did the prompt Orca typed actually become a turn? (issue #60)
 *
 * Writing bytes into a PTY and the agent submitting a user message are different events:
 * `sendRuntimePtyInputVerified` only reports that the PTY accepted input, and the readiness
 * handshake only reports that the composer exists. Issue #60 is what the gap costs — a wrong first
 * prompt was already running, the delivery instruction was pasted into the input box, and nothing
 * in the launch path could tell that it had never been submitted.
 *
 * The evidence available to a client is the agent's own hook status: a submitted turn moves the
 * pane from "between turns" to "working", and its `stateStartedAt` says when that turn began. This
 * module turns that into a verdict with one rule: **unknown is never upgraded to a claim.** When
 * the agent reports nothing, the launch keeps today's meaning ("the text was written") and the
 * caller decides whether to say anything; a positive or negative turn verdict is only emitted from
 * evidence the agent actually published.
 */

/** What a pane's hook status says about turns, as this module needs it. */
export type AgentTurnObservation = 'working' | 'idle' | 'unknown'

export type AgentTurnSnapshot = {
  state: AgentTurnObservation
  /** When the observed state began, when the agent reported it. */
  stateStartedAt: number | null
}

/** One `agentStatusByPaneKey` row, structurally typed so this module stays store-free. */
export type AgentStatusPaneEntry = { state: string; stateStartedAt?: number | null }

export type AgentStatusPaneRecord = Record<string, AgentStatusPaneEntry | undefined>

/**
 * The verdict a launch can publish about its prompt.
 *
 * - `submitted`: a turn that was not running when the write happened began after it.
 * - `written`: the text was written into an observed composer, and status said nothing either way.
 * - `unconfirmed`: the text was written, but the evidence says no turn began — the agent was
 *   already running one, status said it stayed between turns, or the composer was never observed.
 *   This verdict never claims "the agent did not get it"; it claims "Orca cannot show that it did".
 * - `not-written`: the readiness wait expired or the write was rejected; nothing reached the PTY.
 */
export type AgentPromptSubmissionVerdict = 'submitted' | 'written' | 'unconfirmed' | 'not-written'

/** How long a caller watches for the turn a submit is supposed to start. */
export const AGENT_SUBMIT_CONFIRMATION_TIMEOUT_MS = 2000
export const AGENT_SUBMIT_CONFIRMATION_POLL_MS = 250

/**
 * Read one status row as an observation.
 *
 * `blocked` and `waiting` are not "between turns": the agent is holding a prompt or a question, so
 * a new user message cannot be attributed to a turn either. Only `done` means the agent is ready
 * for a fresh message.
 */
export function observeAgentTurnState(state: string | null | undefined): AgentTurnObservation {
  if (state === 'working' || state === 'blocked' || state === 'waiting') {
    return 'working'
  }
  return state === 'done' ? 'idle' : 'unknown'
}

function snapshotFromEntry(entry: AgentStatusPaneEntry | undefined): AgentTurnSnapshot {
  const state = observeAgentTurnState(entry?.state)
  const startedAt = entry?.stateStartedAt
  return {
    state,
    stateStartedAt: typeof startedAt === 'number' && Number.isFinite(startedAt) ? startedAt : null
  }
}

/**
 * The strongest turn observation for one terminal tab across its panes.
 *
 * Why a tab and not a pane key: a launch knows the tab it created, not which leaf the agent ended
 * up in, and a working pane is the one that matters. Newest `stateStartedAt` breaks ties between
 * panes in the same class.
 */
export function readAgentTurnSnapshot(
  panes: AgentStatusPaneRecord | null | undefined,
  tabId: string
): AgentTurnSnapshot {
  const prefix = `${tabId}:`
  let best: AgentTurnSnapshot = { state: 'unknown', stateStartedAt: null }
  for (const [paneKey, entry] of Object.entries(panes ?? {})) {
    if (!paneKey.startsWith(prefix)) {
      continue
    }
    const candidate = snapshotFromEntry(entry)
    if (candidate.state === 'unknown') {
      continue
    }
    if (best.state === 'unknown') {
      best = candidate
      continue
    }
    // Why working wins over idle regardless of timestamps: an agent that is running a turn is the
    // fact a submit has to be judged against, and a sibling idle pane would hide it.
    if (candidate.state === 'working' && best.state !== 'working') {
      best = candidate
      continue
    }
    if (
      candidate.state === best.state &&
      (candidate.stateStartedAt ?? 0) > (best.stateStartedAt ?? 0)
    ) {
      best = candidate
    }
  }
  return best
}

/**
 * Turn two observations into the verdict a launch may publish.
 *
 * `before` is read just before the write, `after` once the confirmation window has passed.
 */
export function decidePromptSubmission(args: {
  before: AgentTurnObservation
  after: AgentTurnSnapshot
  /** When the paste was written; a turn that began earlier is not this write's turn. */
  writeStartedAt: number
  /** Whether the agent's composer was observed at all, or the paste was written blind. */
  composerObserved: boolean
}): Exclude<AgentPromptSubmissionVerdict, 'not-written'> {
  const { before, after, writeStartedAt, composerObserved } = args
  const startedAfterWrite =
    after.stateStartedAt === null || after.stateStartedAt >= writeStartedAt
  if (after.state === 'working' && before !== 'working' && startedAfterWrite) {
    return 'submitted'
  }
  // Why a turn that was already running is unconfirmable rather than submitted: the same working
  // state would be reported whether our message was submitted or merely typed into the box (#60).
  if (before === 'working') {
    return 'unconfirmed'
  }
  if (after.state === 'working') {
    // A turn that began before this write was not started by it.
    return 'unconfirmed'
  }
  if (before === 'idle' && after.state === 'idle') {
    return 'unconfirmed'
  }
  if (!composerObserved) {
    return 'unconfirmed'
  }
  return 'written'
}

/**
 * Wait for the turn a submit should start, bounded by `timeoutMs`.
 *
 * Only meaningful when the pane was `idle` before the write; any other starting state has nothing
 * to wait for, so it returns immediately with the state it already read.
 */
export async function waitForAgentTurnStart(args: {
  tabId: string
  before: AgentTurnObservation
  read: (tabId: string) => AgentTurnSnapshot
  timeoutMs?: number
  pollMs?: number
  sleep?: (ms: number) => Promise<void>
}): Promise<AgentTurnSnapshot> {
  const { tabId, before, read } = args
  let current = read(tabId)
  if (before !== 'idle' || current.state === 'working') {
    return current
  }
  const timeoutMs = args.timeoutMs ?? AGENT_SUBMIT_CONFIRMATION_TIMEOUT_MS
  const pollMs = args.pollMs ?? AGENT_SUBMIT_CONFIRMATION_POLL_MS
  const sleep =
    // Why the global timer and not `window`: this module is unit-tested without a DOM, and
    // `vi.useFakeTimers()` patches whichever one the runtime actually has.
    args.sleep ??
    ((ms: number) => new Promise<void>((resolve) => globalThis.setTimeout(resolve, ms)))
  let waited = 0
  while (waited < timeoutMs) {
    await sleep(Math.min(pollMs, timeoutMs - waited))
    waited += pollMs
    current = read(tabId)
    if (current.state === 'working') {
      return current
    }
  }
  return current
}

/**
 * One submit's observation, opened just before the write.
 *
 * Why an object and not two calls at the read sites: the observation has to survive the write and
 * the confirmation window, and the two facts it carries (when the write happened, whether the
 * composer was ever observed) are only known on either side of it.
 */
export type AgentSubmitObservation = {
  /** What the pane was doing just before the write; the verdict compares it with what comes after. */
  before: AgentTurnObservation
  /** When the write actually happened. A turn that began earlier is not this write's turn. */
  startedAt: number
  /** False once the paste was written without the agent's composer ever being seen. */
  composerObserved: boolean
  /**
   * Take the writing observation.
   *
   * Why not at construction: a launch paste waits for the PTY and then for the agent's composer, so
   * seconds can pass between "about to deliver" and the write. A timestamp from before those waits
   * would let a turn that began in between count as one this write started — the difference between
   * `submitted` and `unconfirmed` (issue #60).
   */
  markWriteStart: (readBefore?: () => AgentTurnObservation, now?: number) => void
  /** Forwards to the caller's unconfirmed notice, and remembers it for the verdict. */
  markComposerUnobserved: () => void
}

export function beginAgentSubmitObservation(args: {
  onUnconfirmedDelivery?: () => void
}): AgentSubmitObservation {
  const observation: AgentSubmitObservation = {
    // Why unknown until the write: an unopened observation must not look like a between-turns agent.
    before: 'unknown',
    startedAt: 0,
    composerObserved: true,
    markWriteStart: (readBefore, now) => {
      observation.before = readBefore?.() ?? 'unknown'
      observation.startedAt = now ?? Date.now()
    },
    markComposerUnobserved: () => {
      observation.composerObserved = false
      args.onUnconfirmedDelivery?.()
    }
  }
  return observation
}

/**
 * Decide what the write that just happened may claim, waiting for the turn it should have started.
 *
 * `not-written` is returned without waiting: there is nothing to confirm when the PTY never took
 * the bytes.
 */
export async function finishAgentSubmitObservation(args: {
  observation: AgentSubmitObservation
  tabId: string
  written: boolean
  read: (tabId: string) => AgentTurnSnapshot
}): Promise<AgentPromptSubmissionVerdict> {
  const { observation, tabId, written, read } = args
  if (!written) {
    return 'not-written'
  }
  // Why no verdict without a write observation: an unarmed observation has no timestamp to compare
  // against, and guessing one would let a turn that began before the write count as this write's.
  // The neutral claim (the bytes went in) is all the evidence supports.
  if (observation.startedAt === 0) {
    return 'written'
  }
  return decidePromptSubmission({
    before: observation.before,
    after: await waitForAgentTurnStart({ tabId, before: observation.before, read }),
    writeStartedAt: observation.startedAt,
    composerObserved: observation.composerObserved
  })
}

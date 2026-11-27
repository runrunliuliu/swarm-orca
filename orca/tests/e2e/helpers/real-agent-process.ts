/**
 * Ownership of the **real agent process** an e2e case started, with the same rule the apex host uses
 * for its own child (`orcad-apex-child.ts`): a stop is finished only when the exit is *confirmed*.
 *
 * Why this module exists separately from `real-agent-tui.ts`: the rule is worth a unit test with a
 * fake process, and that test must not load Playwright or the product's extension source.
 *
 * Why the rule matters here: `pi` is a child of the apex, so stopping the apex is not evidence that
 * the agent is gone, and a signal that was merely **sent** is not evidence either (SIGTERM can be
 * ignored or handled and ignored). If the exit cannot be confirmed, the caller must keep the fixture
 * tree the agent was configured from and report a cleanup failure instead of deleting it.
 *
 * Why an unknown pid is a failure and not a no-op: "the pane never reported a pid" is what a *created*
 * pane looks like when the TUI wait timed out or the `inspectProcess` call failed — the agent may be
 * running, with no handle to signal it. Only `noAgentProcess()` (nothing was created) may be reported
 * as "nothing to reclaim"; everything else has to fail closed and keep the tree.
 */

/** The process a case owns: its pid (when one exists) plus how to probe and signal it. */
export type AgentProcessControl = {
  pid: number | null
  /**
   * Whether this case ever asked the apex to create a pane for the agent. `false` only when nothing
   * was created, i.e. when no process can exist. A created pane with an unknown pid is **not**
   * "nothing to reclaim" — that is the state the stop below has to refuse.
   */
  created: boolean
  /** `kill(pid, 0)` semantics: false only when the kernel says the process does not exist. */
  isAlive: () => boolean
  /** Deliver a signal; throws when it cannot be delivered. */
  signal: (signal: NodeJS.Signals) => void
}

/** True while `pid` exists. A signal that cannot be delivered (`EPERM`) is not "gone". */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as { code?: string } | null)?.code !== 'ESRCH'
  }
}

/**
 * Nothing was created for this case (`terminal.create` failed, or the case threw before asking for a
 * pane): no process can exist, so there is nothing to reclaim and no exit to confirm.
 */
export function noAgentProcess(): AgentProcessControl {
  return { pid: null, created: false, isAlive: () => false, signal: () => {} }
}

/**
 * A pane **exists**. `pid` is what the apex reported, and `null` means the identity could not be
 * established — the TUI wait timed out, `inspectProcess` threw, or it reported no foreground pid.
 * That state is deliberately *not* "no process": the agent may be running and unreachable, so a stop
 * must report "not reclaimed" rather than return quietly.
 */
export function launchedAgentProcess(pid: number | null): AgentProcessControl {
  return {
    pid,
    created: true,
    isAlive: () => (pid === null ? false : isProcessAlive(pid)),
    signal: (signal) => {
      if (pid === null) {
        return
      }
      process.kill(pid, signal)
    }
  }
}

export type StopAgentOptions = {
  /** How long SIGTERM gets before escalating to SIGKILL (default 15 s: a TUI needs to restore). */
  graceMs?: number
  /** How long SIGKILL gets to be confirmed as an exit (default 5 s; injectable for the unit test). */
  killGraceMs?: number
  /** Liveness poll interval (default 100 ms). */
  pollMs?: number
}

const DEFAULT_GRACE_MS = 15_000
const DEFAULT_KILL_GRACE_MS = 5_000
const DEFAULT_POLL_MS = 100

async function waitForGone(
  control: AgentProcessControl,
  timeoutMs: number,
  pollMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (!control.isAlive()) {
      return true
    }
    if (Date.now() > deadline) {
      return false
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

/**
 * Reclaim the owned agent: SIGTERM, then SIGKILL after the grace window, and **confirm the exit**.
 * A stop that cannot confirm it throws — the caller must not delete the directory the process was
 * configured from, and must report the failed cleanup rather than a clean run.
 *
 * Two states are decided before any signal is sent:
 * - `created === false` (with no pid): nothing was created, so this returns — the only no-op.
 * - a created pane whose pid is unknown: it throws. The agent may be alive and there is no handle to
 *   it, so "no pid" is "not confirmed gone", never "nothing to reclaim".
 */
export async function stopRealAgentProcess(
  control: AgentProcessControl,
  options: StopAgentOptions = {}
): Promise<void> {
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS
  if (!control.created && control.pid === null) {
    return
  }
  if (control.pid === null) {
    throw new Error(
      'the real agent pane was created but no pid was ever reported, so its exit cannot be ' +
        'observed: it may not be treated as reclaimed (keeping the fixture tree for inspection)'
    )
  }
  if (!control.isAlive()) {
    return
  }
  try {
    control.signal('SIGTERM')
  } catch {
    // Already gone; the liveness poll below is what decides, not this call.
  }
  if (await waitForGone(control, graceMs, pollMs)) {
    return
  }
  try {
    control.signal('SIGKILL')
  } catch {
    // Same: the process may have exited between the poll and this call.
  }
  if (await waitForGone(control, killGraceMs, pollMs)) {
    return
  }
  throw new Error(
    `real agent pid ${String(control.pid)} was not confirmed gone after SIGTERM+${graceMs}ms ` +
      `and SIGKILL+${killGraceMs}ms: it still answers kill(pid, 0), so the case may not treat it as reclaimed`
  )
}

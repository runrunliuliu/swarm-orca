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
 */

/** The process a case owns: its pid (when one exists) plus how to probe and signal it. */
export type AgentProcessControl = {
  pid: number | null
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

/** A control for a local process id, or an empty one when the pane never reported a pid. */
export function localAgentProcess(pid: number | null): AgentProcessControl {
  return {
    pid,
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
 * A `null` pid is not a failure: no process was ever created (`terminal.create` failed, or the pane
 * never reported a foreground pid), so there is nothing to reclaim.
 */
export async function stopRealAgentProcess(
  control: AgentProcessControl,
  options: StopAgentOptions = {}
): Promise<void> {
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS
  if (control.pid === null) {
    return
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

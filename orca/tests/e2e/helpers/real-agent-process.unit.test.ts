import { describe, expect, it } from 'vitest'
import {
  launchedAgentProcess,
  noAgentProcess,
  stopRealAgentProcess,
  type AgentProcessControl
} from './real-agent-process'

/**
 * W17 / B2: a stop is finished only when the exit is **confirmed**. The case the review asked for is a
 * process that ignores SIGTERM — a signal that was sent is not a process that is gone, so the case
 * must report "not reclaimed" instead of proceeding to delete the directory that process was
 * configured from.
 *
 * W20 / B1: the same rule has to cover the state with **no pid at all**. A created pane whose pid
 * could not be read (TUI wait timeout, `inspectProcess` failure, no foreground pid reported) may be a
 * live agent with no handle to it, so it is "not confirmed gone" and not "nothing to reclaim".
 */

type FakeAgentBehaviour = {
  /** Signals the fake actually honours (default: both). */
  honours?: NodeJS.Signals[]
  /** Milliseconds between an honoured signal and the process disappearing. */
  exitDelayMs?: number
  /** `kill()` throws, as it does when the signal cannot be delivered. */
  signalThrows?: Error
}

function createFakeAgent(pid: number | null, behaviour: FakeAgentBehaviour = {}) {
  const signalled: NodeJS.Signals[] = []
  let alive = pid !== null
  const honours = behaviour.honours ?? ['SIGTERM', 'SIGKILL']
  const control: AgentProcessControl = {
    pid,
    // `createFakeAgent` models a pane the case really created; the "nothing was created" state has
    // its own constructor (`noAgentProcess`).
    created: true,
    isAlive: () => alive,
    signal: (signal) => {
      signalled.push(signal)
      if (behaviour.signalThrows) {
        throw behaviour.signalThrows
      }
      if (honours.includes(signal)) {
        setTimeout(() => {
          alive = false
        }, behaviour.exitDelayMs ?? 0)
      }
    }
  }
  return { control, signalled }
}

/** Grace windows small enough to keep the "ignores signals" case fast. */
const FAST = { graceMs: 30, killGraceMs: 30, pollMs: 5 }

describe('stopRealAgentProcess', () => {
  it('reports an agent that ignores SIGTERM and SIGKILL as not reclaimed', async () => {
    const agent = createFakeAgent(4242, { honours: [] })

    const error = await stopRealAgentProcess(agent.control, FAST).then(
      () => null,
      (reason: unknown) => reason
    )

    expect(error).toBeInstanceOf(Error)
    // The wording has to name the unconfirmed exit and the stuck pid: "cleaned up" would be a lie.
    expect((error as Error).message).toMatch(/pid 4242 was not confirmed gone/)
    expect(agent.signalled).toEqual(['SIGTERM', 'SIGKILL'])
    // And the fake is still alive, which is exactly why the caller may not delete its directory.
    expect(agent.control.isAlive()).toBe(true)
  })

  it('refuses to call a created pane with an unknown pid a reclaim', async () => {
    // The W19/B1 shape: `terminal.create` returned, then the TUI wait or the pid RPC failed, so the
    // agent may be alive and nothing in this process knows its pid.
    const agent = createFakeAgent(null)

    const error = await stopRealAgentProcess(agent.control, FAST).then(
      () => null,
      (reason: unknown) => reason
    )

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(/no pid was ever reported/)
    expect((error as Error).message).toMatch(/may not be treated as reclaimed/)
    // Not "recovered": nothing was signalled, and the unknown state cannot be read as an exit.
    expect(agent.signalled).toEqual([])
    expect(agent.control.isAlive()).toBe(false)
  })

  it('refuses the unknown-pid state even when the real pane can no longer be probed', async () => {
    // Same state through the real constructor: an unknown pid is not a dead pid. A stop that treats
    // "isAlive() === false" as the exit proof would report a reclaim here — this pins the opposite.
    const control = launchedAgentProcess(null)

    await expect(stopRealAgentProcess(control, FAST)).rejects.toThrow(/no pid was ever reported/)
  })

  it('escalates to SIGKILL and accepts only the confirmed exit', async () => {
    const agent = createFakeAgent(4243, { honours: ['SIGKILL'], exitDelayMs: 5 })

    await stopRealAgentProcess(agent.control, FAST)

    expect(agent.signalled).toEqual(['SIGTERM', 'SIGKILL'])
    expect(agent.control.isAlive()).toBe(false)
  })

  it('accepts a SIGTERM honoured after a delay without escalating', async () => {
    const agent = createFakeAgent(4244, { exitDelayMs: 5 })

    await stopRealAgentProcess(agent.control, { graceMs: 300, killGraceMs: 300, pollMs: 5 })

    expect(agent.signalled).toEqual(['SIGTERM'])
    expect(agent.control.isAlive()).toBe(false)
  })

  it('does nothing when the case never created a pane', async () => {
    const control = noAgentProcess()

    await stopRealAgentProcess(control, FAST)

    expect(control.pid).toBeNull()
    expect(control.created).toBe(false)
  })

  it('does not signal a pid that is already gone', async () => {
    const agent = createFakeAgent(4245)
    // What the green path looks like: the UI close already removed the process.
    Object.defineProperty(agent.control, 'isAlive', { value: () => false })

    await stopRealAgentProcess(agent.control, FAST)

    expect(agent.signalled).toEqual([])
  })

  it('treats an undeliverable signal as a stop that still has to be confirmed', async () => {
    // The process exists (the fake stays alive) but signalling reports ESRCH: only the liveness poll
    // may decide, so this must not read as success.
    const agent = createFakeAgent(4246, { signalThrows: new Error('ESRCH') })

    const error = await stopRealAgentProcess(agent.control, FAST).then(
      () => null,
      (reason: unknown) => reason
    )

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(/not confirmed gone/)
  })

  it('builds a local control whose liveness probe is kill(pid, 0) semantics', () => {
    // A pid that cannot exist on this host: the probe is the kernel's answer, not a guess.
    const dead = launchedAgentProcess(2 ** 22 + 12345)
    expect(dead.isAlive()).toBe(false)
    expect(dead.created).toBe(true)
    // A created pane with no pid is not alive either — but it is not "nothing to reclaim" (above).
    expect(launchedAgentProcess(null).isAlive()).toBe(false)
    expect(launchedAgentProcess(null).pid).toBeNull()
  })
})

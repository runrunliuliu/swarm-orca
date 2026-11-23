import type { TuiAgent } from './tui-agent'

/**
 * Who owns the command line a remote launch is built from (issue #60).
 *
 * A launch has two halves that must never be mixed: the command line's executable and spelling,
 * and the arguments appended to it. `resolveAgentLaunchCommand` builds both from the same settings
 * in one string, so a host whose Settings replace the executable also writes arguments for *that*
 * executable — `sh -c 'exec traecli "$@"' wrapper-dispatch --yolo` is one launch, and it means
 * nothing under another host's default `traecli`. Sending the arguments half alone therefore does
 * not describe a launch: the host appends a shell wrapper's `$0` marker to its own executable's
 * argv. That is exactly issue #60, where the marker `wrapper-dispatch` became Trae's first prompt
 * and the delivery instruction only reached the input box afterwards.
 *
 * So the paired-host launch route answers this question before it is put on the wire (the SSH PTY
 * transport still sends the arguments half alone; that parity gap is a tracked residual):
 *
 * - `host-owned`: this client made no executable decision for this agent, so the host may rebuild
 *   the whole command from its own Settings and take the caller's arguments as ordinary CLI
 *   arguments for that command.
 * - `client-prepared`: this client's Settings replaced the agent's command, so the complete command
 *   must travel with its arguments already inside it. Dropping the command half drops the wrapper;
 *   sending the arguments half on its own is the mix this module exists to prevent.
 *
 * The answer is deliberately a property of the plan that was already built, not of the user's
 * intent: see `resolveAgentLaunchCommandOwnership` for why it reads the override the same way the
 * planner does.
 */
export type AgentLaunchCommandOwnership = 'host-owned' | 'client-prepared'

/**
 * Classify a launch plan by whether this client decided the executable.
 *
 * `cmdOverrides` is the settings slice the launch plan already received, so the answer describes
 * that plan rather than re-reading Settings at send time.
 */
export function resolveAgentLaunchCommandOwnership(args: {
  agent: TuiAgent
  cmdOverrides: Partial<Record<TuiAgent, string>> | null | undefined
}): AgentLaunchCommandOwnership {
  // Why truthiness and not the trimmed `hasExplicitTuiLaunchCommand` predicate: the planner picks
  // `override || configured default`, so a whitespace-only override IS the command it built. A
  // classification that disagreed with the plan would put arguments for one command on another.
  return args.cmdOverrides?.[args.agent] ? 'client-prepared' : 'host-owned'
}

/** Whether the launch must carry its complete command instead of arguments alone. */
export function agentLaunchNeedsPreparedCommand(
  ownership: AgentLaunchCommandOwnership
): boolean {
  return ownership === 'client-prepared'
}

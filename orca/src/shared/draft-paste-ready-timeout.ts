import type { TuiAgent } from './tui-agent'
import { TUI_AGENT_CONFIG } from './tui-agent-config'

const DEFAULT_DRAFT_PASTE_READY_TIMEOUT_MS = 8000

/**
 * Spawn budget for a prompt that is delivering an admitted launch (issue #60).
 *
 * Why longer than the generic 8s PTY-spawn verdict in `agent-paste-draft`: that verdict answers
 * "did a PTY appear at all", and a caller pasting into a terminal it did not just create has
 * nothing else to wait for. A launch has already queued its startup command, so its spawn is
 * expected — and measured agent panes can take well over 8s on a busy or cold host (issue #60's
 * e2e sees ~10-13s while a shell pane spawns in 0.5s). Giving up at 8s there throws the
 * instruction away while the PTY is still on its way. The budget stays bounded and is spent once:
 * a paste never happens after a failure has been reported.
 */
export const LAUNCH_PTY_SPAWN_TIMEOUT_MS = 30_000

export function resolveDraftPasteReadyTimeoutMs(agent?: TuiAgent, overrideMs?: number): number {
  return (
    overrideMs ??
    (agent ? TUI_AGENT_CONFIG[agent].draftPasteReadyTimeoutMs : undefined) ??
    DEFAULT_DRAFT_PASTE_READY_TIMEOUT_MS
  )
}

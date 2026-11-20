import { parsePaneKey } from '../../shared/stable-pane-id'
import type { TaskRecordUsageProvider } from '../../shared/task-records-types'
import type { TuiAgent } from '../../shared/tui-agent'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

/**
 * Which usage provider a pane's agent belongs to, when the pane is a tab Orca
 * launched itself (`TerminalTab.launchAgent`).
 *
 * Only the four providers Orca has a usage store for are mapped. Everything else
 * — Cursor, Gemini, Pi, a hand-started agent in a plain shell — stays `undefined`,
 * which the record keeps as "unknown provider" instead of guessing a bucket that
 * would later be read as a real attribution.
 */
const USAGE_PROVIDER_BY_AGENT: Partial<Record<TuiAgent, TaskRecordUsageProvider>> = {
  claude: 'claude',
  'claude-agent-teams': 'claude',
  openclaude: 'claude',
  codex: 'codex',
  'codex-ark': 'codex',
  opencode: 'opencode',
  opencode2: 'opencode',
  muse: 'muse'
}

export function usageProviderForPaneKey(
  sessions: readonly WorkspaceSessionState[],
  paneKey: string
): TaskRecordUsageProvider | undefined {
  const parsed = parsePaneKey(paneKey)
  if (!parsed) {
    return undefined
  }
  for (const session of sessions) {
    for (const tabs of Object.values(session.tabsByWorktree ?? {})) {
      const tab = tabs.find((candidate) => candidate.id === parsed.tabId)
      if (tab) {
        return tab.launchAgent ? USAGE_PROVIDER_BY_AGENT[tab.launchAgent] : undefined
      }
    }
  }
  return undefined
}

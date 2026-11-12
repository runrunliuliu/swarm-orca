import { TUI_AGENT_CONFIG, isTuiAgent } from '../shared/tui-agent-config'
import type { GlobalSettings } from '../shared/global-settings-types'
import { resolveTerminalWorkspacePath } from '../shared/terminal-startup-cwd'
import {
  applyAgentWorkspaceTrust,
  type AgentTrustLaunchContext,
  type AgentTrustSpawnFields
} from './agent-workspace-trust'
import { AGENT_TRUST_KEYED_BY_START_FOLDER } from './execution-host-workspace-trust'

type AgentWorkspaceTrustSetting =
  | Pick<GlobalSettings, 'agentWorkspaceTrustEnabled'>
  | null
  | undefined

function isAgentWorkspaceTrustOn(settings: AgentWorkspaceTrustSetting): boolean {
  return settings?.agentWorkspaceTrustEnabled !== false
}

/**
 * The one place Orca pre-trusts a workspace: every Orca-started agent PTY passes
 * through a spawn builder with its declared `launchAgent`, which survives setup-script
 * wrapping. Reattaches and restores are skipped so trust is never re-run for them.
 * Structured Codex chats have no PTY and enter below instead. Returns null when there is nothing to write, so other spawns take no extra tick:
 * the builders arbitrate pane-spawn reservation races that a tick can reorder.
 *
 * Why every launch surface and not only dispatched Workers: the launch source says nothing about
 * whether anyone is watching the pane. A Trae or Codex Ark pane started by hand in a workspace
 * Orca just created from a new branch parks on `Trust this folder?` exactly like a Worker does,
 * and answering it writes the same record this function would have written. So the grant follows
 * the setting (`agentWorkspaceTrustEnabled`) and the freshness of the launch, not the label, and
 * each writer's own refusals — never a home or a root, never creating Codex Ark's config — still
 * decide whether anything is written.
 */
export function applyAgentWorkspaceTrustToSpawn(
  args: {
    launchAgent: unknown
    /** Worktree or folder workspace id; its root is the folder the agent is trusted in. */
    worktreeId: string | undefined
    /** The resolved folder the agent starts in; floating terminals have only this. */
    cwd: string | undefined
    store: { getFolderWorkspace: (id: string) => { folderPath: string } | undefined } | undefined
    isFreshLaunch: boolean
    settings: AgentWorkspaceTrustSetting
    spawnOptions: AgentTrustSpawnFields
  } & AgentTrustLaunchContext
): Promise<void> | null {
  if (!args.isFreshLaunch || !isAgentWorkspaceTrustOn(args.settings)) {
    return null
  }
  const preset = isTuiAgent(args.launchAgent)
    ? TUI_AGENT_CONFIG[args.launchAgent].preflightTrust
    : undefined
  if (!preset) {
    return null
  }
  const workspaceRoot = resolveTerminalWorkspacePath(
    args.worktreeId,
    (folderWorkspaceId) => args.store?.getFolderWorkspace(folderWorkspaceId)?.folderPath
  )
  const workspacePath = AGENT_TRUST_KEYED_BY_START_FOLDER[preset]
    ? args.cwd || workspaceRoot
    : workspaceRoot
  if (!workspacePath) {
    return null
  }
  return applyAgentWorkspaceTrust(preset, workspacePath, {
    env: args.env,
    claudeAuth: args.claudeAuth,
    wslDistro: args.wslDistro,
    connectionId: args.connectionId
  }).then((fields) => {
    if (fields.agentWorkspaceTrust) {
      args.spawnOptions.agentWorkspaceTrust = fields.agentWorkspaceTrust
    }
  })
}

/**
 * Structured Codex chats are the one agent start with no PTY. Codex's app-server trusts the
 * folder itself only when the chat may write it, so a read-only chat would ignore `.codex` config.
 */
export async function applyStructuredCodexWorkspaceTrust(args: {
  workspacePath: string
  launchEnv: Record<string, string | undefined>
  settings: AgentWorkspaceTrustSetting
}): Promise<void> {
  if (!isAgentWorkspaceTrustOn(args.settings)) {
    return
  }
  await applyAgentWorkspaceTrust('codex', args.workspacePath, {
    env: args.launchEnv,
    claudeAuth: null,
    wslDistro: null,
    connectionId: null
  })
}

import type {
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig
} from '../../../shared/agent-session-resume'
import type {
  AgentLaunchPreferences,
  AgentPromptDelivery,
  RuntimeAgentLaunchPromptDelivery
} from '../../../shared/agent-session-host-authority'
import type { StartupCommandDelivery } from '../../../shared/codex-startup-delivery'
import type { RuntimeTerminalCreate } from '../../../shared/runtime-types'
import type { RuntimeCapability } from '../../../shared/protocol-version'
import type { TuiAgent } from '../../../shared/tui-agent'

export type WebRuntimeTerminalCreateOutcome =
  | { status: 'created' }
  | { status: 'failed'; message: string }

export type CreateWebRuntimeSessionTerminalArgs = {
  worktreeId: string
  environmentId?: string | null
  afterTabId?: string
  targetGroupId?: string
  command?: string
  cwd?: string
  env?: Record<string, string>
  envToDelete?: string[]
  startupCommandDelivery?: StartupCommandDelivery
  launchConfig?: SleepingAgentLaunchConfig
  launchToken?: string
  agent?: TuiAgent
  launchAgent?: TuiAgent
  /** The command already encodes the complete agent startup and prompt-delivery plan. */
  preparedAgentCommand?: boolean
  agentSessionKind?: 'fresh' | 'resume'
  prompt?: string
  promptDelivery?: AgentPromptDelivery
  spawnedFromPaneKey?: string
  /** Explicit CLI override; omission leaves the remote host's defaults authoritative. */
  agentArgs?: string | null
  /** Renderer-side tab marker for this launch (README §7.12 S5). The host wire
   *  carries no such field, so the launch marks the mirrored local row: that is
   *  the index the workbench reads, and the mirroring rebuild keeps an existing
   *  row's marker instead of dropping it. */
  quickCommandLabel?: string | null
  launchPreferences?: AgentLaunchPreferences
  providerSession?: AgentProviderSessionMetadata
  viewMode?: 'terminal' | 'chat'
  activate?: boolean
  selectWorktree?: boolean
  /** Require a host whose structured create owns this launch's prompt delivery. */
  hostAuthorityCapability?: RuntimeCapability
}

export type CreatedWebRuntimeSessionTerminal = {
  outcome: WebRuntimeTerminalCreateOutcome
  hostTabId?: string
  promptDelivery?: RuntimeAgentLaunchPromptDelivery
}

export type CreatedAgentTerminalIdentity = Pick<RuntimeTerminalCreate, 'tabId' | 'paneKey'> & {
  leafId?: string
}

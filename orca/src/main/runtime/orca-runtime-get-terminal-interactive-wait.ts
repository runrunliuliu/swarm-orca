// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { resolveStructuredWorkerAuthority } from './structured-worker-authority'
import { OrcaRuntimeWithAdoptTerminalOrphansFromInventory } from './orca-runtime-adopt-terminal-orphans-from-inventory'
import type {
  RuntimeTerminalAgentStatus,
  RuntimeTerminalInteractiveWait
} from '../../shared/runtime-types'
import type { RuntimeTerminalAgentStatusSnapshot } from './runtime-terminal-agent-status-query'
import { withTimeout } from './runtime-async-boundaries'
import { TERMINAL_INTERACTIVE_WAIT_PROBE_TIMEOUT_MS } from './orca-runtime-core'
import { parsePaneKey } from '../../shared/stable-pane-id'
import type { ExactWorkerProviderSession } from '../../shared/orchestration-worker-output'
import { selectExactWorkerProviderSession } from './orchestration/worker-provider-session'
import type { TuiAgent } from '../../shared/tui-agent'
import { isTuiAgentEnabled } from '../../shared/tui-agent-selection'
import { OrchestrationError } from './orchestration/orchestration-error'
import { homedir } from 'node:os'
import { getWorktreeExecutionHostId } from '../../shared/execution-host'
import { prepareTraeWorkerWorkspaceWrite } from './trae-worker-workspace-write'

export class OrcaRuntimeWithGetTerminalInteractiveWait extends OrcaRuntimeWithAdoptTerminalOrphansFromInventory {
  async getTerminalInteractiveWait(
    handle: string
  ): Promise<RuntimeTerminalInteractiveWait | null | undefined> {
    let ptyId: string
    let terminal: RuntimeTerminalAgentStatusSnapshot
    try {
      ptyId = this.getTerminalAgentStatusPtyId(handle)
      terminal = this.getTerminalAgentStatusSnapshot(handle, ptyId)
    } catch {
      return undefined
    }
    const explicitStatus = this.getFreshExplicitAgentStatusForHandle(handle)
    const promptReason = this.resolveAuthoritativeTerminalWaitPermission(
      terminal,
      explicitStatus,
      this.agentPromptLifecycleByPtyId.get(ptyId)
    )
    if (promptReason) {
      return {
        source: 'prompt-text',
        reason: promptReason,
        ...(terminal.waitBlockedAt !== null ? { since: terminal.waitBlockedAt } : {})
      }
    }
    if (terminal.titleStatus === 'permission' && terminal.titleStatusIsLive) {
      return { source: 'title' }
    }
    if (explicitStatus?.status !== 'permission') {
      return null
    }
    const status = await withTimeout(
      this.probeAgentStatusOncePerPty(handle, ptyId),
      TERMINAL_INTERACTIVE_WAIT_PROBE_TIMEOUT_MS,
      undefined
    )
    if (!status) {
      return undefined
    }
    return status.isRunningAgent && status.status === 'permission'
      ? { source: 'hook', since: explicitStatus.updatedAt }
      : null
  }

  protected probeAgentStatusOncePerPty(
    handle: string,
    ptyId: string
  ): Promise<RuntimeTerminalAgentStatus | undefined> {
    const inFlight = this.interactiveWaitProbesByPtyId.get(ptyId)
    if (inFlight) {
      return inFlight
    }
    const probe = this.getTerminalAgentStatus(handle)
      .catch(() => undefined)
      .finally(() => {
        if (this.interactiveWaitProbesByPtyId.get(ptyId) === probe) {
          this.interactiveWaitProbesByPtyId.delete(ptyId)
        }
      })
    this.interactiveWaitProbesByPtyId.set(ptyId, probe)
    return probe
  }

  getTerminalWorktreeIdForPaneKey(paneKey: string): string | null {
    const parsed = parsePaneKey(paneKey)
    const leaf = parsed ? this.leaves.get(this.getLeafKey(parsed.tabId, parsed.leafId)) : null
    return leaf?.worktreeId ?? this.getPtyRecordForPaneKey(paneKey)?.worktreeId ?? null
  }

  /** Read-only context of the worktree the user is focused on, for plugin
   *  panels (workspace.readContext). Prefers the persisted session focus and
   *  falls back to the last-focused pane's worktree; null when neither
   *  resolves so panels degrade instead of erroring. */
  async resolveActiveWorktreeContext(): Promise<{
    worktreeId: string
    path: string
    branch: string
    displayName: string
  } | null> {
    let worktreeId = this.store?.getWorkspaceSession?.()?.activeWorktreeId ?? null
    if (!worktreeId && this.graphStatus === 'ready') {
      for (const tab of this.tabs.values()) {
        if (tab.activeLeafId && tab.worktreeId) {
          worktreeId = tab.worktreeId
          break
        }
      }
    }
    if (!worktreeId) {
      return null
    }
    try {
      const resolved = await this.resolveWorktreeSelector(`id:${worktreeId}`)
      return {
        worktreeId: resolved.id,
        path: resolved.git.path,
        branch: resolved.git.branch,
        displayName: resolved.displayName
      }
    } catch {
      return null
    }
  }

  getTerminalProcessIncarnation(handle: string): string | null {
    const structured = resolveStructuredWorkerAuthority(
      handle,
      this.getOrchestrationDbIfAvailable?.() ?? null
    )
    if (structured) {
      return structured.identity.processIncarnation
    }
    const live = this.getLivePtyForHandle(handle)
    const record = live?.record ?? this.handles.get(handle)
    if (!record?.ptyId) {
      return null
    }
    const incarnationId = live?.pty.incarnationId ?? this.ptysById.get(record.ptyId)?.incarnationId
    if (incarnationId) {
      return `${record.ptyId}:${incarnationId}`
    }
    // Why: legacy providers may omit process incarnation; retain the prior restart-degraded fence.
    return `${this.runtimeId}:${record.ptyId}:${record.ptyGeneration}`
  }

  getExactWorkerProviderSession(
    handle: string,
    observedAfter: number
  ): ExactWorkerProviderSession | null {
    const paneKey = this.getTerminalPaneKey(handle)
    const processIncarnation = this.getTerminalProcessIncarnation(handle)
    if (!paneKey || !processIncarnation) {
      return null
    }
    const statuses = this.getAgentStatusSnapshotFn?.() ?? []
    let connectionId: string | null | undefined
    let launchToken: string | null | undefined
    let launchTokenHash: string | null | undefined
    let wslDistro: string | undefined
    try {
      const ptyId = this.getTerminalAgentStatusPtyId(handle)
      const pty = this.ptysById.get(ptyId)
      connectionId = pty?.connectionId ?? null
      launchToken = pty?.launchToken ?? null
      launchTokenHash = this.getRestoredTraeLaunchTokenHash(
        handle,
        ptyId,
        pty,
        paneKey,
        processIncarnation,
        statuses
      )
      // A WSL pane's PTY is local, so its hook events only match once the distro is supplied.
      wslDistro = pty?.connectionId
        ? undefined
        : (this.wslDistroByPtyId.get(ptyId) ?? pty?.wslDistro ?? undefined)
    } catch {
      // Exact worker validation rejects this in production; test/legacy providers may not expose PTY metadata.
      connectionId = undefined
      launchToken = undefined
      launchTokenHash = undefined
      wslDistro = undefined
    }
    return selectExactWorkerProviderSession({
      paneKey,
      processIncarnation,
      connectionId,
      launchToken,
      launchTokenHash,
      wslDistro,
      observedAfter,
      statuses
    })
  }

  private getRestoredTraeLaunchTokenHash(
    handle: string,
    ptyId: string,
    pty: unknown,
    paneKey: string,
    processIncarnation: string,
    statuses: readonly unknown[]
  ): string | null {
    if (!pty?.connected || pty.launchAgent !== 'trae' || pty.launchToken) {
      return null
    }
    const hostScope = this.getOrchestrationCompatibilityHostScope(pty)
    const receipt = this.restoredOrchestrationAuthorityByPtyId.get(ptyId)
    if (
      !hostScope ||
      !receipt ||
      receipt.ptyId !== ptyId ||
      receipt.worktreeId !== pty.worktreeId ||
      receipt.terminalHandle !== handle ||
      receipt.paneKey !== paneKey ||
      receipt.processIncarnation !== processIncarnation ||
      !receipt.launchTokenHash ||
      !this.orchestrationCompatibilityHostScopesEqual(receipt.hostScope, hostScope)
    ) {
      return null
    }
    return this.findAttestedRestoredLaunchTokenHash(
      paneKey,
      hostScope,
      receipt.launchTokenHash,
      statuses.filter((status) => status?.agentType === 'trae')
    )
  }

  validateOrchestrationAgentLauncher(agent: TuiAgent): void {
    const settings = this.store?.getSettings()
    if (!settings) {
      throw new Error('runtime_unavailable')
    }
    if (!isTuiAgentEnabled(agent, settings.disabledTuiAgents)) {
      throw new OrchestrationError(
        'agent_unconfigured',
        `Agent launcher ${agent} is disabled or unavailable.`
      )
    }
  }

  async prepareOrchestrationTraeWorkspaceWrite(
    worktreeId: string,
    writableRoots: string[],
    launchSnapshot?: { commandOverride?: string }
  ) {
    const settings = this.store?.getSettings()
    if (!settings) {
      throw new Error('runtime_unavailable')
    }
    const { scope, managedWorktree } = await this.resolveTerminalWorkspaceLaunchTarget(
      `id:${worktreeId}`,
      { materializePushTarget: false }
    )
    if (!managedWorktree) {
      throw new OrchestrationError(
        'invalid_argument',
        'Worker writable roots require an existing managed workspace.'
      )
    }
    return prepareTraeWorkerWorkspaceWrite({
      platform: process.platform,
      executionHostId: getWorktreeExecutionHostId(managedWorktree, scope.repo ?? undefined),
      connectionId: scope.connectionId,
      commandOverride: launchSnapshot
        ? launchSnapshot.commandOverride
        : settings.agentCmdOverrides?.trae,
      workspacePath: scope.path,
      homePath: homedir(),
      writableRoots
    })
  }
}

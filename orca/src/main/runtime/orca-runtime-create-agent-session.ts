// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithGetAgentSessionExecutionNamespace } from './orca-runtime-get-agent-session-execution-namespace'
import { assertTaskWorkspaceLaunchableFor } from '../ipc/sparse-task-start-gate'
import type {
  RuntimeAgentLaunchPromptDelivery,
  RuntimeAgentSessionRpcCaller,
  RuntimeCreateAgentSessionRequest,
  RuntimeCreateAgentSessionResult
} from '../../shared/agent-session-host-authority'
import {
  AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS,
  AGENT_SESSION_OPERATION_FUTURE_SKEW_MS,
  parseAgentSessionOperationTimestamp
} from '../../shared/agent-session-host-authority'
import { createHash } from 'node:crypto'
import {
  AGENT_SESSION_OPERATION_GLOBAL_LIMIT,
  AGENT_SESSION_OPERATION_PER_CLIENT_LIMIT
} from './orca-runtime-core'
import { isTuiAgentEnabled } from '../../shared/tui-agent-selection'
import { TUI_AGENT_CONFIG, agentSupportsSubmittedPrefill } from '../../shared/tui-agent-config'
import { resolveAgentStartupPlanInputs } from '../../shared/agent-startup-plan-inputs'
import {
  buildAgentDraftLaunchPlan,
  buildAgentStartupPlan,
  type AgentDraftLaunchPlan,
  type AgentStartupPlan
} from '../../shared/tui-agent-startup'
import { agentStartupPlanFitsPlatform } from '../../shared/agent-draft-platform-limit'
import type { RuntimeTerminalCreate } from '../../shared/runtime-types'
import type {
  AgentSessionCreateOperation,
  AgentSessionCreateReclaimIdentity
} from './runtime-terminal-contracts'
import {
  deterministicAgentSessionUuid,
  isAgentSessionOperationOutcomeUnknown
} from './runtime-agent-launch-resolution'
import { agentStartedTelemetry } from '../agent-launch/agent-started-telemetry'

export class OrcaRuntimeWithCreateAgentSession extends OrcaRuntimeWithGetAgentSessionExecutionNamespace {
  async createAgentSession(
    request: RuntimeCreateAgentSessionRequest,
    caller: RuntimeAgentSessionRpcCaller = {}
  ): Promise<RuntimeCreateAgentSessionResult> {
    if (!this.store) {
      throw new Error('runtime_unavailable')
    }
    const now = Date.now()
    const operationTimestamp = parseAgentSessionOperationTimestamp(request.clientOperationId)
    if (
      operationTimestamp === null ||
      operationTimestamp > now + AGENT_SESSION_OPERATION_FUTURE_SKEW_MS
    ) {
      throw new Error('agent_session_operation_invalid')
    }
    const callerKey = caller.clientId?.trim() || `trusted-local:${caller.clientKind ?? 'runtime'}`
    const operationKey = `${callerKey}\0${request.clientOperationId}`
    const requestFingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          request.worktree,
          request.agent,
          request.prompt ?? null,
          request.promptDelivery ?? null,
          request.agentArgs ?? null,
          request.agentArgs === undefined ? 'host-default' : 'client-override',
          request.launchPreferences?.model ?? null,
          request.launchPreferences?.effort ?? null,
          request.launchPreferences?.mode ?? null,
          request.startupCwd ?? null,
          request.presentation ?? null,
          request.placement?.tabId ?? null,
          request.placement?.leafId ?? null,
          request.viewMode ?? null,
          ...(request.terminalKittyKeyboardProtocol === true ? ['kitty-keyboard'] : [])
        ])
      )
      .digest('base64url')
    const existing = this.agentSessionCreateOperations.get(operationKey)
    if (existing) {
      if (existing.fingerprint !== requestFingerprint) {
        throw new Error('agent_session_operation_conflict')
      }
      let replayed: RuntimeCreateAgentSessionResult
      try {
        replayed = await existing.promise
      } catch (error) {
        const reclaimed = await this.reclaimFencedAgentSessionSpawn(existing.reclaim.identity)
        if (!reclaimed) {
          throw error
        }
        return {
          terminal: reclaimed,
          disposition: 'replayed',
          // The original create reply was lost before this host could prove prompt delivery.
          // Fail closed: a client must not paste again into a possibly-started session.
          promptDelivery: { state: 'unknown' }
        }
      }
      return { ...replayed, disposition: 'replayed' }
    }
    if (now - operationTimestamp > AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS) {
      // Why: once a tombstone could have expired, an unseen replay must never
      // be reinterpreted as permission to start another fresh agent.
      throw new Error('agent_session_operation_expired')
    }
    let callerOperationCount = 0
    const callerPrefix = `${callerKey}\0`
    for (const key of this.agentSessionCreateOperations.keys()) {
      if (key.startsWith(callerPrefix)) {
        callerOperationCount += 1
      }
    }
    if (
      callerOperationCount >= AGENT_SESSION_OPERATION_PER_CLIENT_LIMIT ||
      this.agentSessionCreateOperations.size >= AGENT_SESSION_OPERATION_GLOBAL_LIMIT
    ) {
      // Why: tombstones cannot be evicted early without making an old replay
      // capable of spawning again; reject new IDs until retained entries age out.
      throw new Error('agent_session_operation_capacity')
    }
    let retainReplayFence = false
    const reclaim: AgentSessionCreateOperation['reclaim'] = {}
    const operation = (async (): Promise<RuntimeCreateAgentSessionResult> => {
      // Why: reserve the client operation before any async preflight so concurrent retries cannot
      // both observe an empty ledger and reach the execution owner independently.
      const workspace = await this.resolveTerminalWorkspaceLaunchScope(request.worktree)
      // M3: a resumed/created agent session runs in the workspace, so it is a launch, not a lookup.
      await assertTaskWorkspaceLaunchableFor({ store: this.store, workspace })
      if (
        !(await this.executionOwnerSupportsAgentSessionOperation(
          workspace,
          'create',
          caller.signal
        ))
      ) {
        // Why: the exact legacy launch remains client-owned until this pre-spawn check succeeds.
        throw new Error('agent_session_legacy_required')
      }
      const startupCwd = this.resolveWorkspaceTerminalStartupCwd(workspace, request.startupCwd)
      // Why: aliases and object property order are client syntax, not authority;
      // fingerprint the host-resolved fields in one fixed order.
      const resolvedFingerprint = createHash('sha256')
        .update(
          JSON.stringify([
            workspace.id,
            request.agent,
            request.prompt ?? null,
            request.promptDelivery ?? null,
            request.agentArgs ?? null,
            request.agentArgs === undefined ? 'host-default' : 'client-override',
            request.launchPreferences?.model ?? null,
            request.launchPreferences?.effort ?? null,
            request.launchPreferences?.mode ?? null,
            startupCwd ?? null,
            request.presentation ?? null,
            request.placement?.tabId ?? null,
            request.placement?.leafId ?? null,
            request.viewMode ?? null,
            ...(request.terminalKittyKeyboardProtocol === true ? ['kitty-keyboard'] : [])
          ])
        )
        .digest('base64url')
      const settings = this.store!.getSettings()
      if (!isTuiAgentEnabled(request.agent, settings.disabledTuiAgents)) {
        throw new Error('Selected agent is disabled. Choose an enabled agent before creating.')
      }
      const startupArgs = resolveAgentStartupPlanInputs({
        agent: request.agent,
        settings,
        platform: this.getAgentLaunchPlatformForWorkspace(workspace),
        // Why: `workspace.repo` is display metadata and may be a row from another host; the launch
        // shape must match the PTY route this scope already resolved.
        isRemote: Boolean(workspace.connectionId),
        ...(request.agentArgs !== undefined ? { agentArgs: request.agentArgs } : {}),
        sessionOptions: this.toAgentSessionOptions(request.launchPreferences)
      })
      const requestedPrompt = request.prompt ?? ''
      const autoSubmitPrompt =
        request.promptDelivery === 'auto-submit' && Boolean(requestedPrompt.trim())
      let promptDelivery: RuntimeAgentLaunchPromptDelivery = { state: 'not-requested' }
      let startup: AgentDraftLaunchPlan | AgentStartupPlan | null
      if (request.promptDelivery === 'draft') {
        // A bound draft is never submitted, so the settlement stays `not-requested`: it means
        // "this host bound no submitted prompt", not "nothing reached the agent".
        startup = buildAgentDraftLaunchPlan({ ...startupArgs, draft: requestedPrompt })
      } else if (
        autoSubmitPrompt &&
        agentSupportsSubmittedPrefill(TUI_AGENT_CONFIG[request.agent])
      ) {
        // The managed agent hook consumes and submits this prefill during startup, before any
        // mirrored tab or renderer-side readiness signal is needed (Pi today).
        startup = buildAgentDraftLaunchPlan({
          ...startupArgs,
          draft: requestedPrompt,
          submitDraft: true
        })
        if (!startup) {
          // This also covers a platform command/env size limit. Refuse before spawn so the
          // renderer can retain its bounded paste fallback without creating a duplicate agent.
          throw new Error('agent_session_legacy_required')
        }
        promptDelivery = { state: 'launch-bound', transport: 'env-hook' }
      } else {
        startup = buildAgentStartupPlan({
          ...startupArgs,
          prompt: requestedPrompt,
          allowEmptyPromptLaunch: true
        })
        if (autoSubmitPrompt && (!startup || startup.followupPrompt !== null)) {
          // This agent needs a live PTY/composer adapter, or its command could not be built.
          // Host authority does not own that write yet, so hand off before spawn to the existing
          // renderer readiness/paste implementation.
          throw new Error('agent_session_legacy_required')
        }
        if (autoSubmitPrompt && startup) {
          // Why: a submit-after-ready prompt is usually too large for argv — the client chose the
          // paste route to stay under the platform ceiling. Refuse before spawn so it can.
          if (!agentStartupPlanFitsPlatform(startup, startupArgs.platform)) {
            throw new Error('agent_session_legacy_required')
          }
          promptDelivery = { state: 'launch-bound', transport: 'argv' }
        }
      }
      if (!startup) {
        throw new Error('agent_session_identity_required')
      }
      if (caller.signal?.aborted) {
        throw new Error('client_disconnected')
      }
      let terminal: RuntimeTerminalCreate
      const executionOperationId = createHash('sha256')
        .update(this.runtimeId)
        .update('\0')
        .update(operationKey)
        .update('\0')
        .update(resolvedFingerprint)
        .digest('base64url')
      const operationTabId =
        request.placement?.tabId ?? deterministicAgentSessionUuid(`${executionOperationId}:tab`)
      const operationLeafId =
        request.placement?.leafId ?? deterministicAgentSessionUuid(`${executionOperationId}:leaf`)
      const operationHandle = `term_${deterministicAgentSessionUuid(`${executionOperationId}:handle`)}`
      // Why: recorded before dispatch — this handle is exported into the PTY as
      // ORCA_TERMINAL_HANDLE, so it is the only name a lost spawn can be re-found by.
      reclaim.identity = {
        worktreeId: workspace.id,
        connectionId: workspace.connectionId ?? null,
        terminalHandle: operationHandle
      }
      try {
        terminal = await this.createTerminal(`id:${workspace.id}`, {
          command: startup.launchCommand,
          env: startup.env,
          launchConfig: startup.launchConfig,
          launchAgent: request.agent,
          terminalKittyKeyboardProtocol: request.terminalKittyKeyboardProtocol,
          startupCommandDelivery: startup.startupCommandDelivery,
          // A fresh agent this host built; the request has no surface field, so it counts as `unknown`.
          telemetry: agentStartedTelemetry(request.agent, undefined),
          cwd: startupCwd,
          presentation: request.presentation ?? 'background',
          tabId: operationTabId,
          leafId: operationLeafId,
          preAllocatedHandle: operationHandle,
          viewMode: request.viewMode,
          agentSessionCreateOperationId: executionOperationId,
          signal: caller.signal,
          onPtySpawnCommitted: () => {
            retainReplayFence = true
          }
        })
      } catch (error) {
        if (isAgentSessionOperationOutcomeUnknown(error)) {
          retainReplayFence = true
        }
        throw error
      }
      return { terminal, disposition: 'created', promptDelivery }
    })()
    this.agentSessionCreateOperations.set(operationKey, {
      fingerprint: requestFingerprint,
      promise: operation,
      reclaim
    })
    const expireOperation = (): void => {
      const expiresAt = Math.max(now, operationTimestamp) + AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS
      const timer = setTimeout(
        () => {
          if (this.agentSessionCreateOperations.get(operationKey)?.promise === operation) {
            this.agentSessionCreateOperations.delete(operationKey)
          }
        },
        Math.max(1, expiresAt - Date.now())
      )
      timer.unref?.()
    }
    try {
      const result = await operation
      expireOperation()
      return result
    } catch (error) {
      if (retainReplayFence) {
        // Why: the first PTY may still be alive; replay the same failure until
        // expiry instead of interpreting a lost outcome as a fresh spawn grant.
        expireOperation()
      } else if (this.agentSessionCreateOperations.get(operationKey)?.promise === operation) {
        this.agentSessionCreateOperations.delete(operationKey)
      }
      throw error
    }
  }

  // Why: the host may still hold the PTY this operation launched. Adoption-only —
  // this never spawns and never kills, so an unreachable or silent host just replays
  // the original failure instead of authorising anything.
  private async reclaimFencedAgentSessionSpawn(
    identity: AgentSessionCreateReclaimIdentity | undefined
  ): Promise<RuntimeTerminalCreate | null> {
    if (!identity) {
      return null
    }
    try {
      return await this.reconcileRemoteTerminalCreate(
        identity.worktreeId,
        identity.terminalHandle,
        identity.connectionId
      )
    } catch {
      // Unverifiable or ambiguous inventory is never evidence the PTY exited.
      return null
    }
  }
}

// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithRefreshFloatingWorkspacePtyLiveness } from './orca-runtime-refresh-floating-workspace-pty-liveness'
import { writeOrchestrationPointerWithSettlement } from './orchestration/mailbox-pointer-pty-write'
import type { WriteSettlement } from '../../shared/pty-write-settlement'
import type { RuntimeLeafRecord } from './runtime-terminal-state-records'
import type { ExecutionHostId } from '../../shared/execution-host'
import { getPtyExecutionHost } from '../../shared/terminal-execution-host'
import type { TuiAgent } from '../../shared/tui-agent'
import { selectRuntimeHookAgentRowForPane } from './runtime-mobile-agent-status-projection'
import { isTuiAgent } from '../../shared/tui-agent-config'
import { resolvePublishedPaneAgentIdentity } from '../../shared/published-pane-agent-identity'
import type { RuntimeTerminalSummary, RuntimeWorktreePsSummary } from '../../shared/runtime-types'
import type { RuntimeWorktreeSummaryPathIndex } from './runtime-worktree-summary-paths'
import { parseRuntimeWorktreeId, type ResolvedWorktree } from './runtime-worktree-path-identity'
import { findRuntimeWorktreeSummaryByPath } from './runtime-worktree-summary-paths'
import { getLatestLeafTitle } from './runtime-worktree-status-projection'
import { parseAppSshPtyId } from '../../shared/ssh-pty-id'
import { isTerminalLeafId, makePaneKey, parsePaneKey } from '../../shared/stable-pane-id'
import type { OrchestrationMailboxLeaf } from './orchestration/mailbox-owner'
import type { OrchestrationMailboxPointerSubmitTarget } from './orchestration/mailbox-pointer-submit'
import { resolveMailboxPaneTarget } from './orchestration-mailbox-pane-target'
import { TraeMailboxDelivery } from './trae-mailbox-delivery'
import { computeTerminalTailWaitState } from './terminal-wait-tail-state'
import { isStrictContinuityFenced } from './orchestration/strict-continuity-store'
import {
  launchTokenHashMatchesStatusRow,
  launchTokenMatchesStatusRow
} from './orchestration/worker-provider-session'

export class OrcaRuntimeWithWriteOrchestrationPointerPty extends OrcaRuntimeWithRefreshFloatingWorkspacePtyLiveness {
  protected readonly traeMailboxDelivery = new TraeMailboxDelivery({
    target: (ptyId) => {
      const pty = this.ptysById.get(ptyId)
      const delivery = this.getTraeDeliveryRow(ptyId)
      const handle = this.handleByPtyId.get(ptyId)
      if (!pty || !delivery || !handle) {
        return null
      }
      return {
        ...delivery,
        handle,
        controller: this.ptyController,
        input: this.terminalRunFacts.readInputFence(ptyId, pty.incarnationId),
        incarnation: this.getTerminalProcessIncarnation(handle),
        outputSequence: this.getPtyOutputSequence(ptyId),
        localProbeAllowed:
          pty.connectionId === null &&
          !pty.isWsl &&
          !pty.wslDistro &&
          !this.wslDistroByPtyId.has(ptyId) &&
          !parseAppSshPtyId(ptyId) &&
          !ptyId.startsWith('remote:')
      }
    },
    publish: (ptyId, request) =>
      this.onTerminalAgentStatus?.({
        ptyId,
        source: 'pty-record',
        paneKey: request.expected.paneKey,
        connectionId: null,
        origin: 'process',
        payload: { agentType: 'trae', state: 'done', prompt: '' },
        traeIdleRevalidation: request
      }),
    redrive: (ptyId) => {
      queueMicrotask(() => {
        try {
          const pty = this.ptysById.get(ptyId)
          if (!pty?.connected) {
            return
          }
          const pane = parsePaneKey(pty.paneKey ?? '')
          const target = pane
            ? this.getOrchestrationMailboxTarget(this.getLeafKey(pane.tabId, pane.leafId))
            : undefined
          if (!target?.leaf.ptyId || target.leaf.ptyId !== ptyId) {
            return
          }
          this.orchestrationMailboxNotifications.deliverForLeaf(target.leaf)
        } catch {
          // Durable mail remains available to explicit check or a later idle edge.
        }
      })
    }
  })
  protected readonly traeIdleRevalidator = this.traeMailboxDelivery.revalidator

  protected getOrchestrationMailboxTarget(leafKey: string) {
    return resolveMailboxPaneTarget(leafKey, {
      leaves: this.leaves,
      ptysById: this.ptysById,
      handleByLeafKey: this.handleByLeafKey,
      handleByPtyId: this.handleByPtyId,
      getLeafKey: (tabId, leafId) => this.getLeafKey(tabId, leafId)
    })
  }

  protected scheduleOwnedMailboxRepointForLeaf(leaf: RuntimeLeafRecord): void {
    const mailboxHandle = this.orchestrationMailboxOwner.resolve(leaf, undefined, {
      routeDirectMail: false
    })
    this.scheduleMailboxRepointIfWork(mailboxHandle)
  }

  protected scheduleOwnedMailboxRepointForPty(ptyId: string): void {
    const pty = this.ptysById.get(ptyId)
    if (!pty?.connected) {
      return
    }
    const pane = parsePaneKey(pty.paneKey ?? '')
    if (!pane) {
      return
    }
    const target = this.getOrchestrationMailboxTarget(this.getLeafKey(pane.tabId, pane.leafId))
    if (target?.leaf.ptyId === ptyId) {
      this.scheduleOwnedMailboxRepointForLeaf(target.leaf)
      return
    }
    const paneKey = `${pane.tabId}:${pane.leafId}`
    this.scheduleOwnedMailboxRepointForPane(paneKey, ptyId)
  }

  protected scheduleOwnedMailboxRepointForPane(paneKey: string, ptyId?: string): void {
    if (ptyId) {
      const pty = this.ptysById.get(ptyId)
      if (!pty?.connected || pty.paneKey !== paneKey) {
        return
      }
    }
    const run = this._orchestrationDb?.getCurrentRunForPane?.(paneKey)
    if (run) {
      this.scheduleMailboxRepointIfWork(`run:${run.id}`)
      return
    }
    const handle = ptyId ? this.handleByPtyId.get(ptyId) : null
    const dispatch = handle
      ? this._orchestrationDb?.getActiveDispatchForIdentity?.(handle, paneKey)
      : undefined
    if (dispatch) {
      this.scheduleMailboxRepointIfWork(`dispatch:${dispatch.id}`)
    }
  }

  protected scheduleOwnedMailboxRepointForTerminalHandle(handle: string | null | undefined): void {
    if (!handle) {
      return
    }
    for (const runId of this._orchestrationDb?.getRunMailboxOwnerIdsForHandle?.(handle) ?? []) {
      this.scheduleMailboxRepointIfWork(`run:${runId}`)
    }
    const paneKey = this.getTerminalPaneKey(handle)
    if (!paneKey) {
      return
    }
    const dispatch = this._orchestrationDb?.getActiveDispatchForIdentity?.(handle, paneKey)
    if (dispatch) {
      this.scheduleMailboxRepointIfWork(`dispatch:${dispatch.id}`)
    }
  }

  private scheduleMailboxRepointIfWork(mailboxHandle: string | null | undefined): void {
    if (
      !mailboxHandle ||
      (!mailboxHandle.startsWith('run:') && !mailboxHandle.startsWith('dispatch:')) ||
      !this._orchestrationDb?.hasMailboxPointerWork?.(mailboxHandle, [])
    ) {
      return
    }
    this.mailPointerRepointScheduler.schedule(mailboxHandle)
  }

  protected getLiveOrchestrationMailboxLeaf(handle: string): OrchestrationMailboxLeaf {
    const livePty = this.getLivePtyForHandle(handle)
    if (!livePty) {
      return this.getLiveLeafForHandle(handle).leaf
    }
    const pane = parsePaneKey(livePty.pty.paneKey ?? '')
    const target = pane
      ? this.getOrchestrationMailboxTarget(this.getLeafKey(pane.tabId, pane.leafId))
      : undefined
    if (!target?.leaf.ptyId || target.terminalHandle !== handle) {
      throw new Error('terminal_handle_stale')
    }
    this.assertLiveTerminalHandleTargetsPty(handle, target.leaf.ptyId)
    return target.leaf
  }

  private getTraeDeliveryRow(ptyId: string | null | undefined) {
    const pty = ptyId ? this.ptysById.get(ptyId) : null
    const handle = ptyId ? this.handleByPtyId.get(ptyId) : null
    if (!pty?.connected || !handle || pty.launchAgent !== 'trae') {
      return null
    }
    const floor = this.agentPromptExplicitStatusFloorByPtyId.get(ptyId) ?? -1
    const exact = this.getExactWorkerProviderSession(handle, floor + 1)
    if (exact?.agent !== 'trae') {
      return null
    }
    const rows = (this.getAgentStatusSnapshotFn?.() ?? [])
      .filter(
        (entry) =>
          entry.agentType === 'trae' &&
          !entry.restoredUnconfirmed &&
          !entry.providerSessionOnly &&
          entry.paneKey === exact.paneKey &&
          entry.connectionId === exact.connectionId &&
          entry.providerSession?.id === exact.providerSession.id &&
          entry.providerSession?.key === exact.providerSession.key &&
          (launchTokenMatchesStatusRow(entry, pty.launchToken) ||
            launchTokenHashMatchesStatusRow(entry, exact.launchTokenHash))
      )
    const row = rows.sort((a, b) => b.receivedAt - a.receivedAt)[0]
    const observed = row?.evidenceObservedAt ?? row?.receivedAt
    return row &&
      Number.isFinite(observed) &&
      observed > floor &&
      observed <= Date.now() &&
      (row.traeIdleRevalidation?.hookObservedAt ?? observed) > floor
      ? {
          row,
          restoredLaunchAttested:
            !pty.launchToken &&
            !!exact.launchTokenHash &&
            launchTokenHashMatchesStatusRow(row, exact.launchTokenHash)
        }
      : null
  }

  protected getTraeDeliveryStatus(ptyId: string | null | undefined, allowStagedInput = false) {
    return this.traeMailboxDelivery.status(ptyId, allowStagedInput)
  }

  protected writeOrchestrationPointerPty(
    ptyId: string,
    data: string,
    canWrite: () => boolean
  ): WriteSettlement | Promise<WriteSettlement> {
    const canWriteAdmitted = () =>
      !(this._orchestrationDb && isStrictContinuityFenced(this._orchestrationDb)) && canWrite()
    if (this.ptysById.get(ptyId)?.launchAgent === 'trae') {
      // Recheck after each yielding probe: a fresh hook does not dismiss a new modal.
      const canWriteUnblocked = () => {
        const pty = this.ptysById.get(ptyId)
        return Boolean(
          pty?.connected &&
          !computeTerminalTailWaitState(pty.tailBuffer, pty.tailPartialLine, pty.preview).signal &&
          canWriteAdmitted()
        )
      }
      return this.traeMailboxDelivery.write(ptyId, data, canWriteUnblocked)
    }
    return writeOrchestrationPointerWithSettlement({
      ptyId,
      data,
      controller: this.ptyController,
      canWrite: canWriteAdmitted
    })
  }

  protected resolveOrchestrationPointerSubmitTarget(
    stagedLeaf: OrchestrationMailboxLeaf,
    ptyId: string
  ): OrchestrationMailboxPointerSubmitTarget | null {
    const leafKey = this.getLeafKey(stagedLeaf.tabId, stagedLeaf.leafId)
    const target = this.getOrchestrationMailboxTarget(leafKey)
    if (!target || target.leaf.ptyId !== ptyId) {
      return null
    }
    const { leaf, terminalHandle } = target
    const pty = this.ptysById.get(ptyId)
    const processIncarnation = this.getTerminalProcessIncarnation(terminalHandle)
    const paneKey = `${leaf.tabId}:${leaf.leafId}`
    const db = this._orchestrationDb
    const run = db?.getCurrentRunForPane(paneKey)
    const dispatch = run ? null : db?.getActiveDispatchForIdentity(terminalHandle, paneKey)
    const attachment = run || dispatch ? null : db?.findActiveRemoteAttachmentForPane(paneKey)
    const mailboxConsumer = run
      ? `run:${run.id}:${run.consumer_generation}`
      : dispatch
        ? `dispatch:${dispatch.id}:${dispatch.consumer_generation}`
        : attachment
          ? `attachment:${attachment.dispatch_id}:${attachment.consumer_generation}`
          : undefined
    const trae = this.getTraeDeliveryStatus(ptyId, true)
    const projectedLeaf =
      pty?.launchAgent === 'trae'
        ? {
            ...leaf,
            lastAgentStatusObservedLive: trae !== null,
            lastAgentStatus:
              trae?.state === 'done'
                ? 'idle'
                : trae?.state === 'working'
                  ? 'working'
                  : trae
                    ? 'permission'
                    : null
          }
        : leaf
    return processIncarnation
      ? {
          leaf: projectedLeaf,
          terminalHandle,
          processIncarnation,
          mailboxConsumer,
          ...(trae ? { providerSession: trae.providerSession } : {})
        }
      : null
  }

  protected getPrimaryLeafForPty(ptyId: string): RuntimeLeafRecord | null {
    return this.getLeavesForPty(ptyId)[0] ?? null
  }

  protected terminalExecutionHostField(
    ptyId: string | null,
    worktreeId: string
  ): { executionHostId?: ExecutionHostId } {
    const fromPtyId = getPtyExecutionHost(ptyId)
    if (fromPtyId === 'foreign') {
      return {}
    }
    const hostId = fromPtyId ?? this.tryGetWorkspaceSessionHostIdForWorktree(worktreeId)
    return hostId ? { executionHostId: hostId } : {}
  }

  protected resolvePaneAgentIdentityField(
    launchAgent: TuiAgent | null | undefined,
    foregroundAgent: TuiAgent | null | undefined,
    title: string | null,
    paneKey: string | null
  ): { agentIdentity?: TuiAgent } {
    const hookRow = paneKey
      ? selectRuntimeHookAgentRowForPane(this.getAgentProviderSessionRowsForPaneFn?.(paneKey) ?? [])
      : null
    const hookAgent = isTuiAgent(hookRow?.agentType) ? hookRow.agentType : null
    const agentIdentity = resolvePublishedPaneAgentIdentity({
      hookAgent,
      hookIsLive: hookRow?.agentIsLive,
      launchAgent,
      foregroundAgent,
      title
    })
    return agentIdentity ? { agentIdentity } : {}
  }

  protected getSummaryForRuntimeWorktreeId(
    summaries: Map<string, RuntimeWorktreePsSummary>,
    runtimeWorktreeSummaryPathIndex: RuntimeWorktreeSummaryPathIndex,
    missingRuntimeWorktreeIds: Set<string>,
    runtimeWorktreeId: string
  ): RuntimeWorktreePsSummary | null {
    const exact = summaries.get(runtimeWorktreeId)
    if (exact) {
      return exact
    }
    if (missingRuntimeWorktreeIds.has(runtimeWorktreeId)) {
      return null
    }
    const parsed = parseRuntimeWorktreeId(runtimeWorktreeId)
    if (!parsed) {
      return null
    }
    const comparisonPlatform =
      runtimeWorktreeSummaryPathIndex.platformByRepoId.get(parsed.repoId) ?? process.platform
    const indexed = findRuntimeWorktreeSummaryByPath(
      runtimeWorktreeSummaryPathIndex,
      parsed.repoId,
      parsed.worktreePath,
      comparisonPlatform
    )
    if (indexed) {
      return indexed
    }
    missingRuntimeWorktreeIds.add(runtimeWorktreeId)
    return null
  }

  protected buildTerminalSummary(
    leaf: RuntimeLeafRecord,
    worktreesById: Map<string, ResolvedWorktree>,
    provenLivePtyIds: ReadonlySet<string> | null = null
  ): RuntimeTerminalSummary {
    const worktree = worktreesById.get(leaf.worktreeId)
    const tab = this.tabs.get(leaf.tabId) ?? null

    const pty = leaf.ptyId ? this.ptysById.get(leaf.ptyId) : undefined
    const title = getLatestLeafTitle(leaf, tab?.title ?? null)
    // Why: leaf.connected mirrors the renderer graph (`ptyId !== null`), so a
    // restored surface whose PTY died with a prior run still reads connected.
    // Demote only on a controller-proven absence, and only for locally-scoped
    // ids the aggregate inventory authoritatively covers — SSH/remote scopes may
    // be legitimately missing from it, and unknown liveness never demotes.
    // The sync hasPty rescue closes the spawn/list race: a just-spawned PTY can
    // register after the inventory snapshot, and federation reads one
    // connected:false as exited.
    const provenAbsent =
      provenLivePtyIds !== null &&
      leaf.ptyId !== null &&
      !provenLivePtyIds.has(leaf.ptyId) &&
      !leaf.ptyId.startsWith('remote:') &&
      parseAppSshPtyId(leaf.ptyId) === null &&
      this.ptyController?.hasPty?.(leaf.ptyId) !== true
    return {
      handle: this.issueHandle(leaf),
      ptyId: leaf.ptyId,
      incarnationId: pty?.incarnationId ?? null,
      orphaned: false,
      worktreeId: leaf.worktreeId,
      worktreePath: worktree?.path ?? '',
      branch: worktree?.branch ?? '',
      tabId: leaf.tabId,
      leafId: leaf.leafId,
      title,
      connected: provenAbsent ? false : leaf.connected,
      writable: provenAbsent ? false : leaf.writable,
      lastOutputAt: leaf.lastOutputAt,
      preview: leaf.preview,
      ...(leaf.lastExitCause ? { exitCause: leaf.lastExitCause } : {}),
      ...this.terminalExecutionHostField(leaf.ptyId, leaf.worktreeId),
      ...this.resolvePaneAgentIdentityField(
        pty?.launchAgent,
        pty?.foregroundAgent,
        title,
        isTerminalLeafId(leaf.leafId) ? makePaneKey(leaf.tabId, leaf.leafId) : null
      )
    }
  }
}

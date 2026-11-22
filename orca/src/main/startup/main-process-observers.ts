import { app } from 'electron'
import { join } from 'node:path'
import { AgentAwakeService } from '../agent-awake-service'
import { normalizeComputerAwakeMode } from '../../shared/computer-awake-mode'
import { registerSystemResumeBroadcast } from '../system-resume-broadcast'
import { agentHookServer } from '../agent-hooks/server'
import { installHookStatusSessionTabsRepublish } from '../agent-hooks/hook-status-session-tabs-republish'
import { initTelemetry, track } from '../telemetry/client'
import { setCodexTrustGrantTelemetry } from '../codex/codex-trust-grant-telemetry'
import { initObservability } from '../observability'
import { recordDurableCrashBreadcrumb } from '../crash-reporting/durable-crash-breadcrumb'
import { recoverPendingSkillTransactions } from '../skills/skill-transaction-startup-recovery'
import { initCohortClassifier } from '../telemetry/cohort-classifier'
import { initOnboardingCohortClassifier } from '../telemetry/onboarding-cohort-classifier'
import { StatsCollector } from '../stats/collector'
import { AgentSessionTransitionRecorder } from '../stats/agent-session-transition-recorder'
import { ClaudeUsageStore } from '../claude-usage/store'
import { CodexUsageStore } from '../codex-usage/store'
import { OpenCodeUsageStore } from '../opencode-usage/store'
import { MuseUsageStore } from '../muse-usage/store'
import { installRepoMaintenanceIdleGate } from '../repo-maintenance-idle-gate'
import {
  createTaskRecordsUsageSource,
  withHookSessionFacts
} from '../task-records/task-records-worktree-usage'
import { createAiVaultSessionIndexLookup } from '../task-records/task-records-session-index-lookup'
import { createTranscriptCheckProbe } from '../task-records/task-records-transcript-check'
import { createTaskRecordsLiveRunObserver } from '../task-records/task-records-live-runs'
import { usageProviderForPaneKey } from '../task-records/task-records-pane-provider'
import { mainProcessState as state } from './main-process-state'

export function initializeMainProcessObservers(): void {
  const store = state.store
  if (!store) {
    throw new Error('Store must be initialized before observers')
  }
  state.unsubscribeSystemResumeBroadcast = registerSystemResumeBroadcast()
  state.agentAwakeService = new AgentAwakeService()
  state.agentAwakeService.setMode(
    normalizeComputerAwakeMode(
      store.getSettings().computerAwakeMode,
      store.getSettings().keepComputerAwakeWhileAgentsRun
    )
  )
  // Why: start from empty — disk-hydrated status rows are UI continuity only; only this runtime's hook events keep the computer awake.
  state.agentAwakeService.setStatuses([])
  state.uninstallRepoMaintenanceIdleGate = installRepoMaintenanceIdleGate({
    isQuitting: () => state.isQuitting,
    getWorkingAgentCount: () => state.agentAwakeService?.getWorkingAgentCount() ?? 0
  })
  const unsubscribeStatusChanges = agentHookServer.subscribeStatusChanges((statuses) => {
    state.agentAwakeService?.setStatuses(statuses)
  })
  const unsubscribeStatusFreshness = agentHookServer.subscribeStatusFreshness((status) => {
    state.agentAwakeService?.observeStatusFreshness(status)
  })
  const uninstallHookStatusRepublish = installHookStatusSessionTabsRepublish(
    agentHookServer,
    () => state.runtime
  )
  state.unsubscribeAgentAwakeStatusChanges = () => {
    unsubscribeStatusChanges()
    unsubscribeStatusFreshness()
    uninstallHookStatusRepublish()
  }
  // Why: telemetry must init before any IPC handler/renderer can call track(); it's a no-op in dev and while TELEMETRY_ENABLED is false, so it's safe early.
  initTelemetry(store)
  const profileStateStartup = state.profileStateStartup
  if (profileStateStartup) {
    track('profile_state_authority_selected', {
      backend: profileStateStartup.backend,
      classification: profileStateStartup.classification,
      authority_mode: 'sqlite-established',
      runtime: profileStateStartup.runtime,
      migrated: profileStateStartup.migrated
    })
  }
  // Why: the breadcrumb alone never leaves the machine — it rides crash reports, and a hang is not
  // a crash (the app is force-quit, so no report is ever generated). Without this the incidence
  // number the watchdog exists to produce would sit unread on the user's disk. Must run after
  // initTelemetry: track() drops silently until the client and store are wired.
  if (state.hangDetection) {
    track('main_thread_hang_detected', {
      unresponsive_ms: Math.round(state.hangDetection.unresponsiveMs),
      self_recovered: state.hangDetection.selfRecovered
    })
  }
  // Why: the trust-grant module is bundled into plain-node CLI entries where
  // the telemetry client cannot load, so the tracker is injected here instead
  // of imported there.
  setCodexTrustGrantTelemetry(({ outcome, hostKind, lane, reason, errorClass, verifyClass }) => {
    track('codex_trust_grant', {
      outcome,
      host_kind: hostKind,
      lane,
      ...(reason !== undefined ? { fallback_reason: reason } : {}),
      ...(errorClass !== undefined ? { error_class: errorClass } : {}),
      ...(verifyClass !== undefined ? { verify_class: verifyClass } : {})
    })
  })
  // Why: the error-tracking lane (telemetry-error-tracking.md) is its own
  // composition root — independent of product telemetry — and must
  // initialize before any IPC handler / runtime span is created so the
  // tracer's active sink is populated at the moment the first span fires.
  // Honors DO_NOT_TRACK / ORCA_TELEMETRY_DISABLED / ORCA_DIAGNOSTICS_DISABLED
  // / CI internally; those gates do not need to be re-checked here.
  initObservability()
  recordDurableCrashBreadcrumb('main_process_lifecycle_started', {
    packaged: app.isPackaged,
    platform: process.platform
  })
  state.skillTransactionRecovery = recoverPendingSkillTransactions(
    join(app.getPath('userData'), 'skill-installs')
  )
  void state.skillTransactionRecovery
    .then((report) => {
      const result = report as {
        scanned: number
        recovered: number
        failures: { code: string }[]
        truncated: boolean
      }
      if (result.scanned || result.failures.length || result.truncated) {
        console.info('[skills] startup transaction recovery:', {
          scanned: result.scanned,
          recovered: result.recovered,
          failures: result.failures.map((failure) => failure.code),
          truncated: result.truncated
        })
      }
    })
    .catch((error) => console.warn('[skills] startup transaction recovery failed:', error))
  // Why: cohort-classifier reads repo count synchronously at every emit, so hydrate it here — before any IPC handler or window can trigger track().
  initCohortClassifier(store)
  initOnboardingCohortClassifier(store)
  state.stats = new StatsCollector()
  // Agent-session stats come from hook status transitions, the same truth the
  // sidebar and dashboard read — never from OSC terminal titles, which miss
  // hook-only agents and count any spinner TUI as an agent (#10201).
  const agentSessionRecorder = new AgentSessionTransitionRecorder(state.stats)
  agentHookServer.subscribeEnrichedStatus((enriched) => agentSessionRecorder.onStatus(enriched))
  agentHookServer.subscribePaneStatusClear((clear) => agentSessionRecorder.onCleared(clear))
  state.claudeUsage = new ClaudeUsageStore(store)
  state.codexUsage = new CodexUsageStore(store)
  state.openCodeUsage = new OpenCodeUsageStore(store)
  state.museUsage = new MuseUsageStore(store)
  // Task records settle a worktree's usage before its row is deleted (issue
  // #36). The source is bound here because the four usage stores do not exist
  // when the Store is constructed; until this line a removal settles nothing.
  store.setTaskRecordsUsageSource(
    createTaskRecordsUsageSource({
      stores: {
        claude: state.claudeUsage,
        codex: state.codexUsage,
        opencode: state.openCodeUsage,
        muse: state.museUsage
      },
      // Two calls of the same hook server at the same moment: the identities say
      // *which* session a pane reports, the status snapshot says what the row
      // observed about the run. Joining them keeps one source of truth (issue #53).
      sessionIdentities: () =>
        withHookSessionFacts(
          agentHookServer.getProviderSessionIdentities(),
          agentHookServer.getStatusSnapshot()
        ),
      providerForPaneKey: (paneKey) =>
        usageProviderForPaneKey(store.getWorkspaceSessionPartitions(), paneKey),
      // The archive snapshot's degraded source (issue #53 A). Bound here because
      // the scan reads the filesystem and the transcript check needs the gated fs
      // process: neither belongs on the synchronous metadata write path.
      archiveSnapshot: {
        sessionIndexLookup: createAiVaultSessionIndexLookup(),
        transcriptCheck: createTranscriptCheckProbe()
      }
    })
  )
  // Why a second subscription and not the stats recorder above: it must be bound
  // after the Store exists (it writes `taskRecords`), and it records the run while
  // the pane is still observable, so a TUI closed mid-task keeps its row (issue
  // #53 follow-up). The observer skips a status that states nothing new, and the
  // Store owns the save schedule like every other task-record write.
  const liveRunObserver = createTaskRecordsLiveRunObserver({
    providerForPaneKey: (paneKey) =>
      usageProviderForPaneKey(store.getWorkspaceSessionPartitions(), paneKey),
    record: (observation) => store.recordTaskRecordLiveRun(observation)
  })
  agentHookServer.subscribeEnrichedStatus((enriched) => {
    // A replay is a cached row from a prior runtime, not an observation taken
    // here; writing it would label it a live run this process never saw.
    if (enriched.isReplay === true) {
      return
    }
    liveRunObserver.observe({
      paneKey: enriched.paneKey,
      ...(enriched.worktreeId === undefined ? {} : { worktreeId: enriched.worktreeId }),
      ...(enriched.providerSession === undefined
        ? {}
        : { providerSession: enriched.providerSession }),
      state: enriched.payload.state,
      stateStartedAt: enriched.stateStartedAt,
      ...(enriched.payload.agentType === undefined
        ? {}
        : { agentType: enriched.payload.agentType }),
      ...(enriched.payload.sessionBoundary === undefined
        ? {}
        : { sessionBoundary: enriched.payload.sessionBoundary }),
      ...(enriched.payload.interrupted === undefined
        ? {}
        : { interrupted: enriched.payload.interrupted }),
      ...(enriched.payload.mainAgent === undefined ? {} : { mainAgent: enriched.payload.mainAgent })
    })
  })
}

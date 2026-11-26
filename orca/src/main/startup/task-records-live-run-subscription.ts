import type { EnrichedAgentHookEventPayload } from '../agent-hooks/server/server-types'
import type { TaskRecordUsageProvider } from '../../shared/task-records-types'
import {
  createTaskRecordsLiveRunObserver,
  type LiveRunObservation
} from '../task-records/task-records-live-runs'

/**
 * The enriched-status → live-run observation assembly, shared by every host that
 * serves a profile Store (issue #68).
 *
 * Why it is a separate module and not the Electron observer initializer: the
 * writer (`createTaskRecordsLiveRunObserver`), the Store operation
 * (`recordTaskRecordLiveRun`) and the read side already existed after #57, but the
 * only place that joined them to the hook feed was `main-process-observers.ts`,
 * which cannot load on the Node host (`app.isPackaged`, `app.getPath`). `orcad` is
 * a full runtime authority with its own Store — its agents' runs were simply never
 * observed, so a TUI closed mid-task left no row. This module is deliberately
 * Electron-free (types only) so both entries wire the same projection instead of
 * restating it and drifting apart.
 *
 * **The replay filter belongs here, not at the feed.** `subscribeEnrichedStatus`
 * itself does not replay (`agent-hooks/server/server-listeners.ts`), but a spool
 * event still enters the status pipeline marked `isReplay` and is broadcast, so a
 * listener that ignores the flag would store a cached row from a *prior* runtime as
 * a run observed in this one.
 *
 * The projection is the full fact set the ledger reads, copied field by field with
 * conditional spreads: an absent optional fact stays absent instead of becoming a
 * value the hook server never stated.
 */
export type TaskRecordsLiveRunSubscriptionArgs = {
  /** The hook feed. Whatever the caller's server exposes: the desktop's singleton
   *  and orcad's are the same class, so the only difference is how it is reached. */
  subscribe: (listener: (payload: EnrichedAgentHookEventPayload) => void) => () => void
  /** Which usage bucket the pane's agent belongs to, from the Store's session
   *  partitions — the same resolver the archive snapshot uses, so a live row and an
   *  archived row for one run share a claim. */
  providerForPaneKey: (paneKey: string) => TaskRecordUsageProvider | undefined
  /** Hand the observation to the caller's Store. The Store owns the save schedule;
   *  this module never persists anything itself. */
  record: (observation: LiveRunObservation) => void
}

/** Subscribe now and return the disposer. The caller must invoke it before its
 *  final persistence barrier: a frozen Store drops later writes silently. */
export function createTaskRecordsLiveRunSubscription(
  args: TaskRecordsLiveRunSubscriptionArgs
): () => void {
  const observer = createTaskRecordsLiveRunObserver({
    providerForPaneKey: args.providerForPaneKey,
    record: args.record
  })
  return args.subscribe((enriched) => {
    if (enriched.isReplay === true) {
      return
    }
    observer.observe({
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

import type { Store } from '../persistence'
import type { EnrichedAgentHookEventPayload } from '../agent-hooks/server/server-types'
import { usageProviderForPaneKey } from '../task-records/task-records-pane-provider'
import { createTaskRecordsLiveRunSubscription } from '../startup/task-records-live-run-subscription'

/**
 * The live-run writer of the headless composition root (`orcad`), the half issue
 * #57 left bound only on the desktop.
 *
 * #57 added the writer and the Store operation, but the only subscription lived in
 * `main-process-observers.ts`, whose module tree imports `electron` at module scope
 * (`app.isPackaged`, `app.getPath('userData')`) and therefore cannot be loaded by
 * the Node host. `orcad` is a full runtime authority with its own Store, so its
 * agents ran with no observation at all: closing the TUI removed the retained row
 * and the task's history lost the run unless the archive's session index happened
 * to answer uniquely later.
 *
 * The provider resolver is deliberately the archive source's own expression
 * (`usageProviderForPaneKey(store.getWorkspaceSessionPartitions(), paneKey)`, see
 * `orcad-task-records-usage-source.ts`): the run's claim is derived from that
 * provider, so two different resolutions would store one run under two claims.
 *
 * Kept out of `orcad-entry.ts` for the reason #31 stated: that file sits exactly on
 * the repository's `max-lines` budget, and a composition-root binding mistake is
 * invisible until a task's history is read. Here it is a plain function whose test
 * can drive the real Store writer with only the hook feed substituted.
 */

/** The live collaborators, narrowed structurally: the hook feed's one subscription
 *  call plus the Store's provider read and live-run write, nothing else. */
export type OrcadTaskRecordsLiveRunPorts = {
  hookServer: {
    subscribeEnrichedStatus: (
      listener: (payload: EnrichedAgentHookEventPayload) => void
    ) => () => void
  }
  store: Pick<Store, 'recordTaskRecordLiveRun' | 'getWorkspaceSessionPartitions'>
}

/** Subscribe the live-run observer to the hook feed and return its disposer.
 *  Callers (the entry point) must dispose before the Store's writes freeze. */
export function installOrcadTaskRecordsLiveRuns(ports: OrcadTaskRecordsLiveRunPorts): () => void {
  const { hookServer, store } = ports
  return createTaskRecordsLiveRunSubscription({
    // Bound, not passed bare: `subscribeEnrichedStatus` reads instance state.
    subscribe: (listener) => hookServer.subscribeEnrichedStatus(listener),
    providerForPaneKey: (paneKey) =>
      usageProviderForPaneKey(store.getWorkspaceSessionPartitions(), paneKey),
    record: (observation) => store.recordTaskRecordLiveRun(observation)
  })
}

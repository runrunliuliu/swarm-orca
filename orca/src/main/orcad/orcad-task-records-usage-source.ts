import type { Store } from '../persistence'
import type { TaskRecordsArchiveSnapshotDeps } from '../task-records/task-records-archive-snapshot'
import { createAiVaultSessionIndexLookup } from '../task-records/task-records-session-index-lookup'
import { createTranscriptCheckProbe } from '../task-records/task-records-transcript-check'
import { usageProviderForPaneKey } from '../task-records/task-records-pane-provider'
import {
  createTaskRecordsUsageSource,
  withHookSessionFacts,
  type HookAgentStatusFacts,
  type TaskRecordSessionIdentity,
  type TaskRecordsUsageSource
} from '../task-records/task-records-worktree-usage'

/**
 * The `task-records` usage source of the headless composition root (`orcad`).
 *
 * Issue #31's root cause: `orcad` never called `store.setTaskRecordsUsageSource`, so
 * `applyArchiveSnapshot` took its "this runtime cannot look" arm for the whole
 * process lifetime — even though the session index on this host held the session.
 * This is the binding that closes it, with the desktop's own factory
 * (`createTaskRecordsUsageSource`) and its own two archive deps, so the archive
 * transition stores what the hook server attributes and, when it attributes
 * nothing, runs the reverse lookup by path + window exactly as the desktop does.
 *
 * **What this root can bind, and why it is only half of the desktop's argument:**
 *
 * - Bound here: `sessionIdentities` (the same `agentHookServer` the rest of this
 *   entry point already serves), `providerForPaneKey` (`Store`'s session
 *   partitions), and `archiveSnapshot`'s two filesystem-backed deps.
 * - **Not** bound here: the four provider usage stores (`claude`/`codex`/
 *   `opencode`/`muse`). Each imports `app` from `electron` at module scope, and the
 *   orcad bundle fails on any Electron importer
 *   (`config/scripts/build-orcad.mjs:241-252`; the ratchet baseline in
 *   `config/runtime-electron-baseline.txt` must stay empty). No substitute is
 *   constructed: a settlement synthesised from anything else would be
 *   indistinguishable from a measured one.
 *
 * So `stores` is passed to the factory **absent**, and the archive snapshot then
 * carries `settlement: null`: the archive write stores **no** settlement at all.
 * That absence is the only literally true claim — this build did not measure — and
 * every existing `unavailable` reason states something that did not happen here
 * (`usage_not_enabled` names a user setting this build has no UI for;
 * `no_matching_session` would read as a measured zero). A reader therefore keeps
 * three states apart: `usageSettlement` absent = not measured by this build;
 * `unavailable` + reason = measured, figure missing; `known` = a number. Sessions,
 * runs and their transcript checks are unaffected: they are measured here and
 * written in full.
 *
 * Kept out of `orcad-entry.ts` for two reasons worth stating:
 *
 * - that file is a 400-line composition root sitting exactly on the repository's
 *   300-line `max-lines` budget (`.oxlintrc.json`), so the mechanism lives here and
 *   the root names only the dependency it passes in;
 * - a binding mistake in a composition root is invisible until a task is archived.
 *   Here the binding is a plain function, so its test can drive the real
 *   `recordTaskRecordsForWorktree` write path with only the two filesystem-touching
 *   deps substituted.
 */

/** The live collaborators, narrowed structurally: this module needs the hook
 *  server's two reads and the store's one write (plus the session partitions the
 *  pane → provider map reads), and nothing else from either. */
export type OrcadTaskRecordsUsageSourcePorts = {
  hookServer: {
    getProviderSessionIdentities: () => readonly TaskRecordSessionIdentity[]
    getStatusSnapshot: () => readonly HookAgentStatusFacts[]
  }
  store: Pick<Store, 'setTaskRecordsUsageSource' | 'getWorkspaceSessionPartitions'>
  /** Test seam: the archive deps reach the filesystem (`listAiVaultSessions`, one
   *  `stat` per stored transcript), so a test supplies them. Production omits this
   *  and gets the real ones below — the same two the desktop binds. */
  archiveSnapshot?: TaskRecordsArchiveSnapshotDeps
}

export function createOrcadTaskRecordsUsageSource(
  ports: OrcadTaskRecordsUsageSourcePorts
): TaskRecordsUsageSource {
  const { hookServer, store } = ports
  return createTaskRecordsUsageSource({
    // Two reads of the same hook server at the same moment: the identities say
    // *which* session a pane reports, the status snapshot says what the row
    // observed about the run. The join is the shared one, not a second one here.
    sessionIdentities: () =>
      withHookSessionFacts(
        hookServer.getProviderSessionIdentities(),
        hookServer.getStatusSnapshot()
      ),
    providerForPaneKey: (paneKey) =>
      usageProviderForPaneKey(store.getWorkspaceSessionPartitions(), paneKey),
    archiveSnapshot: ports.archiveSnapshot ?? {
      sessionIndexLookup: createAiVaultSessionIndexLookup(),
      transcriptCheck: createTranscriptCheckProbe()
    }
  })
}

/**
 * Bind the source on the Store and return it, or report and return `null`.
 *
 * Never throws: this runs inside startup, and a ledger source must not be able to
 * keep a headless host from serving. A failure is *reported* (the caller's contract
 * says "no silent degradation"): the archive then writes its `source_unavailable`
 * marker, which a later metadata touch or `orca history backfill` completes, and
 * the operator can tell "binding threw" apart from "this build has no source".
 */
export function bindOrcadTaskRecordsUsageSource(
  ports: OrcadTaskRecordsUsageSourcePorts
): TaskRecordsUsageSource | null {
  try {
    const source = createOrcadTaskRecordsUsageSource(ports)
    ports.store.setTaskRecordsUsageSource(source)
    return source
  } catch (error) {
    console.warn(
      '[orcad] task-records usage source not bound; archived workspaces will carry the ' +
        'source_unavailable marker instead of measured sessions:',
      error
    )
    return null
  }
}

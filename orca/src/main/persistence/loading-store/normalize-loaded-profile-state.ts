import { normalizePersistedMobileClientTabSelections } from '../../runtime/client-session-tab-selection-persistence'
import type { SshRemotePtyLease } from '../../../shared/ssh-types'
import { normalizeFeatureInteractionTelemetryBuckets } from '../../../shared/feature-interactions'
import { normalizeFolderWorkspaceDiffComments } from '../../folder-workspace-diff-comments'
import { normalizeFolderWorkspaces } from '../../../shared/folder-workspaces'
import { normalizeWorkspaceLineageByChildKey } from '../applying-settings/ui-interaction-merge'
import {
  normalizeSshRemotePtyLease,
  normalizeSshTarget
} from '../leasing-ssh-ptys/ssh-normalization'
import {
  normalizeClaudeLivePtySessionIds,
  normalizeLegacyPaneKeyAliasEntries,
  normalizeMigrationUnsupportedPtyEntries
} from '../restoring-sessions/pane-alias-normalization'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { PreparedLoadedTerminalSettings } from './prepare-loaded-terminal-settings'
import type { PreparedLoadedProfileSettings } from './prepare-loaded-profile-settings'
import { normalizeLoadedGlobalSettings } from './normalize-loaded-global-settings'
import { normalizeLoadedUiState } from './normalize-loaded-ui-state'
import {
  normalizeLoadedAutomationRuns,
  normalizeLoadedHostSessions,
  normalizeLoadedLocalSession,
  normalizeLoadedProjectCatalog
} from './normalize-loaded-state-collections'
import { normalizeTaskRunHistory } from '../../../shared/task-run-history'
import { normalizeTaskRecords } from '../../../shared/task-records'
import { migrateTaskRecordsFromRunHistory } from './task-records-legacy-migration'
import { normalizeRetiredNameRegistryMap } from './retired-name-registry-normalization'
import { hydrateWorktreeMetaAliasProjection } from './worktree-meta-alias-projection'

export function normalizeLoadedProfileState(
  parsed: PersistedState,
  terminal: PreparedLoadedTerminalSettings,
  profile: PreparedLoadedProfileSettings,
  markNeedsSave: () => void
): PersistedState {
  const { defaults, migratedExternalVisibility, osc52ClipboardNoticePending } = terminal
  const { normalizedOnboarding, normalizedProjectGroups, loadedCompactWorktreeCards } = profile
  const projectCatalog = normalizeLoadedProjectCatalog(parsed, markNeedsSave)
  // Ordered: the host partitions drop the global fields this slice already owns.
  const workspaceSession = normalizeLoadedLocalSession(parsed, defaults, markNeedsSave)
  const taskRecords = normalizeTaskRecords(parsed.taskRecords)
  // Why normalize the legacy ledger before migrating: this is untrusted JSON. The
  // raw value can be `{}` or hold null rows, and a throw here would fail the whole
  // profile load instead of dropping a bad row.
  const legacyTaskRunHistory = normalizeTaskRunHistory(parsed.taskRunHistory)
  // No `taskRecords` domain yet means a profile written by issue #31 S2's ledger;
  // seed from it once. An existing domain always wins (no re-migration).
  const migratedTaskRecords =
    parsed.taskRecords === undefined && taskRecords.readable
      ? migrateTaskRecordsFromRunHistory(legacyTaskRunHistory)
      : undefined
  if (migratedTaskRecords) {
    markNeedsSave()
  }

  return {
    ...defaults,
    ...parsed,
    featureInteractionTelemetryBuckets: normalizeFeatureInteractionTelemetryBuckets(
      parsed.featureInteractionTelemetryBuckets
    ),
    projectGroups: normalizedProjectGroups,
    repos: migratedExternalVisibility.repos,
    // Why: persisted catalog rows are untrusted JSON; consumers call string methods on fields the type says are strings.
    projects: projectCatalog.projects,
    projectHostSetups: projectCatalog.projectHostSetups,
    folderWorkspaces: normalizeFolderWorkspaces(parsed.folderWorkspaces, normalizedProjectGroups),
    folderWorkspaceDiffComments: normalizeFolderWorkspaceDiffComments(
      parsed.folderWorkspaceDiffComments
    ),
    // Rebuilds the identity rows the serializer left to the locator map, and restores the shared
    // object reference JSON.parse splits. Not `markNeedsSave`: this IS the canonical on-disk shape.
    // Conditional so a file with no identity map keeps none, rather than gaining an own key whose
    // value is `undefined`.
    ...(parsed.worktreeMetaByIdentity === undefined
      ? {}
      : { worktreeMetaByIdentity: hydrateWorktreeMetaAliasProjection(parsed) }),
    worktreeLineageById: parsed.worktreeLineageById ?? {},
    mobileClientTabSelectionsByDeviceId: normalizePersistedMobileClientTabSelections(
      parsed.mobileClientTabSelectionsByDeviceId
    ),
    workspaceLineageByChildKey: normalizeWorkspaceLineageByChildKey(
      parsed.workspaceLineageByChildKey
    ),
    settings: normalizeLoadedGlobalSettings(parsed, terminal, profile),
    // Why: legacy 'recent' meant the smart sort; migrate once on the raw value so a fresh 'recent' default isn't remigrated.
    ui: normalizeLoadedUiState(
      parsed,
      defaults,
      normalizedOnboarding,
      loadedCompactWorktreeCards,
      osc52ClipboardNoticePending,
      markNeedsSave
    ),
    // Why: volatile schema; zod-validate workspaceSession at read so a bad payload falls to defaults, not a renderer crash.
    workspaceSession,
    // Why: per-host session partitions, validated independently; 'local' stays in workspaceSession for downgrade compat.
    workspaceSessionsByHostId: normalizeLoadedHostSessions(
      parsed,
      defaults,
      workspaceSession,
      markNeedsSave
    ),
    sshTargets: (parsed.sshTargets ?? []).map(normalizeSshTarget),
    deletedSshConfigAliases: Array.isArray(parsed.deletedSshConfigAliases)
      ? parsed.deletedSshConfigAliases.filter((alias): alias is string => typeof alias === 'string')
      : [],
    // Why conditional: a payload this build cannot read must reach a full save
    // byte-for-byte, so the raw spread above stays the only copy of it.
    ...(taskRecords.readable && (parsed.taskRecords !== undefined || migratedTaskRecords)
      ? { taskRecords: migratedTaskRecords ?? taskRecords.state }
      : {}),
    taskRunHistory: legacyTaskRunHistory,
    retiredWorktreeNamesByRepo: normalizeRetiredNameRegistryMap(parsed.retiredWorktreeNamesByRepo),
    retiredWorktreeNamesByNamespace: normalizeRetiredNameRegistryMap(
      parsed.retiredWorktreeNamesByNamespace
    ),
    sshRemotePtyLeases: (parsed.sshRemotePtyLeases ?? [])
      .map(normalizeSshRemotePtyLease)
      .filter((lease): lease is SshRemotePtyLease => lease !== null),
    sshPtyConsumerRecoveries: parsed.sshPtyConsumerRecoveries,
    claudeLivePtySessionIds: normalizeClaudeLivePtySessionIds(parsed.claudeLivePtySessionIds),
    migrationUnsupportedPtyEntries: normalizeMigrationUnsupportedPtyEntries(
      parsed.migrationUnsupportedPtyEntries
    ),
    legacyPaneKeyAliasEntries: normalizeLegacyPaneKeyAliasEntries(parsed.legacyPaneKeyAliasEntries),
    automations: Array.isArray(parsed.automations) ? parsed.automations : [],
    automationRuns: normalizeLoadedAutomationRuns(parsed, markNeedsSave),
    onboarding: normalizedOnboarding
  }
}

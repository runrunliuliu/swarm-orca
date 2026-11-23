import { createProfileStateStoreForStartup } from '../persistence/profile-state/profile-state-startup-authority'
import type { ProfileStateStoreFactoryResult } from '../persistence/profile-state/profile-state-store-factory'
import { ensureActiveOrcaProfile, initOrcaProfilePaths } from '../orca-profiles/profile-index-store'
import { initSshHostKeyStoreFile } from '../ssh/ssh-host-key-store'
import { emitOrcadProfileStateAuthoritySelected } from './orcad-profile-state-telemetry'
import {
  bindOrcadTaskRecordsUsageSource,
  type OrcadTaskRecordsUsageSourcePorts
} from './orcad-task-records-usage-source'

export type OrcadProfileStateProfile = {
  dataFile: string
  stateDatabaseFile: string
  profile: { id: string }
}

export type OrcadProfileStateStartup = {
  store: ProfileStateStoreFactoryResult['store']
  authority: {
    backend: ProfileStateStoreFactoryResult['backend']
    classification: ProfileStateStoreFactoryResult['classification']
    authority_mode: 'sqlite-established'
    runtime: 'orcad'
    migrated: boolean
  }
}

/** What the returned Store needs bound before any writer can see it (issue #31). */
export type OrcadProfileStateStartupPorts = Pick<OrcadTaskRecordsUsageSourcePorts, 'hookServer'>

/**
 * Build the headless Store and publish its authority selection at one Node-only seam.
 *
 * The Store is bound with the `task-records` usage source here, before it is returned
 * and before the runtime exists: `applyArchiveSnapshot` reads that source at the
 * metadata write that flips `isArchived`, so a Store that becomes observable without
 * it archives as "this runtime could not look" — issue #31's empty history, which is a
 * wiring artefact rather than an observation. The binding never throws (see
 * `bindOrcadTaskRecordsUsageSource`), so a failure degrades to the explicit
 * `source_unavailable` marker instead of failing startup.
 */
export async function createOrcadProfileStateStartup(
  userDataPath: string,
  ports: OrcadProfileStateStartupPorts
): Promise<OrcadProfileStateStartup> {
  initOrcaProfilePaths()
  const profile = ensureActiveOrcaProfile(userDataPath)
  const result = await createProfileStateStoreForStartup({
    dataFile: profile.dataFile,
    databaseFile: profile.stateDatabaseFile,
    profileId: profile.profile.id,
    runtime: 'orcad',
    storageAuthority: 'runtime'
  })
  const authority = {
    backend: result.backend,
    classification: result.classification,
    authority_mode: 'sqlite-established' as const,
    runtime: 'orcad' as const,
    migrated: result.migrated
  }
  // Before the authority is published and long before the runtime can serve: the
  // source must exist for the first archive, not the second one.
  bindOrcadTaskRecordsUsageSource({ ...ports, store: result.store })
  try {
    initSshHostKeyStoreFile(profile.dataFile)
    emitOrcadProfileStateAuthoritySelected(authority)
    return { store: result.store, authority }
  } catch (error) {
    try {
      await result.store.freezeWritesAsync()
    } catch (closeError) {
      console.error(
        '[persistence] Failed to close profile persistence after startup failure:',
        closeError
      )
    }
    throw error
  }
}

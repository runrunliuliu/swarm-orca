import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  createProfileStateStoreForStartupMock,
  emitMock,
  ensureActiveOrcaProfileMock,
  initOrcaProfilePathsMock,
  initSshHostKeyStoreFileMock
} = vi.hoisted(() => ({
  createProfileStateStoreForStartupMock: vi.fn(),
  emitMock: vi.fn(),
  ensureActiveOrcaProfileMock: vi.fn(),
  initOrcaProfilePathsMock: vi.fn(),
  initSshHostKeyStoreFileMock: vi.fn()
}))

vi.mock('../persistence/profile-state/profile-state-startup-authority', () => ({
  createProfileStateStoreForStartup: createProfileStateStoreForStartupMock
}))
vi.mock('../orca-profiles/profile-index-store', () => ({
  ensureActiveOrcaProfile: ensureActiveOrcaProfileMock,
  initOrcaProfilePaths: initOrcaProfilePathsMock
}))
vi.mock('../ssh/ssh-host-key-store', () => ({
  initSshHostKeyStoreFile: initSshHostKeyStoreFileMock
}))
vi.mock('./orcad-profile-state-telemetry', () => ({
  emitOrcadProfileStateAuthoritySelected: emitMock
}))

const { createOrcadProfileStateStartup } = await import('./orcad-profile-state-startup')

/** The hook server is the only port this seam takes; the binding it enables is what
 *  the archive transition reads, so its absence would be a startup bug, not a fixture. */
const HOOK_SERVER = {
  getProviderSessionIdentities: () => [],
  getStatusSnapshot: () => []
}

beforeEach(() => {
  vi.resetAllMocks()
  ensureActiveOrcaProfileMock.mockReturnValue({
    dataFile: '/tmp/profile/orca-data.json',
    stateDatabaseFile: '/tmp/profile/profile-state.db',
    profile: { id: 'profile-1' }
  })
})

describe('orcad profile-state startup', () => {
  it('selects the capable authority once and publishes bounded metadata', async () => {
    const store = { getSettings: vi.fn(), setTaskRecordsUsageSource: vi.fn() }
    createProfileStateStoreForStartupMock.mockReturnValue({
      store,
      authority: { readSerializedState: vi.fn() },
      backend: 'sqlite',
      classification: 'json-only',
      migrated: true
    })

    const result = await createOrcadProfileStateStartup('/tmp/user-data', {
      hookServer: HOOK_SERVER
    })

    expect(initOrcaProfilePathsMock).toHaveBeenCalledOnce()
    expect(ensureActiveOrcaProfileMock).toHaveBeenCalledWith('/tmp/user-data')
    expect(initSshHostKeyStoreFileMock).toHaveBeenCalledWith('/tmp/profile/orca-data.json')

    expect(createProfileStateStoreForStartupMock).toHaveBeenCalledWith({
      dataFile: '/tmp/profile/orca-data.json',
      databaseFile: '/tmp/profile/profile-state.db',
      profileId: 'profile-1',
      runtime: 'orcad',
      storageAuthority: 'runtime'
    })
    expect(result.store).toBe(store)
    expect(result.authority).toEqual({
      backend: 'sqlite',
      classification: 'json-only',
      authority_mode: 'sqlite-established',
      runtime: 'orcad',
      migrated: true
    })
    expect(emitMock).toHaveBeenCalledWith(result.authority)
  })

  it('publishes nothing before the profile writer is ready', async () => {
    let refuse = (_error: Error) => {}
    createProfileStateStoreForStartupMock.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          refuse = reject
        })
    )
    const startup = createOrcadProfileStateStartup('/tmp/user-data', { hookServer: HOOK_SERVER })
    const failure = new Error('writer startup refused')
    const rejected = expect(startup).rejects.toBe(failure)
    expect(initSshHostKeyStoreFileMock).not.toHaveBeenCalled()
    expect(emitMock).not.toHaveBeenCalled()
    refuse(failure)
    await rejected
  })

  it('closes a ready writer if sidecar initialization fails', async () => {
    const store = { freezeWritesAsync: vi.fn(async () => {}), setTaskRecordsUsageSource: vi.fn() }
    createProfileStateStoreForStartupMock.mockResolvedValueOnce({
      store,
      backend: 'sqlite',
      classification: 'sqlite-only',
      migrated: false
    })
    const failure = new Error('sidecar initialization refused')
    initSshHostKeyStoreFileMock.mockImplementationOnce(() => {
      throw failure
    })
    await expect(
      createOrcadProfileStateStartup('/tmp/user-data', { hookServer: HOOK_SERVER })
    ).rejects.toBe(failure)
    expect(store.freezeWritesAsync).toHaveBeenCalledOnce()
    expect(emitMock).not.toHaveBeenCalled()
  })

  it('binds the task-records usage source before the Store is handed to the runtime', async () => {
    const store = { getSettings: vi.fn(), setTaskRecordsUsageSource: vi.fn() }
    createProfileStateStoreForStartupMock.mockResolvedValueOnce({
      store,
      backend: 'sqlite',
      classification: 'sqlite-only',
      migrated: false
    })

    await createOrcadProfileStateStartup('/tmp/user-data', { hookServer: HOOK_SERVER })

    // The archive transition reads this source at the metadata write that flips
    // `isArchived` (issue #31); a Store returned without it writes "this runtime could
    // not look" for a workspace whose session the local index holds.
    expect(store.setTaskRecordsUsageSource).toHaveBeenCalledOnce()
    const source = store.setTaskRecordsUsageSource.mock.calls[0]?.[0]
    expect(typeof source?.snapshotForArchive).toBe('function')
    expect(typeof source?.archiveSnapshot?.sessionIndexLookup).toBe('function')
  })

  it('reports a failed binding and still returns the Store instead of failing startup', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = {
      getSettings: vi.fn(),
      setTaskRecordsUsageSource: vi.fn(() => {
        throw new Error('binding refused')
      })
    }
    createProfileStateStoreForStartupMock.mockResolvedValueOnce({
      store,
      backend: 'sqlite',
      classification: 'sqlite-only',
      migrated: false
    })

    const result = await createOrcadProfileStateStartup('/tmp/user-data', {
      hookServer: HOOK_SERVER
    })

    // No startup failure: a ledger source must not keep a headless host from serving.
    expect(result.store).toBe(store)
    // No silent degradation either: the failure names what the archive will store now.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('task-records usage source not bound'),
      expect.any(Error)
    )
    warn.mockRestore()
  })
})

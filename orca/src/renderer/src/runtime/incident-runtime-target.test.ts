import { describe, expect, it } from 'vitest'
import { resolveIncidentRuntimeTarget } from './incident-runtime-target'
import type { WorktreeOperationRouteState } from '@/lib/worktree-operation-route'

describe('incident workspace runtime ownership', () => {
  it.each([null, 'other'])('uses the workspace peer, not global selection %s', (globalId) => {
    expect(
      resolveIncidentRuntimeTarget({
        activeWorktreeId: 'repo::/work',
        activeWorkspaceExecutionHostId: 'runtime:peer',
        settings: { activeRuntimeEnvironmentId: globalId }
      })
    ).toEqual({ kind: 'environment', environmentId: 'peer' })
  })

  it('keeps a selected local workspace local even when the global selection is remote', () => {
    expect(
      resolveIncidentRuntimeTarget({
        activeWorktreeId: 'repo::/work',
        activeWorkspaceExecutionHostId: 'local',
        settings: { activeRuntimeEnvironmentId: 'other' }
      })
    ).toEqual({ kind: 'local' })
  })

  it('resolves projected worktrees without a selected host', () => {
    expect(
      resolveIncidentRuntimeTarget({
        activeWorktreeId: 'repo::/work',
        settings: { activeRuntimeEnvironmentId: null },
        worktreesByRepo: { repo: [{ id: 'repo::/work', repoId: 'repo', hostId: 'runtime:peer' }] }
      })
    ).toEqual({ kind: 'environment', environmentId: 'peer' })
  })

  it.each(['local', 'runtime:peer'] as const)('resolves folder owner %s', (host) => {
    expect(
      resolveIncidentRuntimeTarget({
        activeWorktreeId: 'folder:folder-1',
        folderWorkspaces: [{ id: 'folder-1', projectGroupId: 'group', executionHostId: host }]
      })
    ).toEqual(host === 'local' ? { kind: 'local' } : { kind: 'environment', environmentId: 'peer' })
  })

  it('does not confuse a direct SSH host with the local incident database', () => {
    expect(
      resolveIncidentRuntimeTarget({
        activeWorktreeId: 'repo::/work',
        activeWorkspaceExecutionHostId: 'ssh:connection'
      })
    ).toEqual({ kind: 'unsupported' })
  })

  it.each<WorktreeOperationRouteState>([
    { activeWorktreeId: 'missing' },
    {
      activeWorktreeId: 'repo::/work',
      worktreesByRepo: {
        repo: [
          { id: 'repo::/work', repoId: 'repo', hostId: 'runtime:a' },
          { id: 'repo::/work', repoId: 'repo', hostId: 'runtime:b' }
        ]
      }
    },
    {
      activeWorktreeId: 'repo::/work',
      activeWorkspaceExecutionHostId: 'runtime:removed',
      removedRuntimeEnvironmentIds: new Set(['removed'])
    },
    {
      activeWorktreeId: 'repo::/work',
      activeWorkspaceExecutionHostId: 'runtime:removed',
      runtimeEnvironmentCatalogHydrated: true,
      runtimeEnvironments: []
    }
  ])('fails unresolved, ambiguous or retired ownership closed: %j', (state) => {
    expect(resolveIncidentRuntimeTarget(state)).toEqual({ kind: 'unavailable' })
  })

  it('uses the explicit environment or local default only when no workspace is selected', () => {
    expect(resolveIncidentRuntimeTarget({})).toEqual({ kind: 'local' })
    expect(
      resolveIncidentRuntimeTarget({ settings: { activeRuntimeEnvironmentId: 'peer' } })
    ).toEqual({ kind: 'environment', environmentId: 'peer' })
  })
})

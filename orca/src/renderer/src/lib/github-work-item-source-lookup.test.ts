import { beforeEach, describe, expect, it, vi } from 'vitest'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type * as RuntimeRpcClient from '@/runtime/runtime-rpc-client'
import { useAppStore } from '@/store'
import {
  WORK_ITEM_DETAILS_REPO_UNREADABLE_MESSAGE,
  lookupGitHubWorkItemDetailsForSource
} from './github-work-item-source-lookup'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import type { Repo } from '../../../shared/repo-types'

vi.mock('@/runtime/runtime-rpc-client', async () => {
  const actual = await vi.importActual<typeof RuntimeRpcClient>('@/runtime/runtime-rpc-client')
  return {
    ...actual,
    callRuntimeRpc: vi.fn()
  }
})

const runtimeSourceContext: TaskSourceContext = {
  kind: 'task-source',
  provider: 'github',
  projectId: 'project-1',
  hostId: 'runtime:env-1',
  repoId: 'runtime-repo'
}

// Why: the page's own source context — the one that still says `local` while the
// repo row already belongs to a runtime, which is the #70 shape.
const localSourceContext: TaskSourceContext = {
  ...runtimeSourceContext,
  hostId: 'local'
}

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/Users/test/src/orca',
    displayName: 'stablyai/orca',
    badgeColor: '#22c55e',
    addedAt: 0,
    ...overrides
  }
}

function seedRepoOwnerState(repos: Repo[], activeRuntimeEnvironmentId: string | null = null): void {
  useAppStore.setState({
    repos,
    settings: { activeRuntimeEnvironmentId }
  } as never)
}

describe('GitHub source lookup routing', () => {
  beforeEach(() => {
    vi.mocked(callRuntimeRpc).mockReset()
    seedRepoOwnerState([])
    vi.stubGlobal('window', {
      api: {
        gh: {
          workItemDetails: vi.fn()
        }
      }
    })
  })

  it('routes runtime-owned GitHub details through runtime RPC', async () => {
    vi.mocked(callRuntimeRpc).mockResolvedValue(null)

    await expect(
      lookupGitHubWorkItemDetailsForSource({
        repoPath: '/home/runtime/app',
        repoId: 'renderer-repo',
        sourceContext: runtimeSourceContext,
        number: 42,
        type: 'issue'
      })
    ).resolves.toBeNull()

    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'github.workItemDetails',
      { repo: 'runtime-repo', number: 42, type: 'issue' },
      { timeoutMs: 30_000 }
    )
    expect(window.api.gh.workItemDetails).not.toHaveBeenCalled()
  })

  it('uses the renderer repo id for runtime details when the source has no repo id', async () => {
    vi.mocked(callRuntimeRpc).mockResolvedValue(null)

    await lookupGitHubWorkItemDetailsForSource({
      repoPath: '/home/runtime/app',
      repoId: 'renderer-repo',
      sourceContext: { ...runtimeSourceContext, repoId: null },
      number: 42,
      type: 'pr'
    })

    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'github.workItemDetails',
      { repo: 'renderer-repo', number: 42, type: 'pr' },
      { timeoutMs: 30_000 }
    )
  })

  it('keeps local GitHub details on Electron IPC with source context', async () => {
    seedRepoOwnerState([makeRepo({ id: 'local-repo', path: 'C:\\workspace\\app' })])
    vi.mocked(window.api.gh.workItemDetails).mockResolvedValue(null)
    const sourceContext: TaskSourceContext = {
      ...runtimeSourceContext,
      hostId: 'local',
      repoId: 'local-repo'
    }

    await expect(
      lookupGitHubWorkItemDetailsForSource({
        repoPath: 'C:\\workspace\\app',
        repoId: 'local-repo',
        sourceContext,
        number: 42,
        type: 'issue'
      })
    ).resolves.toBeNull()

    expect(window.api.gh.workItemDetails).toHaveBeenCalledWith({
      repoPath: 'C:\\workspace\\app',
      repoId: 'local-repo',
      sourceContext,
      number: 42,
      type: 'issue'
    })
    expect(callRuntimeRpc).not.toHaveBeenCalled()
  })

  // Why: #70. The repo row is owned by a runtime, the page source is still `local`.
  // Routing on the source alone sends the runtime repo's path/id to the local gh
  // IPC, whose registry answers "Access denied: unknown repository path" and takes
  // the Orca tab down with it.
  it('routes a runtime-owned repo to its owner even when the source context says local', async () => {
    seedRepoOwnerState([
      makeRepo({ id: 'runtime-repo', path: '/home/runtime/app', executionHostId: 'runtime:env-9' })
    ])
    vi.mocked(callRuntimeRpc).mockResolvedValue(null)

    await expect(
      lookupGitHubWorkItemDetailsForSource({
        repoPath: '/home/runtime/app',
        repoId: 'runtime-repo',
        // Why a different repo id: the stale page context must not steer the runtime
        // request — the repo row this dialog opened is the authority.
        sourceContext: { ...localSourceContext, repoId: 'stale-local-repo' },
        number: 7,
        type: 'pr'
      })
    ).resolves.toBeNull()

    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-9' },
      'github.workItemDetails',
      { repo: 'runtime-repo', number: 7, type: 'pr' },
      { timeoutMs: 30_000 }
    )
    expect(window.api.gh.workItemDetails).not.toHaveBeenCalled()
  })

  it('routes a runtime-owned repo to its owner when the source context is missing', async () => {
    seedRepoOwnerState([
      makeRepo({ id: 'runtime-repo', path: '/home/runtime/app', executionHostId: 'runtime:env-9' })
    ])
    vi.mocked(callRuntimeRpc).mockResolvedValue(null)

    await lookupGitHubWorkItemDetailsForSource({
      repoPath: '/home/runtime/app',
      repoId: 'runtime-repo',
      sourceContext: null,
      number: 7,
      type: 'issue'
    })

    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-9' },
      'github.workItemDetails',
      { repo: 'runtime-repo', number: 7, type: 'issue' },
      { timeoutMs: 30_000 }
    )
    expect(window.api.gh.workItemDetails).not.toHaveBeenCalled()
  })

  // Why: #6957 says a repo without an explicit runtime owner is a LOCAL repo, even
  // while some runtime is focused. Details must follow that same rule, or the fix
  // for #70 would start shipping local repos to an unrelated runtime.
  it('keeps an explicitly local repo on Electron IPC while another runtime is focused', async () => {
    seedRepoOwnerState(
      [makeRepo({ id: 'local-repo', path: '/Users/test/src/app', executionHostId: 'local' })],
      'focused-runtime'
    )
    vi.mocked(window.api.gh.workItemDetails).mockResolvedValue(null)

    await lookupGitHubWorkItemDetailsForSource({
      repoPath: '/Users/test/src/app',
      repoId: 'local-repo',
      sourceContext: { ...localSourceContext, repoId: 'local-repo' },
      number: 11,
      type: 'issue'
    })

    expect(window.api.gh.workItemDetails).toHaveBeenCalledTimes(1)
    expect(callRuntimeRpc).not.toHaveBeenCalled()
  })

  // Why: when no host can be resolved the local registry is the last thing tried; its
  // raw denial is not something a user can act on, so surface readable copy instead.
  it('degrades a local registry denial into readable copy', async () => {
    vi.mocked(window.api.gh.workItemDetails).mockRejectedValue(
      new Error(
        "Error invoking remote method 'gh:workItemDetails': Error: Access denied: unknown repository path"
      )
    )

    // Why capture instead of `rejects.toThrow(message)`: on the pre-fix baseline the
    // constant did not exist, and `toThrow(undefined)` asserts nothing — this form is
    // red on the baseline for the right reason.
    const failure = await lookupGitHubWorkItemDetailsForSource({
      repoPath: '/home/runtime/app',
      repoId: 'unknown-repo',
      sourceContext: { ...localSourceContext, repoId: 'unknown-repo' },
      number: 3,
      type: 'issue'
    }).then(
      () => null,
      (error: unknown) => error as Error
    )

    expect(failure?.message).toBe(WORK_ITEM_DETAILS_REPO_UNREADABLE_MESSAGE)
    expect(failure?.message).not.toContain('Access denied')
    expect(callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('leaves non-routing local failures untouched', async () => {
    vi.mocked(window.api.gh.workItemDetails).mockRejectedValue(new Error('gh: not authenticated'))

    await expect(
      lookupGitHubWorkItemDetailsForSource({
        repoPath: '/Users/test/src/app',
        repoId: 'local-repo',
        sourceContext: { ...localSourceContext, repoId: 'local-repo' },
        number: 4,
        type: 'issue'
      })
    ).rejects.toThrow('gh: not authenticated')
  })
})

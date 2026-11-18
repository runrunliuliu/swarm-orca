import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import { buildLinkedIssueContextSnapshot } from '../../shared/linked-issue-context-snapshot'

const mocks = vi.hoisted(() => ({
  ghExecFileAsync: vi.fn(),
  resolveIssueGitHubApiRepositorySource: vi.fn()
}))

vi.mock('../git/runner', () => ({ ghExecFileAsync: mocks.ghExecFileAsync }))
vi.mock('./github-api-repository', () => ({
  resolveIssueGitHubApiRepositorySource: mocks.resolveIssueGitHubApiRepositorySource
}))

import {
  captureLinkedIssueContextForWorktree,
  resolveRepoIssueReadTarget,
  type LinkedIssueContextCaptureStore,
  type LinkedIssueReadTarget
} from './linked-issue-context-capture'

const WORKTREE_ID = 'repo-1::/workspace/app'
const WORKTREE_PATH = '/workspace/app'
const INSTANCE_ID = 'instance-1'
const TARGET: LinkedIssueReadTarget = {
  owner: 'runrunliuliu',
  repo: 'swarm-orca',
  host: 'github.com'
}

// The REST payload `gh api repos/{owner}/{repo}/issues/{n}` answers with.
const ISSUE_RESPONSE = {
  number: 24,
  title: 'feat: inject linked issue',
  html_url: 'https://github.com/runrunliuliu/swarm-orca/issues/24',
  body: '## Background',
  updated_at: '2026-11-18T10:00:00Z'
}

function makeStore(args: {
  meta?: Partial<WorktreeMeta> | undefined
  repo?: Partial<Repo> | undefined
}): {
  store: LinkedIssueContextCaptureStore
  setWorktreeMeta: ReturnType<typeof vi.fn>
  getWorktreeMeta: ReturnType<typeof vi.fn>
} {
  const meta = args.meta === undefined ? { linkedIssue: 24, instanceId: INSTANCE_ID } : args.meta
  const setWorktreeMeta = vi.fn()
  const getWorktreeMeta = vi.fn(() => meta as WorktreeMeta | undefined)
  const store = {
    getWorktreeMeta,
    setWorktreeMeta,
    getRepo: vi.fn(() =>
      args.repo === undefined ? ({ id: 'repo-1', path: '/repo', kind: 'git' } as Repo) : args.repo
    )
  } as unknown as LinkedIssueContextCaptureStore
  return { store, setWorktreeMeta, getWorktreeMeta }
}

async function capture(
  store: LinkedIssueContextCaptureStore,
  overrides: {
    fetchIssue?: (target: LinkedIssueReadTarget, issueNumber: number) => Promise<unknown>
    resolveReadTarget?: () => Promise<LinkedIssueReadTarget | null>
    onCaptured?: () => void
  } = {}
) {
  return captureLinkedIssueContextForWorktree({
    store,
    worktreeId: WORKTREE_ID,
    worktreePath: WORKTREE_PATH,
    resolveReadTarget: overrides.resolveReadTarget ?? (async () => TARGET),
    // Omitted means the real gh adapter, which the adapter cases below exercise.
    ...(overrides.fetchIssue ? { fetchIssue: overrides.fetchIssue } : {}),
    ...(overrides.onCaptured ? { onCaptured: overrides.onCaptured } : {}),
    now: () => 1_700_000_000_000
  })
}

describe('captureLinkedIssueContextForWorktree', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.ghExecFileAsync.mockResolvedValue({ stdout: JSON.stringify(ISSUE_RESPONSE), stderr: '' })
  })

  it('reads the pinned issue and persists one snapshot', async () => {
    const { store, setWorktreeMeta } = makeStore({})
    const onCaptured = vi.fn()
    const fetchIssue = vi.fn(async () => ISSUE_RESPONSE)

    const snapshot = await capture(store, { fetchIssue, onCaptured })

    expect(fetchIssue).toHaveBeenCalledWith(TARGET, 24)
    expect(snapshot).toEqual(
      buildLinkedIssueContextSnapshot({
        number: 24,
        title: ISSUE_RESPONSE.title,
        url: ISSUE_RESPONSE.html_url,
        body: ISSUE_RESPONSE.body,
        updatedAt: ISSUE_RESPONSE.updated_at,
        capturedAt: 1_700_000_000_000
      })
    )
    expect(setWorktreeMeta).toHaveBeenCalledWith(WORKTREE_ID, { linkedIssueContext: snapshot })
    expect(onCaptured).toHaveBeenCalledTimes(1)
  })

  it('does nothing for a worktree with no linked issue', async () => {
    const { store, setWorktreeMeta } = makeStore({ meta: { linkedIssue: null } })
    const fetchIssue = vi.fn()

    await capture(store, { fetchIssue })

    expect(fetchIssue).not.toHaveBeenCalled()
    expect(setWorktreeMeta).not.toHaveBeenCalled()
  })

  it('does not re-capture an issue it already captured', async () => {
    const existing = buildLinkedIssueContextSnapshot({
      number: 24,
      title: ISSUE_RESPONSE.title,
      url: ISSUE_RESPONSE.html_url,
      body: ISSUE_RESPONSE.body,
      capturedAt: 1_700_000_000_000
    })!
    const { store, setWorktreeMeta } = makeStore({
      meta: { linkedIssue: 24, linkedIssueContext: existing }
    })
    const fetchIssue = vi.fn()

    await capture(store, { fetchIssue })

    expect(fetchIssue).not.toHaveBeenCalled()
    expect(setWorktreeMeta).not.toHaveBeenCalled()
  })

  it('skips folder workspaces, which have no git remote for gh to resolve', async () => {
    const { store, setWorktreeMeta } = makeStore({
      repo: { id: 'repo-1', path: '/folder', kind: 'folder' } as Repo
    })
    const fetchIssue = vi.fn()

    await capture(store, { fetchIssue })

    expect(fetchIssue).not.toHaveBeenCalled()
    expect(setWorktreeMeta).not.toHaveBeenCalled()
  })

  it('skips host-backed checkouts however the row names its owner', async () => {
    const hostBackedRepos: Partial<Repo>[] = [
      { id: 'repo-1', path: '/repo', kind: 'git', connectionId: 'ssh:build-box' },
      { id: 'repo-1', path: '/repo', kind: 'git', executionHostId: 'ssh:build-box' }
    ]
    for (const repo of hostBackedRepos) {
      const { store, setWorktreeMeta } = makeStore({ repo })
      const fetchIssue = vi.fn()

      await capture(store, { fetchIssue })

      expect(fetchIssue).not.toHaveBeenCalled()
      expect(setWorktreeMeta).not.toHaveBeenCalled()
    }
  })

  it('skips the read when the repo resolves to no issue source', async () => {
    const { store, setWorktreeMeta } = makeStore({})
    const fetchIssue = vi.fn()

    await capture(store, { fetchIssue, resolveReadTarget: async () => null })

    expect(fetchIssue).not.toHaveBeenCalled()
    expect(setWorktreeMeta).not.toHaveBeenCalled()
  })

  it('swallows a failed read so a create never surfaces an enrichment error', async () => {
    const { store, setWorktreeMeta } = makeStore({})
    const onCaptured = vi.fn()

    await expect(
      capture(store, {
        onCaptured,
        fetchIssue: async () => {
          throw new Error('gh: not authenticated')
        }
      })
    ).resolves.toBeNull()

    expect(setWorktreeMeta).not.toHaveBeenCalled()
    expect(onCaptured).not.toHaveBeenCalled()
  })

  it('stores nothing when the response cannot name the issue', async () => {
    const { store, setWorktreeMeta } = makeStore({})

    await expect(
      capture(store, { fetchIssue: async () => ({ body: 'no url' }) })
    ).resolves.toBeNull()

    expect(setWorktreeMeta).not.toHaveBeenCalled()
  })

  it('refuses a response that names another issue', async () => {
    const { store, setWorktreeMeta } = makeStore({})

    await expect(
      capture(store, { fetchIssue: async () => ({ ...ISSUE_RESPONSE, number: 999 }) })
    ).resolves.toBeNull()

    expect(setWorktreeMeta).not.toHaveBeenCalled()
  })

  it('drops the capture when the link changes while the fetch is in flight', async () => {
    const { store, setWorktreeMeta, getWorktreeMeta } = makeStore({})
    getWorktreeMeta
      .mockReturnValueOnce({ linkedIssue: 24, instanceId: INSTANCE_ID })
      .mockReturnValueOnce({ linkedIssue: null, instanceId: INSTANCE_ID })

    await expect(capture(store, { fetchIssue: async () => ISSUE_RESPONSE })).resolves.toBeNull()

    expect(setWorktreeMeta).not.toHaveBeenCalled()
  })

  it('drops a late capture whose worktree id was rebuilt for the same issue', async () => {
    const { store, setWorktreeMeta, getWorktreeMeta } = makeStore({})
    // Same id, same link, different instance: A was deleted and B re-created at the same path.
    getWorktreeMeta
      .mockReturnValueOnce({ linkedIssue: 24, instanceId: INSTANCE_ID })
      .mockReturnValueOnce({ linkedIssue: 24, instanceId: 'instance-2' })

    await expect(capture(store, { fetchIssue: async () => ISSUE_RESPONSE })).resolves.toBeNull()

    expect(setWorktreeMeta).not.toHaveBeenCalled()
  })

  it('does not overwrite the snapshot a rebuilt worktree already captured', async () => {
    const rebuilt = buildLinkedIssueContextSnapshot({
      number: 24,
      title: ISSUE_RESPONSE.title,
      url: ISSUE_RESPONSE.html_url,
      body: ISSUE_RESPONSE.body,
      capturedAt: 1_700_000_001_000
    })!
    const { store, setWorktreeMeta, getWorktreeMeta } = makeStore({})
    getWorktreeMeta
      .mockReturnValueOnce({ linkedIssue: 24, instanceId: INSTANCE_ID })
      .mockReturnValueOnce({
        linkedIssue: 24,
        instanceId: 'instance-2',
        linkedIssueContext: rebuilt
      })

    await expect(capture(store, { fetchIssue: async () => ISSUE_RESPONSE })).resolves.toBeNull()

    expect(setWorktreeMeta).not.toHaveBeenCalled()
  })
})

describe('resolveRepoIssueReadTarget', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('pins the issue source preference and the Enterprise host', async () => {
    mocks.resolveIssueGitHubApiRepositorySource.mockResolvedValue({
      source: { owner: 'upstream-owner', repo: 'swarm-orca', host: 'ghe.example.com' },
      fellBack: false
    })

    await expect(
      resolveRepoIssueReadTarget({
        path: '/repo',
        issueSourcePreference: 'upstream',
        ghAccount: { host: 'ghe.example.com', user: 'reviewer' }
      })
    ).resolves.toEqual({
      owner: 'upstream-owner',
      repo: 'swarm-orca',
      host: 'ghe.example.com',
      ghAccount: { host: 'ghe.example.com', user: 'reviewer' }
    })
    expect(mocks.resolveIssueGitHubApiRepositorySource).toHaveBeenCalledWith(
      '/repo',
      'upstream',
      null,
      { ghAccount: { host: 'ghe.example.com', user: 'reviewer' } }
    )
  })

  it('pins github.com explicitly so an ambient GH_HOST cannot redirect the read', async () => {
    mocks.resolveIssueGitHubApiRepositorySource.mockResolvedValue({
      source: { owner: 'runrunliuliu', repo: 'swarm-orca' },
      fellBack: false
    })

    await expect(resolveRepoIssueReadTarget({ path: '/repo' })).resolves.toEqual({
      owner: 'runrunliuliu',
      repo: 'swarm-orca',
      host: 'github.com'
    })
  })

  it('pins the gh request to the resolved repository and host', async () => {
    mocks.ghExecFileAsync.mockResolvedValue({
      stdout: JSON.stringify(ISSUE_RESPONSE),
      stderr: ''
    })
    const { store } = makeStore({})

    // No fetchIssue seam: this exercises the real adapter.
    await capture(store, {
      resolveReadTarget: async () => ({
        owner: 'upstream-owner',
        repo: 'fork-name',
        host: 'github.com'
      })
    })

    expect(mocks.ghExecFileAsync).toHaveBeenCalledTimes(1)
    const [argv, options] = mocks.ghExecFileAsync.mock.calls[0] as [
      string[],
      { cwd?: string; host?: string; ghAccount?: { host: string; user: string } }
    ]
    expect(argv).toEqual(['api', '--cache', '60s', 'repos/upstream-owner/fork-name/issues/24'])
    expect(options.cwd).toBe(WORKTREE_PATH)
    // The runner turns this into `--hostname <host>`, so dotcom is pinned like any other host.
    expect(options.host).toBe('github.com')
  })

  it('carries the bound account and Enterprise host into the read', async () => {
    mocks.ghExecFileAsync.mockResolvedValue({
      stdout: JSON.stringify(ISSUE_RESPONSE),
      stderr: ''
    })
    const { store } = makeStore({})

    await capture(store, {
      resolveReadTarget: async () => ({
        owner: 'enterprise-owner',
        repo: 'swarm-orca',
        host: 'ghe.example.com',
        ghAccount: { host: 'ghe.example.com', user: 'reviewer' }
      })
    })

    const [, options] = mocks.ghExecFileAsync.mock.calls[0] as [
      string[],
      { host?: string; ghAccount?: { host: string; user: string } }
    ]
    expect(options.host).toBe('ghe.example.com')
    expect(options.ghAccount).toEqual({ host: 'ghe.example.com', user: 'reviewer' })
  })
})

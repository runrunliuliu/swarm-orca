import { describe, expect, it, vi } from 'vitest'

const {
  callMock,
  runtimeClientConstructorMock,
  serveOrcaAppMock,
  getDefaultUserDataPathMock,
  addEnvironmentFromPairingCodeMock,
  listEnvironmentsMock,
  spawnMock
} = vi.hoisted(() => ({
  callMock: vi.fn(),
  runtimeClientConstructorMock: vi.fn(),
  serveOrcaAppMock: vi.fn(),
  getDefaultUserDataPathMock: vi.fn(() => '/tmp/orca-user-data'),
  addEnvironmentFromPairingCodeMock: vi.fn(),
  listEnvironmentsMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('./runtime-client', async () => {
  const { createRuntimeClientModuleMock } = await import('./index-test-harness.js')
  return createRuntimeClientModuleMock({
    callMock,
    runtimeClientConstructorMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock
  })
})

vi.mock('./runtime/environments', () => ({
  addEnvironmentFromPairingCode: addEnvironmentFromPairingCodeMock,
  listEnvironments: listEnvironmentsMock,
  removeEnvironment: vi.fn(),
  resolveEnvironment: vi.fn()
}))

vi.mock('child_process', async () => {
  const { createChildProcessModuleMock } = await import('./index-test-harness.js')
  return createChildProcessModuleMock(spawnMock)
})

import { main } from './index'
import { buildWorktree, okFixture, queueFixtures, worktreeListFixture } from './test-fixtures'
import { useWorktreeAwarenessEnvironment } from './index-test-harness'

const createdGithubIssue = {
  ok: true,
  number: 42,
  url: 'https://github.com/acme/app/issues/42'
}

const createdLinearIssue = {
  issue: {
    id: 'a1b2c3d4-0000-4000-8000-000000000001',
    identifier: 'ENG-123',
    url: 'https://linear.app/acme/issue/ENG-123/login-retry'
  },
  meta: {
    workspaceId: 'workspace-1',
    writeId: '0f5d5c4e-3a1f-4a8e-9d1a-6c2b1c0f5d5c',
    deduplicated: false
  }
}

/** The last `--json` payload, as the CLI actually printed it. */
function lastPrintedJson(): unknown {
  const calls = vi.mocked(console.log).mock.calls.map((call) => String(call[0]))
  return JSON.parse(calls[calls.length - 1])
}

/**
 * The CLI prints the RPC envelope, so the ticket lives under `result`; a reader that looks for it
 * at the top level gets `undefined` and is tempted to create the ticket again. These narrow the
 * envelope by inspection instead of asserting a shape, so a changed payload fails here.
 */
function readGithubCreate(json: unknown): { number: number; url: string } {
  if (typeof json !== 'object' || json === null || !('result' in json)) {
    throw new Error('github create-issue printed no result envelope')
  }
  const { result } = json
  if (typeof result !== 'object' || result === null) {
    throw new Error('github create-issue result is not an object')
  }
  if (!('ok' in result) || result.ok !== true) {
    throw new Error('github create-issue did not report ok')
  }
  if (!('number' in result) || typeof result.number !== 'number') {
    throw new Error('github create-issue printed no issue number')
  }
  if (!('url' in result) || typeof result.url !== 'string') {
    throw new Error('github create-issue printed no issue url')
  }
  return { number: result.number, url: result.url }
}

function readLinearCreate(json: unknown): { identifier: string; url: string } {
  if (typeof json !== 'object' || json === null || !('result' in json)) {
    throw new Error('linear create printed no result envelope')
  }
  const { result } = json
  if (typeof result !== 'object' || result === null || !('issue' in result)) {
    throw new Error('linear create result carries no issue')
  }
  const { issue } = result
  if (typeof issue !== 'object' || issue === null) {
    throw new Error('linear create issue is not an object')
  }
  if (!('identifier' in issue) || typeof issue.identifier !== 'string') {
    throw new Error('linear create printed no identifier')
  }
  if (!('url' in issue) || typeof issue.url !== 'string') {
    throw new Error('linear create printed no url')
  }
  return { identifier: issue.identifier, url: issue.url }
}

/**
 * The ticket→workspace chain the dock's agent drives from the `orca-cli` guide's
 * ticket-to-workspace reference: one command creates the tracker issue through Orca's own RPC,
 * the next creates a workspace bound to that issue and starts an agent in it. These pin the two
 * contracts that reference depends on — where the identifier appears in `--json`, and that
 * `--issue` / `--linear-issue` plus `--agent/--prompt` travel in one `worktree.create` call.
 */
describe('orca cli ticket → workspace chain', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it('binds the workspace to the issue and starts the agent in the same call', async () => {
    queueFixtures(
      callMock,
      worktreeListFixture([buildWorktree('/tmp/repo', 'main', 'abc', 'repo-1')]),
      okFixture('req_create_issue_workspace', {
        worktree: {
          ...buildWorktree('/tmp/repo/add-login-retry', 'add-login-retry', 'abc', 'repo-1'),
          linkedIssue: 42
        },
        lineage: null,
        warnings: []
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'worktree',
        'create',
        '--repo',
        'id:repo-1',
        '--name',
        'add-login-retry',
        '--issue',
        '42',
        '--agent',
        'codex',
        '--prompt',
        'Start on https://github.com/acme/app/issues/42',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenNthCalledWith(2, 'worktree.create', {
      repo: 'id:repo-1',
      name: 'add-login-retry',
      displayName: 'add-login-retry',
      displayNameKind: 'user',
      baseBranch: undefined,
      linkedIssue: 42,
      comment: undefined,
      runHooks: false,
      activate: false,
      parentWorktree: undefined,
      cwdParentWorktree: 'id:repo-1::/tmp/repo',
      noParent: false,
      callerTerminalHandle: undefined,
      cliProvenanceRequest: {},
      startupAgent: 'codex',
      startupPrompt: 'Start on https://github.com/acme/app/issues/42',
      launchSource: 'cli'
    })
  })

  it('reports agentStarted false and warns when --issue was given without --agent', async () => {
    queueFixtures(
      callMock,
      worktreeListFixture([buildWorktree('/tmp/repo', 'main', 'abc', 'repo-1')]),
      okFixture('req_create_issue_no_agent', {
        worktree: {
          ...buildWorktree('/tmp/repo/login-retry', 'login-retry', 'abc', 'repo-1'),
          linkedIssue: 42
        },
        lineage: null,
        warnings: []
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(
      [
        'worktree',
        'create',
        '--repo',
        'id:repo-1',
        '--name',
        'login-retry',
        '--issue',
        '42',
        '--json'
      ],
      '/tmp/repo'
    )

    const printed = lastPrintedJson() as {
      result: { agentStarted?: boolean; warning?: string }
    }
    // A create linked to a ticket is the request that used to lose its agent silently.
    expect(printed.result.agentStarted).toBe(false)
    expect(printed.result.warning).toContain('--agent')
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('prints the missing-agent warning on stderr without --json', async () => {
    queueFixtures(
      callMock,
      worktreeListFixture([buildWorktree('/tmp/repo', 'main', 'abc', 'repo-1')]),
      okFixture('req_create_issue_no_agent_text', {
        worktree: buildWorktree('/tmp/repo/login-retry', 'login-retry', 'abc', 'repo-1'),
        lineage: null,
        warnings: []
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(
      ['worktree', 'create', '--repo', 'id:repo-1', '--name', 'login-retry', '--issue', '42'],
      '/tmp/repo'
    )

    expect(errorSpy.mock.calls.flat().join(' ')).toContain('without an agent')
    expect(errorSpy.mock.calls.flat().join(' ')).toContain('--agent')
  })

  it('reports agentStarted true when --agent owns the first terminal', async () => {
    queueFixtures(
      callMock,
      worktreeListFixture([buildWorktree('/tmp/repo', 'main', 'abc', 'repo-1')]),
      okFixture('req_create_issue_agent', {
        worktree: {
          ...buildWorktree('/tmp/repo/login-retry', 'login-retry', 'abc', 'repo-1'),
          linkedIssue: 42,
          createdWithAgent: 'codex'
        },
        lineage: null,
        warnings: [],
        startupTerminal: { spawned: true, handle: 'term-agent-1' },
        agentTerminalHandle: 'term-agent-1'
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await main(
      [
        'worktree',
        'create',
        '--repo',
        'id:repo-1',
        '--name',
        'login-retry',
        '--issue',
        '42',
        '--agent',
        'codex',
        '--prompt',
        'Start on https://github.com/acme/app/issues/42',
        '--json'
      ],
      '/tmp/repo'
    )

    const printed = lastPrintedJson() as {
      result: { agentStarted?: boolean; warning?: string }
    }
    expect(printed.result.agentStarted).toBe(true)
    expect(printed.result.warning).toBeUndefined()
  })

  it('feeds the GitHub number create-issue printed into worktree create', async () => {
    queueFixtures(callMock, okFixture('req_create_issue', createdGithubIssue))
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'github',
        'create-issue',
        '--repo',
        'id:repo-1',
        '--title',
        'Add login retry',
        '--body',
        'Retry a failed login once before showing the error.',
        '--json'
      ],
      '/tmp/repo'
    )

    const issue = readGithubCreate(lastPrintedJson())
    expect(issue).toEqual({
      number: createdGithubIssue.number,
      url: createdGithubIssue.url
    })

    queueFixtures(
      callMock,
      worktreeListFixture([buildWorktree('/tmp/repo', 'main', 'abc', 'repo-1')]),
      okFixture('req_create_issue_workspace', {
        worktree: buildWorktree('/tmp/repo/login-retry', 'login-retry', 'abc', 'repo-1'),
        lineage: null,
        warnings: []
      })
    )

    await main(
      [
        'worktree',
        'create',
        '--repo',
        'id:repo-1',
        '--name',
        'login-retry',
        '--issue',
        String(issue.number),
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith(
      'github.createIssue',
      {
        repo: 'id:repo-1',
        title: 'Add login retry',
        body: 'Retry a failed login once before showing the error.'
      },
      { timeoutMs: 60_000 }
    )
    expect(callMock).toHaveBeenLastCalledWith(
      'worktree.create',
      expect.objectContaining({ name: 'login-retry', linkedIssue: 42 })
    )
  })

  it('feeds the Linear identifier create printed into worktree create', async () => {
    queueFixtures(callMock, okFixture('req_linear_create', createdLinearIssue))
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'linear',
        'create',
        '--title',
        'Add login retry',
        '--body',
        'Retry a failed login once before showing the error.',
        '--team',
        'ENG',
        '--write-id',
        createdLinearIssue.meta.writeId,
        '--json'
      ],
      '/tmp/repo'
    )

    const issue = readLinearCreate(lastPrintedJson())
    expect(issue).toEqual({
      identifier: createdLinearIssue.issue.identifier,
      url: createdLinearIssue.issue.url
    })

    queueFixtures(
      callMock,
      worktreeListFixture([buildWorktree('/tmp/repo', 'main', 'abc', 'repo-1')]),
      okFixture('req_create_issue_workspace', {
        worktree: buildWorktree('/tmp/repo/login-retry', 'login-retry', 'abc', 'repo-1'),
        lineage: null,
        warnings: []
      })
    )

    await main(
      [
        'worktree',
        'create',
        '--repo',
        'id:repo-1',
        '--name',
        'login-retry',
        '--linear-issue',
        issue.url,
        '--json'
      ],
      '/tmp/repo'
    )

    // The agent-facing reference tells the agent to replay with the same write id, so the write id
    // and team have to reach the RPC unchanged; the context object is environment-derived.
    expect(callMock).toHaveBeenCalledWith(
      'linear.issueCreate',
      expect.objectContaining({
        title: 'Add login retry',
        body: 'Retry a failed login once before showing the error.',
        teamInput: 'ENG',
        writeId: createdLinearIssue.meta.writeId
      }),
      expect.objectContaining({ timeoutMs: expect.any(Number) })
    )
    expect(callMock).toHaveBeenLastCalledWith(
      'worktree.create',
      expect.objectContaining({ name: 'login-retry', linkedLinearIssue: 'ENG-123' })
    )
  })
})

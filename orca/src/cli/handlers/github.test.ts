import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()

vi.mock('../runtime-client', async () => {
  class RuntimeClient {
    readonly isRemote: boolean
    call = callMock
    getCliStatus = vi.fn()
    openOrca = vi.fn()

    constructor(
      _userDataPath?: string,
      _requestTimeoutMs?: number,
      remotePairingCode = process.env.ORCA_PAIRING_CODE ?? null,
      environmentSelector = process.env.ORCA_ENVIRONMENT ?? null
    ) {
      this.isRemote = Boolean(remotePairingCode || environmentSelector)
    }
  }

  // Why: re-export the REAL error classes; format.ts narrows with `instanceof`
  // against ./runtime/types, so a look-alike would collapse every CLI error
  // code into the generic `runtime_error` shape.
  const { RuntimeClientError, RuntimeRpcFailureError } = await import('../runtime/types.js')

  return {
    RuntimeClient,
    RuntimeClientError,
    RuntimeRpcFailureError
  }
})

import { HANDLER_GROUPS } from '../handler-group-manifest'
import { main } from '../index'
import { COMMAND_SPECS } from '../specs'
import { okFixture, queueFixtures } from '../test-fixtures'

const createdIssue = {
  ok: true,
  number: 42,
  url: 'https://github.com/acme/app/issues/42'
}

describe('orca github CLI handlers', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    vi.restoreAllMocks()
    callMock.mockReset()
    process.env = { ...originalEnv }
    // Why: these tests can run inside an Orca-managed terminal, which exports
    // real worktree/terminal/pairing env hints; clear them so handler context
    // assertions stay deterministic.
    delete process.env.ORCA_WORKTREE_ID
    delete process.env.ORCA_TERMINAL_HANDLE
    delete process.env.ORCA_PAIRING_CODE
    delete process.env.ORCA_ENVIRONMENT
    process.exitCode = undefined
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('forwards the issue fields to github.createIssue exactly once', async () => {
    queueFixtures(callMock, okFixture('req_create_issue', createdIssue))

    await main(
      [
        'github',
        'create-issue',
        '--repo',
        'id:repo-1',
        '--title',
        'Investigate flaky login',
        '--body',
        'Steps to reproduce',
        '--label',
        'bug',
        '--label',
        'needs-triage',
        '--assignee',
        'octocat',
        '--assignee',
        'hubot',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith(
      'github.createIssue',
      {
        repo: 'id:repo-1',
        title: 'Investigate flaky login',
        body: 'Steps to reproduce',
        labels: ['bug', 'needs-triage'],
        assignees: ['octocat', 'hubot']
      },
      { timeoutMs: 60_000 }
    )
    expect(String(vi.mocked(console.log).mock.calls[0][0])).toContain('"number": 42')
  })

  it('omits labels and assignees when the flags are absent', async () => {
    queueFixtures(callMock, okFixture('req_create_issue', createdIssue))

    await main(
      ['github', 'create-issue', '--repo', 'id:repo-1', '--title', 'Follow-up bug'],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith(
      'github.createIssue',
      { repo: 'id:repo-1', title: 'Follow-up bug', body: '' },
      { timeoutMs: 60_000 }
    )
    expect(String(vi.mocked(console.log).mock.calls[0][0])).toContain(
      'Created GitHub issue #42: https://github.com/acme/app/issues/42'
    )
  })

  it('reports a rejected create on stdout and exits non-zero', async () => {
    queueFixtures(callMock, okFixture('req_create_issue', { ok: false, error: 'Not logged in' }))

    await main(
      ['github', 'create-issue', '--repo', 'id:repo-1', '--title', 'Follow-up bug'],
      '/tmp/repo'
    )

    expect(String(vi.mocked(console.log).mock.calls[0][0])).toContain(
      'GitHub issue not created: Not logged in'
    )
    expect(process.exitCode).toBe(1)
  })

  it('reads --body-file - from stdin', async () => {
    const stdin = mockStdin(false, ['line one\n', 'line two'])
    queueFixtures(callMock, okFixture('req_create_issue', createdIssue))

    try {
      await main(
        [
          'github',
          'create-issue',
          '--repo',
          'id:repo-1',
          '--title',
          'Follow-up bug',
          '--body-file',
          '-'
        ],
        '/tmp/repo'
      )
    } finally {
      stdin.restore()
    }

    expect(callMock).toHaveBeenCalledWith(
      'github.createIssue',
      { repo: 'id:repo-1', title: 'Follow-up bug', body: 'line one\nline two' },
      { timeoutMs: 60_000 }
    )
  })

  it('reads --body-file from a path relative to the working directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-github-create-issue-'))
    writeFileSync(join(dir, 'body.md'), '# Heading\n\nDetails')
    queueFixtures(callMock, okFixture('req_create_issue', createdIssue))

    await main(
      [
        'github',
        'create-issue',
        '--repo',
        'id:repo-1',
        '--title',
        'Follow-up bug',
        '--body-file',
        'body.md'
      ],
      dir
    )

    expect(callMock).toHaveBeenCalledWith(
      'github.createIssue',
      { repo: 'id:repo-1', title: 'Follow-up bug', body: '# Heading\n\nDetails' },
      { timeoutMs: 60_000 }
    )
  })

  it('rejects a missing --repo or --title before dispatch', async () => {
    await main(['github', 'create-issue', '--title', 'Follow-up bug'], '/tmp/repo')
    expect(vi.mocked(console.error).mock.calls[0][0]).toContain('Missing required --repo')

    vi.mocked(console.error).mockClear()
    await main(['github', 'create-issue', '--repo', 'id:repo-1'], '/tmp/repo')
    expect(vi.mocked(console.error).mock.calls[0][0]).toContain('Missing required --title')

    expect(callMock).not.toHaveBeenCalled()
  })

  it('agrees with the spec and handler manifest it dispatches through', () => {
    expect(COMMAND_SPECS.some((spec) => spec.path.join(' ') === 'github create-issue')).toBe(true)
    expect(HANDLER_GROUPS.find((group) => group.name === 'github')?.keys).toEqual([
      'github create-issue'
    ])
  })
})

function mockStdin(isTTY: boolean, chunks: string[]): { restore: () => void } {
  const stdin = process.stdin
  const previousIsTTY = stdin.isTTY
  const previousAsyncIterator = stdin[Symbol.asyncIterator]
  Object.defineProperty(stdin, 'isTTY', {
    configurable: true,
    value: isTTY
  })
  ;(stdin as unknown as Record<symbol, unknown>)[Symbol.asyncIterator] = async function* () {
    for (const chunk of chunks) {
      yield chunk
    }
    return undefined
  }
  return {
    restore: () => {
      Object.defineProperty(stdin, 'isTTY', {
        configurable: true,
        value: previousIsTTY
      })
      if (previousAsyncIterator) {
        ;(stdin as unknown as Record<symbol, unknown>)[Symbol.asyncIterator] = previousAsyncIterator
      } else {
        Reflect.deleteProperty(stdin, Symbol.asyncIterator)
      }
    }
  }
}

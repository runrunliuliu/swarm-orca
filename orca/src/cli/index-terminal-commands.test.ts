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

describe('orca cli worktree awareness', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  it('passes explicit focus through terminal.create', async () => {
    queueFixtures(
      callMock,
      okFixture('req_terminal_create', {
        terminal: {
          handle: 'term_1',
          worktreeId: 'repo-1::/tmp/repo/feature',
          title: 'RUNNER'
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'terminal',
        'create',
        '--worktree',
        'path:/tmp/repo/feature',
        '--title',
        'RUNNER',
        '--focus',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('terminal.create', {
      worktree: 'path:/tmp/repo/feature',
      command: undefined,
      title: 'RUNNER',
      focus: true,
      presentation: 'focused'
    })
  })

  it('routes startup wait explicitly with a transport deadline and identity fence', async () => {
    queueFixtures(
      callMock,
      okFixture('startup', {
        startup: { handle: 'term_1', agent: 'trae', ready: true, incarnationId: 'inc-1' }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(
      [
        'terminal',
        'wait-startup',
        '--terminal',
        'term_1',
        '--expected-incarnation-id',
        'inc-1',
        '--timeout-ms',
        '90000',
        '--json'
      ],
      '/tmp'
    )
    expect(callMock).toHaveBeenCalledExactlyOnceWith(
      'terminal.waitForStartup',
      {
        terminal: 'term_1',
        expectedIncarnationId: 'inc-1',
        timeoutMs: 90000
      },
      { timeoutMs: 95000 }
    )
  })

  it.each([
    {},
    { startup: { handle: 'term_1', agent: 'trae', ready: false, incarnationId: 'inc-1' } },
    { startup: { handle: 'other', agent: 'trae', ready: true, incarnationId: 'inc-1' } },
    { startup: { handle: 'term_1', agent: 'trae', ready: true, incarnationId: 'old' } }
  ])('refuses an unconfirmed startup response %j without fallback', async (reply) => {
    const priorExitCode = process.exitCode
    queueFixtures(callMock, okFixture('startup', reply))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await main(
        [
          'terminal',
          'wait-startup',
          '--terminal',
          'term_1',
          '--expected-incarnation-id',
          'inc-1',
          '--json'
        ],
        '/tmp'
      )
      expect(process.exitCode).toBe(1)
      expect(callMock).toHaveBeenCalledOnce()
    } finally {
      process.exitCode = priorExitCode
    }
  })

  it('does not fall back when an older runtime rejects startup wait', async () => {
    const priorExitCode = process.exitCode
    callMock.mockRejectedValueOnce(new Error('method_not_found'))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await main(['terminal', 'wait-startup', '--terminal', 'term_1', '--json'], '/tmp')
      expect(process.exitCode).toBe(1)
      expect(callMock).toHaveBeenCalledOnce()
    } finally {
      process.exitCode = priorExitCode
    }
  })

  it('requires an explicit startup terminal even inside a terminal', async () => {
    const priorExitCode = process.exitCode
    process.env.ORCA_TERMINAL_HANDLE = 'term_implicit'
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await main(['terminal', 'wait-startup', '--json'], '/tmp')
      expect(process.exitCode).toBe(1)
      expect(callMock).not.toHaveBeenCalled()
    } finally {
      process.exitCode = priorExitCode
    }
  })

  it('prints terminal.read fallback screen lines in json mode', async () => {
    queueFixtures(
      callMock,
      okFixture('req_terminal_read', {
        terminal: {
          handle: 'term_worker',
          status: 'running',
          tail: ['Claude Code', 'Checking files', 'Waiting for input'],
          truncated: false,
          limited: true,
          oldestCursor: '0',
          nextCursor: '3000',
          latestCursor: '3000',
          returnedLineCount: 3
        }
      })
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['terminal', 'read', '--terminal', 'term_worker', '--limit', '120', '--json'],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('terminal.read', {
      terminal: 'term_worker',
      limit: 120
    })
    const printed = JSON.parse(String(logSpy.mock.calls[0]?.[0]))
    expect(printed.result.terminal.tail).toEqual([
      'Claude Code',
      'Checking files',
      'Waiting for input'
    ])
  })

  it('keeps interactive Codex startup commands backgrounded unless focus is explicit', async () => {
    queueFixtures(
      callMock,
      okFixture('req_terminal_create', {
        terminal: {
          handle: 'term_1',
          worktreeId: 'repo-1::/tmp/repo/feature',
          title: 'Codex'
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'terminal',
        'create',
        '--worktree',
        'path:/tmp/repo/feature',
        '--title',
        'Codex',
        '--command',
        'codex',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('terminal.create', {
      worktree: 'path:/tmp/repo/feature',
      command: 'codex',
      title: 'Codex',
      focus: false,
      rendererBacked: true,
      activate: false
    })
  })

  it('keeps explicit focus semantics when forcing Codex through the renderer path', async () => {
    queueFixtures(
      callMock,
      okFixture('req_terminal_create', {
        terminal: {
          handle: 'term_1',
          worktreeId: 'repo-1::/tmp/repo/feature',
          title: 'Codex'
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'terminal',
        'create',
        '--worktree',
        'path:/tmp/repo/feature',
        '--title',
        'Codex',
        '--command',
        'codex',
        '--focus',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('terminal.create', {
      worktree: 'path:/tmp/repo/feature',
      command: 'codex',
      title: 'Codex',
      focus: true,
      presentation: 'focused',
      rendererBacked: true,
      activate: true
    })
  })

  it('does not force the visible terminal path for explicit Codex exec commands', async () => {
    queueFixtures(
      callMock,
      okFixture('req_terminal_create', {
        terminal: {
          handle: 'term_1',
          worktreeId: 'repo-1::/tmp/repo/feature',
          title: 'Codex exec'
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'terminal',
        'create',
        '--worktree',
        'path:/tmp/repo/feature',
        '--title',
        'Codex exec',
        '--command',
        'codex exec summarize',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('terminal.create', {
      worktree: 'path:/tmp/repo/feature',
      command: 'codex exec summarize',
      title: 'Codex exec',
      focus: false
    })
  })

  it('does not force the visible terminal path for Codex exec commands after global options', async () => {
    queueFixtures(
      callMock,
      okFixture('req_terminal_create', {
        terminal: {
          handle: 'term_1',
          worktreeId: 'repo-1::/tmp/repo/feature',
          title: 'Codex exec'
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'terminal',
        'create',
        '--worktree',
        'path:/tmp/repo/feature',
        '--title',
        'Codex exec',
        '--command',
        'codex -m gpt-5 --sandbox workspace-write exec summarize',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('terminal.create', {
      worktree: 'path:/tmp/repo/feature',
      command: 'codex -m gpt-5 --sandbox workspace-write exec summarize',
      title: 'Codex exec',
      focus: false
    })
  })

  it('does not force the visible terminal path for Codex review commands after long options', async () => {
    queueFixtures(
      callMock,
      okFixture('req_terminal_create', {
        terminal: {
          handle: 'term_1',
          worktreeId: 'repo-1::/tmp/repo/feature',
          title: 'Codex review'
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'terminal',
        'create',
        '--worktree',
        'path:/tmp/repo/feature',
        '--title',
        'Codex review',
        '--command',
        'codex --model=gpt-5 --sandbox=workspace-write review',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('terminal.create', {
      worktree: 'path:/tmp/repo/feature',
      command: 'codex --model=gpt-5 --sandbox=workspace-write review',
      title: 'Codex review',
      focus: false
    })
  })

  it('does not force the visible terminal path for Codex help commands', async () => {
    queueFixtures(
      callMock,
      okFixture('req_terminal_create', {
        terminal: {
          handle: 'term_1',
          worktreeId: 'repo-1::/tmp/repo/feature',
          title: 'Codex help'
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'terminal',
        'create',
        '--worktree',
        'path:/tmp/repo/feature',
        '--title',
        'Codex help',
        '--command',
        'codex --help',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('terminal.create', {
      worktree: 'path:/tmp/repo/feature',
      command: 'codex --help',
      title: 'Codex help',
      focus: false
    })
  })

  it('keeps Codex prompts after global options backgrounded unless focus is explicit', async () => {
    queueFixtures(
      callMock,
      okFixture('req_terminal_create', {
        terminal: {
          handle: 'term_1',
          worktreeId: 'repo-1::/tmp/repo/feature',
          title: 'Codex prompt'
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'terminal',
        'create',
        '--worktree',
        'path:/tmp/repo/feature',
        '--title',
        'Codex prompt',
        '--command',
        'codex -m gpt-5 "fix the flaky test"',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('terminal.create', {
      worktree: 'path:/tmp/repo/feature',
      command: 'codex -m gpt-5 "fix the flaky test"',
      title: 'Codex prompt',
      focus: false,
      rendererBacked: true,
      activate: false
    })
  })

  it('keeps interactive Claude startup commands backgrounded unless focus is explicit', async () => {
    queueFixtures(
      callMock,
      okFixture('req_terminal_create', {
        terminal: {
          handle: 'term_1',
          worktreeId: 'repo-1::/tmp/repo/feature',
          title: 'Claude'
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'terminal',
        'create',
        '--worktree',
        'path:/tmp/repo/feature',
        '--title',
        'Claude',
        '--command',
        'claude',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('terminal.create', {
      worktree: 'path:/tmp/repo/feature',
      command: 'claude',
      title: 'Claude',
      focus: false,
      rendererBacked: true,
      activate: false
    })
  })

  it('keeps Claude print commands on the background terminal path', async () => {
    queueFixtures(
      callMock,
      okFixture('req_terminal_create', {
        terminal: {
          handle: 'term_1',
          worktreeId: 'repo-1::/tmp/repo/feature',
          title: 'Claude print'
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'terminal',
        'create',
        '--worktree',
        'path:/tmp/repo/feature',
        '--title',
        'Claude print',
        '--command',
        'claude -p "summarize"',
        '--json'
      ],
      '/tmp/repo'
    )

    expect(callMock).toHaveBeenCalledWith('terminal.create', {
      worktree: 'path:/tmp/repo/feature',
      command: 'claude -p "summarize"',
      title: 'Claude print',
      focus: false
    })
  })

  it('uses the resolved enclosing worktree for terminal consumers', async () => {
    queueFixtures(
      callMock,
      worktreeListFixture([buildWorktree('/tmp/repo/feature', 'feature/foo')]),
      okFixture('req_term', { terminals: [], totalCount: 0, truncated: false })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['terminal', 'list', '--worktree', 'active', '--json'], '/tmp/repo/feature/src')

    expect(callMock).toHaveBeenNthCalledWith(2, 'terminal.list', {
      worktree: 'id:repo::/tmp/repo/feature',
      limit: undefined,
      includeVisualLayouts: false
    })
  })

  it('requests visual layouts only for the human-readable terminal list', async () => {
    queueFixtures(
      callMock,
      worktreeListFixture([buildWorktree('/tmp/repo/feature', 'feature/foo')]),
      okFixture('req_term', { terminals: [], totalCount: 0, truncated: false })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['terminal', 'list', '--worktree', 'active'], '/tmp/repo/feature/src')

    expect(callMock).toHaveBeenNthCalledWith(
      2,
      'terminal.list',
      expect.objectContaining({ includeVisualLayouts: true })
    )
  })

  it('allows agent JSON clients to request visual layouts explicitly', async () => {
    const visualLayouts = [
      {
        worktreeId: 'repo::/tmp/repo/feature',
        worktreePath: '/tmp/repo/feature',
        root: { type: 'group', groupId: null, activeTabId: null, tabs: [] }
      }
    ]
    queueFixtures(
      callMock,
      worktreeListFixture([buildWorktree('/tmp/repo/feature', 'feature/foo')]),
      okFixture('req_term', {
        terminals: [],
        visualLayouts,
        totalCount: 0,
        truncated: false
      })
    )
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      ['terminal', 'list', '--worktree', 'active', '--include-visual-layouts', '--json'],
      '/tmp/repo/feature/src'
    )

    expect(callMock).toHaveBeenNthCalledWith(
      2,
      'terminal.list',
      expect.objectContaining({ includeVisualLayouts: true })
    )
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toMatchObject({
      result: { visualLayouts }
    })
  })

  it('rejects implicit remote terminal create instead of resolving from client cwd', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(
      ['terminal', 'create', '--pairing-code', 'remote-runtime', '--json'],
      '/tmp/client/repo/src'
    )

    expect(callMock).not.toHaveBeenCalled()
    expect([...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n')).toContain(
      'Remote terminal create requires --worktree'
    )
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('sends explicit remote terminal create worktree selectors unchanged', async () => {
    queueFixtures(
      callMock,
      okFixture('req_terminal_create', {
        terminal: {
          handle: 'term_1',
          worktreeId: 'repo-1::/srv/orca/feature',
          title: 'Server terminal'
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'terminal',
        'create',
        '--worktree',
        'id:repo-1::/srv/orca/feature',
        '--pairing-code',
        'remote-runtime',
        '--json'
      ],
      '/tmp/client/repo/src'
    )

    expect(callMock).toHaveBeenCalledWith('terminal.create', {
      worktree: 'id:repo-1::/srv/orca/feature',
      command: undefined,
      title: undefined,
      focus: false
    })
  })

  it('exits nonzero when terminal wait returns an unsatisfied blocked result', async () => {
    process.env.ORCA_TERMINAL_HANDLE = 'term_worker'
    callMock.mockResolvedValueOnce({
      id: 'req_terminal_wait',
      ok: true,
      result: {
        wait: {
          handle: 'term_worker',
          condition: 'tui-idle',
          satisfied: false,
          status: 'running',
          exitCode: null,
          blockedReason: 'codex-cwd-prompt'
        }
      },
      _meta: {
        runtimeId: 'runtime-1'
      }
    })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const priorExitCode = process.exitCode

    await main(['terminal', 'wait', '--terminal', 'term_worker', '--for', 'tui-idle'], '/tmp/repo')

    expect(callMock).toHaveBeenCalledWith(
      'terminal.wait',
      {
        terminal: 'term_worker',
        for: 'tui-idle',
        timeoutMs: undefined
      },
      {
        timeoutMs: 300000
      }
    )
    expect(logSpy.mock.calls.flat().join('\n')).toContain('blockedReason: codex-cwd-prompt')
    expect(process.exitCode).toBe(1)

    process.exitCode = priorExitCode
  })

  it('does not force remote Codex terminal creates through a local renderer path', async () => {
    queueFixtures(
      callMock,
      okFixture('req_terminal_create', {
        terminal: {
          handle: 'term_1',
          worktreeId: 'repo-1::/srv/orca/feature',
          title: 'Codex'
        }
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(
      [
        'terminal',
        'create',
        '--worktree',
        'id:repo-1::/srv/orca/feature',
        '--command',
        'codex',
        '--title',
        'Codex',
        '--pairing-code',
        'remote-runtime',
        '--json'
      ],
      '/tmp/client/repo/src'
    )

    expect(callMock).toHaveBeenCalledWith('terminal.create', {
      worktree: 'id:repo-1::/srv/orca/feature',
      command: 'codex',
      title: 'Codex',
      focus: false
    })
  })
})

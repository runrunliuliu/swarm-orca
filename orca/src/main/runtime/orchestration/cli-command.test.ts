import { describe, expect, it, vi } from 'vitest'
import { resolveTerminalOrchestrationCliCommand } from './cli-command'

describe('resolveTerminalOrchestrationCliCommand', () => {
  it('uses the owning native launcher ahead of a dev-mode name', () => {
    expect(
      resolveTerminalOrchestrationCliCommand({
        connectionId: null,
        isWsl: false,
        worktreeId: 'repo::/worktree',
        runtimeCliCommand: 'orca-dev',
        nativeCliCommand: () => "'/data/orca instance/cli/bin/orca-dev'"
      })
    ).toBe("'/data/orca instance/cli/bin/orca-dev'")
  })

  it.each([
    { connectionId: 'ssh-1', isWsl: false, worktreeId: 'repo::/remote', expected: 'orca' },
    { connectionId: null, isWsl: true, worktreeId: 'repo::C:\\repo', expected: 'orca-ide' },
    {
      connectionId: null,
      isWsl: null,
      worktreeId: 'repo::\\\\wsl.localhost\\Ubuntu\\home\\repo',
      expected: 'orca-ide'
    }
  ])('never resolves a native path for $expected / $worktreeId', ({ expected, ...target }) => {
    const nativeCliCommand = vi.fn(() => "'/host/only/orca'")
    expect(resolveTerminalOrchestrationCliCommand({ ...target, nativeCliCommand })).toBe(expected)
    expect(nativeCliCommand).not.toHaveBeenCalled()
  })

  it('keeps authoritative native metadata ahead of a stale WSL path', () => {
    expect(
      resolveTerminalOrchestrationCliCommand({
        connectionId: null,
        isWsl: false,
        worktreeId: 'repo::\\\\wsl.localhost\\Ubuntu\\home\\repo',
        nativeCliCommand: () => "'/native/orca'"
      })
    ).toBe("'/native/orca'")
  })

  it('uses orca-ide for a pane recorded as WSL', () => {
    expect(
      resolveTerminalOrchestrationCliCommand({
        connectionId: null,
        isWsl: true,
        worktreeId: 'repo::C:\\repo'
      })
    ).toBe('orca-ide')
  })

  it('uses project runtime and WSL paths when restored pane metadata is unavailable', () => {
    expect(
      resolveTerminalOrchestrationCliCommand({
        connectionId: null,
        isWsl: null,
        worktreeId: 'repo::C:\\repo',
        projectRuntime: {
          status: 'resolved',
          runtime: {
            kind: 'wsl',
            hostPlatform: 'wsl',
            projectId: 'project',
            distro: 'Ubuntu',
            reason: 'project-override',
            cacheKey: 'project:wsl:Ubuntu'
          }
        }
      })
    ).toBe('orca-ide')
    expect(
      resolveTerminalOrchestrationCliCommand({
        connectionId: null,
        isWsl: null,
        worktreeId: 'repo::\\\\wsl.localhost\\Ubuntu\\home\\alice\\repo'
      })
    ).toBe('orca-ide')
  })

  it('preserves native and SSH bare-orca commands', () => {
    expect(
      resolveTerminalOrchestrationCliCommand({
        connectionId: null,
        isWsl: false,
        worktreeId: 'repo::/home/alice/repo'
      })
    ).toBe('orca')
    expect(
      resolveTerminalOrchestrationCliCommand({
        connectionId: 'ssh-1',
        isWsl: null,
        worktreeId: 'repo::\\\\wsl.localhost\\Ubuntu\\home\\alice\\repo'
      })
    ).toBe('orca')
  })

  it('uses the runtime-provided command locally but never leaks it to SSH', () => {
    expect(
      resolveTerminalOrchestrationCliCommand({
        connectionId: null,
        isWsl: true,
        worktreeId: 'repo::C:\\repo',
        runtimeCliCommand: 'orca-dev'
      })
    ).toBe('orca-dev')
    expect(
      resolveTerminalOrchestrationCliCommand({
        connectionId: 'ssh-1',
        isWsl: true,
        worktreeId: 'repo::C:\\repo',
        runtimeCliCommand: 'orca-dev'
      })
    ).toBe('orca')
  })
})

import { describe, expect, it } from 'vitest'
import { TerminalCreateParams } from './terminal-unary-params'
import { resolveWindowsShellStartupFamily } from '../windows-terminal-shell'
import { MAX_AGENT_ARGS_BYTES } from './agent-session-params'

describe('TerminalCreateParams.shell', () => {
  it('stays optional so older callers keep creating terminals', () => {
    const parsed = TerminalCreateParams.parse({ worktree: 'path:/repo' })

    expect(parsed.shell).toBeUndefined()
  })

  it('carries an allowed Windows shell through to the runtime', () => {
    expect(TerminalCreateParams.parse({ worktree: 'path:/repo', shell: 'cmd.exe' }).shell).toBe(
      'cmd.exe'
    )
    expect(TerminalCreateParams.parse({ worktree: 'path:/repo', shell: 'git-bash' }).shell).toBe(
      'git-bash'
    )
  })

  // The host canonicalizes even when a client did not, so the spawn path and the startup-command
  // quoting only ever see the `.exe` spelling they exact-match.
  it('canonicalizes an accepted spelling before it reaches the runtime', () => {
    expect(TerminalCreateParams.parse({ worktree: 'path:/repo', shell: 'cmd' }).shell).toBe(
      'cmd.exe'
    )
    expect(TerminalCreateParams.parse({ worktree: 'path:/repo', shell: 'pwsh' }).shell).toBe(
      'pwsh.exe'
    )
    expect(TerminalCreateParams.parse({ worktree: 'path:/repo', shell: 'Git-Bash' }).shell).toBe(
      'git-bash'
    )
  })

  it('quotes a bare cmd override as cmd rather than PowerShell', () => {
    const { shell } = TerminalCreateParams.parse({ worktree: 'path:/repo', shell: 'cmd' })

    expect(resolveWindowsShellStartupFamily(shell)).toBe('cmd')
  })

  // The relay refuses these at spawn time; refusing here turns an opaque spawn failure into an
  // answer the caller gets before the terminal exists.
  it('refuses a shell the host will not spawn', () => {
    expect(() => TerminalCreateParams.parse({ worktree: 'path:/repo', shell: 'nu.exe' })).toThrow(
      /shell must be one of/
    )
    expect(() =>
      TerminalCreateParams.parse({ worktree: 'path:/repo', shell: 'cmd.exe && calc' })
    ).toThrow(/shell must be one of/)
  })
})

describe('TerminalCreateParams startup agent fields', () => {
  it('bounds the final UTF-8 agent args at the strict planner 16 KiB limit', () => {
    expect(MAX_AGENT_ARGS_BYTES).toBe(16 * 1024)
    const prefix = "exec --json '汉字'"
    const agentArgs = `${prefix}${'x'.repeat(MAX_AGENT_ARGS_BYTES - Buffer.byteLength(prefix, 'utf8'))}`
    const params = { worktree: 'path:/repo', startupAgent: 'trae', agentArgs }
    expect(TerminalCreateParams.parse(params).agentArgs).toBe(agentArgs)
    expect(() => TerminalCreateParams.parse({ ...params, agentArgs: `${agentArgs}x` })).toThrow(
      /Agent arguments are too large/
    )
    expect(() => TerminalCreateParams.parse({ ...params, agentArgs: 'x'.repeat(23855) })).toThrow(
      /Agent arguments are too large/
    )
  })

  it('accepts runtime-managed terminal agent launch fields without a shell command', () => {
    const parsed = TerminalCreateParams.parse({
      worktree: 'path:/repo',
      startupAgent: 'trae',
      agentArgs: 'exec --json -',
      launchPreferences: { model: 'gpt-5.5', effort: 'xhigh', backendVariant: 'max' }
    })

    expect(parsed).toMatchObject({
      startupAgent: 'trae',
      agentArgs: 'exec --json -',
      launchPreferences: { model: 'gpt-5.5', effort: 'xhigh', backendVariant: 'max' }
    })
  })

  it('refuses an unknown startup agent before spawn', () => {
    expect(() =>
      TerminalCreateParams.parse({ worktree: 'path:/repo', startupAgent: 'not-an-agent' })
    ).toThrow()
  })
})

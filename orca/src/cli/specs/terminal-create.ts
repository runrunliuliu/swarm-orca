import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const TERMINAL_CREATE_COMMAND_SPEC: CommandSpec = {
  path: ['terminal', 'create'],
  summary: 'Create a terminal session in the current worktree',
  usage:
    'orca terminal create [--worktree <selector>] [--title <name>] [--command <text>|--agent <id>] [--agent-args <args>] [--model <id>] [--effort <level>] [--backend-variant <id>] [--shell <shell>] [--focus] [--json]',
  allowedFlags: [
    ...GLOBAL_FLAGS,
    'worktree',
    'command',
    'agent',
    'agent-args',
    'model',
    'effort',
    'backend-variant',
    'shell',
    'title',
    'focus'
  ],
  notes: [
    'Creates a visible terminal tab without switching focus when possible; falls back to a background handle if the UI cannot adopt it. Pass --focus to switch to it.',
    'Use this, not worktree create, for a fresh agent in the current checkout.',
    '--agent starts a runtime-managed TUI agent in the terminal, so Orca can attach launch identity; do not combine it with --command.',
    '--shell picks the shell the terminal IS on a Windows host (cmd.exe, powershell.exe, pwsh.exe, wsl.exe, bash.exe, git-bash); --command is typed into whatever shell the host started, so `--command cmd.exe` leaves a cmd running INSIDE the default shell and exiting it drops back to that shell.',
    'A host that cannot apply --shell refuses the create rather than quietly spawning its default shell: macOS and Linux execution hosts spawn the login shell, terminals routed over SSH resolve their shell on the SSH host, a --shell that contradicts the project execution runtime (WSL vs Windows host) is refused, and an Orca host older than --shell is refused by the CLI.'
  ],
  examples: [
    'orca terminal create --json',
    'orca terminal create --worktree active --command "codex" --json',
    'orca terminal create --worktree active --agent trae --agent-args "exec --json -" --model gpt-5.5 --effort xhigh --backend-variant max --json',
    'orca terminal create --worktree path:/projects/myapp --title "RUNNER" --command "opencode"',
    'orca terminal create --worktree path:/projects/myapp --command "opencode" --focus',
    'orca terminal create --worktree path:C:/src/app --shell cmd.exe --json'
  ]
}

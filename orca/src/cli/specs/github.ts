import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const GITHUB_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['github', 'create-issue'],
    summary: "Create a GitHub issue through Orca's GitHub account",
    usage:
      'orca github create-issue --repo <repo-selector> --title <title> [--body <text> | --body-file <path|->] [--label <label>]... [--assignee <user>]... [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'repo', 'title', 'body', 'body-file', 'label', 'assignee'],
    repeatableFlags: ['assignee'],
    examples: [
      'orca github create-issue --repo id:repo-1 --title "Investigate flaky login" --body "Steps to reproduce"',
      'orca github create-issue --repo path:/repo --title "Follow-up bug" --body-file - --label bug --json'
    ],
    notes: [
      'Uses the GitHub account Orca manages, so it works without a gh login on the current shell.',
      'Exits non-zero when the GitHub API rejects the issue.'
    ]
  }
]

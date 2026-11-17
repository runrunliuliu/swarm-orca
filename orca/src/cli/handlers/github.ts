import type { GitHubCreateIssueResult } from '../../shared/issue-mutation-types'
import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import { getRepeatedStringFlag, getRequiredStringFlag } from '../flags'
import { readLinearBody } from '../linear-request-builders'

const CREATE_ISSUE_TIMEOUT_MS = 60_000

export const GITHUB_HANDLERS: Record<string, CommandHandler> = {
  'github create-issue': async ({ flags, client, cwd, json }) => {
    const repo = getRequiredStringFlag(flags, 'repo')
    const title = getRequiredStringFlag(flags, 'title')
    const body = await readLinearBody(flags, cwd, { required: false })
    const labels = getRepeatedStringFlag(flags, 'label')
    const assignees = getRepeatedStringFlag(flags, 'assignee')
    const response = await client.call<GitHubCreateIssueResult>(
      'github.createIssue',
      {
        repo,
        title,
        body: body ?? '',
        ...(labels.length > 0 ? { labels } : {}),
        ...(assignees.length > 0 ? { assignees } : {})
      },
      { timeoutMs: CREATE_ISSUE_TIMEOUT_MS }
    )
    printResult(response, json, formatGithubCreateIssue)
    if (!response.result.ok) {
      process.exitCode = 1
    }
  }
}

function formatGithubCreateIssue(result: GitHubCreateIssueResult): string {
  if (!result.ok) {
    return `GitHub issue not created: ${result.error}`
  }
  const warning = result.bodySaveWarning ? `\nwarning: ${result.bodySaveWarning}` : ''
  return `Created GitHub issue #${result.number}: ${result.url}${warning}`
}

import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { Worktree } from '../../shared/worktree/types'
import { normalizeLinkedIssueContextSnapshot } from '../../shared/linked-issue-context-snapshot'

type LinkedWorkItemMetadata = Pick<
  Worktree,
  | 'linkedGitLabMR'
  | 'linkedGitLabIssue'
  | 'linkedBitbucketPR'
  | 'linkedAzureDevOpsPR'
  | 'linkedGiteaPR'
  | 'linkedWorkItem'
  | 'linkedTaskSourceContext'
  | 'linkedIssueContext'
>

export function getLinkedWorkItemMetadata(meta: WorktreeMeta | undefined): LinkedWorkItemMetadata {
  return {
    linkedGitLabMR: meta?.linkedGitLabMR ?? null,
    linkedGitLabIssue: meta?.linkedGitLabIssue ?? null,
    linkedBitbucketPR: meta?.linkedBitbucketPR ?? null,
    linkedAzureDevOpsPR: meta?.linkedAzureDevOpsPR ?? null,
    linkedGiteaPR: meta?.linkedGiteaPR ?? null,
    linkedWorkItem: meta?.linkedWorkItem ?? null,
    linkedTaskSourceContext: meta?.linkedTaskSourceContext ?? null,
    // Why still projected as null: readers gate the whole feature on a snapshot existing, and a
    // renderer that received `undefined` would have to spell out both absences at every call site.
    linkedIssueContext: normalizeLinkedIssueContextSnapshot(meta?.linkedIssueContext)
  }
}

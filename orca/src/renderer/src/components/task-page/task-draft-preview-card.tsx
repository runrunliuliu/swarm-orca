import React from 'react'
import { LoaderCircle } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { translate } from '@/i18n/i18n'
import type { TaskDraftProvider } from '@/lib/task-draft-issue-create'

import type { TaskDockDraftModel } from './TaskDock'

export function TaskDraftPreviewCard({
  draft,
  provider
}: {
  draft: TaskDockDraftModel
  provider: TaskDraftProvider | null
}): React.JSX.Element | null {
  if (draft.state === 'idle') {
    return null
  }

  const spinner = <LoaderCircle className="size-3.5 animate-spin" />
  let content: React.ReactNode

  switch (draft.state) {
    case 'no-context':
      content = (
        <p className="text-sm text-destructive">
          {translate(
            'auto.components.TaskPage.taskDraftNoContext',
            'Pick a source and a repository.'
          )}
        </p>
      )
      break
    case 'creating-draft':
      content = (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          {spinner}
          {translate('auto.components.TaskPage.taskDraftCreatingDraft', 'Creating the draft…')}
        </p>
      )
      break
    case 'draft-failed':
      content = (
        <>
          <h3 className="text-sm font-medium">
            {translate(
              'auto.components.TaskPage.taskDraftCreateFailed',
              'Could not create the draft.'
            )}
          </h3>
          <Button type="button" variant="outline" size="sm" onClick={draft.onRetry}>
            {translate('auto.components.TaskPage.taskDraftRetry', 'Try again')}
          </Button>
        </>
      )
      break
    case 'agent-launch-failed':
      content = (
        <>
          <h3 className="text-sm font-medium">
            {translate(
              'auto.components.TaskPage.taskDraftAgentLaunchFailed',
              'The agent could not start.'
            )}
          </h3>
          <Button type="button" variant="outline" size="sm" onClick={draft.onRetry}>
            {translate('auto.components.TaskPage.taskDraftRetryAgent', 'Retry agent')}
          </Button>
        </>
      )
      break
    case 'drafting':
      content = (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          {spinner}
          {translate('auto.components.TaskPage.taskDraftDrafting', 'Drafting the task…')}
        </p>
      )
      break
    case 'preview-ready':
      content =
        draft.proposal === null ? null : (
          <>
            <div className="space-y-2">
              <h3 className="text-sm font-medium">{draft.proposal.title}</h3>
              <p data-testid="task-draft-preview-body" className="whitespace-pre-wrap text-sm">
                {draft.proposal.body}
              </p>
              {draft.proposal.labels.length === 0 ? null : (
                <div className="flex flex-wrap gap-1">
                  {draft.proposal.labels.map((label) => (
                    <Badge key={label} variant="secondary">
                      {label}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" size="sm" onClick={draft.onConfirmCreate}>
                {translate('auto.components.TaskPage.taskDraftCreateIssue', 'Create issue')}
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={draft.onCancelPreview}>
                {translate('auto.components.TaskPage.taskDraftCancelPreview', 'Cancel')}
              </Button>
              {provider === 'github' ? (
                <Button type="button" variant="ghost" size="sm" onClick={draft.onChooseGhFallback}>
                  {translate('auto.components.TaskPage.taskDraftUseGhInstead', 'Use gh instead')}
                </Button>
              ) : null}
            </div>
          </>
        )
      break
    case 'creating-issue':
      content = (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          {spinner}
          {translate('auto.components.TaskPage.taskDraftCreatingIssue', 'Creating the issue…')}
        </p>
      )
      break
    case 'issue-created-link-failed':
      content = (
        <>
          <p className="text-sm">
            {draft.createdIssueNumber === null
              ? translate(
                  'auto.components.TaskPage.taskDraftIssueCreatedLinkFailedUnknown',
                  'The issue was created, but the link was not saved.'
                )
              : translate(
                  'auto.components.TaskPage.taskDraftIssueCreatedLinkFailed',
                  'Issue #{{value0}} was created, but the link was not saved.',
                  { value0: draft.createdIssueNumber }
                )}
          </p>
          <Button type="button" variant="link" size="sm" onClick={draft.onRetry}>
            {translate('auto.components.TaskPage.taskDraftRetryLink', 'Retry link')}
          </Button>
        </>
      )
      break
    case 'provider-rejected':
      content = (
        <>
          <h3 className="text-sm font-medium">
            {translate(
              'auto.components.TaskPage.taskDraftProviderRejected',
              'The provider rejected the issue.'
            )}
          </h3>
          {draft.providerError === null ? null : (
            <p className="text-sm text-destructive">{draft.providerError}</p>
          )}
          <Button type="button" variant="outline" size="sm" onClick={draft.onRetry}>
            {translate('auto.components.TaskPage.taskDraftEditAndRetry', 'Edit and retry')}
          </Button>
        </>
      )
      break
    case 'duplicate-suspected':
      content = (
        <>
          <h3 className="text-sm font-medium">
            {translate(
              'auto.components.TaskPage.taskDraftDuplicateSuspected',
              'A similar issue already exists.'
            )}
          </h3>
          {draft.duplicateCheckUnavailable ? (
            <p className="text-sm text-muted-foreground">
              {translate(
                'auto.components.TaskPage.taskDraftDuplicateCheckUnavailable',
                'Could not check for duplicates.'
              )}
            </p>
          ) : null}
          <div className="space-y-2">
            {draft.duplicates.map((candidate) => (
              <div key={candidate.url} className="flex items-center justify-between gap-3 text-sm">
                <span>
                  #{candidate.number} {candidate.title}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => draft.onReuseCandidate(candidate)}
                >
                  {translate('auto.components.TaskPage.taskDraftReuseCandidate', 'Reuse')}
                </Button>
              </div>
            ))}
          </div>
          <Button type="button" size="sm" onClick={draft.onCreateAnyway}>
            {translate('auto.components.TaskPage.taskDraftCreateAnyway', 'Still create')}
          </Button>
        </>
      )
      break
    case 'remote-unsupported':
      content = (
        <p className="text-sm">
          {translate(
            'auto.components.TaskPage.taskDraftRemoteUnsupported',
            'Creating issues needs a local repository.'
          )}
        </p>
      )
      break
    case 'cancelled':
      content = (
        <>
          <div className="space-y-1 text-sm">
            <p>
              {translate(
                'auto.components.TaskPage.taskDraftCancelled',
                'The draft was not created.'
              )}
            </p>
            <p className="text-muted-foreground">
              {translate('auto.components.TaskPage.taskDraftKept', 'Your draft is kept.')}
            </p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={draft.onRetry}>
            {translate('auto.components.TaskPage.taskDraftContinue', 'Continue drafting')}
          </Button>
        </>
      )
      break
    case 'agent-crashed':
      content = (
        <>
          <p className="text-sm">
            {translate(
              'auto.components.TaskPage.taskDraftAgentCrashed',
              'The agent exited before producing a preview.'
            )}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={draft.onReopenAgent}>
            {translate('auto.components.TaskPage.taskDraftReopenAgent', 'Reopen agent')}
          </Button>
        </>
      )
      break
    case 'outcome-unknown':
      content = (
        <>
          <h3 className="text-sm font-medium">
            {translate('auto.components.TaskPage.taskDraftOutcomeUnknownTitle', 'Outcome unknown.')}
          </h3>
          <p className="text-sm text-muted-foreground">
            {translate(
              'auto.components.TaskPage.taskDraftOutcomeUnknownDetail',
              'The provider may have created the issue, so this draft will not create another. Check the target, then link or delete this draft.'
            )}
          </p>
        </>
      )
      break
    case 'archived':
      content = (
        <p className="text-sm text-muted-foreground">
          {translate('auto.components.TaskPage.taskDraftArchived', 'This draft is archived.')}
        </p>
      )
      break
  }

  return <Card data-testid={`task-draft-state-${draft.state}`}>{content}</Card>
}

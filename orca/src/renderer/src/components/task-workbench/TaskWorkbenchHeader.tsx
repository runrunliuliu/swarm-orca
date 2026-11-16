import React from 'react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { TaskProviderIdentity } from '../../../../shared/task-provider-identity'
import type { DeliveryEvidence, TaskWorkbenchView, TaskWorkbenchWorkspace } from './task-workbench-view'

/**
 * The workbench header: title, identity (tracker provider or the `◇` no-tracker
 * badge), the workspace it would open, the PR summary when evidence exists, and
 * the primary action.
 *
 * Identity rules it must not blur (README §7.2/§7.3.1, F6):
 * - A tracker identity names its provider; a workspace identity never pretends
 *   to have one and carries the `◇` badge instead.
 * - No PR evidence means no PR affordance at all.
 * - The primary action is absent at 0 workspaces: the Panel's empty state owns
 *   that CTA, and one screen must not show two identical actions.
 */

function headerKeys(key: string): string {
  return `auto.components.TaskWorkbenchHeader.${key}`
}

/** Provider names are product names, like the `SSH`/`WSL` labels elsewhere:
 *  they are not prose and stay untranslated in every locale. */
function providerName(identity: TaskProviderIdentity): string {
  switch (identity.provider) {
    case 'github':
      return 'GitHub'
    case 'gitlab':
      return 'GitLab'
    case 'linear':
      return 'Linear'
    case 'jira':
      return 'Jira'
  }
}

/** The most specific project handle the identity carries, or null when it only
 *  names an account. Data, not copy: it is rendered verbatim. */
function providerDetail(identity: TaskProviderIdentity): string | null {
  switch (identity.provider) {
    case 'github':
      return `${identity.owner}/${identity.repo}`
    case 'gitlab': {
      const project = [identity.namespace, identity.project].filter(Boolean).join('/')
      return project || identity.projectId || null
    }
    case 'linear':
      return identity.teamKey ?? identity.workspaceName ?? null
    case 'jira':
      return identity.projectKey ?? identity.siteUrl ?? null
  }
}

const PULL_REQUEST_STATE_COPY: Record<
  NonNullable<DeliveryEvidence['pullRequest']>['state'],
  string
> = {
  draft: 'draft',
  open: 'open',
  merged: 'merged',
  closed: 'closed'
}

/** The workspace the header names: the default when it resolves, else the first
 *  active one, else the first known one. Archived-only views still have an
 *  identity to show (F5). */
function headerWorkspace(view: TaskWorkbenchView): TaskWorkbenchWorkspace | undefined {
  const { workspaceId, source } = view.defaultWorkspace
  if (source !== 'none') {
    const chosen = view.workspaces.find((workspace) => workspace.worktreeId === workspaceId)
    if (chosen) {
      return chosen
    }
  }
  return view.workspaces.find((workspace) => workspace.archived !== true) ?? view.workspaces[0]
}

function TrackerIdentity({ view }: { view: TaskWorkbenchView }): React.JSX.Element | null {
  if (view.identity.kind !== 'tracker') {
    return null
  }
  const detail = providerDetail(view.identity.provider)
  return (
    <span
      data-testid="task-workbench-header-provider"
      className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground"
    >
      <span className="shrink-0 font-medium text-foreground">
        {providerName(view.identity.provider)}
      </span>
      {detail === null ? null : <span className="min-w-0 truncate">{detail}</span>}
      {view.tracker ? (
        <Badge variant="outline" className="shrink-0">
          {translate(
            headerKeys(`trackerState.${view.tracker.state}`),
            view.tracker.state === 'open' ? 'open' : 'closed'
          )}
        </Badge>
      ) : null}
    </span>
  )
}

function WorkspaceIdentityBadge(): React.JSX.Element {
  return (
    <Badge
      data-testid="task-workbench-header-local-badge"
      variant="outline"
      className="shrink-0"
    >
      <span aria-hidden="true">◇</span>
      {translate(headerKeys('noTracker'), 'No tracker')}
    </Badge>
  )
}

function BranchIdentity({ workspace }: { workspace: TaskWorkbenchWorkspace }): React.JSX.Element {
  return (
    // Why the workspace pair and not `base → branch`: DashboardWorkspace carries
    // `repoName`/`worktreeName` only, so P1a names the workspace it would open;
    // P1b adds the base SHA and branch to the view before this can show them.
    <span
      data-testid="task-workbench-header-branch"
      className="flex min-w-0 items-baseline gap-1.5"
    >
      <span aria-hidden="true" className="shrink-0 text-muted-foreground">
        ▦
      </span>
      <span className="min-w-0 truncate">
        {workspace.repoName}
        <span className="mx-1 text-muted-foreground/60">·</span>
        {workspace.worktreeName}
      </span>
    </span>
  )
}

function PullRequestSummary({ view }: { view: TaskWorkbenchView }): React.JSX.Element | null {
  const pullRequest = view.delivery?.pullRequest
  if (!pullRequest) {
    return null
  }
  return (
    <span
      data-testid="task-workbench-header-pr"
      className="flex min-w-0 items-center gap-1 text-xs"
    >
      <span className="shrink-0 tabular-nums text-muted-foreground">
        {translate(headerKeys('pullRequestNumber'), 'PR #{{value0}}', {
          value0: String(pullRequest.number)
        })}
      </span>
      <span className="shrink-0 rounded-full border border-border/60 px-1.5 py-0.5 text-[11px]">
        {translate(
          headerKeys(`pullRequestState.${pullRequest.state}`),
          PULL_REQUEST_STATE_COPY[pullRequest.state]
        )}
      </span>
    </span>
  )
}

export function TaskWorkbenchHeader({ view }: { view: TaskWorkbenchView }): React.JSX.Element {
  useTranslation()
  const workspace = headerWorkspace(view)
  // Contract amendment (2026-11-16): 0 workspaces has no header primary action;
  // the Panel empty state's `Create workspace` is the only CTA on that screen.
  const hasWorkspaces = view.workspaces.length > 0

  return (
    <header data-testid="task-workbench-header" className="flex flex-col gap-1.5">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <h2
          data-testid="task-workbench-header-title"
          className="min-w-0 truncate text-base font-semibold"
          title={view.title}
        >
          {view.title}
        </h2>
        {view.identity.kind === 'tracker' ? <TrackerIdentity view={view} /> : <WorkspaceIdentityBadge />}
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {workspace ? <BranchIdentity workspace={workspace} /> : null}
        <PullRequestSummary view={view} />
        {/* 1 and N share the label: multiple workspaces open the default, and the
            chip set that picks another one belongs to the Workspaces section. */}
        {hasWorkspaces ? (
          <Button
            type="button"
            size="sm"
            data-testid="task-workbench-header-primary-action"
            className="ml-auto shrink-0"
          >
            {translate(headerKeys('openWorkspace'), 'Open workspace')}
          </Button>
        ) : null}
      </div>
    </header>
  )
}

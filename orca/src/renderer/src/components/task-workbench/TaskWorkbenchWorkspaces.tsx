import React from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type {
  TaskWorkbenchLayout,
  TaskWorkbenchView,
  TaskWorkbenchWorkspace
} from './task-workbench-view'

/**
 * The workspace cards of the workbench: 0..N identities, the `Create workspace`
 * primary action and the default marker.
 *
 * Two things this component refuses to do (README §7.3.1, §7.5):
 * - Sacrifice the identity or the CTA at any size. The smallest form is one
 *   summary row, never a menu.
 * - Present "recent activity" as a user's choice. `defaultWorkspace.source` is
 *   rendered, and the two words are visibly different.
 */

function workspacesKeys(key: string): string {
  return `auto.components.TaskWorkbenchWorkspaces.${key}`
}

/** Worktree ids are only unique per repository, so the row key carries both. */
function workspaceKey(workspace: TaskWorkbenchWorkspace): string {
  return `${workspace.repoId}:${workspace.worktreeId}`
}

function hostKindLabel(hostKind: TaskWorkbenchWorkspace['hostKind']): string {
  switch (hostKind) {
    case 'local':
      return translate(workspacesKeys('host.local'), 'local')
    case 'ssh':
      // Protocol names, not prose: they stay untranslated in every locale.
      return 'SSH'
    case 'wsl':
      return 'WSL'
    case 'remote':
      return translate(workspacesKeys('host.remote'), 'remote')
  }
}

/** The default marker is the one card-level claim a reader may act on, so the
 *  two sources get different words: a filled `Default` chip can only come from an
 *  explicit choice, while an inferred one says where it came from. */
function DefaultMarker({
  source
}: {
  source: TaskWorkbenchView['defaultWorkspace']['source']
}): React.JSX.Element {
  if (source === 'recent-activity') {
    return (
      // Why the wrapper: <Badge> owns its own color and typography, so the
      // "inferred" treatment is applied to the parent instead of restyling it.
      <span className="shrink-0 italic text-muted-foreground">
        <Badge data-testid="task-workbench-workspace-card-default" variant="outline">
          {translate(workspacesKeys('defaultFromActivity'), 'Default · recent activity')}
        </Badge>
      </span>
    )
  }
  return (
    <Badge
      data-testid="task-workbench-workspace-card-default"
      variant="secondary"
      className="shrink-0"
    >
      {translate(workspacesKeys('defaultExplicit'), 'Default')}
    </Badge>
  )
}

function WorkspaceIdentity({
  workspace
}: {
  workspace: TaskWorkbenchWorkspace
}): React.JSX.Element {
  return (
    <span className="flex min-w-0 items-baseline gap-1.5">
      <span aria-hidden="true" className="shrink-0 text-muted-foreground">
        ▦
      </span>
      <span className="min-w-0 truncate font-medium">
        {workspace.repoName}
        <span className="mx-1 text-muted-foreground/60">·</span>
        {workspace.worktreeName}
      </span>
    </span>
  )
}

function WorkspaceCard({
  workspace,
  isDefault,
  defaultSource
}: {
  workspace: TaskWorkbenchWorkspace
  isDefault: boolean
  defaultSource: TaskWorkbenchView['defaultWorkspace']['source']
}): React.JSX.Element {
  const isRemote = workspace.hostKind !== 'local'
  const archivedFlag = workspace.archived === true ? 'true' : undefined
  return (
    <Card data-testid="task-workbench-workspace-card" data-archived={archivedFlag}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <WorkspaceIdentity workspace={workspace} />
        {isDefault ? <DefaultMarker source={defaultSource} /> : null}
        {workspace.archived === true ? (
          <Badge variant="outline" className="shrink-0">
            {translate(workspacesKeys('archived'), 'Archived')}
          </Badge>
        ) : null}
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <Badge variant="hostContext" className="shrink-0">
          {workspace.hostLabel ?? hostKindLabel(workspace.hostKind)}
        </Badge>
        {workspace.workspaceKind === 'folder' ? (
          <span className="shrink-0">{translate(workspacesKeys('kind.folder'), 'folder')}</span>
        ) : null}
        {workspace.workspaceStatusLabel ? (
          <span className="flex min-w-0 items-center gap-1">
            <span
              aria-hidden="true"
              className="size-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: workspace.workspaceStatusColor }}
            />
            <span className="min-w-0 truncate">{workspace.workspaceStatusLabel}</span>
          </span>
        ) : null}
        {workspace.review ? (
          <span className="shrink-0 tabular-nums">
            {translate(workspacesKeys('reviewNumber'), 'PR #{{value0}}', {
              value0: String(workspace.review.number)
            })}
          </span>
        ) : null}
        {/* Why: a remote workspace's usage and actions cannot work on the local
            host; saying so once beats a row of controls that silently fail. */}
        {isRemote ? (
          <span className="shrink-0">
            {translate(workspacesKeys('remoteHint'), 'Remote host · usage and actions stay local')}
          </span>
        ) : null}
      </div>
    </Card>
  )
}

function CreateWorkspaceButton({ className }: { className?: string }): React.JSX.Element {
  return (
    // P1a is a static shell: the action is focusable and typed, but it opens
    // nothing until P1b wires it to a workspace creation flow.
    <Button
      type="button"
      size="xs"
      data-testid="task-workbench-workspaces-create"
      className={cn('shrink-0', className)}
    >
      {translate(workspacesKeys('create'), 'Create workspace')}
    </Button>
  )
}

function ToggleButton({
  testId,
  expanded,
  controls,
  onToggle,
  label
}: {
  testId: string
  expanded: boolean
  controls: string
  onToggle: () => void
  label: string
}): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      data-testid={testId}
      aria-expanded={expanded}
      aria-controls={controls}
      onClick={onToggle}
      className="self-start"
    >
      {label}
      <ChevronDown
        aria-hidden="true"
        className={cn('size-3.5 transition-transform', expanded && 'rotate-180')}
      />
    </Button>
  )
}

export function TaskWorkbenchWorkspaces({
  view,
  layout
}: {
  view: TaskWorkbenchView
  layout: TaskWorkbenchLayout
}): React.JSX.Element | null {
  useTranslation()
  const [secondaryOpen, setSecondaryOpen] = React.useState(false)

  const active = view.workspaces.filter((workspace) => workspace.archived !== true)
  const archived = view.workspaces.filter((workspace) => workspace.archived === true)
  // Why open by default only when nothing else is active: an archived-only task
  // (F5) would otherwise render a Workspaces section with no workspace card in
  // it at all. With any active workspace the group stays folded, so an archived
  // one never looks active (README §7.5, contract §4.3).
  const [archivedOpen, setArchivedOpen] = React.useState(
    active.length === 0 && archived.length > 0
  )
  const defaultSource = view.defaultWorkspace.source
  const defaultId = defaultSource === 'none' ? null : view.defaultWorkspace.workspaceId
  const defaultWorkspace = view.workspaces.find((workspace) => workspace.worktreeId === defaultId)
  // The anchor of the list is the default when it is active, otherwise the first
  // active one: an archived workspace can never head the active list.
  const anchor = active[0] ?? null
  const primary =
    defaultWorkspace !== undefined && defaultWorkspace.archived !== true ? defaultWorkspace : anchor
  const secondary = active.filter((workspace) => workspace !== primary)
  // Contract §4.3: the default marker is present iff the default workspace
  // resolves and is not archived, so an archived workspace never carries it.
  const primaryIsDefault = primary !== null && primary === defaultWorkspace
  // Contract §4.3: more than two workspaces means the rest wait behind a toggle.
  const collapseSecondary = view.workspaces.length > 2 && secondary.length > 0

  // Why nothing at all: the Panel owns the 0-workspace empty state and its primary
  // action, and one `Create workspace` per screen is the rule. A second CTA here
  // would render two buttons with the same testid.
  if (layout.workspaces === 'empty' || view.workspaces.length === 0) {
    return null
  }

  if (layout.workspaces === 'compact') {
    const others = primary === null ? 0 : Math.max(active.length - 1, 0)
    return (
      <section
        data-testid="task-workbench-workspaces"
        className="flex flex-col gap-1 rounded-lg border border-border/60 bg-card/40 px-3 py-2"
      >
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          {primary ? (
            <>
              <WorkspaceIdentity workspace={primary} />
              {primaryIsDefault ? <DefaultMarker source={defaultSource} /> : null}
            </>
          ) : (
            <span className="text-muted-foreground">
              {translate(workspacesKeys('noActive'), 'No active workspace')}
            </span>
          )}
          {others > 0 ? (
            <span className="shrink-0 text-muted-foreground">
              {translate(workspacesKeys('moreWorkspaces'), '+{{value0}} more', {
                value0: String(others)
              })}
            </span>
          ) : null}
          <CreateWorkspaceButton className="ml-auto" />
        </div>
        {archived.length > 0 ? (
          <div className="flex flex-col gap-1 text-xs text-muted-foreground">
            <ToggleButton
              testId="task-workbench-workspaces-archived-toggle"
              expanded={archivedOpen}
              controls="task-workbench-workspaces-archived"
              onToggle={() => setArchivedOpen(!archivedOpen)}
              label={translate(workspacesKeys('showArchived'), 'Show archived ({{value0}})', {
                value0: String(archived.length)
              })}
            />
            {archivedOpen ? (
              <ul id="task-workbench-workspaces-archived" className="flex flex-wrap gap-x-2">
                {archived.map((workspace) => (
                  <li key={workspaceKey(workspace)} className="truncate">
                    {workspace.worktreeName}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </section>
    )
  }

  return (
    <section data-testid="task-workbench-workspaces" className="flex flex-col gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {translate(workspacesKeys('heading'), 'Workspaces')}
        </span>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {translate(workspacesKeys('workspaceCount'), '{{value0}} total', {
            value0: String(view.workspaces.length)
          })}
        </span>
        <CreateWorkspaceButton className="ml-auto" />
      </div>

      <div className="flex flex-col gap-2">
        {primary ? (
          <WorkspaceCard
            workspace={primary}
            isDefault={primaryIsDefault}
            defaultSource={defaultSource}
          />
        ) : null}

        {collapseSecondary
          ? null
          : secondary.map((workspace) => (
              <WorkspaceCard
                key={workspaceKey(workspace)}
                workspace={workspace}
                isDefault={false}
                defaultSource={defaultSource}
              />
            ))}

        {collapseSecondary ? (
          <ToggleButton
            testId="task-workbench-workspaces-secondary-toggle"
            expanded={secondaryOpen}
            controls="task-workbench-workspaces-secondary"
            onToggle={() => setSecondaryOpen(!secondaryOpen)}
            label={translate(workspacesKeys('showMore'), 'Show {{value0}} more workspaces', {
              value0: String(secondary.length)
            })}
          />
        ) : null}

        {collapseSecondary && secondaryOpen ? (
          <div
            id="task-workbench-workspaces-secondary"
            className="flex flex-col gap-2"
          >
            {secondary.map((workspace) => (
              <WorkspaceCard
                key={workspaceKey(workspace)}
                workspace={workspace}
                isDefault={false}
                defaultSource={defaultSource}
              />
            ))}
          </div>
        ) : null}
      </div>

      {archived.length > 0 ? (
        <div className="flex flex-col gap-2">
          <ToggleButton
            testId="task-workbench-workspaces-archived-toggle"
            expanded={archivedOpen}
            controls="task-workbench-workspaces-archived"
            onToggle={() => setArchivedOpen(!archivedOpen)}
            label={translate(workspacesKeys('showArchived'), 'Show archived ({{value0}})', {
              value0: String(archived.length)
            })}
          />
          {archivedOpen ? (
            <ul id="task-workbench-workspaces-archived" className="flex flex-col gap-2">
              {archived.map((workspace) => (
                <li key={workspaceKey(workspace)} className="flex flex-col">
                  <WorkspaceCard
                    workspace={workspace}
                    isDefault={false}
                    defaultSource={defaultSource}
                  />
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

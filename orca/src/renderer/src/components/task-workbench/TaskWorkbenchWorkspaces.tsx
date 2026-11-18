import React from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { TaskWorkbenchSectionHeading } from './task-workbench-section-heading'
import type {
  TaskWorkbenchLayout,
  TaskWorkbenchView,
  TaskWorkbenchWorkspace
} from './task-workbench-view'

/**
 * The workspaces section: 0..N identities, the `Create workspace` action and the
 * default marker, as rows inside one surface (README §7.4.2).
 *
 * Three things this component refuses to do (README §7.3.1, §7.5):
 * - Sacrifice the identity or the CTA at any size. The smallest form is one
 *   summary row, never a menu.
 * - Present "recent activity" as a user's choice. `defaultWorkspace.source` is
 *   rendered, and the two words are visibly different.
 * - Name a workspace by its display name. Orca names a generated worktree after
 *   the task title, so `repo · displayName` printed the page's h1 again; the row
 *   names the branch instead and falls back to the display name only when the
 *   row carries no branch (a folder workspace).
 *
 * Why rows and not cards: a `<Card>` here is `py-6` with no horizontal padding, so
 * the content touched the border and the default badge hung outside the rounded
 * corner. One surface with `inset` separators also makes the section's density
 * match the agents section instead of contradicting it.
 */

function workspacesKeys(key: string): string {
  return `auto.components.TaskWorkbenchWorkspaces.${key}`
}

/** P1b owns workspace creation. Until it is wired the action renders disabled
 *  rather than looking live (README §7.4.2 取舍 3). */
const NOT_WIRED = 'Not wired in this build yet'

/** Worktree ids are only unique per repository, so the row key carries both. */
function workspaceKey(workspace: TaskWorkbenchWorkspace): string {
  return `${workspace.repoId}:${workspace.worktreeId}`
}

/** The one name a workspace row may print: the branch when the store row has one,
 *  else the display name it always had (README §7.4.2 取舍 2). */
function workspaceLabel(workspace: TaskWorkbenchWorkspace): string {
  return workspace.branchName ?? workspace.worktreeName
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

/** The default marker is the one row-level claim a reader may act on, so the two
 *  sources get different words: a filled chip can only come from an explicit
 *  choice, while an inferred one says where it came from. No italic: the heading
 *  rule for CJK forbids it, and this is prose in Chinese too. */
function DefaultMarker({
  source
}: {
  source: TaskWorkbenchView['defaultWorkspace']['source']
}): React.JSX.Element {
  if (source === 'recent-activity') {
    return (
      <Badge data-testid="task-workbench-workspace-card-default" variant="outline">
        {translate(workspacesKeys('defaultFromActivity'), 'Default · recent activity')}
      </Badge>
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

function WorkspaceRow({
  workspace,
  isDefault,
  defaultSource
}: {
  workspace: TaskWorkbenchWorkspace
  isDefault: boolean
  defaultSource: TaskWorkbenchView['defaultWorkspace']['source']
}): React.JSX.Element {
  const archivedFlag = workspace.archived === true ? 'true' : undefined
  const hostLabel = workspace.hostLabel ?? hostKindLabel(workspace.hostKind)
  return (
    <div
      data-testid="task-workbench-workspace-card"
      data-archived={archivedFlag}
      className="flex min-w-0 items-center gap-2 px-3 py-2"
    >
      <span aria-hidden="true" className="shrink-0 text-muted-foreground">
        ▦
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px]">
        <span className="text-muted-foreground">{workspace.repoName}</span>
        <span className="mx-1.5 text-muted-foreground/60">·</span>
        <span className="font-mono text-[12.5px] text-foreground">
          {workspaceLabel(workspace)}
        </span>
      </span>

      <span className="flex shrink-0 items-center gap-1.5 text-[12px] text-muted-foreground">
        {/* Only a non-local host is worth a chip: "local" is the unmarked default
            and repeating it on every row is the noise this rework removes. */}
        {workspace.hostKind === 'local' ? null : (
          <Badge
            data-testid="task-workbench-workspace-host-chip"
            variant="hostContext"
            className="shrink-0"
          >
            {hostLabel}
          </Badge>
        )}
        {workspace.workspaceKind === 'folder' ? (
          <span className="shrink-0">{translate(workspacesKeys('kind.folder'), 'folder')}</span>
        ) : null}
        {workspace.review ? (
          <span className="shrink-0 tabular-nums">
            {translate(workspacesKeys('reviewNumber'), 'PR #{{value0}}', {
              value0: String(workspace.review.number)
            })}
          </span>
        ) : null}
        {workspace.archived === true ? (
          <Badge variant="outline" className="shrink-0">
            {translate(workspacesKeys('archived'), 'Archived')}
          </Badge>
        ) : workspace.workspaceStatusLabel ? (
          // The store's own workspace status: a user-authored label, rendered
          // verbatim (it is data, not copy), preceded by its colour swatch.
          <span className="flex min-w-0 items-center gap-1">
            <span
              aria-hidden="true"
              className="size-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: workspace.workspaceStatusColor }}
            />
            <span className="min-w-0 truncate">{workspace.workspaceStatusLabel}</span>
          </span>
        ) : null}
        {isDefault ? <DefaultMarker source={defaultSource} /> : null}
      </span>
    </div>
  )
}

function CreateWorkspaceButton(): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="outline"
      size="xs"
      disabled
      title={translate(workspacesKeys('notWired'), NOT_WIRED)}
      data-testid="task-workbench-workspaces-create"
      className="shrink-0"
    >
      {translate(workspacesKeys('create'), 'New workspace')}
    </Button>
  )
}

/** A fold inside the section's own surface: 24px quiet, aligned with the rows it
 *  reveals instead of floating as a separate control block. */
function ToggleRow({
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
    <div className="px-3 py-1">
      <Button
        type="button"
        variant="ghost"
        size="xs"
        data-testid={testId}
        aria-expanded={expanded}
        aria-controls={controls}
        onClick={onToggle}
        className="text-muted-foreground"
      >
        {label}
        <ChevronDown
          aria-hidden="true"
          className={cn('size-3.5 transition-transform', expanded && 'rotate-180')}
        />
      </Button>
    </div>
  )
}

const SURFACE = 'overflow-hidden rounded-lg bg-card/40 ring-1 ring-inset ring-border/60'
const ROW_LIST = 'flex flex-col divide-y divide-border/50'

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
  // (F5) would otherwise render a Workspaces section with no workspace row in it
  // at all. With any active workspace the group stays folded, so an archived one
  // never looks active (README §7.5, contract §4.3).
  const [archivedOpen, setArchivedOpen] = React.useState(active.length === 0 && archived.length > 0)
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
      <section data-testid="task-workbench-workspaces" className="flex flex-col gap-2">
        <TaskWorkbenchSectionHeading
          label={translate(workspacesKeys('heading'), 'Workspaces')}
          count={translate(workspacesKeys('workspaceCount'), '{{value0}}', {
            value0: String(view.workspaces.length)
          })}
          action={<CreateWorkspaceButton />}
        />
        <div className={SURFACE}>
          <div className={ROW_LIST}>
            {primary ? (
              <WorkspaceRow
                workspace={primary}
                isDefault={primaryIsDefault}
                defaultSource={defaultSource}
              />
            ) : (
              <div className="px-3 py-2 text-[12px] text-muted-foreground">
                {translate(workspacesKeys('noActive'), 'No active workspace')}
              </div>
            )}
            {others > 0 ? (
              <div className="px-3 py-1 text-[12px] text-muted-foreground">
                {translate(workspacesKeys('moreWorkspaces'), '+{{value0}} more', {
                  value0: String(others)
                })}
              </div>
            ) : null}
            {archived.length > 0 ? (
              <ToggleRow
                testId="task-workbench-workspaces-archived-toggle"
                expanded={archivedOpen}
                controls="task-workbench-workspaces-archived"
                onToggle={() => setArchivedOpen(!archivedOpen)}
                label={translate(workspacesKeys('showArchived'), 'Show archived ({{value0}})', {
                  value0: String(archived.length)
                })}
              />
            ) : null}
            {archivedOpen
              ? archived.map((workspace) => (
                  <WorkspaceRow
                    key={workspaceKey(workspace)}
                    workspace={workspace}
                    isDefault={false}
                    defaultSource={defaultSource}
                  />
                ))
              : null}
          </div>
        </div>
      </section>
    )
  }

  return (
    <section data-testid="task-workbench-workspaces" className="flex flex-col gap-2">
      <TaskWorkbenchSectionHeading
        label={translate(workspacesKeys('heading'), 'Workspaces')}
        count={translate(workspacesKeys('workspaceCount'), '{{value0}}', {
          value0: String(view.workspaces.length)
        })}
        action={<CreateWorkspaceButton />}
      />

      <div className={SURFACE}>
        <div className={ROW_LIST}>
          {primary ? (
            <WorkspaceRow
              workspace={primary}
              isDefault={primaryIsDefault}
              defaultSource={defaultSource}
            />
          ) : null}

          {collapseSecondary
            ? null
            : secondary.map((workspace) => (
                <WorkspaceRow
                  key={workspaceKey(workspace)}
                  workspace={workspace}
                  isDefault={false}
                  defaultSource={defaultSource}
                />
              ))}

          {collapseSecondary ? (
            <ToggleRow
              testId="task-workbench-workspaces-secondary-toggle"
              expanded={secondaryOpen}
              controls="task-workbench-workspaces-secondary"
              onToggle={() => setSecondaryOpen(!secondaryOpen)}
              label={translate(workspacesKeys('showMore'), 'Show {{value0}} more workspaces', {
                value0: String(secondary.length)
              })}
            />
          ) : null}
        </div>

        {collapseSecondary && secondaryOpen ? (
          <div id="task-workbench-workspaces-secondary" className={ROW_LIST}>
            {secondary.map((workspace) => (
              <WorkspaceRow
                key={workspaceKey(workspace)}
                workspace={workspace}
                isDefault={false}
                defaultSource={defaultSource}
              />
            ))}
          </div>
        ) : null}

        {archived.length > 0 ? (
          <div className={ROW_LIST}>
            <ToggleRow
              testId="task-workbench-workspaces-archived-toggle"
              expanded={archivedOpen}
              controls="task-workbench-workspaces-archived"
              onToggle={() => setArchivedOpen(!archivedOpen)}
              label={translate(workspacesKeys('showArchived'), 'Show archived ({{value0}})', {
                value0: String(archived.length)
              })}
            />
            {archivedOpen ? (
              <div id="task-workbench-workspaces-archived" className={ROW_LIST}>
                {archived.map((workspace) => (
                  <WorkspaceRow
                    key={workspaceKey(workspace)}
                    workspace={workspace}
                    isDefault={false}
                    defaultSource={defaultSource}
                  />
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  )
}

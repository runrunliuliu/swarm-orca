import React from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { TaskWorkbenchPendingAction } from './task-workbench-pending-action'
import {
  HistoryGapList,
  HistoryResumeAction,
  pendingHistoryAction
} from './task-workbench-history-actions'
import { HistoryFactsLine } from './task-workbench-history-facts'
import { RecordSourceNotice } from './task-workbench-record-source-notice'
import { formatClock } from './task-workbench-history-format'
import type {
  AgentOutcome,
  TaskWorkbenchHistoryRun,
  TaskWorkbenchHistorySession,
  TaskWorkbenchHistoryWorkspace,
  TaskWorkbenchLayout,
  TaskWorkbenchTraceState,
  TaskWorkbenchView
} from './task-workbench-view'

/**
 * The run-history strip (issue #31): what a task can still say about work it
 * already ran after its workspace stopped being an active one.
 *
 * Why it exists instead of the 0-workspace empty state: that state made two
 * claims at once — "never started" and "you may create a workspace now" — and
 * both were wrong for a closed task whose workspace was archived or deleted.
 * The strip states only facts, and the absences stay absent: an unknown agent
 * count is `agents unknown`, an unavailable token figure is `tokens unknown`,
 * and the wall clock says whether it was measured.
 *
 * Why the archived form still shows the normal sections while the deleted form
 * does not: an archived worktree is still on this machine, so its agent rows and
 * workspace row exist. A deleted one has no row left to read, so the strip
 * carries its own run list and says the trace is out of reach.
 */

function historyKeys(key: string): string {
  return `auto.components.TaskWorkbenchHistory.${key}`
}

const OUTCOME_COPY: Record<AgentOutcome, string> = {
  success: 'delivered',
  failure: 'failed',
  cancellation: 'cancelled'
}

/** The run rows, exported because the Agents section lists the same rows while
 *  the workspace is still live: a closed pane's run lives in the record, and one
 *  row renderer keeps the two surfaces from drifting (issue #53 follow-up). */
export function HistoryRunList({
  runs
}: {
  runs: readonly TaskWorkbenchHistoryRun[]
}): React.JSX.Element {
  return (
    <ul
      data-testid="task-workbench-history-runs"
      className="flex flex-col divide-y divide-border/50 overflow-hidden rounded-lg ring-1 ring-inset ring-border/60"
    >
      {runs.map((run) => (
        <RunRow key={run.key} run={run} />
      ))}
    </ul>
  )
}

/** `missing` and `unverifiable` both mean the reader cannot open the trace, but
 *  only the first is a statement about the file: a host that could not look must
 *  never be printed as "gone" (issue #53 A3). */
function traceUnreachableCopy(trace: TaskWorkbenchTraceState): string {
  return trace.presence === 'missing'
    ? translate(historyKeys('traceMissing'), 'Trace unreachable: the recorded file is gone.')
    : translate(historyKeys('traceUnverifiable'), 'Trace unreachable: this host cannot check it.')
}

/** The one sentence for "the checkout that ran this is gone". Shared by both row
 *  kinds so they can never drift into two different statements. */
function noResumeCopy(): string {
  return translate(
    historyKeys('session.noResume'),
    'Resume unavailable: its workspace was removed.'
  )
}

function RunRow({ run }: { run: TaskWorkbenchHistoryRun }): React.JSX.Element {
  const traceUnreachable = run.trace !== undefined && run.trace.presence !== 'present'
  return (
    <li
      data-testid="task-workbench-history-run"
      data-run-source={run.fromRecord === true ? 'record' : 'live'}
      className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 px-3 py-1.5 text-[12.5px]"
    >
      <span className="min-w-32 flex-1 truncate">{run.title ?? run.key}</span>
      {run.agentType === undefined ? null : (
        <span className="shrink-0 text-muted-foreground">{run.agentType}</span>
      )}
      <span className="tabular-nums text-muted-foreground">
        {run.startedAt === undefined ? '—' : formatClock(run.startedAt)}
        <span aria-hidden="true" className="mx-1">
          →
        </span>
        {run.endedAt === undefined ? '—' : formatClock(run.endedAt)}
      </span>
      {run.messageCount === undefined ? null : (
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {translate(historyKeys('runMessages'), '{{value0}} messages', {
            value0: String(run.messageCount)
          })}
        </span>
      )}
      <span className="tabular-nums text-muted-foreground">
        {run.outcome !== undefined
          ? translate(historyKeys(`run.${run.outcome}`), OUTCOME_COPY[run.outcome])
          : run.fromRecord === true
            ? // A frozen observation with no verdict states that. `done` is the
              // live arm's shorthand for "the pane settled", and a record row has
              // no pane to have settled (issue #53 S2).
              translate(historyKeys('runUnknownOutcome'), 'no verdict recorded')
            : translate(historyKeys('runDone'), 'done')}
      </span>
      {run.transcriptPath === undefined || !traceUnreachable
        ? null
        : run.trace !== undefined && (
            <span
              data-testid="task-workbench-history-trace-unreachable"
              className="w-full text-[11.5px] text-muted-foreground"
            >
              {traceUnreachableCopy(run.trace)}
            </span>
          )}
      {run.transcriptPath === undefined || traceUnreachable
        ? null
        : pendingHistoryAction('locateTrace', 'Locate trace', 'task-workbench-history-run-locate')}
      {run.resumable !== true ? null : run.resumeCommand === undefined ? (
        // Resumable, but the record never saw a command (the hook path has none):
        // say so with the same disabled treatment instead of offering a control
        // that would copy nothing.
        <TaskWorkbenchPendingAction
          label={translate(historyKeys('copyResume'), 'Copy resume command')}
          hint={translate(
            historyKeys('resumeCommandMissing'),
            'No resume command was recorded for this run.'
          )}
          testId="task-workbench-history-run-resume"
        />
      ) : (
        <HistoryResumeAction command={run.resumeCommand} checkoutPath={run.checkoutPath} />
      )}
      {run.resumable !== false ? null : (
        <span
          data-testid="task-workbench-history-run-no-resume"
          className="w-full text-[11.5px] text-muted-foreground"
        >
          {noResumeCopy()}
        </span>
      )}
    </li>
  )
}

function WorkspaceRow({
  workspace
}: {
  workspace: TaskWorkbenchHistoryWorkspace
}): React.JSX.Element {
  return (
    <li
      data-testid="task-workbench-history-workspace"
      data-state={workspace.state}
      className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 px-3 py-1.5 text-[12.5px]"
    >
      <Badge
        data-testid="task-workbench-history-workspace-state"
        variant={workspace.state === 'removed' ? 'secondary' : 'outline'}
      >
        {workspace.state === 'removed'
          ? translate(historyKeys('state.removed'), 'Removed')
          : translate(historyKeys('state.archived'), 'Archived')}
      </Badge>
      <span className="min-w-32 flex-1 truncate" title={workspace.path}>
        {workspace.path}
      </span>
      <span className="shrink-0 text-muted-foreground">
        {workspace.lastVerifiedAt === null
          ? translate(historyKeys('unverified'), 'not verified')
          : formatClock(workspace.lastVerifiedAt)}
      </span>
      {/* Rendered, not merely computed: "this workspace reported sessions" is what
          keeps an empty run list from reading as "nothing ever ran" (issue #53
          T2). */}
      <span
        data-testid="task-workbench-history-workspace-sessions"
        data-has-sessions={workspace.hasSessions ? 'true' : 'false'}
        className="shrink-0 text-[11.5px] text-muted-foreground"
      >
        {workspace.hasSessions
          ? translate(historyKeys('workspace.hasSessions'), 'sessions recorded')
          : translate(historyKeys('workspace.noSessions'), 'no sessions recorded')}
      </span>
    </li>
  )
}

function SessionRow({ session }: { session: TaskWorkbenchHistorySession }): React.JSX.Element {
  return (
    <li
      data-testid="task-workbench-history-session"
      data-resumable={session.resumable ? 'true' : 'false'}
      className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 px-3 py-1.5 text-[12.5px]"
    >
      <span className="min-w-32 flex-1 truncate font-mono text-[11.5px]">{session.key}</span>
      {session.provider === undefined ? null : (
        <span className="shrink-0 text-muted-foreground">{session.provider}</span>
      )}
      <span className="shrink-0 text-muted-foreground">
        {session.hasTranscriptPath
          ? translate(historyKeys('session.transcript'), 'transcript path recorded')
          : translate(historyKeys('session.noTranscript'), 'no transcript path recorded')}
      </span>
      {session.resumable ? null : (
        // Why a visible sentence and not a disabled button: the row is here
        // because the workspace is gone, and a disabled control would leave the
        // reader guessing which half is unavailable.
        <span
          data-testid="task-workbench-history-session-no-resume"
          className="w-full text-[11.5px] text-muted-foreground"
        >
          {noResumeCopy()}
        </span>
      )}
      {session.trace === undefined || session.trace.presence === 'present' ? null : (
        <span
          data-testid="task-workbench-history-trace-unreachable"
          data-trace-presence={session.trace.presence}
          className="w-full text-[11.5px] text-muted-foreground"
        >
          {traceUnreachableCopy(session.trace)}
        </span>
      )}
    </li>
  )
}

export function TaskWorkbenchHistory({
  view,
  layout
}: {
  view: TaskWorkbenchView
  layout: TaskWorkbenchLayout
}): React.JSX.Element | null {
  useTranslation()
  const [expanded, setExpanded] = React.useState(false)
  const history = view.history
  if (!history) {
    return null
  }

  // Narrow or short windows sacrifice history detail first (README §7.3.1).
  const compact = layout.columns === 'single' || layout.agentHistory === 'collapsed'
  const detailsOpen = !compact || expanded
  // The archive form lists only the rows the record supplied (issue #53): its
  // live rows are already the Agents section, and listing them twice would print
  // one agent as two.
  const recordRuns = history.runs.filter((run) => run.fromRecord === true)
  // Absences the record stored. Absent on a view built before the fold carried
  // them, which is not "no gaps" — but there is nothing to print either way.
  const gaps = history.gaps ?? []

  return (
    <section
      data-testid="task-workbench-history"
      data-compact={compact ? 'true' : undefined}
      data-trace={history.trace}
      className="flex min-w-0 flex-col gap-2 rounded-lg bg-card/40 px-4 py-3 ring-1 ring-inset ring-border/60"
    >
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
          {translate(historyKeys('newBadge'), 'NEW')}
        </span>
        <h2 className="text-[13px] font-medium">
          {translate(historyKeys('heading'), 'Run history')}
        </h2>
        <span className="ml-auto shrink-0 text-[12px] text-muted-foreground">
          {translate(historyKeys('totalScope'), 'Total: every run')}
        </span>
        {compact ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            data-testid="task-workbench-history-details"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
            className="shrink-0"
          >
            <span className="text-muted-foreground">
              {expanded
                ? translate(historyKeys('collapse'), 'Collapse')
                : translate(historyKeys('details'), 'Details')}
            </span>
            <ChevronDown
              aria-hidden="true"
              className={cn('size-3.5 transition-transform', expanded && 'rotate-180')}
            />
          </Button>
        ) : null}
      </div>

      <HistoryFactsLine history={history} />

      {/* Where the record was read from, and what could not be read (issue #31).
          Rendered in compact mode too: an environment the client could not reach
          is a fact about the history's completeness, and folding it away with the
          details would leave the shorter view claiming a whole picture. */}
      {view.recordSource === undefined ? null : <RecordSourceNotice source={view.recordSource} />}

      {detailsOpen && history.workspaces.length > 0 ? (
        <ul
          data-testid="task-workbench-history-workspaces"
          className="flex flex-col divide-y divide-border/50 overflow-hidden rounded-lg ring-1 ring-inset ring-border/60"
        >
          {history.workspaces.map((workspace) => (
            <WorkspaceRow key={workspace.worktreeId} workspace={workspace} />
          ))}
        </ul>
      ) : null}

      {detailsOpen && history.sessions.length > 0 ? (
        <ul
          data-testid="task-workbench-history-sessions"
          className="flex flex-col divide-y divide-border/50 overflow-hidden rounded-lg ring-1 ring-inset ring-border/60"
        >
          {history.sessions.map((session) => (
            <SessionRow key={`${session.worktreeId}:${session.key}`} session={session} />
          ))}
        </ul>
      ) : null}

      {detailsOpen && history.trace === 'archived' ? (
        <>
          <p
            data-testid="task-workbench-history-archived-note"
            className="min-w-0 text-[12px] text-muted-foreground"
          >
            {history.archivedWorkspaces === 1
              ? translate(
                  historyKeys('archivedOne'),
                  '1 workspace archived; its content is still on this machine.'
                )
              : translate(
                  historyKeys('archivedMany'),
                  '{{value0}} archived workspaces; their content is still on this machine.',
                  { value0: String(history.archivedWorkspaces) }
                )}
          </p>
          {/* Recorded absences come first, before the run list: a workspace the
              record could not attribute has no rows to read, and without this
              sentence its empty list is indistinguishable from "nothing ran"
              (issue #53 T2 / B1). */}
          {gaps.length === 0 ? null : <HistoryGapList gaps={gaps} />}
          {recordRuns.length === 0 ? (
            <p
              data-testid="task-workbench-history-runs-none"
              className="min-w-0 text-[12px] text-muted-foreground"
            >
              {translate(historyKeys('runsNone'), 'No run recorded.')}
            </p>
          ) : (
            <HistoryRunList runs={recordRuns} />
          )}
          <div
            data-testid="task-workbench-history-trace"
            className="flex flex-wrap items-center gap-1"
          >
            {pendingHistoryAction(
              'locateTrace',
              'Locate trace',
              'task-workbench-history-trace-locate'
            )}
          </div>
        </>
      ) : null}

      {detailsOpen && history.trace === 'deleted' ? (
        <>
          <p
            data-testid="task-workbench-history-trace-lost"
            className="min-w-0 text-[12px] text-muted-foreground"
          >
            {translate(
              historyKeys('traceLost'),
              'Workspace deleted; the recorded trace is out of reach.'
            )}
          </p>
          {gaps.length === 0 ? null : <HistoryGapList gaps={gaps} />}
          <HistoryRunList runs={history.runs} />
        </>
      ) : null}
    </section>
  )
}

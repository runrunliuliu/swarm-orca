// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { TaskWorkbenchAgents } from './TaskWorkbenchAgents'
import { runHistory, tracked, workspace } from './task-workbench-fixtures-support'
import type { TaskWorkbenchHistoryRun, TaskWorkbenchLayout } from './task-workbench-view'

/**
 * The Agents section's history fold when the record is the only witness: an agent
 * whose TUI was closed mid-task has no pane, no card and (for a process that
 * exited) no retained row, so the run the record kept is the row the section must
 * print (issue #53 follow-up).
 *
 * Only the section renders here; the join and the record fold are covered where
 * they live, and the fixtures are hand-written so the component cannot hide a
 * missing field behind a builder.
 */

const LAYOUT: TaskWorkbenchLayout = {
  columns: 'double',
  delivery: 'expanded',
  agentHistory: 'expanded',
  spend: 'full',
  workspaces: 'full'
}

const RECORD_RUN: TaskWorkbenchHistoryRun = {
  key: 'claude|session_id:run-1',
  title: 'Closed pane run',
  agentType: 'claude',
  startedAt: 1_767_000_000_000,
  endedAt: 1_767_000_060_000,
  fromRecord: true,
  resumable: true,
  resumeCommand: 'claude --resume run-1',
  checkoutPath: '/repo/feature'
}

afterEach(cleanup)

describe('TaskWorkbenchAgents — runs the record kept for a closed TUI', () => {
  it('counts and lists a recorded run while the workspace is still open', () => {
    const ws = workspace('web-app', 'feature/add-login')
    render(
      <TaskWorkbenchAgents
        layout={LAYOUT}
        view={tracked('Add login', ws, 'open', {
          agents: [],
          spend: { kind: 'unavailable', reason: 'disabled' },
          history: runHistory({
            agents: 1,
            wall: { kind: 'unknown' },
            tokens: { kind: 'unavailable', reason: 'no_matching_session' },
            trace: 'none',
            runs: [RECORD_RUN]
          })
        })}
      />
    )

    // One answer: the heading count covers the rows the fold prints, and the
    // "no agents" sentence is not printed next to a run.
    expect(screen.getByTestId('task-workbench-agents-history-count')).toHaveTextContent('1')
    expect(screen.getByTestId('task-workbench-agents-record-runs')).toBeInTheDocument()
    expect(screen.getByText('Closed pane run')).toBeInTheDocument()
    expect(screen.queryByTestId('task-workbench-agents-empty')).toBeNull()
    expect(screen.queryByTestId('task-workbench-agents-history-empty')).toBeNull()
  })

  it('leaves an archived task’s recorded runs to the history strip', () => {
    const ws = workspace('web-app', 'feature/add-login', { archived: true })
    render(
      <TaskWorkbenchAgents
        layout={LAYOUT}
        view={tracked('Add login', ws, 'closed', {
          agents: [],
          spend: { kind: 'unavailable', reason: 'disabled' },
          history: runHistory({
            agents: 1,
            wall: { kind: 'unknown' },
            tokens: { kind: 'unavailable', reason: 'no_matching_session' },
            trace: 'archived',
            archivedWorkspaces: 1,
            runs: [RECORD_RUN]
          })
        })}
      />
    )

    // The strip owns the archived form; printing the same run in both surfaces
    // would list one agent twice.
    expect(screen.queryByTestId('task-workbench-agents-record-runs')).toBeNull()
    expect(screen.getByTestId('task-workbench-agents-history-empty')).toBeInTheDocument()
  })
})

// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { TaskWorkbenchPanel } from './TaskWorkbenchPanel'
import type { TaskWorkbenchLayout, TaskWorkbenchView } from './task-workbench-view'

const LAYOUT: TaskWorkbenchLayout = {
  columns: 'single',
  delivery: 'collapsed',
  agentHistory: 'expanded',
  spend: 'summary',
  workspaces: 'empty'
}

function emptyView(overrides: Partial<TaskWorkbenchView> = {}): TaskWorkbenchView {
  return {
    identity: { kind: 'workspace', primaryWorktreeId: 'wt-fixture' },
    title: 'Remote-only task',
    defaultWorkspace: { workspaceId: '', source: 'none' },
    agents: [],
    workspaces: [],
    spend: { kind: 'unavailable', reason: 'no_matching_session' },
    ...overrides
  }
}

afterEach(() => cleanup())

describe('TaskWorkbenchPanel', () => {
  it('renders an undetermined remote-history degradation instead of never started or zero sections', () => {
    render(
      <TaskWorkbenchPanel
        view={emptyView({
          recordSource: {
            environmentIds: [],
            blocksFinalAbsence: true,
            candidateFailure: 'undetermined',
            answered: [],
            unavailable: [],
            conflicts: [],
            pending: false
          }
        })}
        layout={LAYOUT}
      />
    )

    expect(screen.getByTestId('task-workbench-history-source-undetermined')).toBeInTheDocument()
    expect(screen.queryByTestId('task-workbench-empty-state')).not.toBeInTheDocument()
    expect(screen.queryByTestId('task-workbench-agents')).not.toBeInTheDocument()
    expect(screen.queryByTestId('task-workbench-facts')).not.toBeInTheDocument()
    expect(screen.queryByText(/\$0|0 tokens/i)).not.toBeInTheDocument()
  })

  it('keeps never started reachable after every selected source answered empty', () => {
    render(
      <TaskWorkbenchPanel
        view={emptyView({
          recordSource: {
            environmentIds: ['env-a'],
            blocksFinalAbsence: true,
            answered: ['env-a'],
            unavailable: [],
            conflicts: [],
            pending: false
          }
        })}
        layout={LAYOUT}
      />
    )

    expect(screen.getByTestId('task-workbench-empty-state')).toBeInTheDocument()
  })

  it('keeps the local Create action when only fallback remote history is unavailable', () => {
    render(
      <TaskWorkbenchPanel
        view={emptyView({
          recordSource: {
            environmentIds: ['env-a'],
            answered: [],
            unavailable: [{ environmentId: 'env-a', failure: 'repo-unknown' }],
            conflicts: [],
            pending: false
          }
        })}
        layout={LAYOUT}
      />
    )

    expect(screen.getByTestId('task-workbench-history-source-unavailable')).toBeInTheDocument()
    expect(screen.getByTestId('task-workbench-empty-state')).toBeInTheDocument()
    expect(screen.getByTestId('task-workbench-workspaces-create')).toBeInTheDocument()
  })

  it('does not flash never started or no-data sections while discovery is pending', () => {
    render(<TaskWorkbenchPanel view={emptyView({ historyPending: true })} layout={LAYOUT} />)

    expect(screen.queryByTestId('task-workbench-empty-state')).not.toBeInTheDocument()
    expect(screen.queryByTestId('task-workbench-agents')).not.toBeInTheDocument()
    expect(screen.queryByTestId('task-workbench-facts')).not.toBeInTheDocument()
  })

  it('blocks local Create when a required remote source is unsupported', () => {
    render(
      <TaskWorkbenchPanel
        view={emptyView({
          recordSource: {
            environmentIds: ['env-a'],
            blocksFinalAbsence: true,
            answered: [],
            unavailable: [{ environmentId: 'env-a', failure: 'unsupported' }],
            conflicts: [],
            pending: false
          }
        })}
        layout={LAYOUT}
      />
    )

    expect(screen.getByTestId('task-workbench-history-source-unavailable')).toBeInTheDocument()
    expect(screen.queryByTestId('task-workbench-empty-state')).not.toBeInTheDocument()
    expect(screen.queryByTestId('task-workbench-workspaces-create')).not.toBeInTheDocument()
  })
})

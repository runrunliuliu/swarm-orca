// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { RecordSourceNotice } from './task-workbench-record-source-notice'
import type { TaskWorkbenchRecordSource } from './task-workbench-view'

/**
 * The "we could not read this profile" copy (issue #31).
 *
 * What this file owns: that every degradation names the environment and says the
 * local history was kept, that the four reasons stay four different sentences, and
 * that an `unsupported` host prints its version — the one number the reader can
 * act on. The merge itself is exercised in `task-workbench-record-sources.test.ts`;
 * nothing here recomputes it.
 */

afterEach(() => {
  cleanup()
})

function source(overrides: Partial<TaskWorkbenchRecordSource> = {}): TaskWorkbenchRecordSource {
  return {
    environmentIds: ['env-a'],
    answered: [],
    unavailable: [],
    conflicts: [],
    pending: false,
    ...overrides
  }
}

describe('RecordSourceNotice', () => {
  it('names an older host, its version, and that the local history was kept', () => {
    render(
      <RecordSourceNotice
        source={source({
          unavailable: [
            {
              environmentId: 'env-a',
              failure: 'unsupported',
              label: 'Build box',
              appVersion: '0.1.0+9d05e51df904'
            }
          ]
        })}
      />
    )

    const line = screen.getByTestId('task-workbench-history-source-unavailable')
    expect(line).toHaveAttribute('data-source-state', 'unsupported')
    expect(line).toHaveTextContent('Build box')
    expect(line).toHaveTextContent('0.1.0+9d05e51df904')
    expect(line).toHaveTextContent('Showing what this computer has')
  })

  it('keeps a timeout retryable and does not print a version for it', () => {
    render(
      <RecordSourceNotice
        source={source({
          unavailable: [{ environmentId: 'env-a', failure: 'unreachable' }]
        })}
      />
    )

    const line = screen.getByTestId('task-workbench-history-source-unavailable')
    expect(line).toHaveTextContent('env-a')
    expect(line).toHaveTextContent('retryable')
    expect(line).not.toHaveTextContent(/Orca \d/)
  })

  it('separates a scope refusal from a wrong-repository answer', () => {
    render(
      <RecordSourceNotice
        source={source({
          unavailable: [
            { environmentId: 'env-a', failure: 'forbidden' },
            { environmentId: 'env-b', failure: 'repo-unknown' }
          ]
        })}
      />
    )

    const lines = screen.getAllByTestId('task-workbench-history-source-unavailable')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toHaveTextContent('not allowed to read that environment')
    expect(lines[1]).toHaveTextContent('no workspace registered for this repository')
  })

  it('states a disagreement and which profile was kept', () => {
    render(
      <RecordSourceNotice
        source={source({
          conflicts: [{ worktreeId: 'wt-1', kept: null, fields: ['path', 'isArchived'] }]
        })}
      />
    )

    const line = screen.getByTestId('task-workbench-history-source-conflict')
    expect(line).toHaveTextContent('wt-1')
    expect(line).toHaveTextContent('path, isArchived')
    expect(line).toHaveTextContent('this computer')
  })

  it('says when remote profiles were folded in, and when more may arrive', () => {
    render(
      <RecordSourceNotice
        source={source({ answered: ['env-a'], pending: true, environmentIds: ['env-a', 'env-b'] })}
      />
    )

    expect(screen.getByTestId('task-workbench-history-source-included')).toHaveTextContent(
      'History also includes what 1 environment(s) recorded'
    )
    expect(screen.getByTestId('task-workbench-history-source-pending')).toHaveTextContent(
      'Still reading 2 environment(s)'
    )
  })

  it('renders nothing when there is nothing to say', () => {
    const { container } = render(<RecordSourceNotice source={source()} />)
    expect(container).toBeEmptyDOMElement()
  })
})
